'use strict';

const fs = require('fs');
const path = require('path');
const { readable } = require('./eventCatalog');
const {
  FAMILIES, DEFAULT_FAMILY, FAMILY_DEFAULT_PROFILE, counterColumns, statFields,
  csvColumns, profileFields, profileSort, profileOf, withProfile,
  normProfile, resolveModeWithProfile, SM5_OFFICIAL_FIELDS, snake,
} = require('./gameModes');

/**
 * Match statistics -> CSV files on this PC. Nothing leaves the machine.
 *
 * Files under {csv.dir} (default data/stats/):
 *
 *   matches/<stamp>_<matchId>_players.csv   one row per player, this match
 *   matches/<stamp>_<matchId>_events.csv    every event of this match (if csv.writeEvents)
 *   all_players_<family>.csv                append-only: every player row, PER FAMILY
 *   totals_<family>.csv                     aggregate per player, PER FAMILY
 *   matches.csv                             append-only: one row per match
 *   player_modes.csv                        who played which game mode, and when
 *
 * WHY PER FAMILY (contract D): a Laserball row counts goals/steals/passes, an SM5
 * row counts shots/deactivations/missiles. The two column sets are factually
 * incompatible, so a single mixed grand total would be meaningless as soon as
 * both modes run on the same day. Every aggregate is therefore kept per
 * `gameState.mode.family`.
 *
 * MIGRATION: a pre-mode `all_players.csv` (Laserball history, no mode columns) is
 * read ONCE at startup so its totals survive — `counterColumns('laserball')` is
 * column-identical to that old set, and it is what the replay reads by NAME, so
 * neither the added columns nor the new column ORDER touch the import. The old
 * file is never written, renamed or deleted; it is only ever read.
 *
 * WHICH COLUMNS a player row gets is the DISPLAY PROFILE's business, not the
 * family's — see src/gameModes.js. The per-match file follows the match's
 * profile; the append-only `all_players_<family>.csv` follows the family's
 * default profile, because its header is fixed on first write and two profiles
 * of one family would otherwise collide.
 *
 * A match is finalized on the Laserforce "mission end" (0101). If the operator
 * starts a new match without an end, the previous one is still finalized from
 * the last snapshot seen, so nothing is lost.
 */

const FAMILY_LIST = [FAMILIES.LASERBALL, FAMILIES.SM5];

/** Legacy file written before mode awareness — read-only, for migration. */
const LEGACY_ALL_PLAYERS = 'all_players.csv';
/**
 * How a reset names what it is about to delete. The operator confirms with his
 * password, so he must be able to read beforehand what goes — in his words, not
 * in file names. Order matters: the first matching entry wins, and the last one
 * is the catch-all for anything else that ended up in the folder.
 */
const RESET_GROUPS = [
  { key: 'matches', label: 'Einzelmatches (Ordner matches/)', match: (n) => n.startsWith('matches/') },
  { key: 'overview', label: 'Missionsübersicht (matches.csv)', match: (n) => n === 'matches.csv' },
  { key: 'modes', label: 'Modus-Historie (player_modes.csv)', match: (n) => n === 'player_modes.csv' },
  { key: 'totals', label: 'Gesamtwertungen (totals_*, all_players_*)', match: (n) => /^(totals|all_players)(_[A-Za-z0-9]+)?\.csv$/.test(n) },
  { key: 'other', label: 'Sonstige CSV-Dateien im Ordner', match: () => true },
];

/** Mode bucket the pre-mode Laserball history is filed under in player_modes.csv. */
const LEGACY_MODE = { key: 'laserball_legacy', label: 'Laserball (Altbestand)', number: null, family: FAMILIES.LASERBALL };

/**
 * Player rows are ordered by BUSINESS IMPORTANCE, not by accident:
 *
 *   1. identity  — HEAD_COLS: which match, when, which mode, who, which team,
 *                  which role, which level
 *   2. result    — RESULT_COLS: the points and how the match ended
 *   3. core      — the profile's leading metrics (profileFields(), front part)
 *   4. detail    — the profile's remaining counters
 *   5. provenance— TAIL_COLS: where each block of numbers came from
 *
 * `mode_number` is carried as well — it is the only stable handle on a mode
 * whose number is not in the registry. `profile` says which column set this row
 * was written with, so a reader never has to guess from the header.
 */
const HEAD_COLS = [
  'match_id', 'date',
  'mode_key', 'mode_label', 'mode_number', 'family', 'profile',
  'player_id', 'name', 'team_id', 'team', 'role', 'level',
];

/** The outcome, right after the identity — what anybody looks at first. */
const RESULT_COLS = ['score', 'team_score', 'opp_score', 'result', 'duration_s'];

/**
 * Provenance, always last. `stats_source` says whether the counters are the
 * official type-7 numbers of the arena (`tdf7`) or lf_live's own live count
 * (`live`); `score_source` likewise for the score the `result` was derived
 * from; `accuracy_source` likewise for the hit rate (only where there is one).
 */
const TAIL_COLS = ['stats_source', 'score_source'];
const ACCURACY_SOURCE_COL = 'accuracy_source';

/**
 * Player-object fields that must land in the CSV as an EMPTY cell when they are
 * not a number — the official type-7 measurements (they do not exist before the
 * match has ended) and the derived hit rate (undefined without shots). Writing
 * a 0 there would pass a missing measurement off as a measured zero.
 */
const BLANK_WHEN_MISSING = new Set(SM5_OFFICIAL_FIELDS.concat(['accuracy']));

const TOTAL_HEAD = ['player_id', 'name', 'matches', 'wins', 'losses', 'draws'];

/** One row per match — the index of everything that was recorded. */
const MATCH_COLS = [
  'match_id', 'date', 'started_at', 'ended_at', 'duration_s',
  'mode_key', 'mode_label', 'mode_number', 'family', 'profile',
  'players', 'teams', 'scores', 'winner_team', 'winner_score', 'score_source', 'events',
  // Appended, never inserted: existing consumers read these files by position.
  'exit_codes', 'end_source',
];

/** "Which player played which mode, and when" — the mode history per player. */
const PLAYER_MODE_COLS = [
  'player_id', 'name', 'mode_key', 'mode_label', 'family', 'matches',
  'first_played', 'last_played', 'wins', 'losses', 'draws', 'total_duration_s',
];

const EVENT_COLS = [
  'match_id', 'seq', 'elapsed_s', 'wall_time', 'type', 'code',
  'actor_id', 'actor', 'actor_team', 'target_id', 'target', 'target_team', 'assist', 'detail',
  'text', 'mode_key',
];

/**
 * `counterColumns()` / `statFields()` / `profileFields()` build a fresh array on
 * every call; seeding the totals from a long history calls them once per row, so
 * memoize. The cached arrays are read-only for everyone in this module.
 *
 * Two separate caches, because the two axes are separate:
 *   familyCols/familyFields — the FAMILY's plain counters (aggregates)
 *   profileCols/profileFlds — the PROFILE's display block (player rows)
 */
const COL_CACHE = new Map();
const FIELD_CACHE = new Map();
const PROFILE_COL_CACHE = new Map();
const PROFILE_FIELD_CACHE = new Map();
function familyCols(family) {
  const f = normFamily(family);
  if (!COL_CACHE.has(f)) COL_CACHE.set(f, counterColumns(f));
  return COL_CACHE.get(f);
}
function familyFields(family) {
  const f = normFamily(family);
  if (!FIELD_CACHE.has(f)) FIELD_CACHE.set(f, statFields(f));
  return FIELD_CACHE.get(f);
}
function profileCols(profile) {
  const p = normProfile(profile);
  if (!PROFILE_COL_CACHE.has(p)) PROFILE_COL_CACHE.set(p, csvColumns(p));
  return PROFILE_COL_CACHE.get(p);
}
function profileFlds(profile) {
  const p = normProfile(profile);
  if (!PROFILE_FIELD_CACHE.has(p)) PROFILE_FIELD_CACHE.set(p, profileFields(p));
  return PROFILE_FIELD_CACHE.get(p);
}

/**
 * The profile a FAMILY's append-only aggregate file is written with.
 *
 * `all_players_<family>.csv` is append-only, so its header is fixed on first
 * write and every later row must fit it. Two modes of the same family may use
 * different display profiles (`standard` and `sm5` both speak family `sm5`), so
 * the shared file uses the family's DEFAULT profile — which is the widest of
 * that family's profiles. The per-match file uses the match's own profile.
 */
function familyProfile(family) {
  return FAMILY_DEFAULT_PROFILE[normFamily(family)] || normProfile(null);
}

/** Does this profile show a hit rate? Then its rows carry its provenance too. */
function profileHasAccuracy(profile) {
  return profileFlds(profile).includes('accuracy');
}

/** Provenance block of a profile — always the last columns of a player row. */
function tailColumns(profile) {
  return profileHasAccuracy(profile) ? TAIL_COLS.concat([ACCURACY_SOURCE_COL]) : TAIL_COLS.slice();
}

/**
 * Player-row columns for a display PROFILE: identity, result, the profile's
 * counter block, provenance.
 *
 * BACK-COMPAT: a family name still works — `playerColumns('laserball')` yields
 * the Laserball profile, exactly as before.
 */
function playerColumns(profile) {
  const p = normProfile(profile);
  return HEAD_COLS.concat(RESULT_COLS, profileCols(p), tailColumns(p));
}

/**
 * Totals columns for a FAMILY — deliberately not profile-aware. The head is
 * unchanged from the pre-mode file, and so is the counter block: a total is a
 * sum, and neither a derived rate nor a type-7-only measurement may be summed.
 */
function totalColumns(family) {
  const f = normFamily(family);
  const derived = f === FAMILIES.LASERBALL ? 'goals_per_match' : 'score_per_match';
  return TOTAL_HEAD.concat(familyCols(f), ['score', derived]);
}

class StatsWriter {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;
    this._snap = null;      // live reference to the latest engine state (NOT a clone)
    this._prev = null;      // cheap shallow capture, enough to finalize an abandoned match
    this._match = null;     // { matchId, stamp, startedAt, mode, events: [], finalized }
    this._liveTimer = null;
    this._totals = new Map();      // family -> Map(playerId -> aggregate row)
    this._playerModes = new Map(); // modeMapKey(playerId, modeKey) -> mode history row
    this._lastFamily = null;       // family of the most recently finalized match
    this._legacyPending = false;   // legacy all_players.csv folded in but not yet persisted
    this._loadTotals();            // seed once from what is already on disk
  }

  get cfg() { return this.getConfig().csv; }
  dir() { return path.resolve(process.cwd(), this.cfg.dir); }
  file(name) { return path.join(this.dir(), name); }

  // ---- engine hooks ----
  onChange(state) {
    // Hot path: no deep clone. Keep a live reference for the live writer, plus a
    // cheap shallow capture of the parts a match_start reset would detach (players,
    // events) or zero in place (scores) — so an abandoned previous match can still
    // be finalized from the last state we saw. The deep clone is deferred to
    // _finalize(), which runs at most once per match.
    this._snap = state;
    this._prev = {
      matchId: state.matchId,
      elapsedTime: state.elapsedTime,
      duration: state.duration,
      teams: state.teams,
      players: state.players,
      events: state.events,
      scores: { ...(state.scores || {}) },
      mode: state.mode ? { ...state.mode } : null,
      scoreSource: state.scoreSource,
    };
    this._noteMode(state);
    if (this.cfg.enabled && this.cfg.writeLive && this._match && !this._liveTimer) {
      this._liveTimer = setTimeout(() => { this._liveTimer = null; this._writeMatchPlayers(this._snap, false); }, 1500);
    }
  }

  onEvent(evt) {
    if (!this._match) return;
    this._match.events.push(evt);
    // Anything that is not match bookkeeping proves the match is really running —
    // used by _noteMode() to tell "our mode arrived late" from "that is the NEXT
    // mission's type-1 line".
    if (evt && evt.category && evt.category !== 'match') this._match.hadPlayEvent = true;
  }

  onMatchStart(state) {
    // finalize a previous match that never got an explicit end
    if (this._match && !this._match.finalized && this._prev) {
      this.log.info('stats', `finalizing previous match ${this._match.matchId} (no end event)`);
      this._finalize(this._prev);
    }
    const now = new Date();
    this._match = {
      matchId: state.matchId || `m${now.getTime()}`,
      stamp: stampOf(now),
      startedAt: now.toISOString(),
      mode: null,
      hadPlayEvent: false,
      events: [],
      finalized: false,
    };
    this._noteMode(state);
    this.log.info('stats', `recording match ${this._match.matchId} (${this._match.mode ? this._match.mode.label : 'Modus unbekannt'})`);
  }

  onMatchEnd(state) {
    if (!this._match) {
      // an end without a start we saw — synthesize a context
      this.onMatchStart(state);
    }
    this._finalize(state);
  }

  /**
   * Remember the mode of the match that is currently being recorded.
   *
   * The type-1 mission line of the NEXT match arrives BEFORE its 0100 (contract
   * C1), so a running match must not adopt every mode it sees — otherwise an
   * abandoned match would be filed under its successor's mode. Accepted are:
   *   - the first mode of a fresh match,
   *   - the engine's runtime family correction, which keeps `key` and only flips
   *     `family`/`source` (engine `_inferFamily`),
   *   - a real mode for a match that started without one, as long as no gameplay
   *     event has been recorded yet.
   */
  _noteMode(state) {
    try {
      const m = this._match;
      if (!m) return;
      const next = pickMode(state);
      if (!next) return;
      if (!m.mode || next.key === m.mode.key) { m.mode = next; return; }
      if (m.mode.key === 'unknown' && !m.hadPlayEvent) m.mode = next;
    } catch (_err) {
      /* mode bookkeeping must never disturb the hot path */
    }
  }

  // ---- finalize ----
  _finalize(rawState) {
    if (!this.cfg.enabled) { this._match = null; return; }
    // The one place a stable deep copy is actually needed: from here on the rows
    // are derived and written synchronously, so a snapshot taken now is enough.
    const state = structuredClone(rawState);
    try {
      const mode = this._match?.mode || pickMode(state) || fallbackMode(state);
      const family = normFamily(mode.family);
      const profile = profileOf(mode);
      this._match.mode = mode;
      this._match.endedAt = new Date().toISOString();
      fs.mkdirSync(path.join(this.dir(), 'matches'), { recursive: true });
      const rows = this._playerRows(state, mode, family);
      this._writeMatchPlayers(state, true, rows, family, profile);
      if (this.cfg.writeEvents) this._writeMatchEvents(mode);
      this._appendAll(rows, family);
      this._appendMatchRow(state, mode, family, rows);
      this._accumulateTotals(rows, family);
      this._accumulateModes(rows, mode, family);
      this._writeTotals(family);
      // Persist a freshly migrated Laserball history even when the first match
      // after the update was an SM5 one — otherwise the import would be redone
      // (harmlessly, but pointlessly) on every start until a Laserball match runs.
      if (this._legacyPending) this._writeTotals(FAMILIES.LASERBALL);
      this._writePlayerModes();
      this._lastFamily = family;
      this.log.info('stats', `match ${this._match.matchId}: wrote ${rows.length} player rows (${family})`);
    } catch (err) {
      this.log.error('stats', `finalize failed: ${err.stack}`);
    }
    if (this._match) this._match.finalized = true;
    this._match = null;
  }

  /**
   * One row per player, ordered the way a human reads a result sheet:
   * by team, and inside a team by score, best first.
   */
  _playerRows(state, mode, family) {
    const m = this._match;
    const date = m.startedAt.slice(0, 10);
    const durationS = Math.round((state.elapsedTime || 0) / 1000);
    const scores = state.scores || {};
    const scoreSource = state.scoreSource === 'tdf' ? 'tdf' : 'internal';
    const profile = profileOf(mode);
    // Fill the union of the match profile's block and the family file's block:
    // the same row object is written to the per-match file (match profile) and
    // to the append-only family file (family default profile).
    const fields = [...new Set(profileFlds(profile).concat(profileFlds(familyProfile(family))))];
    const rows = Object.values(state.players || {}).map((p) => {
      const teamScore = num(scores[p.teamId]);
      const oppScore = Math.max(0, ...Object.entries(scores)
        .filter(([k]) => k !== String(p.teamId))
        .map(([, v]) => num(v)), 0);
      const result = teamScore > oppScore ? 'win' : teamScore < oppScore ? 'loss' : 'draw';
      const team = state.teams?.[p.teamId]?.name || `Team ${p.teamId}`;
      const row = {
        // identity
        match_id: m.matchId, date,
        mode_key: mode.key, mode_label: mode.label, mode_number: mode.number == null ? '' : mode.number,
        family, profile,
        player_id: p.id, name: p.name, team_id: p.teamId, team,
        role: p.roleLabel || '', level: blank(p.level),
        // result
        score: num(p.score),
        team_score: teamScore, opp_score: oppScore, result,
        duration_s: durationS,
        // provenance
        stats_source: p.statsSource === 'tdf7' ? 'tdf7' : 'live',
        score_source: scoreSource,
        accuracy_source: p.accuracySource === 'tdf7' ? 'tdf7' : 'live',
      };
      // Counter block. A field the arena has not measured YET (the type-7-only
      // values, and the hit rate of a player who never fired) stays EMPTY —
      // writing 0 there would sell a missing measurement as a measured zero.
      for (const f of fields) {
        row[snakeCol(f)] = BLANK_WHEN_MISSING.has(f) ? blank(p[f]) : num(p[f]);
      }
      return row;
    });
    // Team first, then the better score on top; the name only breaks ties so
    // the order is stable between two runs over the same match.
    return rows.sort((a, b) =>
      String(a.team_id).localeCompare(String(b.team_id), 'en', { numeric: true })
      || num(b.score) - num(a.score)
      || String(a.name).localeCompare(String(b.name), 'de', { sensitivity: 'base' }));
  }

  _writeMatchPlayers(state, final, rows, family, profile) {
    if (!this._match) return;
    const mode = this._match.mode || pickMode(state) || fallbackMode(state);
    if (!family) family = normFamily(mode.family);
    if (!profile) profile = profileOf(mode);
    rows = rows || this._playerRows(state, mode, family);
    const file = path.join(this.dir(), 'matches', `${this._match.stamp}_${safe(this._match.matchId)}_players.csv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._writeCsv(file, playerColumns(profile), rows, false);
  }

  _writeMatchEvents(mode) {
    const file = path.join(this.dir(), 'matches', `${this._match.stamp}_${safe(this._match.matchId)}_events.csv`);
    const rows = this._match.events.map((e) => ({
      match_id: this._match.matchId, seq: e.id, elapsed_s: ((e.elapsedMs || 0) / 1000).toFixed(1),
      wall_time: new Date(e.ts).toISOString(), type: e.type, code: e.code || '',
      actor_id: e.actorId || '', actor: e.actorName || '', actor_team: e.actorTeamId || '',
      target_id: e.targetId || '', target: e.targetName || '', target_team: e.targetTeamId || '',
      assist: e.assistName || '', detail: e.text || '',
      text: (typeof e.phrase === 'string' && e.phrase.trim()) ? e.phrase : readable(e),
      mode_key: mode ? mode.key : '',
    }));
    this._writeCsv(file, EVENT_COLS, rows, false);
  }

  /**
   * The append-only per-family file. Its header is fixed on first write, so it
   * always uses the family's default profile — never the match's, which may be
   * a narrower profile of the same family.
   */
  _appendAll(rows, family) {
    this._writeCsv(this.file(`all_players_${family}.csv`), playerColumns(familyProfile(family)), rows, true);
  }

  /** One row per match — `matches.csv`, append-only. */
  _appendMatchRow(state, mode, family, rows) {
    const m = this._match;
    const scores = state.scores || {};
    const teams = state.teams || {};
    const entries = Object.entries(scores).map(([id, v]) => ({
      id, score: num(v), name: teams[id]?.name || `Team ${id}`,
    }));
    const best = entries.reduce((a, b) => (b.score > a.score ? b : a), { id: '', score: -Infinity, name: '' });
    const tied = entries.filter((e) => e.score === best.score).length > 1;
    const row = {
      match_id: m.matchId, date: m.startedAt.slice(0, 10),
      started_at: m.startedAt, ended_at: m.endedAt || new Date().toISOString(),
      duration_s: Math.round((state.elapsedTime || 0) / 1000),
      mode_key: mode.key, mode_label: mode.label, mode_number: mode.number == null ? '' : mode.number,
      family, profile: profileOf(mode),
      players: rows.length, teams: Object.keys(teams).length,
      scores: entries.map((e) => `${e.name}:${e.score}`).join(' | '),
      winner_team: tied || !entries.length ? '' : best.name,
      winner_score: entries.length ? Math.max(...entries.map((e) => e.score)) : '',
      score_source: state.scoreSource === 'tdf' ? 'tdf' : 'internal',
      events: m.events.length,
      // Diagnostics for the match-end path (see docs/LASERFORCE.md): which type-6
      // exit codes the arena actually sent, and what ended the match.
      exit_codes: Array.isArray(state.exitCodesSeen) ? state.exitCodesSeen.join('|') : '',
      end_source: state.endSource || '',
    };
    this._writeCsv(this.file('matches.csv'), MATCH_COLS, [row], true);
  }

  // ---- aggregates ----

  _totalsFor(family) {
    const f = normFamily(family);
    if (!this._totals.has(f)) this._totals.set(f, new Map());
    return this._totals.get(f);
  }

  /**
   * Seed the in-memory aggregates once at startup.
   *
   * Preference per family: the already-aggregated `totals_<family>.csv`; if that
   * is missing, replay `all_players_<family>.csv`. `player_modes.csv` is seeded
   * from itself, or rebuilt from the per-family player files.
   *
   * MIGRATION of the pre-mode `all_players.csv`: folded into the Laserball
   * aggregates exactly when there is no Laserball data yet — which is true on the
   * first start after the update, and false ever after, because the first finalize
   * persists the folded numbers. Idempotent across restarts, and self-healing if
   * the run that folded it never got to write anything.
   */
  _loadTotals() {
    try {
      const needModes = !fs.existsSync(this.file('player_modes.csv'));
      if (!needModes) this._seedPlayerModes();

      for (const family of FAMILY_LIST) {
        const totalsFile = this.file(`totals_${family}.csv`);
        const needTotals = !fs.existsSync(totalsFile);
        if (!needTotals) this._seedTotalsFile(family, totalsFile);
        if (needTotals || needModes) {
          this._replayRows(this.file(`all_players_${family}.csv`), family, { toTotals: needTotals, toModes: needModes });
        }
      }

      const legacy = this.file(LEGACY_ALL_PLAYERS);
      if (this._totalsFor(FAMILIES.LASERBALL).size === 0 && fs.existsSync(legacy)) {
        const before = this._totalsFor(FAMILIES.LASERBALL).size;
        this._replayRows(legacy, FAMILIES.LASERBALL, { toTotals: true, toModes: needModes, legacy: true });
        const added = this._totalsFor(FAMILIES.LASERBALL).size - before;
        if (added > 0) {
          this._legacyPending = true;
          this.log?.info?.('stats', `migriert: ${added} Spieler aus ${LEGACY_ALL_PLAYERS} in die Laserball-Gesamtwertung übernommen`);
        }
      }
    } catch (err) {
      // Never let a damaged history stop the recorder — a fresh aggregate is
      // still better than no statistics at all.
      this.log?.warn?.('stats', `konnte vorhandene Statistiken nicht einlesen: ${err.message}`);
    }
  }

  /** Read an already-aggregated totals_<family>.csv straight into memory. */
  _seedTotalsFile(family, file) {
    const cols = familyCols(family);
    for (const r of this._readCsvRows(file)) {
      const id = String(r.player_id == null ? '' : r.player_id).trim();
      if (!id) continue;
      const a = {
        player_id: id, name: r.name || '',
        matches: num(r.matches), wins: num(r.wins), losses: num(r.losses), draws: num(r.draws),
        score: num(r.score),
      };
      for (const c of cols) a[c] = num(r[c]);
      this._totalsFor(family).set(id, a);
    }
  }

  /** Read player_modes.csv back into memory so restarts keep the mode history. */
  _seedPlayerModes() {
    for (const r of this._readCsvRows(this.file('player_modes.csv'))) {
      const id = String(r.player_id == null ? '' : r.player_id).trim();
      const key = String(r.mode_key == null ? '' : r.mode_key).trim();
      if (!id || !key) continue;
      this._playerModes.set(modeMapKey(id, key), {
        player_id: id, name: r.name || '', mode_key: key, mode_label: r.mode_label || '',
        family: normFamily(r.family), matches: num(r.matches),
        first_played: r.first_played || '', last_played: r.last_played || '',
        wins: num(r.wins), losses: num(r.losses), draws: num(r.draws),
        total_duration_s: num(r.total_duration_s),
      });
    }
  }

  /** Replay a player-row file (new or legacy layout) into the aggregates. */
  _replayRows(file, fallbackFamily, { toTotals, toModes, legacy }) {
    if (!toTotals && !toModes) return;
    for (const r of this._readCsvRows(file)) {
      const id = String(r.player_id == null ? '' : r.player_id).trim();
      if (!id) continue;
      const family = normFamily(r.family || fallbackFamily);
      if (toTotals) this._addToTotals(family, id, r.name, r.result, (k) => num(r[k]), num(r.score));
      if (toModes) {
        const mode = legacy ? LEGACY_MODE : {
          key: r.mode_key || 'unknown',
          label: r.mode_label || '',
          family,
        };
        // Legacy rows only carry a date — good enough for "when", and it sorts
        // correctly against the ISO timestamps of the new rows.
        this._addToModes(id, r.name, mode, family, r.result, num(r.duration_s), r.date || '');
      }
    }
  }

  /** Fold one finalized match's player rows into the per-family totals. */
  _accumulateTotals(rows, family) {
    for (const r of rows) {
      const id = r.player_id == null ? '' : String(r.player_id);
      if (!id) continue;
      this._addToTotals(family, id, r.name, r.result, (k) => num(r[k]), num(r.score));
    }
  }

  _addToTotals(family, id, name, result, statOf, score) {
    const cols = familyCols(family);
    const map = this._totalsFor(family);
    let a = map.get(id);
    if (!a) {
      a = { player_id: id, name, matches: 0, wins: 0, losses: 0, draws: 0, score: 0 };
      cols.forEach((k) => (a[k] = 0));
      map.set(id, a);
    }
    a.name = name || a.name;
    a.matches++;
    if (result === 'win') a.wins++; else if (result === 'loss') a.losses++; else a.draws++;
    a.score += num(score);
    cols.forEach((k) => { a[k] = num(a[k]) + statOf(k); });
  }

  /** Fold one finalized match into the "who played which mode" history. */
  _accumulateModes(rows, mode, family) {
    const when = this._match?.startedAt || new Date().toISOString();
    for (const r of rows) {
      const id = r.player_id == null ? '' : String(r.player_id);
      if (!id) continue;
      this._addToModes(id, r.name, mode, family, r.result, num(r.duration_s), when);
    }
  }

  _addToModes(id, name, mode, family, result, durationS, when) {
    const key = String(mode && mode.key ? mode.key : 'unknown');
    const mapKey = modeMapKey(id, key);
    let a = this._playerModes.get(mapKey);
    if (!a) {
      a = {
        player_id: id, name: name || '', mode_key: key, mode_label: (mode && mode.label) || '',
        family: normFamily(family), matches: 0, first_played: '', last_played: '',
        wins: 0, losses: 0, draws: 0, total_duration_s: 0,
      };
      this._playerModes.set(mapKey, a);
    }
    a.name = name || a.name;
    if (mode && mode.label) a.mode_label = mode.label;
    a.family = normFamily(family || a.family);
    a.matches++;
    if (result === 'win') a.wins++; else if (result === 'loss') a.losses++; else a.draws++;
    a.total_duration_s = num(a.total_duration_s) + num(durationS);
    const stamp = String(when || '');
    if (stamp) {
      if (!a.first_played || stamp < a.first_played) a.first_played = stamp;
      if (!a.last_played || stamp > a.last_played) a.last_played = stamp;
    }
  }

  /**
   * Write totals_<family>.csv from the in-memory Map.
   *
   * Ranked by the profile's most important metric first, then its runner-up
   * (`profileSort()` in gameModes.js — one place, next to the columns).
   */
  _writeTotals(family) {
    const f = normFamily(family);
    const laserball = f === FAMILIES.LASERBALL;
    const [first, second] = profileSort(familyProfile(f)).map(snakeCol);
    const rows = [...this._totalsFor(f).values()]
      .map((a) => (laserball
        ? { ...a, goals_per_match: a.matches ? +(num(a.goals) / a.matches).toFixed(2) : 0 }
        : { ...a, score_per_match: a.matches ? +(num(a.score) / a.matches).toFixed(2) : 0 }))
      .sort((x, y) => num(y[first]) - num(x[first])
        || num(y[second]) - num(x[second])
        || String(x.name).localeCompare(String(y.name), 'de', { sensitivity: 'base' }));
    this._writeCsv(this.file(`totals_${f}.csv`), totalColumns(f), rows, false);
    if (f === FAMILIES.LASERBALL) this._legacyPending = false;
  }

  /** Write player_modes.csv — the answer to "who played which mode, and when". */
  _writePlayerModes() {
    const rows = [...this._playerModes.values()].sort((x, y) =>
      String(x.name).localeCompare(String(y.name), 'de', { sensitivity: 'base' })
      || String(x.family).localeCompare(String(y.family))
      || String(x.mode_key).localeCompare(String(y.mode_key)));
    this._writeCsv(this.file('player_modes.csv'), PLAYER_MODE_COLS, rows, false);
  }

  // ---- csv io ----
  _writeCsv(file, cols, rows, append) {
    const delim = this.cfg.delimiter;
    const body = rows.map((r) => cols.map((c) => csvCell(r[c], delim)).join(delim)).join('\r\n');
    if (append) {
      const exists = fs.existsSync(file);
      const chunk = (exists ? '' : (this.cfg.bom ? '﻿' : '') + cols.join(delim) + '\r\n') + body + (body ? '\r\n' : '');
      fs.appendFileSync(file, chunk);
    } else {
      const chunk = (this.cfg.bom ? '﻿' : '') + cols.join(delim) + '\r\n' + body + (body ? '\r\n' : '');
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, chunk);
      fs.renameSync(tmp, file);
    }
  }

  /** Parse a CSV file of ours into row objects. Missing/broken file -> []. */
  _readCsvRows(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const delim = this.cfg.delimiter;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const header = splitCsv(lines[0], delim);
    const out = [];
    for (const line of lines.slice(1)) {
      const c = splitCsv(line, delim);
      const o = {};
      for (let i = 0; i < header.length; i++) o[header[i]] = c[i];
      out.push(o);
    }
    return out;
  }

  // ---- console helpers ----
  status() {
    return {
      enabled: this.cfg.enabled, dir: this.cfg.dir, delimiter: this.cfg.delimiter,
      recording: !!this._match, matchId: this._match?.matchId || null,
      mode: this._match?.mode ? { ...this._match.mode } : null,
      families: this.totalsFamilies(),
    };
  }

  listFiles() {
    const out = [];
    const root = this.dir();
    const walk = (d, prefix) => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name), prefix + e.name + '/');
        else if (e.name.endsWith('.csv')) {
          const st = fs.statSync(path.join(d, e.name));
          out.push({ name: prefix + e.name, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(root, '');
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  readFile(name) {
    const safeName = String(name).replace(/\\/g, '/');
    if (safeName.includes('..') || safeName.startsWith('/')) return null;
    const full = path.join(this.dir(), safeName);
    if (!full.startsWith(this.dir() + path.sep)) return null;
    try { return fs.readFileSync(full); } catch { return null; }
  }

  // ---- deleting and resetting (console -> Statistik, password confirmed) ----

  /**
   * Resolve a name to a path inside the stats folder, or null. Exactly the
   * handling readFile() uses — backslashes normalised, `..` and absolute paths
   * refused, resolved path must stay inside the folder — plus the rule that a
   * deletable file is a `.csv` and nothing else.
   */
  _resolveCsv(name) {
    const safeName = String(name == null ? '' : name).replace(/\\/g, '/');
    if (!safeName || safeName.includes('..') || safeName.startsWith('/')) return null;
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.csv$/.test(safeName)) return null;
    const full = path.join(this.dir(), safeName);
    if (!full.startsWith(this.dir() + path.sep)) return null;
    return full;
  }

  /**
   * Files inside the stats folder that a delete must never touch. Normally
   * empty: the name list an operator maintains lives in data/roster.csv. But
   * nothing stops him from pointing localRoster.file into the stats folder, and
   * a "reset the statistics" must not eat his player names.
   */
  _protected() {
    const out = new Set();
    try {
      const r = this.getConfig().localRoster;
      if (r && r.file) out.add(path.resolve(process.cwd(), String(r.file)));
    } catch { /* no roster configured */ }
    return out;
  }

  /**
   * What a reset would delete, grouped the way the console names it to the
   * operator. Nothing is deleted here — this is the sentence he reads BEFORE
   * he confirms with his password.
   */
  resetPlan() {
    const skip = this._protected();
    const groups = RESET_GROUPS.map((g) => ({ key: g.key, label: g.label, files: 0, bytes: 0 }));
    let files = 0, bytes = 0;
    for (const f of this.listFiles()) {
      if (skip.has(path.resolve(this.dir(), f.name))) continue;
      const i = RESET_GROUPS.findIndex((g) => g.match(f.name));
      groups[i < 0 ? groups.length - 1 : i].files++;
      groups[i < 0 ? groups.length - 1 : i].bytes += f.size;
      files++; bytes += f.size;
    }
    return { dir: this.dir(), files, bytes, groups };
  }

  /** Delete ONE stats file. The in-memory aggregates follow along. */
  deleteFile(name) {
    const full = this._resolveCsv(name);
    if (!full) return { ok: false, error: 'bad_name' };
    if (this._protected().has(path.resolve(full))) return { ok: false, error: 'protected' };
    if (!fs.existsSync(full)) return { ok: false, error: 'not_found' };
    try { fs.unlinkSync(full); } catch (err) { return { ok: false, error: 'io', hint: err.message }; }
    this._forget(path.basename(full));
    return { ok: true, deleted: 1 };
  }

  /** Delete every stats file and clear the aggregates that feed them. */
  resetAll() {
    const plan = this.resetPlan();
    const skip = this._protected();
    let deleted = 0;
    const failed = [];
    for (const f of this.listFiles()) {
      const full = path.join(this.dir(), f.name);
      if (skip.has(path.resolve(full))) continue;
      try { fs.unlinkSync(full); deleted++; } catch { failed.push(f.name); }
    }
    // the per-match folder is only interesting with files in it
    try { fs.rmdirSync(path.join(this.dir(), 'matches')); } catch { /* not empty or not there */ }
    this.forgetAll();
    return { ok: true, deleted, failed, plan };
  }

  /**
   * Drop every aggregate held in memory.
   *
   * WITHOUT THIS A RESET DOES NOTHING. The grand totals and the mode history do
   * not live in the files — they live in `_totals` and `_playerModes` and are
   * rewritten from memory at the end of every match (_writeTotals /
   * _writePlayerModes). Delete the files alone and the very next mission end
   * writes the old sums straight back.
   */
  forgetAll() {
    this._totals.clear();
    this._playerModes.clear();
    this._lastFamily = null;
    this._legacyPending = false;
  }

  /** Same reconciliation for a single deleted file. */
  _forget(base) {
    const fam = /^totals_([A-Za-z0-9]+)\.csv$/.exec(base);
    if (fam) {
      const f = normFamily(fam[1]);
      this._totals.delete(f);
      if (this._lastFamily === f) this._lastFamily = null;
      if (f === FAMILIES.LASERBALL) this._legacyPending = false;
    }
    if (base === 'player_modes.csv') this._playerModes.clear();
    if (base === 'totals.csv' || base === LEGACY_ALL_PLAYERS) this._legacyPending = false;
  }

  /** Families that actually have a totals file, newest first. */
  totalsFamilies() {
    return FAMILY_LIST
      .map((f) => {
        let mtime = 0;
        try { mtime = fs.statSync(this.file(`totals_${f}.csv`)).mtimeMs; } catch { return null; }
        return { family: f, mtime };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .map((e) => e.family);
  }

  /**
   * Totals as JSON. Without an argument: the family of the match recorded last,
   * else the most recently written totals file, else the pre-mode `totals.csv`
   * of an installation that has not recorded anything since the update.
   */
  totalsJson(family) {
    const wanted = family && FAMILY_LIST.includes(String(family)) ? String(family) : null;
    const names = wanted
      ? [`totals_${wanted}.csv`]
      : [
        ...(this._lastFamily ? [`totals_${this._lastFamily}.csv`] : []),
        ...this.totalsFamilies().map((f) => `totals_${f}.csv`),
        'totals.csv',
      ];
    for (const name of names) {
      const buf = this.readFile(name);
      if (!buf) continue;
      const delim = this.cfg.delimiter;
      const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) continue;
      const header = splitCsv(lines[0], delim);
      return lines.slice(1).map((l) => {
        const c = splitCsv(l, delim);
        const o = {};
        header.forEach((h, i) => (o[h] = c[i]));
        return o;
      });
    }
    return [];
  }
}

// ---- helpers ----

/** Normalize an untrusted family name. Anything unknown -> the default family. */
function normFamily(family) {
  const f = String(family == null ? '' : family).trim().toLowerCase();
  return f === FAMILIES.LASERBALL ? FAMILIES.LASERBALL : (f === FAMILIES.SM5 ? FAMILIES.SM5 : DEFAULT_FAMILY);
}

/** A defensive copy of `state.mode`, or null when the state carries none. */
function pickMode(state) {
  const m = state && state.mode;
  if (!m || typeof m !== 'object' || !m.key) return null;
  return withProfile({
    number: m.number == null ? null : m.number,
    key: String(m.key),
    label: String(m.label == null ? '' : m.label),
    family: normFamily(m.family),
    profile: m.profile,
    known: !!m.known,
    source: String(m.source == null ? '' : m.source),
  });
}

/**
 * Mode for a state that carries none (a hand-built state, or a stream that never
 * sent a type-1 line). The family is inferred from the player objects: SM5
 * players carry SM5 counters, Laserball players never do.
 */
function fallbackMode(state) {
  const mode = { ...resolveModeWithProfile(null, null) };
  try {
    const players = Object.values((state && state.players) || {});
    const sm5 = players.some((p) => p && typeof p.shotsFired === 'number');
    if (players.length && !sm5) {
      mode.family = FAMILIES.LASERBALL;
      // the display profile follows the inferred family
      delete mode.profile;
    }
  } catch (_err) {
    /* keep the default family */
  }
  return withProfile(mode);
}

/** Unambiguous composite key for the player/mode history map. */
function modeMapKey(id, modeKey) { return JSON.stringify([String(id), String(modeKey)]); }

function csvCell(v, delim) {
  const s = v == null ? '' : String(v);
  return /["\r\n]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
}
function splitCsv(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }
/**
 * A number, or an EMPTY cell when there is none.
 *
 * Used for every value that may legitimately not exist yet — the official
 * type-7 measurements (`livesLeft`, `shotsLeft`, …), the derived hit rate, the
 * player level of a feed that does not report one. `num()` would turn all of
 * those into a 0, and a 0 in a statistics table is read as a measurement.
 */
function blank(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : '';
}
/** Memoized camelCase -> snake_case; called once per field per row. */
const SNAKE_CACHE = new Map();
function snakeCol(field) {
  if (!SNAKE_CACHE.has(field)) SNAKE_CACHE.set(field, snake(field));
  return SNAKE_CACHE.get(field);
}
function safe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'match'; }
function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = {
  StatsWriter,
  playerColumns, totalColumns, tailColumns, familyProfile,
  HEAD_COLS, RESULT_COLS, TAIL_COLS, EVENT_COLS, MATCH_COLS, PLAYER_MODE_COLS,
  // kept for compatibility with anything that imported the old constant names
  PLAYER_COLS: playerColumns(FAMILIES.LASERBALL),
  TOTAL_COLS: totalColumns(FAMILIES.LASERBALL),
  csvCell, splitCsv,
};
