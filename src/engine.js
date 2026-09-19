'use strict';

const { EventEmitter } = require('events');
const { describe, phrase, readable, streamPhrase } = require('./eventCatalog');
const { TdfSchema } = require('./tdfSchema');
const {
  FAMILIES, FAMILY_DEFAULT_PROFILE, resolveModeWithProfile, withProfile,
  familyOf, newPlayerStats, newOfficialStats, SM5_OFFICIAL_FIELDS, roleLabel,
} = require('./gameModes');

/**
 * Type-4 codes the core `processLogLine` switch/if-chain below ALREADY acts on
 * (state and/or its own `_pushEvent`). The additive `_emitAuxEvent()` path skips
 * every one of these so nothing is emitted twice or altered.
 */
const HANDLED_TYPE4 = new Set([
  '0100', '0101',
  '1100', '1101', '1102', '1103', '1104', '1106', '1107', '1108', '1109', '110A',
]);

/**
 * Currently-ignored type-4 codes that get an explicit event `type`. Everything
 * else unhandled falls through to a generic `lf_event` (gated by
 * `emitUnknownEvents`). Codes / categories per docs/LASERFORCE.md + eventCatalog.
 */
const AUX_TYPE4 = {
  '1105': 'round_start',
  '110B': 'reset',
  '110C': 'reset',
  '0201': 'miss', '0202': 'miss',
  '0203': 'target_hit', '0204': 'target_destroy',
  '0205': 'player_hit', '0206': 'player_deactivate', '0209': 'warbot_deactivate',
  // ADDITIVE — codes measured in the hall's own mode 7 ("Standard LZ - 2 Teams"),
  // see docs/LASERFORCE.md. They used to surface as a generic `lf_event`; they
  // now get a type, exactly like 0400/0500 did before. No counter, no state:
  // `_emitAuxEvent` never mutates gameState.
  '0208': 'player_hit',            // friendly fire (48/48 same team)
  '0D05': 'player_hit',            // blast, target NOT deactivated — n=1, unverified
  '0D06': 'player_deactivate',     // blast, target deactivated (75/78)
  '0402': 'invulnerability', '0408': 'retaliation',
  '0700': 'generator_critical', '0701': 'irradiated',
  '0E00': 'promotion',
  '0300': 'missile_lock', '0301': 'missile_miss', '0303': 'missile_destroy',
  '0304': 'missile_miss', '0306': 'missile_hit', '0308': 'missile_hit',
  // SM5 codes that now also feed a live counter (C6) — they used to surface as
  // a generic `lf_event`; the code, category and label are unchanged.
  '0400': 'rapid_fire', '0404': 'nuke_activate', '0405': 'nuke_detonate',
  '0500': 'resupply', '0502': 'resupply',
  '0510': 'team_resupply', '0512': 'team_resupply',
  '0600': 'penalty',
  '0B00': 'beacon_claim', '0B03': 'base_award',
  '0900': 'achievement', '0901': 'achievement', '0902': 'reward',
};

/**
 * SM5 live counters per type-4 code (contract C6). Runs only while the mode
 * family is `sm5`; the 11xx Laserball path is completely untouched by it.
 *
 * `actor` / `target` list the counter names raised on the acting / receiving
 * player. `teamSplit` marks the two codes whose effect depends on whether actor
 * and target share a team (friendly fire).
 *
 * shotsFired: Laserforce logs no plain "shot" event, so it is only raised where
 * a hit/miss event proves a shot happened -> the live value is a LOWER BOUND.
 * The official type-7 end block (C4) corrects it at match end.
 */
const SM5_COUNTERS = {
  '0201': { actor: ['misses', 'shotsFired'] },
  '0202': { actor: ['misses', 'shotsFired'] },
  '0203': { actor: ['targetHits', 'shotsHit', 'shotsFired'] },
  '0204': { actor: ['targetDestroys', 'shotsHit', 'shotsFired'] },
  '0205': {
    teamSplit: true,
    actor: ['shotsHit', 'shotsFired'], target: ['timesHit'],
    actorTeam: ['shotTeam', 'shotsFired'], targetTeam: ['timesHitByTeam'],
  },
  '0206': {
    teamSplit: true,
    actor: ['shotsHit', 'shotsFired', 'deactivations'], target: ['timesHit', 'timesDeactivated'],
    actorTeam: ['shotTeam', 'shotsFired'], targetTeam: ['timesHitByTeam', 'timesDeactivated'],
  },
  '0209': { target: ['timesDeactivated'] },          // warbot — no actor credit
  '0300': { actor: ['missileLocks'] },
  '0301': { actor: ['missileMisses'] },
  '0304': { actor: ['missileMisses'] },
  '0303': { actor: ['missileDestroys'] },
  '0306': { actor: ['missileHits'], target: ['timesMissiled'] },
  '0308': { actor: ['missileTeam'], target: ['timesMissiled'] },
  '0400': { actor: ['rapidFires'] },
  '0404': { actor: ['nukesActivated'] },
  '0405': { actor: ['nukesDetonated'] },
  '0500': { actor: ['ammoResupplies'], target: ['ammoReceived'] },
  '0502': { actor: ['livesResupplies'], target: ['livesReceived'] },
  '0510': { actor: ['teamAmmoResupplies'] },
  '0512': { actor: ['teamLivesResupplies'] },
  '0600': { actor: ['penalties'] },
  '0B00': { actor: ['beaconClaims'] },
  '0B03': { actor: ['baseAwards'] },
  '0900': { actor: ['achievements'] },
  '0901': { actor: ['achievements'] },
  '0902': { actor: ['rewards'] },
};

// ─── Verdacht „Hinterherlaufen" (chasing) ────────────────────────────────────
//
// A SUSPICION, never a finding. Per player we keep the run of consecutive
// successful tags on the SAME opponent; once it reaches the threshold the pair
// is listed. Nothing is punished, nothing is written anywhere, the match is not
// affected in any way.
//
// WHAT COUNTS AS TAGGING A PERSON. Decided against four real recordings of
// mode 7 ("Standard LZ - 2 Teams", 480 s, 30-41 players, 9k-14k lines each);
// docs/GAMEMODES.md carries the same table with the counts.
//   `0206` Player Deactivate — 1085-1573 per match: THE normal tag in a
//                              standard game. Leaving it out would blind the
//                              detection almost completely.
//   `0205` Player Hit        — 30-46 per match, same line shape, same verb.
//                              Rare here, but it is the same act.
// Everything else is NOT part of the sequence: it neither counts nor breaks a
// run, because the run is defined over successful OPPONENT tags only.
//   `0208`          friendly fire    — 48 of 48 occurrences across all four
//                                      recordings were between players of the
//                                      SAME team, while `0205`/`0206` were
//                                      cross-team in 5333 of 5333.
//                                      Shooting your own side is not hunting an
//                                      opponent. The same-team guard in
//                                      `_noteTag()` is the second belt for it.
//   `0D06` "blastet"         — one actor, SEVERAL targets on the same
//                                      timestamp: an area effect (78 occurrences,
//                                      all cross-team, 75 of them deactivating).
//                                      Two of those on one timestamp are one
//                                      button press, not two chases.
//   `0201`/`0202`   misses           — the operator's rule says so explicitly.
//   `0203`/`0204`   target hit/kill  — a target is not a person.
//   `0209`          warbot           — has no actor at all.
//   `0300`-`0308`   missiles         — excluded. A missile needs a lock-on and
//                                      reaches across the arena, which is the
//                                      opposite of running after somebody. In
//                                      the recordings it is moot anyway:
//                                      `0300` appears once in 9237 lines and
//                                      `0306` not at all.
//   actor === target                 — never a chase; guarded separately.
//
// Laserball (`1103`/`1104`) is deliberately NOT supported: the operator wants
// the view for standard games only.
//
// Player ids in this mode are `#` plus eight alphanumeric characters
// (`#aA1bB2cC`), NOT numbers — nothing below parses, compares or sorts them
// numerically.
const CHASE_TAG_CODES = new Set(['0205', '0206']);

/** Tags in a row on the same person before the pair is listed. */
const CHASE_THRESHOLD_DEFAULT = 3;

/**
 * DISPLAY PROFILES the detection runs for — not mission numbers and not the
 * family. Since 19.09.2026 the arena's number for "Standard" is measured (`7`)
 * and entered in `modes/standard.json`, so a standard game runs under profile
 * `standard` and this list matches it out of the box. A mode whose number is
 * NOT in `modes/` still runs under profile `sm5` and stays silent — add `sm5`
 * to this list to cover those as well (docs/GAMEMODES.md).
 */
const CHASE_PROFILES_DEFAULT = ['standard'];

/**
 * Highest threshold the config may ask for. A threshold below 2 is nonsense
 * (every single tag would be a "run"), so 0 and 1 both mean: switched off.
 */
const CHASE_THRESHOLD_MAX = 50;

/**
 * Hard ceiling on the per-player bookkeeping. One entry per ACTOR, so a real
 * match never comes close; it exists so a hostile feed inventing actor ids
 * cannot grow the map. Each entry is three numbers — no hit history is kept.
 */
const CHASE_MAX_ENTRIES = 128;

/**
 * Positional fallback for the type-7 SM5 end block, used only when the stream
 * shipped no `;` schema line for type 7. Order per the lfstats TDF_Spec:
 * `7 <id> <23 fields>` — 24 fields plus the type column = 25 tabs. These names
 * describe columns 2..24 (column 0 = line type, column 1 = id).
 * A schema comment line always wins over this list — that is what tdfSchema is for.
 */
const TYPE7_FALLBACK = [
  'shotsHit', 'shotsFired', 'timesZapped', 'timesMissiled', 'missileHits',
  'nukesDetonated', 'nukesActivated', 'nukesCancelled', 'medicHits', 'ownMedicHits',
  'medicNukes', 'scoutRapid', 'lifeBoost', 'ammoBoost', 'livesLeft', 'shotsLeft',
  'penalties', 'shot3Hit', 'ownNukeCancels', 'shotOpponent', 'shotTeam',
  'missiledOpponent', 'missiledTeam',
];

/**
 * type-7 field -> live SM5 counter it overrides (contract C4). Ordered: a later
 * pair wins, so `missiledOpponent` is the authority for `missileHits`.
 */
const TYPE7_TO_STAT = [
  ['shotsHit', 'shotsHit'],
  ['shotsFired', 'shotsFired'],
  ['timesZapped', 'timesDeactivated'],
  ['timesMissiled', 'timesMissiled'],
  ['missileHits', 'missileHits'],
  ['nukesDetonated', 'nukesDetonated'],
  ['nukesActivated', 'nukesActivated'],
  ['penalties', 'penalties'],
  ['shotOpponent', 'deactivations'],
  ['shotTeam', 'shotTeam'],
  ['missiledOpponent', 'missileHits'],
  ['missiledTeam', 'missileTeam'],
];

/** Mission duration sanity window (contract C1). */
const DURATION_MIN_MS = 60000;
const DURATION_MAX_MS = 7200000;
/** Raw values below this are read as seconds, at or above it as milliseconds. */
const DURATION_SECONDS_LIMIT = 10000;

/** Strict integer from an untrusted stream token. null when it is not one. */
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v == null ? '' : v).trim();
  if (!/^[+-]?\d{1,15}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Mission duration -> milliseconds, or null when the value is not plausible.
 * Unit heuristic (contract C1): a raw value < 10000 is read as SECONDS and
 * multiplied by 1000, anything else is already milliseconds. The result must
 * fall into 60 000 - 7 200 000 ms (1 min - 2 h), otherwise it is discarded.
 */
function durationMs(raw) {
  const n = toInt(raw);
  if (n == null || n <= 0) return null;
  const ms = n < DURATION_SECONDS_LIMIT ? n * 1000 : n;
  if (ms < DURATION_MIN_MS || ms > DURATION_MAX_MS) return null;
  return ms;
}

/** Object keys that must never be written from stream data. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Exit code of a type-6 line, kept as the RAW token the arena sent (`01`, `02`,
 * `17`, …) — the leading zero is part of the observation and must not be lost
 * to a parseInt(). Foreign data: reduced to a short alphanumeric token so it can
 * never carry markup, a delimiter or unbounded length into a UI or a CSV cell.
 * @returns {string|null} null when the token is unusable
 */
function exitCodeToken(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 8 || !/^[A-Za-z0-9]+$/.test(s)) return null;
  return s;
}

/** Ids from the stream are object keys — never let one shadow a prototype slot. */
function safeKey(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s || UNSAFE_KEYS.has(s)) return null;
  return s;
}

/**
 * Longest display name kept from the stream. A Laserforce codename is a handful
 * of characters; the same ceiling the mission report already uses.
 */
const NAME_MAX = 64;
/**
 * A name (player or team) as it came off the TCP socket.
 *
 * Both are FOREIGN INPUT in the strict sense — a player picks his own codename,
 * and nothing about the feed is authenticated. Until now the token was stored
 * verbatim and unbounded, and from `gameState` it travels into the readable
 * event-log file, onto stdout and into the CSV statistics. A name carrying a
 * raw control character therefore ended up in a text file the operator opens
 * (a NUL turns it binary, an ESC sequence repaints his terminal), and an
 * unbounded one was repeated in every state push and kept in the grand total
 * for ever.
 *
 * Same rule everywhere in the project (gameModes.cleanDesc, matchReport.cleanText):
 * C0 and C1 controls collapse to a space, runs of whitespace collapse to one,
 * the result is trimmed and cut at NAME_MAX. Anything a real name contains —
 * umlauts, hyphens, digits, punctuation — passes through untouched.
 */
function cleanName(v) {
  // eslint-disable-next-line no-control-regex
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** camelCase key from a schema column name (`shots-hit` -> `shotsHit`). null when unusable. */
function camelKey(name) {
  const parts = String(name == null ? '' : name).trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return null;
  const head = parts[0].charAt(0).toLowerCase() + parts[0].slice(1);
  const key = head + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || UNSAFE_KEYS.has(key)) return null;
  return key;
}

/**
 * ADDITIVE ENRICHMENT MAPS (Task 1). Used only by `_pushEvent` -> `_enrich()` to
 * stamp descriptive metadata (`code`, `category`, `label`, `phrase`) onto every
 * emitted event *when those fields are absent*. They never overwrite a value the
 * parser already set and never influence which events fire or their payload —
 * see `_enrich()`.
 *
 * `TYPE_TO_CODE` maps the engine's own `type` strings to the hex TDF code the
 * doc/catalog assign. Most call sites (`pass`/`goal`/`steal`/`clear`/`block`/
 * `failed_clear`/`reset` via 1104, every `_emitAuxEvent` code, `score`=5,
 * `match_summary`=6) already stamp `code` themselves, so in practice this only
 * fills in `match_start`/`match_end` (and would cover the others if a future call
 * site forgets). Codes cross-checked against `EVENTS` in eventCatalog.js and
 * docs/LASERFORCE.md; `player_join`/`status` have no type-4 code -> omitted.
 * NB: `clear` is TDF `1109` (not `1104`) and `goal` is `1101` per the catalog.
 */
const TYPE_TO_CODE = {
  match_start: '0100',
  match_end: '0101',
  round_start: '1105',
  pass: '1100',
  goal: '1101',
  steal: '1103',
  block: '1104',
  clear: '1109',
  failed_clear: '110A',
  get_ball: '1107',
};

/** Fallback category when no `code` is known. Mirrors the doc's category words. */
const TYPE_TO_CATEGORY = {
  match_start: 'match', match_end: 'match', round_start: 'match', match_summary: 'match',
  mode_change: 'match',
  goal: 'score', score: 'score', base_award: 'score',
  pass: 'possession', steal: 'possession', clear: 'possession', get_ball: 'possession',
  reset: 'possession', failed_clear: 'possession',
  player_join: 'player', player_leave: 'player', resupply: 'player', status: 'player',
  team_resupply: 'player', penalty: 'player', sm5_stats: 'player',
  rapid_fire: 'special', nuke_activate: 'special', nuke_detonate: 'special',
  beacon_claim: 'special',
  invulnerability: 'special', retaliation: 'special', generator_critical: 'special',
  irradiated: 'combat', promotion: 'other',
  achievement: 'other', reward: 'other',
  block: 'combat',
  miss: 'combat', player_hit: 'combat', player_deactivate: 'combat',
  target_hit: 'combat', target_destroy: 'combat', warbot_deactivate: 'combat',
  missile_lock: 'combat', missile_miss: 'combat', missile_hit: 'combat', missile_destroy: 'combat',
};

/**
 * ── Matchende erkennen (docs/LASERFORCE.md, „Reihenfolge im echten Betrieb") ──
 *
 * Defaults in milliseconds. The console/.env values are given in SECONDS and
 * converted by `matchEndMs()` below; `0` switches a path off entirely.
 *
 * Why these numbers:
 *   watchdogMs 120 s   — the longest plausible silence INSIDE a running match.
 *                        A quiet Laserball possession or an SM5 stand-off
 *                        produces gaps of seconds, never of minutes, and the
 *                        watchdog counts ANY line (type 9 status, type 5 score,
 *                        schema comments), not just scoring events. Two minutes
 *                        is therefore far outside normal play while costing at
 *                        most two minutes of a stuck clock.
 *   endBlockMs  10 s   — `0101` follows the 6/7 end block in the same burst,
 *                        milliseconds later. Ten seconds is three orders of
 *                        magnitude of headroom for a slow or fragmented TCP
 *                        write and still ends the clock ~110 s earlier than the
 *                        watchdog would.
 *   streamLostMs 30 s  — a Laserforce export reconnects within seconds. Half a
 *                        minute survives a reconnect; longer than that and the
 *                        match is not coming back over this socket.
 */
const MATCH_END_DEFAULTS = { watchdogMs: 120000, streamLostMs: 30000, endBlockMs: 10000 };

/** How often the end detection looks at the clock while a match is running. */
const END_TICK_MS = 1000;

/**
 * Fewest type-6 reports that may ever count as a closing summary.
 *
 * The real test is COMPLETENESS (`_noteEntityEnd()`): every entity of the match
 * has reported. This is only the floor below which even completeness means
 * nothing — and it is `1`, not `2`, on purpose:
 *
 *   - For every match with two or more entities the completeness rule is
 *     already the STRICTER of the two, so a separate "at least two" adds
 *     nothing: one report out of two entities is not complete either way.
 *   - For a match with exactly ONE entity — rare, but possible (a solo run, a
 *     practice mission, a match everyone but one player dropped out of) the old
 *     minimum of two made the whole rule dead: the summary could never be
 *     recognised and the match always fell back to the 120 s watchdog.
 *   - And with one entity the two readings of a lone type-6 collapse: whether
 *     that entity was kicked or reported the mission end, nobody is left to
 *     play. Recognising it costs nothing and is not a false positive.
 *
 * The protection that actually carries the rule is not this number, it is
 * (a) completeness and (b) that recognising ARMS a deadline instead of ending
 * anything — any further type-4 or type-5 line disarms it again.
 */
const END_BLOCK_MIN_REPORTS = 1;

/** `endReason` values — the contract other consumers build on. */
const END_REASONS = ['mission_end', 'watchdog', 'stream_lost', 'next_match', 'shutdown'];

/**
 * `endSource` values — ADDITIVE diagnostic beside `endReason`: not *why* the
 * match counts as over but *through what* the end was recognised. The two
 * `watchdog` reasons are the reason this exists at all — a match that ran into
 * the recognised 6/7 summary and one that simply went silent are the same
 * `endReason` and two completely different observations.
 */
const END_SOURCES = [
  '0101',            // the arena sent the mission-end code itself
  'summary_type6',   // every entity of the match reported a type-6 line
  'summary_type7',   // an SM5 type-7 end block arrived
  'silence',         // no line at all any more — the plain watchdog
  'stream_lost', 'next_match', 'shutdown',
];

/** Fallback `endSource` per reason, used when a call site names none. */
const REASON_SOURCE = {
  mission_end: '0101', watchdog: 'silence', stream_lost: 'stream_lost',
  next_match: 'next_match', shutdown: 'shutdown',
};

const END_TEXT = {
  mission_end: 'Match ended',                                   // unchanged wording for `0101`
  watchdog: 'Match ended (keine Daten mehr von der Anlage)',
  stream_lost: 'Match ended (Verbindung zur Anlage abgebrochen)',
  next_match: 'Match ended (das nächste Match hat begonnen)',
  shutdown: 'Match ended (Dienst wurde beendet)',
};

/** Seconds from config/.env -> the milliseconds the engine works with. */
function matchEndMs(cfg) {
  const s = cfg && typeof cfg === 'object' ? cfg : {};
  const ms = (v, d) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return d;
    return Math.round(n * 1000);
  };
  return {
    watchdogMs: ms(s.watchdogSeconds, MATCH_END_DEFAULTS.watchdogMs),
    streamLostMs: ms(s.streamLostSeconds, MATCH_END_DEFAULTS.streamLostMs),
    endBlockMs: ms(s.endBlockSeconds, MATCH_END_DEFAULTS.endBlockMs),
  };
}

/** Title-case an engine `type` string for a last-resort `label`. */
function titleCaseType(s) {
  if (typeof s !== 'string' || !s) return null;
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Match engine.
 *
 * The Laserforce log-line parsing below (processLogLine) is a faithful port of
 * the original server.js `processLogLine`. The interpretation of every column,
 * every event code and every heuristic is intentionally UNCHANGED. The only
 * differences are plumbing:
 *   - `broadcastState()`            -> this._touch()   (orchestrator decides when to flush)
 *   - `pushLog('<div>...</div>')`   -> this._pushEvent({structured, no HTML})
 *   - `handleReplayTrigger(teamId)` -> this.emit('goal', {...}) (OBS module handles it)
 *   - roster map                    -> injected via setRoster()
 *
 * No user-controlled string is ever turned into markup here; consumers get
 * structured fields and a plain-text `text` convenience string.
 */
class Engine extends EventEmitter {
  constructor({ logger, defaultDurationMs = 720000, emitUnknownEvents = true, matchEnd = null, chase = null } = {}) {
    super();
    this.log = logger;
    this.defaultDurationMs = defaultDurationMs;
    /** Thresholds in ms; see MATCH_END_DEFAULTS. 0 switches that path off. */
    this.matchEnd = { ...MATCH_END_DEFAULTS };
    this.setMatchEndConfig(matchEnd);
    /** „Hinterherlaufen": threshold + the display profiles it runs for. */
    this.chase = {
      threshold: CHASE_THRESHOLD_DEFAULT,
      profiles: new Set(CHASE_PROFILES_DEFAULT),
    };
    // Additive only: when true, every type-4 code the core parser does not act on
    // still surfaces as a generic `lf_event`. Never changes an existing branch.
    this.emitUnknownEvents = emitUnknownEvents !== false;
    this.dbPlayersMap = {};
    /** Column names learned from the `;` schema-comment lines of the stream. */
    this.tdfSchema = new TdfSchema();
    this.reset();
    // After reset(), because it publishes the values into gameState.
    this.setChaseConfig(chase);
  }

  reset() {
    this.gameState = {
      missionActive: false,
      matchId: null,   // synthetic id, set on mission start — metadata only, not from the stream
      teams: {},
      players: {},
      scores: {},
      ballHolderId: null,
      duration: this.defaultDurationMs,
      elapsedTime: 0,
      events: [], // structured, bounded ring (replaces the old HTML `logs`)
      updatedAt: Date.now(),
      // ---- additive (contract C7) --------------------------------------
      // No type-1 line seen yet: unknown mode, default family `sm5`, default
      // display profile `sm5`.
      mode: resolveModeWithProfile(null, null),
      missionDesc: null,
      durationKnown: false,   // false -> the UI counts UP instead of down
      remainingMs: null,      // derived: durationKnown ? duration - elapsed : null
      scoreSource: 'internal', // 'internal' (own count) | 'tdf' (type-5 lines)
      // ---- additive: how and when the match ended ----------------------
      // null while a match is running and before the first match ever ran.
      endReason: null,        // 'mission_end'|'watchdog'|'stream_lost'|'next_match'|'shutdown'
      endedAt: null,          // ms timestamp of the moment the match was ended
      endSource: null,        // one of END_SOURCES — through WHAT the end was recognised
      // ---- additive: the type-6 exit codes this match actually produced ----
      // Pure diagnostics. They no longer decide anything (see `_noteEntityEnd`),
      // but they are the value the recordings will have to be evaluated against.
      exitCodes: {},          // entityId -> raw exit token ('01', '02', '17', …)
      exitCodesSeen: [],      // the distinct codes of this match, sorted
      // ---- additive: Verdacht „Hinterherlaufen" ------------------------
      // A SUSPICION list, never a finding — see CHASE_TAG_CODES above.
      chasing: [],            // [{playerId,playerName,teamId,targetId,targetName,targetTeamId,streak,lastAt}]
      chaseThreshold: this.chase ? this.chase.threshold : CHASE_THRESHOLD_DEFAULT,
      chaseProfiles: this.chase ? [...this.chase.profiles] : CHASE_PROFILES_DEFAULT.slice(),
      chaseWatched: false,    // does the CURRENT display profile get watched at all?
    };
    this._resetEndDetection();
    this._resetChase();
    this.livePassesStream = [];
    this.playerStatusMap = {};
    this._eventSeq = 0;
    this._teamNamesDirty = false;
    this._teamNamesScheduled = false;
    this._familyInferred = false;
    if (this.tdfSchema) this.tdfSchema.reset();
  }

  setRoster(map) {
    this.dbPlayersMap = map || {};
  }

  // ─── Matchende erkennen ───────────────────────────────────────────────────
  //
  // The arena is NOT trusted to announce the end of a mission. `0101` is one of
  // four ways a match can end here; the other three are inferred. Everything in
  // this block is additive: it only ever flips a RUNNING match to ended, never
  // the other way round, and a wrongly ended match is the one outcome that must
  // not happen — hence the deliberately generous thresholds.

  /** Apply new thresholds (ms). Unknown/negative values keep the current one. */
  setMatchEndConfig(cfg) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    for (const k of ['watchdogMs', 'streamLostMs', 'endBlockMs']) {
      const n = Number(c[k]);
      if (Number.isFinite(n) && n >= 0) this.matchEnd[k] = Math.round(n);
    }
    return this.matchEnd;
  }

  /** Per-match bookkeeping of the end detection. Never touches gameState. */
  _resetEndDetection() {
    this._stopEndWatch();
    this._endTimer = null;
    this._lastLineAt = Date.now();
    this._streamLostAt = null;   // socket gone since this moment (match still running)
    this._endBlockAt = null;     // end summary seen at this moment, waiting for `0101`
    this._endBlockSource = null; // WHAT armed it: 'summary_type6' | 'summary_type7'
    // Every entity that has reported a type-6 line in this match — whatever its
    // exit code was. Mid-game drop-outs and the closing batch land in the SAME
    // set on purpose; see `_noteEntityEnd()`.
    this._entityEnds = new Set();
  }

  /** Start the ticker that turns the thresholds into real endings. */
  _startEndWatch() {
    if (this._endTimer) return;
    const m = this.matchEnd;
    const active = [m.watchdogMs, m.streamLostMs, m.endBlockMs].filter((v) => v > 0);
    if (!active.length) return;
    // Fast enough for a short test threshold, never faster than 100 ms.
    const tick = Math.max(100, Math.min(END_TICK_MS, Math.floor(Math.min(...active) / 3)));
    this._endTimer = setInterval(() => {
      try { this.checkMatchEnd(); } catch (_err) { /* the clock must never crash the service */ }
    }, tick);
    this._endTimer.unref?.();
  }

  _stopEndWatch() {
    if (this._endTimer) { clearInterval(this._endTimer); this._endTimer = null; }
  }

  /**
   * Any byte from the arena counts as "the match is alive" — a status line, a
   * score line, even a `;` schema comment. Called first thing in
   * processLogLine(), so a line that later fails to parse still feeds it.
   */
  noteActivity(now = Date.now()) {
    this._lastLineAt = now;
    this._streamLostAt = null;   // data is arriving, so the stream is clearly there
  }

  /** The TCP connection to the arena went away. */
  noteStreamLost(now = Date.now()) {
    if (!this.gameState.missionActive) return;
    if (this._streamLostAt == null) this._streamLostAt = now;
    this._startEndWatch();
  }

  /** The arena connected again — a reconnect must not end the match. */
  noteStreamResumed() {
    this._streamLostAt = null;
  }

  /**
   * The 6/7 end summary looks like it has been sent. Only ARMS a deadline:
   * if `0101` still follows, it wins and the reason stays `mission_end`.
   */
  _armEndBlock(source = 'summary_type6', now = Date.now()) {
    if (!this.gameState.missionActive) return;
    if (!(this.matchEnd.endBlockMs > 0)) return;
    this._endBlockAt = now;      // refreshed by every further end-block line
    this._endBlockSource = END_SOURCES.includes(source) ? source : 'summary_type6';
    this._startEndWatch();
  }

  /** Proof that the match is still being played — disarm the end block again. */
  _liveSignal() {
    if (this._endBlockAt != null) this._endBlockAt = null;
    this._endBlockSource = null;
  }

  /**
   * Remember the exit code of a type-6 line. Diagnostics only — nothing in the
   * end detection reads it back. Bounded by the player count, so a hostile feed
   * cannot grow the map: an unknown entity never gets this far.
   */
  _noteExitCode(entityId, exitCode) {
    try {
      const gs = this.gameState;
      const key = safeKey(entityId);
      const code = exitCodeToken(exitCode);
      if (!key || !code) return;
      if (gs.exitCodes[key] === code) return;
      gs.exitCodes[key] = code;
      if (!gs.exitCodesSeen.includes(code)) {
        gs.exitCodesSeen.push(code);
        gs.exitCodesSeen.sort();
      }
    } catch (_err) {
      /* a diagnostic value must never disturb the parser */
    }
  }

  /**
   * One type-6 line. **A single one must never end the match**: mid-game it
   * means exactly one entity is out. The closing summary is told apart from a
   * mid-game drop-out by COMPLETENESS, and by nothing else:
   *
   *   a type-6 block counts as the end-of-match summary exactly when EVERY
   *   entity of this match has reported a type-6 line — whatever exit code
   *   it carried.
   *
   * Why not the exit code any more. The rule used to demand exit `02` ("Ende"
   * per the community spec). Observed at a real arena on 17.09.2026: a regular
   * standard mission closes with exit **`01`** there. With `02` hard-wired the
   * summary was never recognised on that arena and every match fell through to
   * the 120 s watchdog. The exit code is a value we RECORD (`_noteExitCode`),
   * not one we may gate on, until the recordings say what it means.
   *
   * Why completeness is the load-bearing test — and is no weaker than before.
   * An entity reports exactly once. One that drops out mid-game reports THEN;
   * the rest report at the end. So counting every reporter in one set and
   * asking for `reports >= entities` is arithmetically the very same rule the
   * old code expressed as `endExits >= entities - earlyExits` (the two sets
   * were disjoint) — only without the exit-code filter in front of it. A lone
   * mid-game kick is still one report out of N and still ends nothing.
   *
   * And recognising ENDS NOTHING: it arms `matchEnd.endBlockSeconds`. A `0101`
   * inside that window wins (reason stays `mission_end`), and any type-4 or
   * type-5 line disarms it again — the match was evidently still being played.
   */
  _noteEntityEnd(entityId, exitCode) {
    const gs = this.gameState;
    if (!gs.missionActive || !entityId || !gs.players[entityId]) return;
    this._noteExitCode(entityId, exitCode);
    this._entityEnds.add(entityId);

    const known = Object.keys(gs.players).length;
    if (this._entityEnds.size < END_BLOCK_MIN_REPORTS) return;
    if (this._entityEnds.size < known) return;
    this._armEndBlock('summary_type6');
  }

  /**
   * End a running match from the outside (shutdown, tests, a future console
   * button). Returns false when no match was running.
   */
  endMatch(reason) {
    if (!this.gameState.missionActive) return false;
    this._endMatch(END_REASONS.includes(reason) ? reason : 'shutdown');
    return true;
  }

  /**
   * How a match that is ending right now was recognised as over. Explicit
   * `source` wins; for `watchdog` an armed end block is the honest answer
   * ("the 6/7 summary ran out"), otherwise the reason's own default.
   */
  _endSourceFor(reason, source) {
    if (END_SOURCES.includes(source)) return source;
    return REASON_SOURCE[reason] || null;
  }

  /**
   * The single place a match stops. `0101` and all three inferred endings pass
   * through here, so the state, the event and the `match_end` emit can never
   * disagree.
   */
  _endMatch(reason, source) {
    const gs = this.gameState;
    const endSource = this._endSourceFor(reason, source);
    gs.missionActive = false;
    gs.ballHolderId = null;
    gs.endReason = reason;
    gs.endSource = endSource;
    gs.endedAt = Date.now();
    this.livePassesStream = [];
    this._stopEndWatch();
    this._streamLostAt = null;
    this._endBlockAt = null;
    this._endBlockSource = null;
    if (reason !== 'mission_end') {
      this.log?.warn('engine', `MISSION ENDE erkannt (${reason}/${endSource}) — kein 0101 von der Anlage`);
    }
    // `code` is the code the ARENA sent. Only a real `0101` may carry it — an
    // inferred end must never leave a `0101` in the event log that never came
    // over the wire, so it goes out with an empty code instead.
    // ADDITIVE: `endSource` and `exitCodes` say through WHAT the end was
    // recognised and which type-6 exit codes this match actually produced —
    // the two things a recording will have to be checked against.
    this._pushEvent({
      type: 'match_end',
      code: reason === 'mission_end' ? '0101' : '',
      reason,
      endSource,
      exitCodes: { ...gs.exitCodes },
      exitCodesSeen: gs.exitCodesSeen.slice(),
      text: END_TEXT[reason] || END_TEXT.mission_end,
    });
    this.emit('match_end', { reason, endSource, scores: { ...gs.scores } });
    this._touch();
  }

  /**
   * Decide whether the running match is over. Called by the ticker once a
   * second; tests call it directly with an explicit `now`, which keeps them
   * deterministic and instant.
   */
  checkMatchEnd(now = Date.now()) {
    const gs = this.gameState;
    if (!gs.missionActive) { this._stopEndWatch(); return null; }
    const m = this.matchEnd;

    // The end summary is the strongest signal we have, so it may end the match
    // long before the watchdog would — but only after the grace period in which
    // a `0101` would still have won.
    if (this._endBlockAt != null && m.endBlockMs > 0 && now - this._endBlockAt >= m.endBlockMs) {
      this._endMatch('watchdog', this._endBlockSource || 'summary_type6');
      return 'watchdog';
    }
    if (this._streamLostAt != null && m.streamLostMs > 0 && now - this._streamLostAt >= m.streamLostMs) {
      this._endMatch('stream_lost', 'stream_lost');
      return 'stream_lost';
    }
    if (m.watchdogMs > 0 && now - this._lastLineAt >= m.watchdogMs) {
      this._endMatch('watchdog', 'silence');
      return 'watchdog';
    }
    return null;
  }

  /** Snapshot for API consumers. */
  snapshot() {
    // resolveTeamNames() is debounced off the per-login hot path; make sure any
    // pending resolution is applied before an external observer reads the state.
    if (this._teamNamesDirty) this._flushTeamNames();
    this._syncDerived();
    return this.gameState;
  }

  /**
   * ADDITIVE. Keep derived snapshot fields in sync (contract C2). Nobody outside
   * the engine computes `duration - elapsedTime` any more: when the mission
   * length is unknown the clock counts up and `remainingMs` is null.
   */
  _syncDerived() {
    try {
      const gs = this.gameState;
      gs.remainingMs = gs.durationKnown
        ? Math.max(0, (gs.duration || 0) - (gs.elapsedTime || 0))
        : null;
    } catch (_err) {
      /* derived fields are best effort */
    }
    this._syncAccuracy();
    this._syncChase();
  }

  /**
   * ADDITIVE. Hit rate per player: `shotsHit / shotsFired`.
   *
   * HONESTY, and this matters: the LIVE value is systematically **too HIGH**.
   * `shotsFired` only rises on an event that proves a shot happened
   * (`0201 0202 0203 0204 0205 0206`). Every shot that HITS produces such an
   * event, so it lands in numerator and denominator alike — but a shot that the
   * arena never reports at all is missing from the denominator only. The
   * denominator is therefore short while the numerator is complete, and the
   * quotient comes out too optimistic.
   *
   * So the live value is published as an ESTIMATE: `accuracyIsEstimate: true`
   * plus `accuracySource: 'live'`, and a UI can mark it. Once the official
   * type-7 end block has replaced `shotsHit`/`shotsFired` with the arena's own
   * numbers, `statsSource` flips to `tdf7`, the estimate flag drops and the
   * rate is recomputed from the official figures.
   *
   * `shotsFired === 0` yields `null`, not `0`: no shots means no measurable
   * rate, and a 0 there would read as "never hit anything".
   *
   * Runs only on players that carry SM5 counters — the Laserball path has no
   * shot counter at all and is left completely untouched.
   */
  _syncAccuracy() {
    try {
      const players = this.gameState.players;
      for (const id of Object.keys(players)) {
        const p = players[id];
        if (!p || typeof p.shotsFired !== 'number') continue;
        const fired = p.shotsFired;
        const hit = typeof p.shotsHit === 'number' ? p.shotsHit : 0;
        p.accuracy = fired > 0 ? Math.round((hit / fired) * 10000) / 10000 : null;
        const official = p.statsSource === 'tdf7';
        p.accuracyIsEstimate = !official;
        p.accuracySource = official ? 'tdf7' : 'live';
      }
    } catch (_err) {
      /* derived fields are best effort */
    }
  }

  // ─── Verdacht „Hinterherlaufen" ───────────────────────────────────────────
  //
  // Memory: ONE entry per acting player, holding the last target, a counter and
  // a timestamp. No hit history is kept — that is the whole point, the base
  // load of this service was measured and must not move.
  //
  // Cost: the hot path is `_noteTag()`, which for a non-tag code is a single
  // Set lookup and returns. For a tag it is two map lookups and three integer
  // writes. It can never throw, and it never touches anything the parser owns.

  /**
   * Per-match bookkeeping. Never touches gameState.
   *
   * One fixed-size entry per acting player — no hit history, whatever happens:
   *   targetId/streak/lastAt      the run going on RIGHT NOW
   *   best/bestTargetId/flaggedAt the LONGEST run of this match, its target and
   *                               when a listed run last advanced
   *   runs                        how often a run reached the threshold
   *
   * Why `best` exists at all, and it is not a nicety: a run ends the moment the
   * player tags somebody else, so a purely momentary list is almost always
   * empty. Measured against the four real recordings, 32-63 % of all players
   * reached the threshold at some point in a match, while at any single instant
   * at most five were on a run — and at the final whistle usually none. A list
   * that only knew the current run would show the operator almost nothing and
   * would write an almost empty day log. So the published list is CUMULATIVE
   * for the match: once a player is in it, he stays in it until the next
   * mission start, and `open` says whether the run is still going.
   */
  _resetChase() {
    this._chase = new Map();
    this._chaseDirty = true;   // the published list has to be rebuilt
  }

  /**
   * Apply threshold and watched profiles. `null`/unknown values keep the
   * current ones, so a partial patch cannot silently switch the feature off.
   * @returns {{threshold:number,profiles:string[]}} what is in force now
   */
  setChaseConfig(cfg) {
    try {
      const c = cfg && typeof cfg === 'object' ? cfg : {};
      const n = Number(c.threshold);
      if (Number.isFinite(n) && n >= 0) {
        this.chase.threshold = Math.min(CHASE_THRESHOLD_MAX, Math.round(n));
      }
      if (Array.isArray(c.profiles)) {
        const list = c.profiles
          .map((p) => String(p == null ? '' : p).trim().toLowerCase())
          .filter(Boolean).slice(0, 16);
        this.chase.profiles = new Set(list);
      }
      const gs = this.gameState;
      if (gs) {
        gs.chaseThreshold = this.chase.threshold;
        gs.chaseProfiles = [...this.chase.profiles];
        this._chaseDirty = true;
        this._syncChase();
      }
    } catch (_err) {
      /* configuration must never break a running match */
    }
    return { threshold: this.chase.threshold, profiles: [...this.chase.profiles] };
  }

  /**
   * Does the detection run for the mode on screen right now? Gated on the
   * DISPLAY PROFILE, never on the mission number and never on the family — the
   * arena's number for "Standard" is still unknown, and the profile is the one
   * knob that will point at the right games once it is entered.
   */
  _chaseWatched() {
    if (!(this.chase.threshold >= 2)) return false;
    const mode = this.gameState.mode;
    if (!mode) return false;
    // Laserball is not supported and must stay unsupported even if somebody
    // puts `laserball` into the profile list: the 11xx code set is a different
    // game (a block is not a chase, and taking the ball off the carrier says
    // more about who carries the ball than about who follows whom).
    if (mode.family === FAMILIES.LASERBALL) return false;
    const prof = typeof mode.profile === 'string' ? mode.profile : '';
    return !!prof && this.chase.profiles.has(prof);
  }

  /**
   * One type-4 event, already parsed. Raises or breaks the run of the acting
   * player. Returns true when the PUBLISHED list may have changed, so the
   * caller can push a state update — a run below the threshold changes nothing
   * anybody can see and costs no push.
   */
  _noteTag(code, actorId, targetId) {
    try {
      if (!CHASE_TAG_CODES.has(code)) return false;
      const gs = this.gameState;
      if (!gs.missionActive) return false;
      if (!this._chaseWatched()) return false;
      if (!actorId || !targetId || actorId === targetId) return false;
      const players = gs.players;
      const a = Object.prototype.hasOwnProperty.call(players, actorId) ? players[actorId] : null;
      const t = Object.prototype.hasOwnProperty.call(players, targetId) ? players[targetId] : null;
      if (!a || !t) return false;
      // Friendly fire is not hunting an opponent — it is not part of the run.
      if (String(a.teamId) === String(t.teamId)) return false;

      let e = this._chase.get(actorId);
      if (!e) {
        if (this._chase.size >= CHASE_MAX_ENTRIES) return false;
        e = { targetId: null, streak: 0, lastAt: 0, best: 0, bestTargetId: null, flaggedAt: 0, runs: 0 };
        this._chase.set(actorId, e);
      }
      const th = this.chase.threshold;
      const wasOpen = e.streak >= th;
      if (e.targetId === targetId) e.streak += 1;
      else { e.targetId = targetId; e.streak = 1; }   // somebody else -> start over
      e.lastAt = Date.now();
      const isOpen = e.streak >= th;
      if (!isOpen) {
        // The run just broke. The player STAYS in the list (it is cumulative),
        // only his `open` flag changes — and that has to be republished.
        if (!wasOpen) return false;
        this._chaseDirty = true;
        return true;
      }
      // A run that has just reached the threshold is a new listed run.
      if (e.streak === th) e.runs += 1;
      e.flaggedAt = e.lastAt;
      if (e.streak > e.best) { e.best = e.streak; e.bestTargetId = e.targetId; }
      this._chaseDirty = true;
      return true;
    } catch (_err) {
      return false;   // a suspicion must never disturb the parser
    }
  }

  /**
   * Build the published list from the counters. Only called when dirty.
   *
   * CUMULATIVE for the match: every player who reached the threshold at least
   * once is in it. `streak` is his LONGEST run and `targetId` the target of
   * that run; `runs` says how often a run reached the threshold at all, and
   * `open` whether one is going on at this very moment.
   */
  _chaseList() {
    const out = [];
    const th = this.chase.threshold;
    if (!(th >= 2)) return out;
    const players = this.gameState.players;
    for (const [pid, e] of this._chase) {
      if (!e || e.best < th || !e.bestTargetId) continue;
      const p = players[pid];
      const t = players[e.bestTargetId];
      if (!p || !t) continue;   // logged out / match restarted
      out.push({
        playerId: pid,
        playerName: p.name,
        teamId: p.teamId == null ? null : String(p.teamId),
        targetId: e.bestTargetId,
        targetName: t.name,
        targetTeamId: t.teamId == null ? null : String(t.teamId),
        /** the LONGEST run of this match on that target */
        streak: e.best,
        /** how often a run of this player reached the threshold */
        runs: e.runs,
        /** when a listed run of his last advanced */
        lastAt: e.flaggedAt,
        /** true while a run is still going right now */
        open: e.streak >= th,
      });
    }
    // Longest run first, then the most recent one — the order the operator
    // would look at them in.
    out.sort((x, y) => (y.streak - x.streak)
      || (y.lastAt - x.lastAt)
      || String(x.playerName).localeCompare(String(y.playerName)));
    return out;
  }

  /** Keep `chasing` / `chaseWatched` in the snapshot in sync. Best effort. */
  _syncChase() {
    try {
      const gs = this.gameState;
      const watched = this._chaseWatched();
      if (gs.chaseWatched !== watched) {
        gs.chaseWatched = watched;
        // Not watching this mode any more: drop the counters as well, so a mode
        // change cannot leave a stale suspicion standing.
        if (!watched) this._chase.clear();
        this._chaseDirty = true;
      }
      if (!this._chaseDirty) return;
      this._chaseDirty = false;
      gs.chasing = this._chaseList();
    } catch (_err) {
      /* derived fields are best effort */
    }
  }

  /** Run a pending debounced team-name resolution now. */
  _flushTeamNames() {
    this._teamNamesDirty = false;
    this.resolveTeamNames();
  }

  /** Mark team names for (coalesced) re-resolution after a burst of logins. */
  _scheduleTeamNames() {
    this._teamNamesDirty = true;
    if (this._teamNamesScheduled) return;
    this._teamNamesScheduled = true;
    setImmediate(() => {
      this._teamNamesScheduled = false;
      if (this._teamNamesDirty) this._flushTeamNames();
    });
  }

  _touch() {
    this._syncDerived();
    this.gameState.updatedAt = Date.now();
    this.emit('change', this.gameState);
  }

  _pushEvent(evt) {
    const full = {
      id: ++this._eventSeq,
      ts: Date.now(),
      elapsedMs: this.gameState.elapsedTime,
      matchId: this.gameState.matchId,
      ...evt,
    };
    this._enrich(full);
    this.gameState.events.push(full);
    if (this.gameState.events.length > 50) this.gameState.events.shift();
    this.emit('event', full);
    return full;
  }

  /**
   * ADDITIVE. Single choke-point normalization: stamp `code`, `category`,
   * `label` and `phrase` onto an event when they are absent. Never overwrites an
   * existing field, never mutates gameState, never throws — on any failure the
   * event is emitted exactly as the parser built it. This is the "richer events"
   * the user asked for; the parsing logic (which events fire, their order, their
   * existing values) is untouched.
   */
  _enrich(evt) {
    try {
      if (evt.code == null && evt.type && TYPE_TO_CODE[evt.type]) {
        evt.code = TYPE_TO_CODE[evt.type];
      }
      const info = evt.code != null ? describe(evt.code) : null;
      const known = (i) => i && i.status !== 'unknown';

      if (evt.category == null) {
        evt.category = (known(info) && info.category)
          || TYPE_TO_CATEGORY[evt.type]
          || (info && info.category)
          || 'other';
      }
      if (evt.label == null) {
        const lab = (known(info) && info.label) || titleCaseType(evt.type);
        if (lab) evt.label = lab;
      }
      if (evt.phrase == null) {
        // readable() = phrase(), but a generic catalog label never shadows a
        // good evt.text — so downstream can safely use `evt.phrase || evt.text`.
        const r = readable(evt);
        if (r) evt.phrase = r;
      }
    } catch (_err) {
      // enrichment is best effort; leave the event as the parser built it
    }
  }

  /**
   * ADDITIVE. Emit an event for a type-4 code the core parser does not act on.
   * Never mutates gameState, never calls _touch(), never runs for a code in
   * HANDLED_TYPE4 — so it cannot affect any existing case. Must never throw.
   */
  _emitAuxEvent(code, actorId, targetId, tail, tailExact) {
    try {
      if (!code || HANDLED_TYPE4.has(code)) return;
      const mapped = AUX_TYPE4[code];
      if (!mapped && !this.emitUnknownEvents) return;
      const info = describe(code);
      const a = actorId && this.gameState.players[actorId] ? this.gameState.players[actorId] : null;
      const t = targetId && this.gameState.players[targetId] ? this.gameState.players[targetId] : null;
      const evt = { type: mapped || 'lf_event', code, category: info.category, label: info.label };
      if (actorId) evt.actorId = actorId;
      if (a) { evt.actorName = a.name; evt.actorTeamId = a.teamId; }
      if (targetId) evt.targetId = targetId;
      if (t) { evt.targetName = t.name; evt.targetTeamId = t.teamId; }
      // ── ADDITIVE. The arena ships the MEANING of its own codes as German
      //    plain text in the same line ("… blastet …", "… aktiviert Vergeltung").
      //    Every hall may define its own game modes, so the catalog can never be
      //    complete — this turns an unlabelled code into a readable sentence
      //    without guessing anything, because the words are the arena's own.
      //    `phrase()` uses it ONLY where no catalog case knows the code, so it
      //    can never override a documented wording.
      if (Array.isArray(tail) && tail.length) {
        const st = streamPhrase(tail, (id) => {
          const p = this.gameState.players[safeKey(id)];
          return p ? p.name : null;
        });
        if (st) evt.streamText = st;
        // 0E00 carries the new rank as its own field between the two text parts.
        if (code === '0E00' && tailExact) {
          const rank = tail.find((v, i) => i > 0 && typeof v === 'string'
            && v.trim() && v.trim()[0] !== '#' && v.trim()[0] !== '@'
            && !/\s/.test(v));
          if (rank) evt.rank = rank.trim().slice(0, 40);
        }
      }
      evt.text = phrase(evt);
      this._pushEvent(evt);
    } catch (_err) {
      // aux surfacing must never disrupt the parser
    }
  }

  // =====================================================================
  // ADDITIVE: game-mode awareness (contract C1/C3/C4/C6). Everything below
  // is new ground: it never touches the 11xx Laserball branch, never removes
  // a field, and every method swallows its own errors so a hostile or broken
  // feed can never stop the parser.
  // =====================================================================

  /**
   * Re-align a WHITESPACE-split row with its schema.
   *
   * A TDF row is tab-delimited, but `processLogLine` splits on `/\s+/`, so the
   * one field per row that may contain spaces (the mission `desc`, the player
   * `desc` = name) tears into several tokens and shifts every column behind it.
   * When the schema is known, the shift is exactly `cols.length - names.length`
   * and can be folded back into that field — after which the row lines up with
   * the schema again and a tab-fed and a space-fed stream produce identical
   * results.
   *
   * @returns {string[]|null} an aligned row, or null when it cannot be derived
   */
  _alignRow(lineType, cols, tabCols, varCol = 'desc') {
    try {
      if (Array.isArray(tabCols) && tabCols.length > 1) return tabCols;
      if (!Array.isArray(cols)) return null;
      const names = this.tdfSchema.names(lineType);
      const idx = this.tdfSchema.indexOf(lineType, varCol);
      if (names.length < 2 || idx < 1) return null;
      const extra = cols.length - names.length;
      if (extra < 0 || extra > 64) return null;
      if (idx + extra >= cols.length) return null;
      const out = cols.slice(0, idx);
      out.push(cols.slice(idx, idx + extra + 1).join(' '));
      for (let i = idx + extra + 1; i < cols.length; i++) out.push(cols[i]);
      return out.length === names.length ? out : null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * Store a mode descriptor and emit `mode_change` when it actually changed.
   * @param {{number:number|null,key:string,label:string,family:string,known:boolean,source:string}} next
   */
  _applyMode(rawNext) {
    try {
      if (!rawNext || typeof rawNext !== 'object') return;
      // Single choke-point: every mode that reaches gameState carries `profile`.
      const next = withProfile(rawNext);
      const prev = this.gameState.mode || null;
      const same = prev
        && prev.number === next.number && prev.key === next.key
        && prev.label === next.label && prev.family === next.family
        && prev.profile === next.profile
        && prev.known === next.known && prev.source === next.source;
      this.gameState.mode = next;
      if (same) return;
      this._pushEvent({
        type: 'mode_change', category: 'match', label: 'Modus erkannt',
        mode: { ...next }, previousMode: prev ? { ...prev } : null,
        text: `Modus: ${next.label}${next.known ? '' : ' (unbekannt)'}`,
      });
      this.emit('mode_change', { ...next });
      this._touch();
    } catch (_err) {
      /* mode bookkeeping must never disrupt the parser */
    }
  }

  /**
   * Runtime family correction (contract B). A stream whose type-1 line is
   * missing or wrong still gets the right counters: 11xx codes force family
   * `laserball`, 02xx-06xx force `sm5` — the latter never for mission number 28,
   * which is Laserball by definition. Fires at most once per match and always
   * through `_applyMode`, so it produces a `mode_change` event.
   */
  _inferFamily(code) {
    try {
      if (this._familyInferred) return;
      const cur = this.gameState.mode;
      if (!cur) return;
      const fam = familyOf(code);
      if (fam === 'all' || fam === cur.family) return;
      if (fam === FAMILIES.SM5 && cur.number === 28) return; // never demote a declared Laserball match
      this._familyInferred = true;
      // The display profile follows the corrected family: a profile pinned in
      // the registry belongs to the family that just turned out to be wrong.
      this._applyMode({
        ...cur, family: fam, profile: FAMILY_DEFAULT_PROFILE[fam], source: 'inferred',
      });
    } catch (_err) {
      /* inference is best effort */
    }
  }

  /**
   * Type-1 (mission): `1  type  desc…  start  [duration]  [penalty]`
   * (`duration` from TDF v2.001, `penalty` from v2.003).
   *
   * Mode number and description come from the schema when the stream provided
   * one, otherwise from the known positions. The duration is read by NAME first;
   * the old `cols[cols.length - 2]` guess is gone — it silently reads `start`
   * once `penalty` is missing and would break again as soon as a future TDF
   * version appends another column (exactly what `#rgb` did to type 2).
   */
  _handleMissionLine(cols, tabCols) {
    try {
      const gs = this.gameState;
      const aligned = this._alignRow('1', cols, tabCols);
      const rawType = this.tdfSchema.get('1', 'type', cols, 1, aligned);
      const desc = this._missionDesc(cols, aligned);
      gs.missionDesc = desc || null;
      this._familyInferred = false;
      this._applyMode(resolveModeWithProfile(rawType, desc));

      // duration: schema first, positional heuristic only as a fallback
      let ms = durationMs(this.tdfSchema.get('1', 'duration', cols, undefined, aligned));
      if (ms == null) ms = this._durationFallback(cols, aligned);
      if (ms != null) {
        gs.duration = ms;
        gs.durationKnown = true;
      } else {
        gs.duration = this.defaultDurationMs;
        gs.durationKnown = false;
      }
      this._touch();
    } catch (_err) {
      /* a broken type-1 line must not stop the stream */
    }
  }

  /** Mission description: schema column `desc`, else the tokens before the trailing numbers. */
  _missionDesc(cols, tabCols) {
    try {
      const viaSchema = this.tdfSchema.get('1', 'desc', cols, undefined, tabCols);
      if (typeof viaSchema === 'string' && viaSchema.trim()) return viaSchema.trim();
      if (Array.isArray(tabCols) && tabCols.length > 2 && String(tabCols[2]).trim()) {
        return String(tabCols[2]).trim();
      }
      // whitespace-split fallback: everything between `type` and the trailing
      // run of numbers (start / duration / penalty). A description that ENDS in
      // a number loses that token here — a tab-delimited feed or a schema line
      // gets it right, which is why both are tried first.
      let end = cols.length;
      while (end - 1 >= 2 && toInt(cols[end - 1]) != null) end--;
      return cols.slice(2, end).join(' ').trim();
    } catch (_err) {
      return '';
    }
  }

  /**
   * Positional duration fallback, used only when no schema names the column.
   * Only the LAST THREE tokens are considered — that is where `start`,
   * `duration` and `penalty` live — so a number inside the description cannot
   * be mistaken for a duration. Of the candidates that survive the unit
   * heuristic and the plausibility window the FIRST one wins, because
   * `duration` always precedes `penalty` while `start` (a timestamp) never
   * lands inside the window.
   */
  _durationFallback(cols, tabCols) {
    try {
      const row = Array.isArray(tabCols) && tabCols.length > 1 ? tabCols : cols;
      const from = Math.max(2, row.length - 3);
      for (let i = from; i < row.length; i++) {
        const ms = durationMs(row[i]);
        if (ms != null) return ms;
      }
      return null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * Type-5 (score) is the authority for every mode (contract C3):
   * `5  time  entity  old  delta  new`.
   *
   * `entity` is a team index OR a player id — a key of `gameState.players` wins
   * and lands in `players[id].score`, everything else is a team score. From the
   * first type-5 line on, `scoreSource` is `'tdf'` and the engine's own goal
   * counting stops writing `gameState.scores` (the goal event and `goals++`
   * stay exactly as they were).
   */
  _applyScoreLine(cols, tabCols) {
    try {
      const gs = this.gameState;
      const entityRaw = this.tdfSchema.get('5', 'entity', cols, 2, tabCols);
      const value = toInt(this.tdfSchema.get('5', 'new', cols, 5, tabCols));
      if (value == null || entityRaw == null) return;

      const pid = Engine.cleanId(String(entityRaw));
      if (pid && Object.prototype.hasOwnProperty.call(gs.players, pid) && gs.players[pid]) {
        gs.players[pid].score = value;
        gs.scoreSource = 'tdf';
        this._touch();
        return;
      }
      // team score — only for a plausible team key, so a hostile feed cannot
      // grow gameState.scores without bound (same guard as the type-2 branch).
      const key = String(entityRaw).trim();
      if (!/^\d{1,2}$/.test(key) || UNSAFE_KEYS.has(key)) return;
      const known = Object.prototype.hasOwnProperty.call(gs.teams, key)
        || Object.prototype.hasOwnProperty.call(gs.scores, key);
      if (!known && Object.keys(gs.scores).length >= 32) return;
      gs.scores[key] = value;
      gs.scoreSource = 'tdf';
      this._touch();
    } catch (_err) {
      /* score authority is best effort; the own count stays as fallback */
    }
  }

  /**
   * Type-7 (official SM5 end block, contract C4): `7  id  <23 stat fields>`
   * (24 fields plus the type column). Field names come from the `;` schema line
   * when present, otherwise from TYPE7_FALLBACK. Arrives BEFORE `0101`, so the
   * stats writer sees the official numbers.
   */
  _handleSm5StatsLine(cols, tabCols) {
    try {
      const gs = this.gameState;
      const row = Array.isArray(tabCols) && tabCols.length > 1 ? tabCols : cols;
      const pid = Engine.cleanId(String(this.tdfSchema.get('7', 'id', cols, 1, tabCols) || ''));
      if (!pid || !Object.prototype.hasOwnProperty.call(gs.players, pid)) return;
      const p = gs.players[pid];
      if (!p) return;

      const names = this.tdfSchema.names('7');
      const useSchema = names.length > 2 && row.length <= names.length;
      const official = {};
      for (let i = 2; i < row.length; i++) {
        const raw = useSchema ? names[i] : TYPE7_FALLBACK[i - 2];
        const key = camelKey(raw);
        if (!key || key === 'id') continue;
        const n = toInt(row[i]);
        official[key] = n == null ? String(row[i]).slice(0, 32) : n;
      }
      if (!Object.keys(official).length) return;

      p.official = official;
      for (const [from, to] of TYPE7_TO_STAT) {
        const v = official[from];
        if (typeof v === 'number') p[to] = v;
      }
      // ADDITIVE. The official fields that have NO live counterpart — remaining
      // lives, remaining ammo, the medic/boost/nuke-cancel block — are lifted
      // out of `official` onto the player object so scoreboard and CSV can show
      // them without digging into a raw sub-object. A field the arena did not
      // send stays `null`, never 0: it is a missing measurement, not a zero.
      for (const f of SM5_OFFICIAL_FIELDS) {
        const v = official[f];
        p[f] = typeof v === 'number' ? v : null;
      }
      p.statsSource = 'tdf7';

      this._pushEvent({
        type: 'sm5_stats', code: '7', category: 'player', label: 'Endstatistik',
        actorId: pid, actorName: p.name, actorTeamId: p.teamId,
        stats: { ...official },
        text: `Endstatistik ${p.name}`,
      });
      this._touch();
    } catch (_err) {
      /* a broken type-7 block must not stop the stream */
    }
  }

  /** Raise one counter on a player, creating it when the family changed mid-match. */
  _bumpStat(p, field) {
    if (!p || typeof field !== 'string') return;
    const cur = p[field];
    p[field] = (typeof cur === 'number' && Number.isFinite(cur) ? cur : 0) + 1;
  }

  /**
   * SM5 live counters (contract C6). Runs ONLY while the mode family is `sm5`,
   * strictly separate from the Laserball switch, and only ever raises the
   * counters listed in SM5_COUNTERS.
   * @returns {boolean} true when something changed
   */
  _applySm5Counters(code, actorId, targetId) {
    try {
      const rule = Object.prototype.hasOwnProperty.call(SM5_COUNTERS, code) ? SM5_COUNTERS[code] : null;
      if (!rule) return false;
      const players = this.gameState.players;
      const a = actorId && Object.prototype.hasOwnProperty.call(players, actorId) ? players[actorId] : null;
      const t = targetId && Object.prototype.hasOwnProperty.call(players, targetId) ? players[targetId] : null;
      if (!a && !t) return false;

      let actorFields = rule.actor;
      let targetFields = rule.target;
      if (rule.teamSplit && a && t && String(a.teamId) === String(t.teamId)) {
        actorFields = rule.actorTeam;
        targetFields = rule.targetTeam;
      }
      let changed = false;
      if (a && Array.isArray(actorFields)) {
        for (const f of actorFields) { this._bumpStat(a, f); changed = true; }
      }
      if (t && Array.isArray(targetFields)) {
        for (const f of targetFields) { this._bumpStat(t, f); changed = true; }
      }
      return changed;
    } catch (_err) {
      return false;
    }
  }

  // ---- helpers ported verbatim ----
  static cleanId(idStr) {
    return idStr ? idStr.replace(/[@#]/g, '').trim() : '';
  }

  // --- Team Name Auto-Synchronizer (verbatim from server.js) ---
  resolveTeamNames() {
    const gameState = this.gameState;
    const dbPlayersMap = this.dbPlayersMap;
    const lfTeams = {};
    Object.values(gameState.players).forEach((p) => {
      const dbInfo = dbPlayersMap[p.id];
      if (dbInfo && dbInfo.dbTeamName) {
        if (!lfTeams[p.teamId]) lfTeams[p.teamId] = {};
        lfTeams[p.teamId][dbInfo.dbTeamName] = (lfTeams[p.teamId][dbInfo.dbTeamName] || 0) + 1;
      }
    });

    for (const tId in lfTeams) {
      let maxCount = 0;
      let bestName = null;
      for (const name in lfTeams[tId]) {
        if (lfTeams[tId][name] > maxCount) {
          maxCount = lfTeams[tId][name];
          bestName = name;
        }
      }
      if (bestName && gameState.teams[tId]) {
        gameState.teams[tId].name = cleanName(bestName);
      }
    }
  }

  /** Feed one already-trimmed log line. */
  processLogLine(line) {
    const gameState = this.gameState;
    const dbPlayersMap = this.dbPlayersMap;
    const cleanId = Engine.cleanId;

    if (!line) return;
    // ADDITIVE: the watchdog counts ANY line, parsable or not, and this is the
    // first statement of the function so even a line that throws below has
    // already proven that the arena is still talking to us.
    this.noteActivity();
    // ADDITIVE: `;` lines are the schema comments naming the columns of the
    // following rows of their type. They were dropped before and still change
    // nothing when unusable — the parser keeps its hard-coded positions then.
    if (line.startsWith(';')) {
      try { this.tdfSchema.observe(line); } catch (_err) { /* never disrupt the parser */ }
      return;
    }
    const cols = line.split(/\s+/).filter(Boolean);
    const type = cols[0];
    // A real TDF row is TAB-delimited; `cols` above is the historical
    // whitespace split and stays byte-for-byte what every existing branch uses.
    // `tabCols` is the only representation a schema column index may be applied
    // to — see TdfSchema.get().
    let tabCols = null;
    try {
      tabCols = TdfSchema.tabColumns(line);
      this.tdfSchema.noteLineType(type);
    } catch (_err) { /* never disrupt the parser */ }

    // Mission line: mode + duration (contract C1)
    if (type === '1') {
      this._handleMissionLine(cols, tabCols);
      return;
    }

    // Track elapsed time (column 1 of every in-game event)
    if (['3', '4', '5', '6', '9'].includes(type) && !isNaN(cols[1])) {
      gameState.elapsedTime = parseInt(cols[1]);
    }

    if (type === '9') {
      const pid = cleanId(cols[2]);
      const sCode = parseInt(cols[3]);
      if (pid && gameState.players[pid]) {
        gameState.players[pid].status = sCode;
        this._pushEvent({ type: 'status', actorId: pid, actorName: gameState.players[pid].name, status: sCode, text: `${gameState.players[pid].name} status ${sCode}` });
        this._touch();
      }
      return;
    }

    // ── ADDITIVE. Type-5 (score) and type-6 (entity-end / final summary) lines.
    //    Type 6 stays purely informational (no gameState mutation, no _touch()).
    //    Type 5 is now the SCORE AUTHORITY for every mode (contract C3): the
    //    `score` event below is unchanged, `_applyScoreLine()` additionally
    //    writes gameState.scores / players[id].score and flips `scoreSource`.
    if (type === '5') {
      // A score line is live play, not an end summary (the end block is 6/7).
      this._liveSignal();
      this._applyScoreLine(cols, tabCols);
      // 5  time  entity  old  delta  new
      const toN = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
      const teamId = cols[2];
      const oldV = toN(cols[3]);
      const deltaV = toN(cols[4]);
      const newV = toN(cols[5]);
      this._pushEvent({
        type: 'score', code: '5', category: 'score', teamId,
        old: oldV, delta: deltaV, new: newV,
        text: `Score Team ${teamId}: ${oldV ?? '?'} → ${newV ?? '?'}${deltaV != null ? ` (${deltaV >= 0 ? '+' : ''}${deltaV})` : ''}`,
      });
      return;
    }
    if (type === '6') {
      // 6  time  id  type(exit-code)  score
      const entityId = cleanId(cols[2]) || cols[2] || null;
      const exitCode = cols[3] != null ? cols[3] : null;
      const score = cols[4] != null ? cols[4] : null;
      // ADDITIVE: may arm the end-of-match deadline — never on its own, see
      // _noteEntityEnd(). The event below is unchanged.
      try { this._noteEntityEnd(entityId, exitCode); } catch (_err) { /* never disturb the parser */ }
      this._pushEvent({
        type: 'match_summary', code: '6', category: 'match',
        entityId, exitCode, score, cols: cols.slice(1),
        text: `Abschluss ${entityId ?? '?'} (Exit ${exitCode ?? '?'}, Score ${score ?? '?'})`,
      });
      return;
    }
    // ── ADDITIVE. Type-7: the official SM5 end block (contract C4). It carries
    //    no `time` column, so elapsedTime is deliberately untouched.
    if (type === '7') {
      // ADDITIVE: type-7 rows exist ONLY in the closing summary of an SM5
      // mission (docs/LASERFORCE.md) — one of them is already enough to arm the
      // deadline. Laserball has no type 7; there the type-6 rule above applies.
      try { this._armEndBlock('summary_type7'); } catch (_err) { /* never disturb the parser */ }
      this._handleSm5StatsLine(cols, tabCols);
      return;
    }

    if (type === '4' && cols[2] === '0100') {
      // ADDITIVE: a start while the previous match is still running IS the end
      // of that previous one — finalize it before its state is cleared below.
      if (gameState.missionActive) this._endMatch('next_match', 'next_match');
      this.log?.info('engine', `MISSION START (0100) | teams loaded: ${Object.keys(gameState.teams).length}`);
      gameState.missionActive = true;
      gameState.matchId = Date.now().toString(36);

      gameState.players = {};
      gameState.ballHolderId = null;
      gameState.events = [];
      this.playerStatusMap = {};
      this.livePassesStream = [];

      for (const teamId in gameState.teams) {
        gameState.scores[teamId] = 0;
      }

      // ADDITIVE: per-match reset of the new bookkeeping. `mode`, `duration`
      // and `durationKnown` are NOT reset here — the type-1 line arrives BEFORE
      // 0100 and must survive it (contract C1).
      gameState.scoreSource = 'internal';
      this._familyInferred = false;
      // ADDITIVE: a running match has no end — and the end detection starts over.
      gameState.endReason = null;
      gameState.endedAt = null;
      gameState.endSource = null;
      gameState.exitCodes = {};
      gameState.exitCodesSeen = [];
      // A suspicion belongs to ONE match and to nothing else.
      gameState.chasing = [];
      this._resetChase();
      this._resetEndDetection();
      this._startEndWatch();

      this._pushEvent({ type: 'match_start', text: 'Match started' });
      this.emit('match_start', {});
      this._touch();
      return;
    }

    if (type === '4' && cols[2] === '0101') {
      // The arena said so itself — this always wins over anything inferred.
      // A `0101` for a match this engine has ALREADY ended (watchdog, stream
      // loss) is swallowed: it would otherwise write the same match a second
      // time. A `0101` on a stream we joined mid-match (no `0100`, no end yet)
      // still reports, exactly as before.
      if (gameState.missionActive || gameState.endReason == null) this._endMatch('mission_end', '0101');
      else this.log?.info('engine', `0101 nach bereits erkanntem Ende (${gameState.endReason}) — ignoriert`);
      return;
    }

    if (type === '2') {
      const teamIndex = cols[1];

      // Bounds guard only: real Laserforce uses team indices 0-7, so this never
      // fires for a legitimate feed. Keeps a hostile :9000 feed from growing
      // gameState.teams / .scores without limit. Parsing below is unchanged.
      const teamIndexNum = parseInt(teamIndex, 10);
      if (!Number.isInteger(teamIndexNum) || teamIndexNum < 0 || teamIndexNum > 31) return;

      // hex color always starts with '#'
      const hexIndex = cols.findIndex((c) => String(c).startsWith('#'));
      const color = hexIndex !== -1 ? cols[hexIndex] : '#9ca3af';

      // hex color is always preceded by exactly two values (colour-enum, colour-desc)
      const teamName = cleanName((hexIndex !== -1 && hexIndex >= 4)
        ? cols.slice(2, hexIndex - 2).join(' ')
        : cols[2]);

      gameState.teams[teamIndex] = { name: teamName, color: color };
      if (gameState.scores[teamIndex] === undefined) gameState.scores[teamIndex] = 0;
      this._touch();
      return;
    }

    if (type === '3') {
      // ── ADDITIVE (docs/LASERFORCE.md, "Typ-3 im Detail"). The entity kind has
      //    its OWN column in the schema:
      //      ;3/entity-start  time  id  type  desc  team  level  category  …
      //    Reading it there is exact. The old `cols.indexOf('player')` searched
      //    the whole row for the WORD `player` and therefore also matched a
      //    NON-player entity that happens to be NAMED "player" (the arena lets
      //    an operator name targets freely) — it would then read the id one
      //    token to the left of the name and create a bogus player. It also
      //    depended on the whitespace split.
      //    The schema path is taken only when the row can be lined up with the
      //    schema (`_alignRow` returns the TAB columns, or folds the one field
      //    that may contain spaces back together and insists on the exact
      //    column count). Without a usable schema NOTHING changes: the old
      //    `indexOf` runs on the old `cols`, byte for byte.
      const aligned3 = this._alignRow('3', cols, tabCols);
      const kindIdx = this.tdfSchema.indexOf('3', 'type');
      let row = cols;
      let typeIdx;
      if (Array.isArray(aligned3) && kindIdx > 0 && kindIdx < aligned3.length) {
        row = aligned3;
        typeIdx = String(aligned3[kindIdx]).trim().toLowerCase() === 'player' ? kindIdx : -1;
      } else {
        typeIdx = cols.indexOf('player');
      }

      if (typeIdx !== -1) {
        // The entity id becomes an object key in gameState.players. Same guard
        // the exit-code map already used (safeKey): a feed that calls an entity
        // `__proto__` would otherwise not add a player at all but replace the
        // PROTOTYPE of the whole player map.
        // `row` is the schema-aligned row when there was one, and the plain
        // whitespace split otherwise — the index arithmetic below is unchanged.
        const id = safeKey(cleanId(row[typeIdx - 1]));
        if (!id) return;

        // Find the signature Team/Level/Category cluster: three numbers in a row.
        let teamIdIdx = typeIdx + 1;
        while (teamIdIdx < row.length - 2) {
          if (!isNaN(row[teamIdIdx]) && !isNaN(row[teamIdIdx + 1]) && !isNaN(row[teamIdIdx + 2])) {
            break;
          }
          teamIdIdx++;
        }

        const teamId = row[teamIdIdx];
        const lfName = row.slice(typeIdx + 1, teamIdIdx).join(' ');

        const dbInfo = dbPlayersMap[id];
        const finalName = cleanName(dbInfo ? dbInfo.nick : lfName);
        const finalAvatar = dbInfo ? dbInfo.avatar : null;

        // NB: this `5` is NOT what keeps non-players out — measured at the real
        // arena, Neutral is team index `2` there and the filter never fires
        // (docs/LASERFORCE.md, "Neutral ist an dieser Anlage Team-Index 2").
        // What carries the decision is the `type` column above. The filter
        // stays because it costs nothing and covers an arena that does use 5.
        if (teamId !== '5') {
          this.log?.debug('engine', `Player logged in: ${finalName} (Team ${teamId})`);
          gameState.players[id] = {
            id: id, name: finalName, teamId: teamId, avatar: finalAvatar,
            status: 0, goals: 0, assists: 0,
            stealsDone: 0, stealsReceived: 0, blocksDone: 0, blocksReceived: 0,
            resetsDone: 0, resetsReceived: 0, clearsDone: 0, clearsReceived: 0,
            passesDone: 0, passesReceived: 0,
          };
          // ADDITIVE (contract C5 + B): SM5 role / level / battlesuit are no
          // longer discarded, and an `sm5` match gets its counter set. The
          // Laserball counters above are always present and never renamed.
          try {
            const p = gameState.players[id];
            const lvl = toInt(row[teamIdIdx + 1]);
            const cat = toInt(row[teamIdIdx + 2]);
            p.level = lvl == null ? null : lvl;
            p.category = cat == null ? null : cat;
            p.roleLabel = roleLabel(cat);
            // The same aligned row the entity kind was read from, above.
            const suit = this.tdfSchema.get('3', 'battlesuit', cols, undefined, aligned3);
            p.battlesuit = typeof suit === 'string' && suit.trim() ? suit.trim().slice(0, 32) : null;
            const mem = this.tdfSchema.get('3', 'memberId', cols, undefined, aligned3);
            p.memberId = typeof mem === 'string' && mem.trim() ? mem.trim().slice(0, 32) : null;
            p.score = 0;
            p.statsSource = 'live';
            if (gameState.mode && gameState.mode.family === FAMILIES.SM5) {
              Object.assign(p, newPlayerStats(FAMILIES.SM5));
              // Official end-block values do not exist yet -> null, not 0.
              Object.assign(p, newOfficialStats());
              p.accuracy = null;
              p.accuracyIsEstimate = true;
              p.accuracySource = 'live';
            }
          } catch (_err) {
            // the player is already created above; extra metadata is optional
          }
          this.playerStatusMap[id] = 0;
          this._scheduleTeamNames();
          this._pushEvent({ type: 'player_join', actorId: id, actorName: finalName, teamId, text: `${finalName} joined team ${teamId}` });
          this._touch();
        }
      }
      return;
    }

    if (type === '4') {
      // ADDITIVE: a game event after the 6/7 block proves the match is still
      // being played — whatever the summary looked like, disarm the deadline.
      this._liveSignal();
      const code = cols[2];
      const actorId = cleanId(cols[3]);
      const eventTime = parseInt(cols[1]) || 0;
      let targetId = '';
      const targetElement = cols.find((val, idx) => idx > 3 && (val.startsWith('@') || val.startsWith('#')));
      if (targetElement) targetId = cleanId(targetElement);
      else if (cols[5] && !isNaN(cleanId(cols[5]))) targetId = cleanId(cols[5]);

      // ── ADDITIVE. Surface type-4 codes the chain below does not act on
      //    (1105 round start, 110B/110C resets, SM5 0xxx, anything unknown).
      //    Runs before the "no known actor" early-return so actor-less control
      //    codes are still visible. HANDLED_TYPE4 gates out every code an
      //    existing branch owns, so this cannot change an existing case.
      //    ADDITIVE: the line's own tail (`;4/event  time  type  varies`) goes
      //    along so an unknown code can be labelled with the arena's own words.
      //    A TAB-split tail is exact; the whitespace fallback is good enough for
      //    a sentence but not for reading a single field out of it.
      const tailExact = Array.isArray(tabCols) && tabCols.length > 3;
      this._emitAuxEvent(code, actorId, targetId,
        tailExact ? tabCols.slice(3) : cols.slice(3), tailExact);

      // ── ADDITIVE (contract B + C6). Runs BEFORE the "no known actor" early
      //    return below, because SM5 has actor-less events (0209 warbot) — and
      //    strictly separate from the 11xx switch further down, which stays
      //    untouched. `_applySm5Counters` only fires while family === 'sm5'.
      this._inferFamily(code);
      if (gameState.mode && gameState.mode.family === FAMILIES.SM5) {
        if (this._applySm5Counters(code, actorId, targetId)) this._touch();
      }

      // ── ADDITIVE. Verdacht „Hinterherlaufen" (docs/GAMEMODES.md). Runs
      //    before the "no known actor" early return like the block above, is
      //    gated on the DISPLAY PROFILE inside `_noteTag`, cannot throw and
      //    only asks for a state push when the published list can have changed.
      if (this._noteTag(code, actorId, targetId)) this._touch();

      let updateNeeded = false;
      if (!actorId || !gameState.players[actorId]) return;

      if (code === '1107') { gameState.ballHolderId = actorId; updateNeeded = true; }
      else if ((code === '1100' || code === '1109') && targetId) { gameState.ballHolderId = targetId; updateNeeded = true; }
      else if (['1101', '1102', '1108', '1106'].includes(code)) { gameState.ballHolderId = null; updateNeeded = true; }
      else if (code === '1103') { gameState.ballHolderId = actorId; updateNeeded = true; }

      const aName = gameState.players[actorId].name;
      const aTeamId = gameState.players[actorId].teamId;
      const tName = targetId && gameState.players[targetId] ? gameState.players[targetId].name : null;
      const tTeamId = targetId && gameState.players[targetId] ? gameState.players[targetId].teamId : null;

      switch (code) {
        case '1100':
          gameState.players[actorId].passesDone++;
          if (targetId && gameState.players[targetId]) {
            gameState.players[targetId].passesReceived++;
            this.livePassesStream.push({ passerId: actorId, receiverId: targetId, time: eventTime });
            this._pushEvent({ type: 'pass', code, actorId, actorName: aName, actorTeamId: aTeamId, targetId, targetName: tName, targetTeamId: tTeamId, text: `${aName} -> ${tName}` });
          }
          updateNeeded = true; break;

        case '1109':
          gameState.players[actorId].clearsDone++;
          if (targetId && gameState.players[targetId]) {
            gameState.players[targetId].clearsReceived++;
            this.livePassesStream.push({ passerId: actorId, receiverId: targetId, time: eventTime });
            this._pushEvent({ type: 'clear', code, actorId, actorName: aName, actorTeamId: aTeamId, targetId, targetName: tName, targetTeamId: tTeamId, text: `${aName} cleared -> ${tName}` });
          }
          updateNeeded = true; break;

        case '1101': case '1102': { // EventScore
          this.log?.info('engine', `GOAL! Player ${actorId} (${aName}) scored`);
          gameState.players[actorId].goals++;
          const validPasses = this.livePassesStream.filter((p) => (eventTime - p.time) <= 10000);
          const matchPass = validPasses.reverse().find((p) => p.receiverId === actorId);
          let assistId = null;
          if (matchPass && gameState.players[matchPass.passerId]) {
            gameState.players[matchPass.passerId].assists++;
            assistId = matchPass.passerId;
          }
          this.livePassesStream = [];

          const teamId = gameState.players[actorId].teamId;
          // THE ONLY change to the Laserball path (contract C3): once type-5
          // lines have been seen they own gameState.scores, so the own count
          // must not add on top. Everything else here — goals++, the assist
          // window, the event, the OBS replay trigger — is unchanged.
          if (gameState.scoreSource !== 'tdf' && gameState.scores[teamId] !== undefined) {
            gameState.scores[teamId]++;
          }

          this._pushEvent({
            type: 'goal', code, actorId, actorName: aName, actorTeamId: teamId,
            assistId, assistName: assistId ? gameState.players[assistId].name : null,
            scores: { ...gameState.scores },
            text: `${aName} SCORED`,
          });

          // --- OBS replay engine (call sequence unchanged, just decoupled) ---
          this.emit('goal', { teamId, actorId, actorName: aName });

          updateNeeded = true; break;
        }

        case '1103':
          gameState.players[actorId].stealsDone++;
          if (targetId && gameState.players[targetId]) gameState.players[targetId].stealsReceived++;
          this.livePassesStream = [];
          this._pushEvent({ type: 'steal', code, actorId, actorName: aName, actorTeamId: aTeamId, targetId, targetName: tName, targetTeamId: tTeamId, text: `${aName} stole from ${tName}` });
          updateNeeded = true; break;

        case '110A': // Failed Clear
          this._pushEvent({ type: 'failed_clear', code, actorId, actorName: aName, actorTeamId: aTeamId, text: `${aName} failed to clear` });
          updateNeeded = true; break;

        case '1104': {
          const targetStatus = gameState.players[targetId] ? gameState.players[targetId].status : 0;
          if (targetStatus === 2) {
            gameState.players[actorId].resetsDone++;
            if (targetId && gameState.players[targetId]) gameState.players[targetId].resetsReceived++;
            this._pushEvent({ type: 'reset', code, actorId, actorName: aName, actorTeamId: aTeamId, targetId, targetName: tName, targetTeamId: tTeamId, text: `${aName} reset ${tName}` });
          } else {
            gameState.players[actorId].blocksDone++;
            if (targetId && gameState.players[targetId]) gameState.players[targetId].blocksReceived++;
            this._pushEvent({ type: 'block', code, actorId, actorName: aName, actorTeamId: aTeamId, targetId, targetName: tName, targetTeamId: tTeamId, text: `${aName} blocked ${tName}` });
          }
          updateNeeded = true; break;
        }
      }
      if (updateNeeded) this._touch();
    }
  }
}

module.exports = {
  Engine, matchEndMs, MATCH_END_DEFAULTS, END_REASONS, END_SOURCES,
  CHASE_TAG_CODES, CHASE_THRESHOLD_DEFAULT, CHASE_THRESHOLD_MAX, CHASE_PROFILES_DEFAULT,
};
