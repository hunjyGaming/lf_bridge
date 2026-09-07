'use strict';

const { EventEmitter } = require('events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Central logger. Replaces the scattered console.log calls in the old servers.
 * - keeps a bounded ring buffer so the GUI can show a live tail
 * - emits 'line' events (consumed by the main process -> renderer)
 * - respects a configurable level so per-packet spam can be silenced in production
 */
class Logger extends EventEmitter {
  constructor({ level = 'info', bufferSize = 500 } = {}) {
    super();
    this.setMaxListeners(50);
    this.level = LEVELS[level] || LEVELS.info;
    this.bufferSize = bufferSize;
    this.buffer = [];
  }

  setLevel(level) {
    this.level = LEVELS[level] || LEVELS.info;
  }

  _emit(level, scope, msg) {
    if (LEVELS[level] < this.level) return;
    const entry = {
      ts: Date.now(),
      level,
      scope: scope || '-',
      msg: typeof msg === 'string' ? msg : safeString(msg),
    };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    // Mirror to stdout for headless / dev runs.
    const line = `[${new Date(entry.ts).toISOString()}] ${level.toUpperCase()} ${entry.scope}: ${entry.msg}`;
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    this.emit('line', entry);
  }

  debug(scope, msg) { this._emit('debug', scope, msg); }
  info(scope, msg) { this._emit('info', scope, msg); }
  warn(scope, msg) { this._emit('warn', scope, msg); }
  error(scope, msg) { this._emit('error', scope, msg); }

  tail(n = 200) {
    return this.buffer.slice(-n);
  }
}

function safeString(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { Logger, LEVELS };
