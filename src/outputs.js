'use strict';

const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');

/**
 * Outputs — every place match data is pushed TO. Configured in the console.
 *
 * kind = "webhook"  HTTP POST per event (optional HMAC signature)
 * kind = "tcp"      outbound TCP client to host:port, newline-delimited JSON
 * kind = "udp"      UDP datagrams to host:port, one JSON per packet
 *
 * All three carry the same envelope as the WebSocket feed:
 *   {"type":"event","data":{…}}      one per event
 *   {"type":"state","data":{…}}      snapshot, only if the output has sendState
 *
 * TCP outputs hold the connection open and reconnect with backoff. A dead
 * output never blocks the engine or the other outputs.
 */
class Outputs {
  constructor({ logger, getConfig, getState }) {
    this.log = logger;
    this.getConfig = getConfig;
    this.getState = getState;
    this.status = {};              // id -> { ok, detail, at }
    this._tcp = new Map();         // id -> { socket, connected, queue, backoff, timer, closed }
    this._udp = dgram.createSocket('udp4');
    this._udp.on('error', (e) => this.log.warn('output', `udp socket: ${e.message}`));
    this._stateThrottle = new Map(); // id -> last sent ts
    this._denyWarn = new Map();      // id -> last warn ts (keeps a blocked target from flooding the log)
    this.stateDirty = false;
  }

  list() { return this.getConfig().outputs || []; }
  get(id) { return this.list().find((o) => o.id === id) || null; }

  /**
   * Optional egress allowlist (config.outputAllow / LF_OUTPUT_ALLOW).
   * Empty list = allow everything (the historical behaviour).
   */
  allowed(o) {
    const list = this.getConfig().outputAllow || [];
    if (!list.length) return true;
    const t = targetHostPort(o);
    if (!t || !t.host) return false;
    return list.some((entry) => entryMatches(entry, t));
  }
  _denied(o, label) {
    const t = targetHostPort(o);
    const where = t ? `${t.host}:${t.port || '?'}` : '?';
    const now = Date.now();
    if (now - (this._denyWarn.get(o.id) || 0) > 30000) {
      this._denyWarn.set(o.id, now);
      this.log.warn('output', `"${o.name}" -> ${where} blocked by outputAllow — not sending (${label})`);
    }
    this.status[o.id] = { ok: false, detail: 'blocked by outputAllow', at: now };
  }

  /** Called once at boot and after every config change. */
  reconcile() {
    const want = new Map(this.list().filter((o) => o.kind === 'tcp' && o.enabled && this.allowed(o)).map((o) => [o.id, o]));
    for (const o of this.list()) if (o.kind === 'tcp' && o.enabled && !this.allowed(o)) this._denied(o, 'connect');
    // drop TCP connections that are gone or disabled or changed target
    for (const [id, conn] of this._tcp) {
      const o = want.get(id);
      if (!o || `${o.host}:${o.port}` !== conn.target) { this._closeTcp(id); }
    }
    // open TCP connections that are new
    for (const [id, o] of want) {
      if (!this._tcp.has(id)) this._openTcp(o);
    }
    // prune status of deleted outputs
    const ids = new Set(this.list().map((o) => o.id));
    for (const id of Object.keys(this.status)) if (!ids.has(id)) delete this.status[id];
  }

  stop() {
    for (const id of [...this._tcp.keys()]) this._closeTcp(id);
    try { this._udp.close(); } catch {}
  }

  statusList() {
    return this.list().map((o) => ({
      id: o.id, name: o.name, kind: o.kind, enabled: o.enabled,
      target: o.kind === 'webhook' ? o.url : `${o.host}:${o.port}`,
      last: this.status[o.id] || null,
      connected: o.kind === 'tcp' ? !!this._tcp.get(o.id)?.connected : undefined,
    }));
  }

  // ---- dispatch ----
  onEvent(evt) {
    for (const o of this.list()) {
      if (!o.enabled || o.sendEvents === false) continue;
      const evs = o.events || ['*'];
      if (!evs.includes('*') && !evs.includes(evt.type)) continue;
      this._send(o, { type: 'event', data: evt }, evt.type);
    }
  }

  markDirty() { this.stateDirty = true; }

  /**
   * Shared state tick (src/index.js): `snapshot` is engine.snapshot() and `str`
   * is the already-serialized {type:'state',data:snapshot}. Reuse `str` for the
   * newline-delimited tcp/udp targets; the webhook path keeps its own envelope.
   * Per-output 500 ms throttle (max 2/s) is unchanged.
   */
  pushState(snapshot, str) {
    this.stateDirty = false;
    const now = Date.now();
    const line = str + '\n';
    for (const o of this.list()) {
      if (!o.enabled || !o.sendState) continue;
      if (now - (this._stateThrottle.get(o.id) || 0) < 500) continue; // max 2/s per output
      this._stateThrottle.set(o.id, now);
      if (!this.allowed(o)) { this._denied(o, 'state'); continue; }
      if (o.kind === 'webhook') { this._sendWebhook(o, snapshot, 'state'); continue; }
      if (o.kind === 'udp') {
        this._udp.send(Buffer.from(line), o.port, o.host, (err) => {
          this.status[o.id] = err ? { ok: false, detail: err.message, at: Date.now() } : { ok: true, detail: 'state', at: Date.now() };
        });
        continue;
      }
      if (o.kind === 'tcp') {
        const conn = this._tcp.get(o.id);
        if (conn && conn.connected) { conn.socket.write(line); this.status[o.id] = { ok: true, detail: 'state', at: Date.now() }; }
        else { this.status[o.id] = { ok: false, detail: 'not connected', at: Date.now() }; }
        continue;
      }
    }
  }

  _send(o, envelope, label) {
    if (!this.allowed(o)) return this._denied(o, label);
    if (o.kind === 'webhook') return this._sendWebhook(o, envelope.data, label);
    const line = JSON.stringify(envelope) + '\n';
    if (o.kind === 'udp') {
      const buf = Buffer.from(line);
      this._udp.send(buf, o.port, o.host, (err) => {
        this.status[o.id] = err ? { ok: false, detail: err.message, at: Date.now() } : { ok: true, detail: label, at: Date.now() };
      });
      return;
    }
    if (o.kind === 'tcp') {
      const conn = this._tcp.get(o.id);
      if (conn && conn.connected) {
        conn.socket.write(line);
        this.status[o.id] = { ok: true, detail: label, at: Date.now() };
      } else {
        this.status[o.id] = { ok: false, detail: 'not connected', at: Date.now() };
      }
    }
  }

  // ---- webhook ----
  async _sendWebhook(o, data, label, attempt = 1) {
    const ts = Date.now();
    const payload = { event: data.type, ts, data };
    if (o.includeState || o.sendState) payload.state = this.getState();
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'lf-live/1.0',
      'X-LFB-Event': data.type,
      'X-LFB-Timestamp': String(ts),
    };
    if (o.secret) headers['X-LFB-Signature'] = 'sha256=' + crypto.createHmac('sha256', o.secret).update(`${ts}.${body}`).digest('hex');

    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(o.url, { method: 'POST', headers, body, signal: ctl.signal });
      this.status[o.id] = { ok: res.ok, detail: `HTTP ${res.status}`, at: Date.now() };
      if (!res.ok && attempt < 3) { clearTimeout(to); await sleep(attempt * 1000); return this._sendWebhook(o, data, label, attempt + 1); }
    } catch (err) {
      if (attempt < 3) { clearTimeout(to); await sleep(attempt * 1000); return this._sendWebhook(o, data, label, attempt + 1); }
      this.status[o.id] = { ok: false, detail: err.message, at: Date.now() };
    } finally {
      clearTimeout(to);
    }
  }

  // ---- tcp client ----
  _openTcp(o) {
    const target = `${o.host}:${o.port}`;
    const conn = { socket: null, connected: false, target, backoff: 1000, timer: null, closed: false };
    this._tcp.set(o.id, conn);

    const connect = () => {
      if (conn.closed) return;
      const socket = net.connect({ host: o.host, port: o.port });
      conn.socket = socket;
      socket.setNoDelay(true);
      socket.on('connect', () => {
        conn.connected = true;
        conn.backoff = 1000;
        this.log.info('output', `tcp "${o.name}" connected -> ${target}`);
        this.status[o.id] = { ok: true, detail: 'connected', at: Date.now() };
        socket.write(JSON.stringify({ type: 'hello', service: 'lf-live', ts: Date.now() }) + '\n');
        if (o.sendState) socket.write(JSON.stringify({ type: 'state', data: this.getState() }) + '\n');
      });
      socket.on('error', (err) => {
        this.status[o.id] = { ok: false, detail: err.code || err.message, at: Date.now() };
      });
      socket.on('close', () => {
        conn.connected = false;
        if (conn.closed) return;
        conn.timer = setTimeout(connect, conn.backoff);
        conn.backoff = Math.min(conn.backoff * 2, 30000);
      });
    };
    connect();
  }

  _closeTcp(id) {
    const conn = this._tcp.get(id);
    if (!conn) return;
    conn.closed = true;
    if (conn.timer) clearTimeout(conn.timer);
    try { conn.socket?.destroy(); } catch {}
    this._tcp.delete(id);
  }

  // ---- test ----
  async test(o) {
    const evt = { id: 0, ts: Date.now(), type: 'test', text: 'lf-live test event', elapsedMs: 0 };
    if (!this.allowed(o)) { this._denied(o, 'test'); return { ok: false, detail: 'blocked by outputAllow', at: Date.now() }; }
    if (o.kind === 'webhook') {
      await this._sendWebhook(o, evt, 'test');
      return this.status[o.id] || { ok: true, at: Date.now() };
    }
    if (o.kind === 'udp') {
      await new Promise((resolve) => {
        this._udp.send(Buffer.from(JSON.stringify({ type: 'event', data: evt }) + '\n'), o.port, o.host, (err) => {
          this.status[o.id] = err ? { ok: false, detail: err.message, at: Date.now() } : { ok: true, detail: 'sent', at: Date.now() };
          resolve();
        });
      });
      return this.status[o.id];
    }
    if (o.kind === 'tcp') {
      // one-shot connect, send, close — doesn't disturb a live connection
      return await new Promise((resolve) => {
        const s = net.connect({ host: o.host, port: o.port });
        const done = (ok, detail) => { try { s.destroy(); } catch {} this.status[o.id] = { ok, detail, at: Date.now() }; resolve(this.status[o.id]); };
        s.setTimeout(4000);
        s.on('connect', () => { s.write(JSON.stringify({ type: 'event', data: evt }) + '\n'); setTimeout(() => done(true, 'sent'), 100); });
        s.on('timeout', () => done(false, 'timeout'));
        s.on('error', (err) => done(false, err.code || err.message));
      });
    }
    return { ok: false, detail: 'unknown kind', at: Date.now() };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** { host, port } an output would talk to, lower-cased; null if it is unusable. */
function targetHostPort(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.kind === 'webhook') {
    try {
      const u = new URL(o.url);
      return { host: u.hostname.toLowerCase(), port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80) };
    } catch { return null; }
  }
  return { host: String(o.host || '').trim().toLowerCase(), port: parseInt(o.port, 10) || 0 };
}

/** One allowlist entry: "host", "host:port", "*.suffix", "*.suffix:port". */
function entryMatches(entry, t) {
  let pat = String(entry || '').trim().toLowerCase();
  if (!pat) return false;
  let port = null;
  const c = pat.lastIndexOf(':');
  if (c > 0 && /^[0-9]+$/.test(pat.slice(c + 1)) && pat.indexOf(':') === c) {
    port = parseInt(pat.slice(c + 1), 10);
    pat = pat.slice(0, c);
  }
  if (port !== null && port !== t.port) return false;
  if (pat.startsWith('*.')) return t.host.endsWith(pat.slice(1)); // "*.example.com" -> ".example.com"
  return t.host === pat;
}

module.exports = { Outputs };
