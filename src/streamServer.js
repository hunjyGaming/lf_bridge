'use strict';

const net = require('net');

/**
 * Raw TCP stream server. For tools that speak plain sockets rather than HTTP or
 * WebSocket (broadcast controllers, custom overlays, quick `nc` checks).
 *
 * Any client that connects immediately receives, as newline-delimited JSON:
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
    this._dirty = false;
    this._flush = null;
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
      this.clients.add(socket);
      socket.setNoDelay(true);
      this.log.info('stream', `client connected (${this.clientCount}) ${socket.remoteAddress}`);
      this._write(socket, { type: 'hello', service: 'lf-live', ts: Date.now() });
      this._write(socket, { type: 'state', data: this.getState() });
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => { this.clients.delete(socket); this.log.info('stream', `client left (${this.clientCount})`); });
    });
    server.on('error', (err) => this.log.error('stream', `server error: ${err.message}`));
    server.listen(wantPort, wantHost, () => {
      this.server = server;
      this.port = wantPort;
      this.host = wantHost;
      this.log.info('stream', `raw TCP stream on ${wantHost}:${wantPort}`);
    });

    if (!this._flush) {
      this._flush = setInterval(() => this._flushState(), 200);
      this._flush.unref?.();
    }
  }

  stop() {
    if (this._flush) { clearInterval(this._flush); this._flush = null; }
    for (const s of this.clients) { try { s.destroy(); } catch {} }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    this.port = null;
    this.host = null;
  }

  _write(socket, obj) {
    try { socket.write(JSON.stringify(obj) + '\n'); } catch {}
  }

  markDirty() { this._dirty = true; }

  broadcastEvent(evt) {
    const line = JSON.stringify({ type: 'event', data: evt }) + '\n';
    for (const s of this.clients) { try { s.write(line); } catch {} }
  }

  _flushState() {
    if (!this._dirty || this.clients.size === 0) return;
    this._dirty = false;
    const line = JSON.stringify({ type: 'state', data: this.getState() }) + '\n';
    for (const s of this.clients) { try { s.write(line); } catch {} }
  }
}

module.exports = { StreamServer };
