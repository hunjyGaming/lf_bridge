'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WEB_DIR = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The one thing the hall LAN talks to: JSON API + WebSocket + the web console,
 * all on a single HTTP port (config.http). Endpoints — docs/API.md.
 *
 * Security model (docs/SECURITY.md):
 *   - optional access token (config.apiToken / LF_API_TOKEN): when set, every
 *     /api/* except /api/health and the WebSocket require it (constant-time compare)
 *   - CORS: only origins in config.cors get Access-Control-Allow-Origin, and
 *     cross-origin requests can only ever be GET (Allow-Methods: GET, OPTIONS)
 *   - mutating POST on a token-less instance requires a same-origin request
 *     (Sec-Fetch-Site / Origin) — blocks drive-by CSRF from a page the operator visits
 *   - per-IP rate limit (config.rateLimitPerMin)
 *   - static console served with a strict CSP, nosniff, DENY framing
 *   - request body capped at 512 KiB; static paths are traversal-guarded
 */
class ApiServer {
  constructor({ logger, config, engine, getStatus, roster, stats, outputs, onConfigChange }) {
    this.log = logger;
    this.config = config;
    this.engine = engine;
    this.getStatus = getStatus;
    this.roster = roster;
    this.stats = stats;
    this.outputs = outputs;
    this.onConfigChange = onConfigChange;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this._dirty = false;
    this._flush = null;
    this._rate = new Map();
  }

  get cfg() { return this.config.data; }
  get clientCount() { return this.clients.size; }

  start() {
    return new Promise((resolve, reject) => {
      const { host, port } = this.cfg.http;
      this.stop();

      const server = http.createServer((req, res) => this._route(req, res).catch((err) => {
        this.log.error('http', `unhandled: ${err.stack}`);
        if (!res.headersSent) this._json(res, 500, { error: 'internal' });
      }));
      const wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
        if (url.pathname !== '/ws' || !this._authed(req, url)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => this._onWs(ws));
      });

      server.on('error', (err) => { this.log.error('http', `server error: ${err.message}`); reject(err); });
      server.listen(port, host, () => {
        this.server = server; this.wss = wss;
        this.log.info('http', `web console + API on http://${host}:${port}  (ws://${host}:${port}/ws)`);
        if (host === '0.0.0.0' && !this.cfg.apiToken) {
          this.log.warn('http', 'reachable from the whole LAN and no access token set — fine on a trusted event network, otherwise set LF_API_TOKEN');
        }
        resolve();
      });
    });
  }

  stop() {
    if (this._flush) clearInterval(this._flush);
    this._flush = null;
    for (const ws of this.clients) { try { ws.close(1001); } catch {} }
    this.clients.clear();
    if (this.wss) { try { this.wss.close(); } catch {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  // ---- auth / origin ----
  _token(req, url) {
    const h = req.headers['authorization'];
    if (h && h.startsWith('Bearer ')) return h.slice(7).trim();
    return url.searchParams.get('token') || '';
  }
  _authed(req, url) {
    const want = this.cfg.apiToken || '';
    if (!want) return true;
    const got = Buffer.from(this._token(req, url));
    const exp = Buffer.from(want);
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  }
  _sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin' || site === 'same-site' || site === 'none';
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client (curl, a server-side proxy)
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  _rateOk(ip) {
    const limit = this.cfg.rateLimitPerMin;
    if (!limit) return true;
    const now = Date.now();
    let b = this._rate.get(ip);
    if (!b || now - b.t > 60000) { b = { t: now, n: 0 }; this._rate.set(ip, b); }
    b.n++;
    if (this._rate.size > 4000) this._rate.clear();
    return b.n <= limit;
  }

  // ---- helpers ----
  _cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = this.cfg.cors || [];
    if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (allowed.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  _json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  }
  _readBody(req) {
    return new Promise((resolve) => {
      let d = '', big = false;
      req.on('data', (c) => { d += c; if (d.length > 512 * 1024) { big = true; req.destroy(); } });
      req.on('end', () => { if (big) return resolve(null); try { resolve(JSON.parse(d || '{}')); } catch { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = req.socket.remoteAddress || '?';

    this._cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // static console
    if (!p.startsWith('/api/') && p !== '/ws') return this._static(p, res);

    if (p === '/api/health') {
      return this._json(res, 200, { ok: true, service: 'lf-live', matchActive: !!this.engine.snapshot().missionActive, ts: Date.now() });
    }

    if (!this._rateOk(ip)) { res.setHeader('Retry-After', '30'); return this._json(res, 429, { error: 'rate_limited' }); }
    if (!this._authed(req, url)) return this._json(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token>' });

    if (req.method === 'GET') return this._get(p, url, res);
    if (req.method === 'POST') {
      if (!this.cfg.apiToken && !this._sameOrigin(req)) return this._json(res, 403, { error: 'cross_origin_blocked' });
      const body = await this._readBody(req);
      if (body === null) return this._json(res, 400, { error: 'bad_json' });
      return this._post(p, body, res);
    }
    return this._json(res, 405, { error: 'method_not_allowed' });
  }

  _get(p, url, res) {
    if (p === '/api/state') return this._json(res, 200, { data: this.engine.snapshot() });
    if (p === '/api/teams') { const s = this.engine.snapshot(); return this._json(res, 200, { data: { teams: s.teams, scores: s.scores, missionActive: s.missionActive } }); }
    if (p === '/api/players') return this._json(res, 200, { data: Object.values(this.engine.snapshot().players) });
    if (p === '/api/events') {
      const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
      return this._json(res, 200, { data: this.engine.gameState.events.filter((e) => e.id > since).slice(-limit) });
    }
    if (p === '/api/status') return this._json(res, 200, { data: this.getStatus() });
    if (p === '/api/logs') {
      const n = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      return this._json(res, 200, { data: this.log.tail(n) });
    }
    if (p === '/api/config') return this._json(res, 200, { data: this.cfg, envPins: this.config.envPins });
    if (p === '/api/stats/totals') return this._json(res, 200, { data: this.stats.totalsJson() });
    if (p === '/api/stats/files') return this._json(res, 200, { data: this.stats.listFiles() });
    if (p === '/api/stats/file') {
      const name = url.searchParams.get('name') || '';
      const buf = this.stats.readFile(name);
      if (!buf) return this._json(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    }
    return this._json(res, 404, { error: 'not_found' });
  }

  async _post(p, body, res) {
    if (p === '/api/config') {
      const before = JSON.stringify(this.cfg);
      this.config.update(body);
      this.log.setLevel(this.cfg.logLevel);
      if (before !== JSON.stringify(this.cfg)) await this.onConfigChange();
      return this._json(res, 200, { data: this.cfg, envPins: this.config.envPins });
    }
    if (p === '/api/roster/reload') {
      this.roster.load();
      this.engine.setRoster(this.roster.getMap());
      return this._json(res, 200, { data: this.roster.status() });
    }
    if (p === '/api/outputs/test') {
      const o = body.output || body.webhook;
      if (!o || typeof o !== 'object') return this._json(res, 400, { error: 'missing output' });
      try { return this._json(res, 200, { data: await this.outputs.test(o) }); }
      catch (err) { return this._json(res, 200, { data: { ok: false, error: err.message } }); }
    }
    return this._json(res, 404, { error: 'not_found' });
  }

  _static(p, res) {
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const full = path.join(WEB_DIR, rel);
    if (full !== path.join(WEB_DIR, 'index.html') && !full.startsWith(WEB_DIR + path.sep)) return this._json(res, 403, { error: 'forbidden' });
    fs.readFile(full, (err, buf) => {
      if (err) { fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, idx) => e2 ? this._json(res, 404, { error: 'not_found' }) : this._sendFile(res, '.html', idx)); return; }
      this._sendFile(res, path.extname(full), buf);
    });
  }
  _sendFile(res, ext, buf) {
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(buf);
  }

  // ---- websocket ----
  _onWs(ws) {
    this.clients.add(ws);
    this.log.info('ws', `client connected (${this.clientCount})`);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => {});
    ws.on('error', () => {});
    ws.on('close', () => { this.clients.delete(ws); this.log.info('ws', `client disconnected (${this.clientCount})`); });

    this._safe(ws, { type: 'hello', service: 'lf-live', ts: Date.now() });
    this._safe(ws, { type: 'state', data: this.engine.snapshot() });

    if (!this._flush) {
      this._flush = setInterval(() => this._flushState(), 150);
      this._flush.unref?.();
    }
  }
  _safe(ws, obj) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} } }

  markDirty() { this._dirty = true; }
  broadcastEvent(evt) {
    const payload = JSON.stringify({ type: 'event', data: evt });
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} }
  }
  _flushState() {
    if (!this._dirty || this.clients.size === 0) return;
    this._dirty = false;
    const payload = JSON.stringify({ type: 'state', data: this.engine.snapshot() });
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} }
  }
}

module.exports = { ApiServer };
