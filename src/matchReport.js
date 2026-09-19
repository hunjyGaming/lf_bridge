'use strict';

const fs = require('fs');
const path = require('path');

const {
  FAMILIES, FAMILY_DEFAULT_PROFILE, DEFAULT_PROFILE,
  metricInfo, profileOf, normProfile,
} = require('./gameModes');

/**
 * matchReport.js — the SHORT form of a finished mission.
 *
 * The full match state is a live working object: every counter of every player,
 * an event ring, team tables, provenance flags. It is what the console and the
 * CSV writer need, and it is far too much to push at a booking backend after
 * every mission. This module turns that state into a compact, stable,
 * self-explaining object — one overview block plus one slim block per player —
 * and hands it to a queue that keeps it until somebody has taken it.
 *
 * Three rules run through everything below.
 *
 * 1. HONESTY BEFORE COMPLETENESS. A value the arena has not reported is
 *    `null` or absent, never 0. `undefined` means "this mode does not even have
 *    that counter", `null` means "it exists but has not been measured yet".
 *    A 0 would read as a measurement ("this player hit nothing"), which is a
 *    lie about a missing number.
 * 2. THE HIT RATE IS AN ESTIMATE while the match runs, and it is too HIGH:
 *    Laserforce does not report a shot that had no effect, so it is missing
 *    from the denominator while every hit is in the numerator. Wherever
 *    `accuracy` goes out, `accuracySource` and `accuracyIsEstimate` go with it.
 * 3. A MISSION MUST NOT BE LOST. Everything that can fail — an unknown field
 *    name in a profile file, an unreachable target, a full queue — is logged in
 *    plain German and the report is still built and still sent.
 *
 * What is configurable, and where: `modes/profile/<profil>.json`, section
 * `_bericht` (docs/GAMEMODES.md). The leading underscore is not decoration —
 * the game-mode loader in src/gameModes.js only knows the display fields and
 * would otherwise warn about `bericht` as an unknown field on every start.
 * Keys beginning with `_` are explicitly free for other readers; this is one.
 */

// ---------------------------------------------------------------------------
// limits — every one of them bounded on purpose
// ---------------------------------------------------------------------------

/** Wire format. A consumer pins this string and nothing else. */
const REPORT_SCHEMA = 'lf-live.match-report/1';

/**
 * Metric names a profile may list under `_bericht.spieler`.
 *
 * Why 64: the widest shipped profile (SM5) writes 41 counters to its CSV, so 64
 * leaves the operator room to add every remaining SM5 field and still caps a
 * runaway config. At the limit a 50-player report stays around 200 KB — small
 * enough for one HTTP POST and for one MQTT message, which is the whole point
 * of the short form. Anything beyond is reported and dropped.
 */
const MAX_PLAYER_FIELDS = 64;

/** Players per report. A mission has at most a few dozen; 256 is pure defence. */
const MAX_PLAYERS = 256;

/** Raw entity tokens remembered per match (`#1234567` / `@104`). */
const MAX_ENTITY_IDS = 512;

/** Queue: reports kept on disk. Beyond this the OLDEST is dropped, loudly. */
const QUEUE_MAX_ENTRIES = 200;

/** Queue: total bytes on disk. Same overflow rule as the entry count. */
const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

/** A single report larger than this is not queued — it would never get through. */
const ENTRY_MAX_BYTES = 4 * 1024 * 1024;

/** Retry ladder for a target that is not reachable (ms). */
const RETRY_MS = [5000, 10000, 20000, 40000, 80000, 160000, 300000];

// ---------------------------------------------------------------------------
// what a profile may ask for
// ---------------------------------------------------------------------------

/**
 * Overview blocks a profile may switch on, by their German config name.
 * Everything not listed here is always present: without `matchId`, the times
 * and the mode a backend cannot file the report at all.
 */
const OVERVIEW_BLOCKS = {
  teams: 'teams',
  sieger: 'winner',
  ende: 'end',
  punktequelle: 'scoreSource',
  dauer: 'duration',
  spielerzahl: 'playerCount',
};
const OVERVIEW_NAMES = Object.keys(OVERVIEW_BLOCKS);

/** Keys `_bericht` knows. Anything else is a typo and is reported as one. */
const REPORT_FIELDS = ['spieler', 'uebersicht', 'namen'];

/** Free-text keys, so a JSON file can carry its own comments (as in modes/). */
const TEXT_FIELDS = ['beschreibung', 'hinweis', 'kommentar'];

/**
 * Built-in defaults per profile — what goes out when a profile file says
 * nothing. Chosen to answer the question the operator actually asked: who
 * played, how well, and how sure are we of the number.
 */
const DEFAULT_PLAYER_FIELDS = {
  standard: ['score', 'level', 'shotsFired', 'shotsHit', 'accuracy'],
  sm5: [
    'score', 'level', 'roleLabel',
    'shotsFired', 'shotsHit', 'accuracy',
    'livesLeft', 'shotsLeft',
    'deactivations', 'timesDeactivated',
  ],
  laserball: [
    'score', 'level',
    'goals', 'assists',
    'blocksDone', 'clearsDone', 'stealsDone', 'passesDone',
  ],
};

/** Player fields that are always there — the report is unusable without them. */
const PLAYER_CORE = ['playerId', 'entityId', 'idKind', 'memberId', 'teamId', 'team', 'result'];

/**
 * ADDITIVE — split the arena's reported member id into the three numbers the
 * Mongo `Member` schema of the receiving side uses (`countryCode`, `centerCode`,
 * `memberCode`, all numeric there).
 *
 * MEASURED, not guessed. Four real recordings of the hall's own arena
 * (19.09.2026, mode 7) carry a `memberId` column on every type-3 player line,
 * always of the form `<zahl>-<zahl>-<zahl>`: 141 of 141 players, no exception,
 * and no non-player entity had one (their column is empty). The type-0 header
 * names the centre as `21-101`, and the first two parts matched it for 135 of
 * those 141 players.
 *
 * THE SIX THAT DID NOT MATCH ARE THE POINT: two recordings contained three
 * players each whose id began `21-103` while the arena's own centre was
 * `21-101` — guests from another centre. `countryCode`/`centerCode` therefore
 * belong to the PLAYER and must be read out of the player's own id; deriving
 * them from the type-0 header would silently mis-file every visitor.
 *
 * Anything that does not match the three-number shape returns null, and the
 * caller then simply omits the field — the raw string always stays in the
 * report next to it and is never replaced by this.
 *
 * @param {string} raw e.g. '21-101-10001'
 * @returns {{countryCode:number, centerCode:number, memberCode:number}|null}
 */
function splitMemberId(raw) {
  try {
    if (typeof raw !== 'string') return null;
    const m = raw.trim().match(/^(\d{1,6})-(\d{1,6})-(\d{1,12})$/);
    if (!m) return null;
    const country = Number(m[1]);
    const center = Number(m[2]);
    const member = Number(m[3]);
    if (!Number.isSafeInteger(country) || !Number.isSafeInteger(center) || !Number.isSafeInteger(member)) return null;
    return { countryCode: country, centerCode: center, memberCode: member };
  } catch (_err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Untrusted display text -> printable, bounded. Same rule as the mode loader. */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** For an error message: show what the file actually contained, bounded. */
function shown(v) {
  if (v === undefined) return '(fehlt)';
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? '(Liste)' : '(Objekt)';
  if (typeof v === 'string') return `"${cleanText(v, 40)}"`;
  return cleanText(String(v), 40) || '(leer)';
}

/** A finite number, or null. Never 0 as a stand-in for "unknown". */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** No prototype pollution through an object key, whatever a file contains. */
function jsonReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

/** Where the mode files live. Mirrors gameModes.modesDir(). */
function profileDir() {
  const env = process.env.LF_MODES_DIR;
  const base = env && String(env).trim() ? path.resolve(String(env).trim()) : path.join(__dirname, '..', 'modes');
  return path.join(base, 'profile');
}

/** `false` only for a literal "false"/"0"/"no"; anything else keeps the default. */
function envBool(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'nein', 'off'].includes(s)) return false;
  if (['true', '1', 'yes', 'ja', 'on'].includes(s)) return true;
  return dflt;
}

// ---------------------------------------------------------------------------
// raw entity ids — member or guest
// ---------------------------------------------------------------------------

/**
 * Keeps the RAW entity token of every player of the running match.
 *
 * Why this exists at all. The stream identifies a player in one of two ways
 * (docs/LASERFORCE.md):
 *
 *   `#xxxxxxx`  the worldwide unique Laserforce member id. This, and only
 *               this, can be matched against a member across visits.
 *   `@NNN`      the hardware number of a vest. A guest. It means nothing
 *               tomorrow and nothing in the next arena.
 *
 * `Engine.cleanId()` strips the leading character, and with it exactly the
 * distinction a backend needs. The engine is not ours to change here, so this
 * class reads the one line that carries it — the type-3 login — straight off
 * the stream, before the engine sees it, and remembers the prefix per player.
 *
 * Cost: one `charCodeAt(0)` per line for everything that is not a type-3 line,
 * which is all of them but a handful per match.
 *
 * The clean fix belongs in the engine: a `rawId` / `idKind` on the player
 * object at login. Until then this is the honest substitute — and when it saw
 * nothing, it says `unknown` instead of guessing.
 */
class EntityIds {
  constructor() {
    /** @type {Map<string,{entityId:string, idKind:string}>} */
    this._map = new Map();
  }

  reset() { this._map.clear(); }

  /** One raw stream line. Only a type-3 (entity start) line is looked at. */
  noteLine(line) {
    try {
      if (typeof line !== 'string' || line.length < 4) return;
      if (line.charCodeAt(0) !== 51) return;                  // not a '3' line
      const sep = line.charCodeAt(1);
      if (sep !== 9 && sep !== 32) return;                    // "3<TAB>" or "3 "
      if (this._map.size >= MAX_ENTITY_IDS) return;
      const cols = (line.indexOf('\t') !== -1 ? line.split('\t') : line.split(/\s+/)).map((s) => s.trim());
      const idx = cols.indexOf('player');
      if (idx < 1) return;
      const raw = String(cols[idx - 1] || '');
      if (!/^[@#][0-9A-Za-z_-]{1,32}$/.test(raw)) return;
      const key = raw.slice(1).trim();
      if (!key) return;
      this._map.set(key, { entityId: raw, idKind: raw[0] === '#' ? 'member' : 'guest' });
    } catch (_err) {
      /* an id hint must never disturb the stream */
    }
  }

  /**
   * What we know about a player key (the id WITHOUT prefix, as the engine and
   * the CSV use it). Never throws, never guesses.
   */
  lookup(playerId) {
    const hit = this._map.get(String(playerId));
    if (hit) return { entityId: hit.entityId, idKind: hit.idKind };
    return { entityId: null, idKind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// `_bericht` — the per-profile configuration
// ---------------------------------------------------------------------------

/**
 * Read `modes/profile/<profil>.json` and take its `_bericht` section apart.
 *
 * Error behaviour is the one the mode loader already sets: a problem is
 * reported in plain German with the file name, the offending entry is skipped,
 * and the built-in default stands in. Nothing here can stop a report from being
 * built or sent — a typo in a config file must never cost a mission.
 *
 * @param {string} profile   display profile of the match ('sm5', 'laserball', …)
 * @param {(p:{level:string,file:string,message:string})=>void} [onProblem]
 * @returns {{playerFields:string[], overview:string[], includeNames:boolean, file:string|null}}
 */
function readReportConfig(profile, onProblem) {
  const prof = normProfile(profile);
  const fallback = DEFAULT_PLAYER_FIELDS[prof] || DEFAULT_PLAYER_FIELDS[DEFAULT_PROFILE];
  const out = {
    playerFields: fallback.slice(),
    overview: OVERVIEW_NAMES.slice(),
    includeNames: true,
    file: null,
  };
  const report = (level, file, message) => { try { if (onProblem) onProblem({ level, file, message }); } catch (_e) { /* never throws */ } };

  const rel = `modes/profile/${prof}.json`;
  const full = path.join(profileDir(), `${prof}.json`);
  let obj;
  try {
    if (!fs.existsSync(full)) return out;                    // built-in profile, no file: defaults
    obj = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''), jsonReviver);
  } catch (err) {
    report('warn', rel, `Die Datei konnte für den Missionsbericht nicht gelesen werden (${cleanText(err && err.message, 120)}). Es gelten die eingebauten Vorgaben; der Bericht wird trotzdem gebaut und verschickt.`);
    return out;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;

  const sec = obj._bericht !== undefined ? obj._bericht : obj.bericht;
  if (sec === undefined) return out;                          // no section: defaults
  out.file = rel;
  if (!sec || typeof sec !== 'object' || Array.isArray(sec)) {
    report('warn', rel, `Der Abschnitt "_bericht" ist kein Objekt (gefunden: ${shown(sec)}). Erwartet wird z. B. { "spieler": ["score", "shotsHit"] }. Es gelten die eingebauten Vorgaben; der Bericht wird trotzdem gebaut und verschickt.`);
    return out;
  }

  for (const k of Object.keys(sec)) {
    if (REPORT_FIELDS.includes(k) || TEXT_FIELDS.includes(k) || k.startsWith('_')) continue;
    report('warn', rel, `Unbekanntes Feld "${cleanText(k, 40)}" im Abschnitt "_bericht" — Tippfehler? Das Feld wird übersprungen. Bekannt sind: ${REPORT_FIELDS.join(', ')} (dazu ${TEXT_FIELDS.join(', ')} als freier Text).`);
  }

  // ---- spieler: which numbers each player block carries --------------------
  if (sec.spieler !== undefined) {
    if (!Array.isArray(sec.spieler)) {
      report('warn', rel, `"_bericht.spieler" ist keine Liste (gefunden: ${shown(sec.spieler)}). Erwartet wird z. B. ["score", "shotsFired", "shotsHit", "accuracy"]. Es gilt die eingebaute Vorgabe für dieses Profil.`);
    } else {
      const picked = [];
      for (const item of sec.spieler) {
        if (picked.length >= MAX_PLAYER_FIELDS) {
          report('warn', rel, `"_bericht.spieler" nennt mehr als ${MAX_PLAYER_FIELDS} Kennzahlen — alles darüber wird übersprungen. Ein Missionsbericht ist die Kurzfassung; wer jede Zahl braucht, nimmt die CSV-Dateien.`);
          break;
        }
        const name = typeof item === 'string' ? item.trim() : '';
        if (!name) {
          report('warn', rel, `Ein Eintrag in "_bericht.spieler" ist kein Name (gefunden: ${shown(item)}) — er wird übersprungen.`);
          continue;
        }
        if (!metricInfo(name)) {
          report('warn', rel, `Unbekannte Kennzahl "${cleanText(name, 40)}" in "_bericht.spieler" — dieses Feld wird übersprungen, der Bericht geht trotzdem raus. Die gültigen Kennzahlnamen stehen in docs/GAMEMODES.md, Abschnitt "Spaltenbeschriftungen".`);
          continue;
        }
        if (PLAYER_CORE.includes(name) || picked.includes(name)) continue;
        picked.push(name);
      }
      // An empty result would send player blocks without a single number. The
      // default is the better answer than silence.
      if (picked.length) out.playerFields = picked;
      else report('warn', rel, '"_bericht.spieler" enthält nach dem Prüfen keine einzige gültige Kennzahl. Es gilt die eingebaute Vorgabe für dieses Profil.');
    }
  }

  // ---- uebersicht: which blocks the mission overview carries ---------------
  if (sec.uebersicht !== undefined) {
    if (!Array.isArray(sec.uebersicht)) {
      report('warn', rel, `"_bericht.uebersicht" ist keine Liste (gefunden: ${shown(sec.uebersicht)}). Erwartet wird z. B. ["teams", "sieger", "ende"]. Es gelten die eingebauten Vorgaben.`);
    } else {
      const picked = [];
      for (const item of sec.uebersicht) {
        const name = typeof item === 'string' ? item.trim().toLowerCase() : '';
        if (!name || !OVERVIEW_NAMES.includes(name)) {
          report('warn', rel, `Unbekannter Block ${shown(item)} in "_bericht.uebersicht" — er wird übersprungen, der Bericht geht trotzdem raus. Erlaubt sind: ${OVERVIEW_NAMES.join(', ')}. Match-Kennung, Start, Ende und Modus stehen immer im Bericht und müssen hier nicht genannt werden.`);
          continue;
        }
        if (!picked.includes(name)) picked.push(name);
      }
      out.overview = picked;                                  // a deliberately empty list is allowed
    }
  }

  // ---- namen: privacy switch ----------------------------------------------
  if (sec.namen !== undefined) {
    if (typeof sec.namen !== 'boolean') {
      report('warn', rel, `"_bericht.namen" muss true oder false sein (gefunden: ${shown(sec.namen)}). Es bleibt bei true, die Spielernamen gehen also mit.`);
    } else {
      out.includeNames = sec.namen;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// the report itself
// ---------------------------------------------------------------------------

/**
 * One player's value for one metric.
 *
 * `undefined` = this mode does not have that counter at all -> the key is left
 * out of the block. `null` = the counter exists but the arena has not reported
 * it yet -> the key is there with `null`. Never 0 for either.
 */
function playerValue(p, field) {
  const v = p[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  const info = metricInfo(field);
  const fmt = info ? info.format : 'int';
  if (fmt === 'text') return cleanText(String(v), 64) || null;
  return numOrNull(v);
}

/**
 * Build the short form of a finished mission.
 *
 * @param {object} state      engine snapshot at mission end (not modified)
 * @param {object} [opts]
 * @param {EntityIds} [opts.entityIds]   raw-token index of this match
 * @param {object}  [opts.mode]          mode to file the match under (default: state.mode)
 * @param {string}  [opts.startedAt]     ISO start time (default: derived from endedAt - elapsed)
 * @param {boolean} [opts.includeNames]  false leaves every player name out
 * @param {function} [opts.onProblem]    reporter for config problems
 * @returns {object} the report
 */
function buildMatchReport(state, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const s = state && typeof state === 'object' ? state : {};
  const ids = o.entityIds || new EntityIds();
  const mode = o.mode || s.mode || null;
  const profile = profileOf(mode);
  const cfg = readReportConfig(profile, o.onProblem);
  const wants = (block) => cfg.overview.includes(block);

  const includeNames = o.includeNames === undefined
    ? (cfg.includeNames && envBool('LF_REPORT_NAMES', true))
    : !!o.includeNames;

  const endedAtMs = numOrNull(s.endedAt) || Date.now();
  const elapsedMs = numOrNull(s.elapsedTime);
  const startedAt = o.startedAt
    || new Date(endedAtMs - (elapsedMs == null ? 0 : elapsedMs)).toISOString();

  // ---- teams and winner ---------------------------------------------------
  const scores = s.scores && typeof s.scores === 'object' ? s.scores : {};
  // ADDITIVE — where the team score came from. 'tdf' = the arena reported team
  // points itself; 'derived' = lf_live summed them from the player scores
  // because the arena reports per player only (standard mode); 'internal' = no
  // usable type-5 lines, the bridge's own count. The engine has already put the
  // value to use into `scores` in all three cases — this report never sums
  // anything itself. `scoreDerived` travels ON every single number below, so a
  // backend cannot read a total of ours and take it for the arena's.
  const teamScoreSource = ['tdf', 'derived', 'internal'].includes(s.teamScoreSource)
    ? s.teamScoreSource : 'internal';
  const teamScoreDerived = teamScoreSource === 'derived';
  const teamIds = [...new Set(Object.keys(s.teams || {}).concat(Object.keys(scores)))];
  const teams = teamIds.map((id) => ({
    teamId: String(id),
    name: cleanText(String(s.teams?.[id]?.name || `Team ${id}`), 64),
    color: cleanText(String(s.teams?.[id]?.color || ''), 32) || null,
    score: numOrNull(scores[id]),
    scoreDerived: teamScoreDerived,
  }));
  const scored = teams.filter((t) => t.score !== null);
  const best = scored.length ? Math.max(...scored.map((t) => t.score)) : null;
  const leaders = best === null ? [] : scored.filter((t) => t.score === best);
  const winner = leaders.length === 1
    ? { teamId: leaders[0].teamId, name: leaders[0].name, score: leaders[0].score, scoreDerived: teamScoreDerived }
    : null;
  const draw = leaders.length > 1;

  // ---- overview -----------------------------------------------------------
  const match = {
    // always present: without these a backend cannot file the report
    matchId: s.matchId ? cleanText(String(s.matchId), 64) : null,
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    mode: {
      number: mode && mode.number !== undefined && mode.number !== null ? numOrNull(mode.number) : null,
      key: cleanText(String(mode?.key || 'unknown'), 40),
      label: cleanText(String(mode?.label || 'Unbekannter Modus'), 64),
      family: mode?.family === FAMILIES.LASERBALL ? FAMILIES.LASERBALL : FAMILIES.SM5,
      profile,
    },
  };
  if (wants('dauer')) {
    // `durationMs` is what the mission ACTUALLY ran; `plannedDurationMs` is
    // what the arena announced. `durationKnown: false` means it announced
    // nothing — then the planned value is null and must not be derived.
    match.durationMs = elapsedMs;
    match.durationS = elapsedMs == null ? null : Math.round(elapsedMs / 1000);
    match.durationKnown = s.durationKnown === true;
    match.plannedDurationMs = s.durationKnown === true ? numOrNull(s.duration) : null;
  }
  if (wants('teams')) match.teams = teams;
  if (wants('sieger')) { match.winner = winner; match.draw = draw; }
  if (wants('punktequelle')) {
    match.scoreSource = s.scoreSource === 'tdf' ? 'tdf' : 'internal';
    // ADDITIVE and separate on purpose: `scoreSource` says whether type-5 lines
    // arrived at all, `teamScoreSource` says whether the TEAM number in
    // `teams[].score`/`winner.score` is the arena's or ours.
    match.teamScoreSource = teamScoreSource;
    match.teamScoreDerived = teamScoreDerived;
  }
  if (wants('ende')) {
    match.end = {
      reason: s.endReason || null,
      source: s.endSource || null,
      exitCodes: s.exitCodes && typeof s.exitCodes === 'object' ? { ...s.exitCodes } : {},
      exitCodesSeen: Array.isArray(s.exitCodesSeen) ? s.exitCodesSeen.slice() : [],
    };
  }

  // ---- one slim block per player ------------------------------------------
  const all = Object.values(s.players || {}).filter((p) => p && typeof p === 'object');
  const players = all.slice(0, MAX_PLAYERS).map((p) => {
    const playerId = cleanText(String(p.id == null ? '' : p.id), 40);
    const { entityId, idKind } = ids.lookup(playerId);
    const teamScore = numOrNull(scores[p.teamId]);
    const opp = Object.entries(scores)
      .filter(([k]) => String(k) !== String(p.teamId))
      .map(([, v]) => numOrNull(v))
      .filter((v) => v !== null);
    const oppScore = opp.length ? Math.max(...opp) : null;
    const result = (teamScore === null || oppScore === null)
      ? null
      : (teamScore > oppScore ? 'win' : teamScore < oppScore ? 'loss' : 'draw');

    const block = {
      // Key lf_live and the CSV files use — the id WITHOUT the prefix.
      playerId,
      // The identification EXACTLY as the arena sent it, prefix included.
      // '#…' member · '@…' guest vest · null when no login line was seen.
      entityId,
      // 'member' | 'guest' | 'unknown' — never inferred from the number itself.
      idKind,
      // Worldwide unique Laserforce member id. The ONLY field that may be used
      // to recognise a person across visits, and it is null for every guest.
      memberId: idKind === 'member' && entityId ? entityId.slice(1) : null,
      teamId: String(p.teamId == null ? '' : p.teamId),
      team: cleanText(String(s.teams?.[p.teamId]?.name || `Team ${p.teamId}`), 64),
      result,
    };
    // Second, independent source: the `memberId` column of the type-3 line,
    // which only late TDF 2.006 arenas send. Absent -> the key is left out.
    if (typeof p.memberId === 'string' && p.memberId.trim()) {
      block.memberIdReported = cleanText(p.memberId, 32);
      // ADDITIVE, never instead of the raw string above: the three numbers the
      // receiving Mongo `Member` schema is keyed by. Omitted when the id does
      // not have the measured `<land>-<zentrum>-<mitglied>` shape — see
      // splitMemberId() for what was measured and what the six visitors proved.
      const parts = splitMemberId(block.memberIdReported);
      if (parts) block.memberIdParts = parts;
    }
    if (includeNames) block.name = cleanText(String(p.name || ''), 64) || null;

    for (const f of cfg.playerFields) {
      const v = playerValue(p, f);
      if (v === undefined) continue;                          // mode has no such counter
      block[f] = v;
      // A hit rate without its provenance is a number a backend would treat as
      // a measurement. It never travels alone.
      if (f === 'accuracy') {
        block.accuracySource = p.accuracySource === 'tdf7' ? 'tdf7' : 'live';
        block.accuracyIsEstimate = p.accuracySource !== 'tdf7';
      }
    }
    // Where this player's counters come from: 'live' = counted by lf_live from
    // the event stream, 'tdf7' = the arena's own end block.
    block.statsSource = p.statsSource === 'tdf7' ? 'tdf7' : 'live';
    return block;
  });
  if (wants('spielerzahl')) match.playerCount = all.length;

  const report = { schema: REPORT_SCHEMA, generatedAt: new Date().toISOString(), match, players };
  if (all.length > MAX_PLAYERS) {
    report.truncated = { players: all.length - MAX_PLAYERS };
  }
  return report;
}

// ---------------------------------------------------------------------------
// the queue — a mission survives an unreachable target and a restart
// ---------------------------------------------------------------------------

/**
 * A durable, bounded outbox for finished missions.
 *
 * The moment a mission ends is exactly the moment the network is least
 * trustworthy, and it is the one moment the data cannot be produced again. So
 * the report is written to disk SYNCHRONOUSLY, through a temp file and a
 * rename, before anything is sent: a power cut one millisecond later costs
 * nothing, and the next start picks the file up and delivers it.
 *
 * Delivery is AT LEAST ONCE, never exactly once — a webhook that answers 200
 * after the socket died is indistinguishable from one that never answered. Every
 * report therefore carries a stable `match.matchId`, and **the receiver
 * de-duplicates on it**. That is written in docs/INTEGRATION.md as a contract,
 * not left as an assumption.
 *
 * Overflow drops the OLDEST report, logs an ERROR and counts it in
 * `status().dropped`, which the console shows. Dropping silently would be the
 * one failure mode nobody notices until the month-end report is wrong.
 */
class ReportQueue {
  constructor({ logger, dir, sinks, maxEntries, maxBytes } = {}) {
    this.log = logger || null;
    this.dir = dir || path.resolve(process.cwd(), 'data', 'reports');
    /** @type {Array<{name:string, send:(report:object)=>Promise<any>}>} */
    this.sinks = Array.isArray(sinks) ? sinks.slice() : [];
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.round(maxEntries) : QUEUE_MAX_ENTRIES;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.round(maxBytes) : QUEUE_MAX_BYTES;
    this.dropped = 0;
    this.delivered = 0;
    this.lastError = null;
    this.lastOkAt = null;
    this._seq = 0;
    this._attempt = 0;
    this._timer = null;
    this._draining = false;
    this._stopped = false;
  }

  addSink(name, send) {
    if (typeof send !== 'function') return false;
    this.sinks.push({ name: String(name || 'sink'), send });
    return true;
  }

  /** Pick up whatever a previous run left behind. Call once at boot. */
  start() {
    const pending = this._files().length;
    if (pending) this._warn(`${pending} Missionsbericht(e) aus einem früheren Lauf liegen noch in ${this.dir} — sie werden jetzt zugestellt.`);
    this._schedule(1000);
    return pending;
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  /**
   * Put one report in the outbox. Synchronous and durable; delivery follows.
   * Never throws — a failure here is logged and the report is still attempted.
   */
  enqueue(report) {
    let body;
    try { body = JSON.stringify(report); }
    catch (err) {
      this._error(`Ein Missionsbericht ließ sich nicht in JSON umwandeln (${cleanText(err && err.message, 120)}) — er wird verworfen.`);
      return null;
    }
    if (Buffer.byteLength(body) > ENTRY_MAX_BYTES) {
      this._error(`Ein Missionsbericht ist ${Math.round(Buffer.byteLength(body) / 1024)} KB groß, erlaubt sind höchstens ${ENTRY_MAX_BYTES / 1024} KB. Er wird NICHT in die Warteschlange gelegt, sondern nur einmal direkt verschickt. Bitte "_bericht.spieler" in modes/profile/ kürzen.`);
      this._deliver(report).catch(() => {});
      return null;
    }
    const id = `${String(Date.now()).padStart(14, '0')}-${String(++this._seq).padStart(4, '0')}`;
    const safe = cleanText(String(report?.match?.matchId || 'match'), 40).replace(/[^A-Za-z0-9_-]/g, '') || 'match';
    const name = `${id}-${safe}.json`;
    const full = path.join(this.dir, name);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${full}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, full);                                // atomic: no half file survives a crash
    } catch (err) {
      this._error(`Die Warteschlange unter ${this.dir} ist nicht beschreibbar (${cleanText(err && err.message, 120)}). Der Bericht wird nur einmal direkt verschickt und überlebt keinen Neustart.`);
      this._deliver(report).catch(() => {});
      return null;
    }
    this._enforceLimits();
    this._attempt = 0;
    this._schedule(0);
    return name;
  }

  status() {
    const files = this._files();
    return {
      dir: this.dir,
      pending: files.length,
      oldest: files.length ? files[0] : null,
      dropped: this.dropped,
      delivered: this.delivered,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      sinks: this.sinks.map((s) => s.name),
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      retrying: this._timer != null,
    };
  }

  // ---- internals ----
  _files() {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort();
    } catch (_err) { return []; }
  }

  /**
   * Keep the outbox inside both limits. The OLDEST goes first: a report that
   * has been stuck for days is the one least likely ever to be wanted, and
   * losing today's mission to a queue clogged with last week's is worse.
   */
  _enforceLimits() {
    try {
      let files = this._files();
      while (files.length > this.maxEntries) {
        const victim = files.shift();
        this._drop(victim, `Warteschlange voll (${this.maxEntries} Berichte)`);
      }
      let bytes = 0;
      const sized = files.map((n) => {
        let size = 0;
        try { size = fs.statSync(path.join(this.dir, n)).size; } catch (_e) { /* gone already */ }
        bytes += size;
        return { n, size };
      });
      while (bytes > this.maxBytes && sized.length) {
        const victim = sized.shift();
        bytes -= victim.size;
        this._drop(victim.n, `Warteschlange voll (${Math.round(this.maxBytes / 1024)} KB)`);
      }
    } catch (_err) {
      /* bookkeeping must never take the bridge down */
    }
  }

  _drop(name, why) {
    try { fs.unlinkSync(path.join(this.dir, name)); } catch (_e) { /* already gone */ }
    this.dropped++;
    this._error(`ÜBERLAUF: der älteste Missionsbericht ${name} wurde GELÖSCHT — ${why}. Insgesamt verworfen: ${this.dropped}. Das Ziel ist seit Längerem nicht erreichbar; bitte den Ausgang in der Konsole prüfen.`);
  }

  _schedule(ms) {
    if (this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.drain().catch(() => {}); }, Math.max(0, ms));
    this._timer.unref?.();
  }

  /** Try to hand over everything that is waiting, oldest first. */
  async drain() {
    if (this._draining || this._stopped) return;
    this._draining = true;
    try {
      for (const name of this._files()) {
        const full = path.join(this.dir, name);
        let report;
        try {
          report = JSON.parse(fs.readFileSync(full, 'utf8'), jsonReviver);
        } catch (err) {
          // Unreadable: park it instead of retrying it forever, so the ones
          // behind it still get through.
          try { fs.renameSync(full, `${full}.defekt`); } catch (_e) { /* best effort */ }
          this._error(`Der wartende Bericht ${name} ist unlesbar (${cleanText(err && err.message, 120)}) und wurde als ${name}.defekt beiseitegelegt. Die übrigen werden weiter zugestellt.`);
          continue;
        }
        const res = await this._deliver(report);
        if (!res.ok) {
          this.lastError = res.detail;
          const wait = RETRY_MS[Math.min(this._attempt, RETRY_MS.length - 1)];
          this._attempt++;
          this._warn(`Missionsbericht ${name} konnte nicht zugestellt werden (${res.detail}). Er BLEIBT in der Warteschlange; nächster Versuch in ${Math.round(wait / 1000)} s.`);
          this._schedule(wait);
          return;
        }
        try { fs.unlinkSync(full); } catch (_e) { /* best effort */ }
        this.delivered++;
        this.lastOkAt = Date.now();
        this.lastError = null;
        this._attempt = 0;
      }
    } finally {
      this._draining = false;
    }
  }

  /**
   * One delivery attempt across every sink. A sink that throws counts as
   * failed; one that returns `{ok:false}` counts as failed. Anything else
   * counts as accepted.
   */
  async _deliver(report) {
    if (!this.sinks.length) return { ok: true, detail: 'kein Ziel eingerichtet' };
    const details = [];
    let ok = true;
    for (const sink of this.sinks) {
      try {
        const r = await sink.send(report);
        const good = r === undefined || r === true || (r && typeof r === 'object' && r.ok !== false);
        if (!good) { ok = false; details.push(`${sink.name}: ${cleanText(String(r && r.detail || 'abgelehnt'), 80)}`); }
      } catch (err) {
        ok = false;
        details.push(`${sink.name}: ${cleanText(err && err.message, 80) || 'Fehler'}`);
      }
    }
    return { ok, detail: details.join(' · ') || 'ok' };
  }

  _warn(msg) { if (this.log) this.log.warn('bericht', msg); else try { process.stderr.write(`WARN bericht: ${msg}\n`); } catch (_e) { /* nothing */ } }
  _error(msg) { if (this.log) this.log.error('bericht', msg); else try { process.stderr.write(`ERROR bericht: ${msg}\n`); } catch (_e) { /* nothing */ } }
}

// ---------------------------------------------------------------------------
// the piece src/index.js talks to
// ---------------------------------------------------------------------------

/**
 * Ties the three parts together: watch the stream for raw ids, build the report
 * when a mission ends, hand it to the queue.
 *
 * Deliberately owns no transport of its own. Sinks are added from outside —
 * `src/outputs.js` for webhook/TCP/UDP, and MQTT when that module exists.
 */
class MatchReporter {
  constructor({ logger, getConfig, dir, sinks } = {}) {
    this.log = logger || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.ids = new EntityIds();
    this.queue = new ReportQueue({ logger, dir, sinks });
    this._startedAt = null;
    this._problems = [];
    this._lastReportAt = null;
    this._lastSig = '';
  }

  get enabled() {
    const cfg = this.getConfig() || {};
    // `config.report` does not exist yet (see the report to the operator); the
    // env switch is the one that works today, and both default to ON.
    if (cfg.report && cfg.report.enabled === false) return false;
    return envBool('LF_REPORT_ENABLED', true);
  }

  addSink(name, send) { return this.queue.addSink(name, send); }

  /** One raw stream line — the ONLY hot-path call, one charCode for most lines. */
  noteLine(line) { this.ids.noteLine(line); }

  onMatchStart() {
    this.ids.reset();
    this._startedAt = new Date().toISOString();
  }

  /**
   * A mission ended. Build the short form and put it in the outbox.
   * @returns {object|null} the report, for tests and for the console
   */
  onMatchEnd(state) {
    if (!this.enabled) return null;
    try {
      this._problems = [];
      const report = buildMatchReport(state, {
        entityIds: this.ids,
        startedAt: this._startedAt || undefined,
        onProblem: (p) => this._noteProblem(p),
      });
      this._lastReportAt = Date.now();
      this.queue.enqueue(report);
      if (this.log) {
        this.log.info('bericht', `Missionsbericht ${report.match.matchId || '(ohne Kennung)'} erstellt: ${report.players.length} Spieler, ${report.match.mode.label}`);
      }
      return report;
    } catch (err) {
      // A broken report must never take the bridge — or the CSV writer, which
      // runs on the same event — down with it.
      if (this.log) this.log.error('bericht', `Der Missionsbericht konnte nicht gebaut werden: ${err.stack}`);
      return null;
    } finally {
      this._startedAt = null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      lastReportAt: this._lastReportAt,
      problems: this._problems.slice(0, 20),
      queue: this.queue.status(),
    };
  }

  /** Report a config problem once per distinct set, exactly as modes/ does. */
  _noteProblem(p) {
    this._problems.push(p);
    const sig = `${p.level}|${p.file}|${p.message}`;
    if (sig === this._lastSig) return;
    this._lastSig = sig;
    const text = `${p.file ? `${p.file}: ` : ''}${p.message}`;
    if (this.log) (p.level === 'error' ? this.log.error : this.log.warn).call(this.log, 'bericht', text);
    else try { process.stderr.write(`WARN bericht: ${text}\n`); } catch (_e) { /* nothing */ }
  }
}

/**
 * MQTT, if and only if somebody built it — the second delivery path.
 *
 * `src/mqtt.js` belongs to another hand, and this is the whole of the coupling:
 * a narrow, optional adapter. No module, no `publish()`, no MQTT — that is not
 * an error, it is a bridge without MQTT, exactly as before.
 *
 * WHAT IS EXPECTED of the object handed in (src/mqtt.js `MqttOut`):
 *   `publish(payload, topicSuffix) -> boolean`
 *       true  = handed to the broker OR held in its own queue
 *       false = MQTT switched off, payload unusable, or the message was DROPPED
 *   `enabled -> boolean`  — whether MQTT is switched on at all
 *
 * Why both are needed. `false` alone cannot say whether the message was thrown
 * away or whether MQTT is simply off, and those two need opposite answers: a
 * dropped mission must stay in the outbox and be retried, a switched-off MQTT
 * must never hold one back. `enabled` separates them. With MQTT off the sink
 * reports success without publishing anything.
 *
 * @param {object} mqtt     an MqttOut instance, or null
 * @param {object} [logger]
 * @returns {{name:string, send:function}|null}
 */
function optionalMqttSink(mqtt, logger) {
  let target = mqtt;
  if (!target) {
    try { const mod = require('./mqtt'); target = mod && (mod.mqtt || mod.client || null); }
    catch (_err) { return null; }                             // not built: nothing to do
  }
  if (!target || typeof target.publish !== 'function') {
    if (logger && target) logger.warn('bericht', 'MQTT bietet kein publish(payload, topicSuffix) — Missionsberichte gehen nur über die Ausgänge raus.');
    return null;
  }
  return {
    name: 'mqtt',
    send: (report) => {
      if (target.enabled === false) return { ok: true, detail: 'MQTT ist ausgeschaltet' };
      const ok = target.publish({ event: 'match_report', ...report }, 'report');
      return ok ? true : { ok: false, detail: 'von MQTT verworfen' };
    },
  };
}

module.exports = {
  MatchReporter,
  ReportQueue,
  EntityIds,
  buildMatchReport,
  splitMemberId,
  readReportConfig,
  optionalMqttSink,
  REPORT_SCHEMA,
  OVERVIEW_NAMES,
  DEFAULT_PLAYER_FIELDS,
  MAX_PLAYER_FIELDS,
  QUEUE_MAX_ENTRIES,
};
