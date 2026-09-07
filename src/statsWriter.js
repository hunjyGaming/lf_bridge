'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Match statistics -> CSV files on this PC. Nothing leaves the machine.
 *
 * Files under {csv.dir} (default data/stats/):
 *
 *   matches/<stamp>_<matchId>_players.csv   one row per player, this match
 *   matches/<stamp>_<matchId>_events.csv    every event of this match (if csv.writeEvents)
 *   all_players.csv                         append-only: every player row from every match
 *   totals.csv                              aggregate per player across all matches
 *
 * A match is finalized on the Laserforce "mission end" (0101). If the operator
 * starts a new match without an end, the previous one is still finalized from
 * the last snapshot seen, so nothing is lost.
 */
const PLAYER_COLS = [
  'match_id', 'date', 'player_id', 'name', 'team_id', 'team', 'team_score', 'opp_score', 'result',
  'goals', 'assists',
  'steals_done', 'steals_received', 'blocks_done', 'blocks_received',
  'resets_done', 'resets_received', 'clears_done', 'clears_received',
  'passes_done', 'passes_received', 'duration_s',
];
const EVENT_COLS = [
  'match_id', 'seq', 'elapsed_s', 'wall_time', 'type', 'code',
  'actor_id', 'actor', 'actor_team', 'target_id', 'target', 'target_team', 'assist', 'detail',
];
const TOTAL_COLS = [
  'player_id', 'name', 'matches', 'wins', 'losses', 'draws',
  'goals', 'assists',
  'steals_done', 'steals_received', 'blocks_done', 'blocks_received',
  'resets_done', 'resets_received', 'clears_done', 'clears_received',
  'passes_done', 'passes_received', 'goals_per_match',
];
const STAT_KEYS = PLAYER_COLS.slice(9, 21); // goals..passes_received

class StatsWriter {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;
    this._snap = null;      // deep copy of the latest engine state
    this._match = null;     // { matchId, stamp, startedAt, events: [], finalized }
    this._liveTimer = null;
  }

  get cfg() { return this.getConfig().csv; }
  dir() { return path.resolve(process.cwd(), this.cfg.dir); }

  // ---- engine hooks ----
  onChange(state) {
    this._snap = structuredClone(state);
    if (this.cfg.enabled && this.cfg.writeLive && this._match && !this._liveTimer) {
      this._liveTimer = setTimeout(() => { this._liveTimer = null; this._writeMatchPlayers(this._snap, false); }, 1500);
    }
  }

  onEvent(evt) {
    if (this._match) this._match.events.push(evt);
  }

  onMatchStart(state) {
    // finalize a previous match that never got an explicit end
    if (this._match && !this._match.finalized && this._snap) {
      this.log.info('stats', `finalizing previous match ${this._match.matchId} (no end event)`);
      this._finalize(this._snap);
    }
    const now = new Date();
    this._match = {
      matchId: state.matchId || `m${now.getTime()}`,
      stamp: stampOf(now),
      startedAt: now.toISOString(),
      events: [],
      finalized: false,
    };
    this.log.info('stats', `recording match ${this._match.matchId}`);
  }

  onMatchEnd(state) {
    if (!this._match) {
      // an end without a start we saw — synthesize a context
      this.onMatchStart(state);
    }
    this._finalize(structuredClone(state));
  }

  // ---- finalize ----
  _finalize(state) {
    if (!this.cfg.enabled) { this._match = null; return; }
    try {
      fs.mkdirSync(path.join(this.dir(), 'matches'), { recursive: true });
      const rows = this._playerRows(state);
      this._writeMatchPlayers(state, true, rows);
      if (this.cfg.writeEvents) this._writeMatchEvents();
      this._appendAll(rows);
      this._rebuildTotals();
      this.log.info('stats', `match ${this._match.matchId}: wrote ${rows.length} player rows`);
    } catch (err) {
      this.log.error('stats', `finalize failed: ${err.stack}`);
    }
    if (this._match) this._match.finalized = true;
    this._match = null;
  }

  _playerRows(state) {
    const m = this._match;
    const date = m.startedAt.slice(0, 10);
    const durationS = Math.round((state.elapsedTime || 0) / 1000);
    const scores = state.scores || {};
    return Object.values(state.players || {}).map((p) => {
      const teamScore = scores[p.teamId] ?? 0;
      const oppScore = Math.max(0, ...Object.entries(scores).filter(([k]) => k !== String(p.teamId)).map(([, v]) => v), 0);
      const result = teamScore > oppScore ? 'win' : teamScore < oppScore ? 'loss' : 'draw';
      const team = state.teams?.[p.teamId]?.name || `Team ${p.teamId}`;
      return {
        match_id: m.matchId, date, player_id: p.id, name: p.name, team_id: p.teamId, team,
        team_score: teamScore, opp_score: oppScore, result,
        goals: p.goals, assists: p.assists,
        steals_done: p.stealsDone, steals_received: p.stealsReceived,
        blocks_done: p.blocksDone, blocks_received: p.blocksReceived,
        resets_done: p.resetsDone, resets_received: p.resetsReceived,
        clears_done: p.clearsDone, clears_received: p.clearsReceived,
        passes_done: p.passesDone, passes_received: p.passesReceived,
        duration_s: durationS,
      };
    });
  }

  _writeMatchPlayers(state, final, rows) {
    if (!this._match) return;
    rows = rows || this._playerRows(state);
    const file = path.join(this.dir(), 'matches', `${this._match.stamp}_${safe(this._match.matchId)}_players.csv`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this._writeCsv(file, PLAYER_COLS, rows, false);
  }

  _writeMatchEvents() {
    const file = path.join(this.dir(), 'matches', `${this._match.stamp}_${safe(this._match.matchId)}_events.csv`);
    const rows = this._match.events.map((e) => ({
      match_id: this._match.matchId, seq: e.id, elapsed_s: ((e.elapsedMs || 0) / 1000).toFixed(1),
      wall_time: new Date(e.ts).toISOString(), type: e.type, code: e.code || '',
      actor_id: e.actorId || '', actor: e.actorName || '', actor_team: e.actorTeamId || '',
      target_id: e.targetId || '', target: e.targetName || '', target_team: e.targetTeamId || '',
      assist: e.assistName || '', detail: e.text || '',
    }));
    this._writeCsv(file, EVENT_COLS, rows, false);
  }

  _appendAll(rows) {
    const file = path.join(this.dir(), 'all_players.csv');
    this._writeCsv(file, PLAYER_COLS, rows, true);
  }

  _rebuildTotals() {
    const file = path.join(this.dir(), 'all_players.csv');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const delim = this.cfg.delimiter;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const header = splitCsv(lines[0], delim);
    const idx = (k) => header.indexOf(k);
    const agg = new Map();
    for (const line of lines.slice(1)) {
      const c = splitCsv(line, delim);
      const id = c[idx('player_id')];
      if (!id) continue;
      let a = agg.get(id);
      if (!a) { a = { player_id: id, name: c[idx('name')], matches: 0, wins: 0, losses: 0, draws: 0 }; STAT_KEYS.forEach((k) => (a[k] = 0)); agg.set(id, a); }
      a.name = c[idx('name')] || a.name;
      a.matches++;
      const r = c[idx('result')];
      if (r === 'win') a.wins++; else if (r === 'loss') a.losses++; else a.draws++;
      STAT_KEYS.forEach((k) => { a[k] += num(c[idx(k)]); });
    }
    const rows = [...agg.values()]
      .map((a) => ({ ...a, goals_per_match: a.matches ? +(a.goals / a.matches).toFixed(2) : 0 }))
      .sort((x, y) => y.goals - x.goals || y.assists - x.assists);
    this._writeCsv(path.join(this.dir(), 'totals.csv'), TOTAL_COLS, rows, false);
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

  // ---- console helpers ----
  status() {
    return {
      enabled: this.cfg.enabled, dir: this.cfg.dir, delimiter: this.cfg.delimiter,
      recording: !!this._match, matchId: this._match?.matchId || null,
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

  totalsJson() {
    const buf = this.readFile('totals.csv');
    if (!buf) return [];
    const delim = this.cfg.delimiter;
    const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const header = splitCsv(lines[0], delim);
    return lines.slice(1).map((l) => {
      const c = splitCsv(l, delim);
      const o = {};
      header.forEach((h, i) => (o[h] = c[i]));
      return o;
    });
  }
}

// ---- helpers ----
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
function num(v) { const n = parseFloat(v); return Number.isNaN(n) ? 0 : n; }
function safe(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'match'; }
function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { StatsWriter, PLAYER_COLS, EVENT_COLS, TOTAL_COLS, csvCell, splitCsv };
