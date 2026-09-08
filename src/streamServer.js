'use strict';

const net = require('net');
const crypto = require('crypto');

const AUTH_TIMEOUT_MS = 2000;
const AUTH_MAX_BYTES = 4096;

/**
 * Raw TCP stream server. For tools that speak plain sockets rather than HTTP or
 * WebSocket (broadcast controllers, custom overlays, quick `nc` checks).
 *
 * When an access token is configured (config.apiToken / LF_API_TOKEN), a client
 * must send `{"token":"<value>"}\n` as its very first line within 2 s; anything
 * else drops the connection. Without a token the server behaves as before.
 *
 * Any client that connects (and, if required, authenticates) receives, as
 * newline-delimited JSON:
 *   {"type":"hello","service":"lf-live","ts":...}
 *   {"type":"state","data":{…}}          once
 *   {"type":"event","data":{…}}          per event
 *   {"type":"state","data":{…}}          on change, throttled ~5/s
 *
 * Read-only: anything a client sends is ignored. Off by default; binds to
 * 127.0.0.1 unless LF_STREAM_HOST widens it. Enable + set port/host in the
 * console under Ausgänge, or via LF_STREAM_* in .env.
 */
class StreamServer {
  constructor({ logger, getConfig, getState }) {
    this.log = logger;
    this.getConfig = getConfig;
    this.getState = getState;
    this.server = null;
    this.clients = new Set();
    this.port = null;
    this.host = null;
    this.stateDirty = false;
  }

  get clientCount() { return this.clients.size; }

  reconcile() {
    const cfg = this.getConfig().streamServer || {};
    const wantPort = cfg.enabled ? cfg.port : null;
    const wantHost = cfg.host || '127.0.0.1';
    if (wantPort === this.port && wantHost === this.host) return;
    this.stop();
    if (!wantPort) return;

    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket.on('error', () => {});
      const want = this.getConfig().apiToken || '';
      if (!want) return this._admit(socket);

      // token gate: first line must be {"token":"…"} and arrive quickly
      let buf = '';
      const peer = socket.remoteAddress;
      const reject = (why) => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        this.log.warn('stream', `auth rejected (${why}) ${peer}`);
        try { socket.destroy(); } catch {}
      };
      const timer = setTimeout(() => reject('timeout'), AUTH_TIMEOUT_MS);
      timer.unref?.();
      const onData = (chunk) => {
        buf += chunk;
        const i = buf.indexOf('\n');
        if (i < 0) { if (buf.length > AUTH_MAX_BYTES) reject('oversized'); return; }
        const line = buf.slice(0, i);
        const rest = buf.slice(i + 1);
        let got = null;
        try { const o = JSON.parse(line); if (o && typeof o.token === 'string') got = o.token; } catch {}
        if (got === null || !timingSafeEqualStr(got, want)) return reject('bad token');
        clearTimeout(timer);
        socket.removeListener('data', onData);
        void rest; // anything a client sends is ignored, as before
        this._admit(socket);
      };
      socket.on('data', onData);
      socket.on('close', () => { clearTimeout(timer); });
    });
    server.on('error', (err) => this.log.error('stream', `server error: ${err.message}`));
    server.listen(wantPort, wantHost, () => {
      this.server = server;
      this.port = wantPort;
      this.host = wantHost;
      this.log.info('stream', `raw TCP stream on ${wantHost}:${wantPort}`);
    });
  }

  /** Add an (authenticated) socket to the broadcast set and send the opener. */
  _admit(socket) {
    this.clients.add(socket);
    this.log.info('stream', `client connected (${this.clientCount}) ${socket.remoteAddress}`);
    this._write(socket, { type: 'hello', service: 'lf-live', ts: Date.now() });
    this._write(socket, { type: 'state', data: this.getState() });
    socket.on('data', () => {});
    socket.on('close', () => { this.clients.delete(socket); this.log.info('stream', `client left (${this.clientCount})`); });
  }

  stop() {
    for (const s of this.clients) { try { s.destroy(); } catch {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    this.port = null;
    this.host = null;
  }

  _write(socket, obj) {
    try { socket.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  markDirty() { this.stateDirty = true; }

  broadcastEvent(evt) {
    const line = JSON.stringify({ type: 'event', data: evt }) + '\n';
    for (const s of this.clients) { try { s.write(line); } catch {} }
  }

  /** Fan a pre-serialized {type:'state',...} string out to every raw-TCP client. */
  pushState(str) {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    if (this.clients.size === 0) return;
    const line = str + '\n';
    for (const s of this.clients) { try { s.write(line); } catch {} }
  }
}

/** Constant-time string compare; length is checked first (lengths are not secret). */
function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { StreamServer };
