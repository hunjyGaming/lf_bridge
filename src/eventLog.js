'use strict';

const fs = require('fs');
const path = require('path');
const { describe, readable } = require('./eventCatalog');

/**
 * eventLog.js — a human-readable, append-only event-log file.
 *
 * One line per engine event, written next to the CSV stats. Meant to be read,
 * grepped and tailed by a hall operator — not parsed by a machine (the CSV and
 * the JSON API are for that). Nothing leaves the PC.
 *
 * Line format (fixed columns, two-space separated):
 *
 *   2026-09-10 21:14:03  +07:12.900  [mtrsjfzf]  score       Tor für Team Rot (3:2)
 *   └ wall clock ──────┘  └ elapsed ┘  └ match ─┘  └ category┘  └ readable sentence ┘
 *
 * Rotation (config.eventLog.rotate):
 *   'daily'  -> events-YYYY-MM-DD.log   (default)
 *   'match'  -> events-<matchId>.log    (new file on every match_start)
 *   'none'   -> events.log              (single file)
 *
 * Writes go through a small async queue (like logger.js); fs errors are caught
 * and surfaced once via the app logger as a warning — they never reach the
 * caller. A synchronous flush runs on process exit and on shutdown().
 */

// Longest real category ("possession") is 10 chars — pad every category to that
// so the sentence column lines up.
const CAT_WIDTH = 10;
const TYPE_CATEGORY = {
  match_start: 'match', match_end: 'match', match_summary: 'match',
  round_start: 'match', reset: 'combat', score: 'score',
  player_join: 'player', status: 'player', lf_event: 'other',
};

class EventLog {
  /**
   * @param {object} config  the resolved config object (config.data)
   * @param {object} [logger] app logger, for the one-time fs-error warning
   */
  constructor(config, logger) {
    this.log = logger || null;
    const cfg = (config && config.eventLog) || {};
    this.enabled = cfg.enabled !== false;
    this._dirRel = typeof cfg.dir === 'string' && cfg.dir.trim() ? cfg.dir.trim() : 'data/logs';
    this.dir = path.resolve(process.cwd(), this._dirRel);
    this.rotate = ['daily', 'match', 'none'].includes(cfg.rotate) ? cfg.rotate : 'daily';
    this.prefix = String(cfg.filenamePrefix || 'events').replace(/[^a-zA-Z0-9._-]/g, '') || 'events';

    this._queue = [];
    this._writing = false;
    this._dirReady = false;
    this._mkdirPending = false;
    this._warned = false;
    this._matchId = null;

    this._onExit = () => this.flush();
    process.on('exit', this._onExit);
  }

  /** Current target file for the active rotation mode. */
  currentFile() {
    if (this.rotate === 'match') {
      const id = this._matchId ? safeName(this._matchId) : 'pending';
      return path.join(this.dir, `${this.prefix}-${id}.log`);
    }
    if (this.rotate === 'none') return path.join(this.dir, `${this.prefix}.log`);
    return path.join(this.dir, `${this.prefix}-${ymd(new Date())}.log`);
  }

  status() {
    return { enabled: this.enabled, dir: this._dirRel, file: this.currentFile() };
  }

  // ---- engine hooks ----
  onEvent(evt) {
    if (!this.enabled || !evt) return;
    try { this._enqueue(formatLine(evt)); }
    catch (err) { this._warnOnce(err); }
  }

  onMatchStart(snapshot) {
    if (!this.enabled) return;
    try {
      const s = snapshot || {};
      if (this.rotate === 'match' && s.matchId) this._matchId = s.matchId;
      const id = s.matchId || '?';
      const mode = firstStr(s.mode, s.missionType, s.gameMode);
      const n = s.players && typeof s.players === 'object' ? Object.keys(s.players).length : null;
      const parts = [`Match ${id}`];
      if (mode) parts.push(mode);
      if (n) parts.push(`${n} Spieler`);
      parts.push(fmtWall(new Date()));
      this._enqueue(`──── ${parts.join(' · ')} ────`);
    } catch (err) { this._warnOnce(err); }
  }

  onMatchEnd(snapshot) {
    if (!this.enabled) return;
    try {
      const s = snapshot || {};
      const id = s.matchId || '?';
      const sc = scoreText(s.scores);
      const n = s.players && typeof s.players === 'object' ? Object.keys(s.players).length : null;
      const parts = [`Match ${id} beendet`];
      if (sc) parts.push(`Endstand ${sc}`);
      if (n) parts.push(`${n} Spieler`);
      parts.push(fmtWall(new Date()));
      this._enqueue(`──── ${parts.join(' · ')} ────`);
    } catch (err) { this._warnOnce(err); }
  }

  /** Synchronous best-effort flush — process exit / shutdown(). */
  flush() {
    if (!this._queue.length) return;
    const chunk = this._queue.join('');
    this._queue.length = 0;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.currentFile(), chunk);
    } catch (_err) { /* last-resort flush: nothing more we can do */ }
  }

  // ---- internals ----
  _enqueue(line) {
    if (line == null) return;
    this._queue.push(line.endsWith('\n') ? line : `${line}\n`);
    this._drain();
  }

  _drain() {
    if (this._writing || !this._queue.length) return;

    // Create the directory once, keeping every line queued while we wait — so a
    // synchronous flush() during the wait still captures them, in order.
    if (!this._dirReady) {
      if (this._mkdirPending) return;
      this._mkdirPending = true;
      fs.mkdir(this.dir, { recursive: true, mode: 0o700 }, (err) => {
        this._mkdirPending = false;
        if (err && err.code !== 'EEXIST') { this._warnOnce(err); return; }
        this._dirReady = true;
        this._drain();
      });
      return;
    }

    this._writing = true;
    const chunk = this._queue.join('');
    this._queue.length = 0;
    fs.appendFile(this.currentFile(), chunk, (err) => {
      this._writing = false;
      if (err) { this._warnOnce(err); return; }
      if (this._queue.length) this._drain();
    });
  }

  _warnOnce(err) {
    if (this._warned) return;
    this._warned = true;
    const msg = err && err.message ? err.message : String(err);
    if (this.log && typeof this.log.warn === 'function') {
      this.log.warn('eventlog', `write failed, further errors suppressed: ${msg}`);
    }
  }
}

// ---- formatting helpers ----
function formatLine(evt) {
  const wall = fmtWall(evt && evt.ts ? new Date(evt.ts) : new Date());
  const elapsed = fmtElapsed(evt && evt.elapsedMs);
  const mid = `[${shortId(evt && evt.matchId)}]`;
  const cat = padRight(categoryOf(evt), CAT_WIDTH);
  const sentence = sentenceOf(evt);
  return `${wall}  ${elapsed}  ${mid}  ${cat}  ${sentence}`;
}

function categoryOf(evt) {
  const e = evt || {};
  if (typeof e.category === 'string' && e.category) return e.category;
  const info = describe(e.code);
  if (info && info.category && info.status !== 'unknown') return info.category;
  return TYPE_CATEGORY[e.type] || (info && info.category) || 'other';
}

function sentenceOf(evt) {
  // The engine now stamps evt.phrase on every event (engine._enrich); fall back
  // to readable() for events that reach here without it (e.g. direct callers).
  const s = (evt && typeof evt.phrase === 'string' && evt.phrase.trim()) ? evt.phrase : readable(evt);
  return typeof s === 'string' && s.trim() ? s.trim() : `Event ${(evt && evt.code) || (evt && evt.type) || '?'}`;
}

function fmtWall(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtElapsed(ms) {
  const v = Math.max(0, Math.floor(Number(ms) || 0));
  const mmm = String(v % 1000).padStart(3, '0');
  const totalSec = Math.floor(v / 1000);
  const ss = String(totalSec % 60).padStart(2, '0');
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  return `+${mm}:${ss}.${mmm}`;
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function safeName(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40) || 'match';
}

function shortId(id) {
  const s = id == null ? '' : String(id);
  return s ? s.slice(0, 12) : '--------';
}

function padRight(s, w) {
  s = String(s == null ? '' : s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function scoreText(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const vals = Object.keys(scores).sort().map((k) => scores[k]).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return vals.length ? vals.join(':') : null;
}

module.exports = { EventLog };
