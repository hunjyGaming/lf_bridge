'use strict';

const { EventEmitter } = require('events');
const { describe, phrase, readable } = require('./eventCatalog');

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
  '0300': 'missile_lock', '0301': 'missile_miss', '0303': 'missile_destroy',
  '0304': 'missile_miss', '0306': 'missile_hit', '0308': 'missile_hit',
};

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
  goal: 'score', score: 'score',
  pass: 'possession', steal: 'possession', clear: 'possession', get_ball: 'possession',
  reset: 'possession', failed_clear: 'possession',
  player_join: 'player', player_leave: 'player', resupply: 'player', status: 'player',
  block: 'combat',
  miss: 'combat', player_hit: 'combat', player_deactivate: 'combat',
  target_hit: 'combat', target_destroy: 'combat', warbot_deactivate: 'combat',
  missile_lock: 'combat', missile_miss: 'combat', missile_hit: 'combat', missile_destroy: 'combat',
};

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
  constructor({ logger, defaultDurationMs = 720000, emitUnknownEvents = true } = {}) {
    super();
    this.log = logger;
    this.defaultDurationMs = defaultDurationMs;
    // Additive only: when true, every type-4 code the core parser does not act on
    // still surfaces as a generic `lf_event`. Never changes an existing branch.
    this.emitUnknownEvents = emitUnknownEvents !== false;
    this.dbPlayersMap = {};
    this.reset();
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
    };
    this.livePassesStream = [];
    this.playerStatusMap = {};
    this._eventSeq = 0;
    this._dirty = false;
    this._teamNamesDirty = false;
    this._teamNamesScheduled = false;
  }

  setRoster(map) {
    this.dbPlayersMap = map || {};
  }

  /** Snapshot for API consumers. */
  snapshot() {
    // resolveTeamNames() is debounced off the per-login hot path; make sure any
    // pending resolution is applied before an external observer reads the state.
    if (this._teamNamesDirty) this._flushTeamNames();
    return this.gameState;
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
    this.gameState.updatedAt = Date.now();
    this._dirty = true;
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
  _emitAuxEvent(code, actorId, targetId) {
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
      evt.text = phrase(evt);
      this._pushEvent(evt);
    } catch (_err) {
      // aux surfacing must never disrupt the parser
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
        gameState.teams[tId].name = bestName;
      }
    }
  }

  /** Feed one already-trimmed log line. */
  processLogLine(line) {
    const gameState = this.gameState;
    const dbPlayersMap = this.dbPlayersMap;
    const cleanId = Engine.cleanId;

    if (line.startsWith(';') || !line) return;
    const cols = line.split(/\s+/).filter(Boolean);
    const type = cols[0];

    // Mission total length (second-to-last column of a type-1 line)
    if (type === '1') {
      const durationStr = cols[cols.length - 2];
      if (!isNaN(durationStr)) {
        gameState.duration = parseInt(durationStr);
      }
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
    //    The core parser only reads their `time` column (elapsedTime, above) and
    //    otherwise ignores them — gameState.scores stays derived from the
    //    1101/1102 goal path. These events are informational: no gameState
    //    mutation, no _touch(). Reaching here means the line already did its
    //    (only) existing job of updating elapsedTime.
    if (type === '5') {
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
      this._pushEvent({
        type: 'match_summary', code: '6', category: 'match',
        entityId, exitCode, score, cols: cols.slice(1),
        text: `Abschluss ${entityId ?? '?'} (Exit ${exitCode ?? '?'}, Score ${score ?? '?'})`,
      });
      return;
    }

    if (type === '4' && cols[2] === '0100') {
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

      this._pushEvent({ type: 'match_start', text: 'Match started' });
      this.emit('match_start', {});
      this._touch();
      return;
    }

    if (type === '4' && cols[2] === '0101') {
      gameState.missionActive = false;
      gameState.ballHolderId = null;
      this.livePassesStream = [];
      this._pushEvent({ type: 'match_end', text: 'Match ended' });
      this.emit('match_end', { scores: { ...gameState.scores } });
      this._touch();
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
      const teamName = (hexIndex !== -1 && hexIndex >= 4)
        ? cols.slice(2, hexIndex - 2).join(' ')
        : cols[2];

      gameState.teams[teamIndex] = { name: teamName, color: color };
      if (gameState.scores[teamIndex] === undefined) gameState.scores[teamIndex] = 0;
      this._touch();
      return;
    }

    if (type === '3') {
      const typeIdx = cols.indexOf('player');

      if (typeIdx !== -1) {
        const id = cleanId(cols[typeIdx - 1]);

        // Find the signature Team/Level/Category cluster: three numbers in a row.
        let teamIdIdx = typeIdx + 1;
        while (teamIdIdx < cols.length - 2) {
          if (!isNaN(cols[teamIdIdx]) && !isNaN(cols[teamIdIdx + 1]) && !isNaN(cols[teamIdIdx + 2])) {
            break;
          }
          teamIdIdx++;
        }

        const teamId = cols[teamIdIdx];
        const lfName = cols.slice(typeIdx + 1, teamIdIdx).join(' ');

        const dbInfo = dbPlayersMap[id];
        const finalName = dbInfo ? dbInfo.nick : lfName;
        const finalAvatar = dbInfo ? dbInfo.avatar : null;

        if (teamId !== '5') {
          this.log?.debug('engine', `Player logged in: ${finalName} (Team ${teamId})`);
          gameState.players[id] = {
            id: id, name: finalName, teamId: teamId, avatar: finalAvatar,
            status: 0, goals: 0, assists: 0,
            stealsDone: 0, stealsReceived: 0, blocksDone: 0, blocksReceived: 0,
            resetsDone: 0, resetsReceived: 0, clearsDone: 0, clearsReceived: 0,
            passesDone: 0, passesReceived: 0,
          };
          this.playerStatusMap[id] = 0;
          this._scheduleTeamNames();
          this._pushEvent({ type: 'player_join', actorId: id, actorName: finalName, teamId, text: `${finalName} joined team ${teamId}` });
          this._touch();
        }
      }
      return;
    }

    if (type === '4') {
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
      this._emitAuxEvent(code, actorId, targetId);

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
          if (gameState.scores[teamId] !== undefined) gameState.scores[teamId]++;

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

module.exports = { Engine };
