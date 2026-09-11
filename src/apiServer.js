'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WEB_DIR = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The console is exactly three files — nothing else under src/web/ is servable.
const STATIC_ALLOW = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
]);

// What a set secret looks like on the wire; posting it back keeps the stored value.
const SECRET_MASK = '••••••';
const WS_PING_MS = 30000;

// File-backed event-log endpoints (docs/LOGGING.md). Only files whose name looks
// like an event-log file are ever listed or streamed.
const EVENTLOG_RE = /^events[A-Za-z0-9._-]*\.log$/;
/** True only for a bare event-log filename — no traversal, no separators, no absolute path. */
function eventLogNameOk(name) {
  return typeof name === 'string' && !!name
    && !name.includes('..') && !/[\\/]/.test(name) && !path.isAbsolute(name)
    && EVENTLOG_RE.test(name);
}
/** List `events*.log` files in `dir`, newest first. Never throws; missing dir -> []. */
function listEventLogFiles(dir) {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && EVENTLOG_RE.test(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/**
 * The one thing the hall LAN talks to: JSON API + WebSocket + the web console,
 * all on a single HTTP port (config.http). Endpoints — docs/API.md.
 *
 * Security model (docs/SECURITY.md):
 *   - optional access token (config.apiToken / LF_API_TOKEN): when set, every
 *     /api/* except /api/health and the WebSocket require it (constant-time compare)
 *   - CORS: only origins in config.cors get Access-Control-Allow-Origin (default:
 *     none), and cross-origin requests can only ever be GET (Allow-Methods: GET, OPTIONS)
 *   - mutating requests without a valid bearer token need Sec-Fetch-Site: same-origin
 *     or the X-LF-Console: 1 header — blocks drive-by CSRF from a page the operator visits
 *   - per-IP rate limit (config.rateLimitPerMin); the client IP comes from the
 *     socket unless config.http.trustProxy is on (then X-Forwarded-For, left-most)
 *   - GET /api/config never returns the access token or an output secret
 *   - every accepted config change is logged at warn level (who + which keys)
 *   - static console: fixed 3-file allowlist, strict CSP, nosniff, DENY framing
 *   - request body capped at 512 KiB; header/request/keep-alive timeouts set
 */
class ApiServer {
  constructor({ logger, config, engine, getStatus, roster, stats, outputs, eventLog, onConfigChange }) {
    this.log = logger;
    this.config = config;
    this.engine = engine;
    this.getStatus = getStatus;
    this.roster = roster;
    this.stats = stats;
    this.outputs = outputs;
    this.eventLog = eventLog || null;
    this.onConfigChange = onConfigChange;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.stateDirty = false;
    this._reaper = null;
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
      // slow-loris / idle-socket budget
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.keepAliveTimeout = 5000;
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
      server.on('close', () => this._stopReaper());
      server.listen(port, host, () => {
        this.server = server; this.wss = wss;
        this._startReaper();
        this.log.info('http', `web console + API on http://${host}:${port}  (ws://${host}:${port}/ws)`);
        if (host === '0.0.0.0' && !this.cfg.apiToken) {
          this.log.warn('http', 'reachable from the whole LAN and no access token set — fine on a trusted event network, otherwise set LF_API_TOKEN');
        }
        resolve();
      });
    });
  }

  stop() {
    this._stopReaper();
    for (const ws of this.clients) { try { ws.close(1001); } catch {} }
    this.clients.clear();
    if (this.wss) { try { this.wss.close(); } catch {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  /** Drop WebSocket clients whose peer vanished without a FIN (dead NAT, sleeping laptop). */
  _startReaper() {
    this._stopReaper();
    this._reaper = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          this.clients.delete(ws);
          try { ws.terminate(); } catch {}
          this.log.info('ws', `client timed out (${this.clientCount})`);
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, WS_PING_MS);
    this._reaper.unref?.();
  }
  _stopReaper() {
    if (this._reaper) clearInterval(this._reaper);
    this._reaper = null;
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
  /** True only if the request itself carries a valid bearer/query token. */
  _hasToken(req, url) {
    const want = this.cfg.apiToken || '';
    return !!want && this._authed(req, url);
  }
  /**
   * CSRF gate for mutating requests that bring no token. A browser either marks
   * the request same-origin itself, or it is our console (which sets X-LF-Console).
   * "same-site"/"none" are NOT accepted — a sibling host must not reconfigure us.
   */
  _sameOrigin(req) {
    if (req.headers['x-lf-console'] === '1') return true;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }
  /**
   * Client IP. Only trusts X-Forwarded-For when config.http.trustProxy is on —
   * otherwise the header is a free-form, spoofable string and is ignored.
   */
  _clientIp(req) {
    if (this.cfg.http?.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        const first = String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket?.remoteAddress || '?';
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
    const ip = this._clientIp(req);

    this._cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // static console
    if (!p.startsWith('/api/') && p !== '/ws') return this._static(p, res);

    if (p === '/api/health') {
      return this._json(res, 200, { ok: true, service: 'lf-live', matchActive: !!this.engine.snapshot().missionActive, ts: Date.now() });
    }

    if (!this._rateOk(ip)) { res.setHeader('Retry-After', '30'); return this._json(res, 429, { error: 'rate_limited' }); }
    if (!this._authed(req, url)) return this._json(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token>' });

    // HEAD is answered like GET (Node drops the body itself) — the console probes
    // HEAD /api/logs/events to decide whether to show the "Datei öffnen" link.
    if (req.method === 'GET' || req.method === 'HEAD') return this._get(p, url, res);

    // Mutating methods: a request without a valid token must prove it is not a
    // cross-site drive-by (browser-set Sec-Fetch-Site, or our own console header).
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (!this._hasToken(req, url) && !this._sameOrigin(req)) {
        this.log.warn('http', `cross-origin ${req.method} ${p} blocked from ${ip}`);
        return this._json(res, 403, { error: 'cross_origin_blocked' });
      }
    }

    if (req.method === 'POST') {
      const body = await this._readBody(req);
      if (body === null) return this._json(res, 400, { error: 'bad_json' });
      return this._post(p, body, res, ip);
    }
    return this._json(res, 405, { error: 'method_not_allowed' });
  }

  /** Resolved event-log location — same handle the engine service reports via getStatus(). */
  _eventLogInfo() {
    try {
      const el = this.eventLog;
      if (!el) return null;
      return {
        enabled: el.enabled !== false,
        dir: el.dir ? path.resolve(el.dir) : null,
        file: typeof el.currentFile === 'function' ? el.currentFile() : null,
      };
    } catch {
      return null;
    }
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
    if (p === '/api/logs/events') {
      const info = this._eventLogInfo();
      if (!info || !info.enabled || !info.dir) return this._json(res, 200, { ok: true, dir: null, current: null, files: [] });
      const files = listEventLogFiles(info.dir);
      const cur = info.file ? path.basename(info.file) : null;
      return this._json(res, 200, { ok: true, dir: info.dir, current: (cur && EVENTLOG_RE.test(cur)) ? cur : null, files });
    }
    if (p === '/api/logs/events/file') {
      const name = url.searchParams.get('name') || '';
      if (!eventLogNameOk(name)) return this._json(res, 400, { error: 'bad_name' });
      const info = this._eventLogInfo();
      if (!info || !info.enabled || !info.dir) return this._json(res, 404, { error: 'not_found' });
      const full = path.join(info.dir, name);
      if (full !== path.join(info.dir, path.basename(name)) || !full.startsWith(info.dir + path.sep)) {
        return this._json(res, 400, { error: 'bad_name' });
      }
      let buf;
      try { buf = fs.readFileSync(full); }
      catch { return this._json(res, 404, { error: 'not_found' }); }
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    }
    if (p === '/api/logs') {
      const n = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      return this._json(res, 200, { data: this.log.tail(n) });
    }
    if (p === '/api/config') return this._json(res, 200, { data: this._redactedConfig(), envPins: this.config.envPins });
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

  // ---- config: never hand out secrets, never lose them on the way back ----
  /** Deep copy of the running config with the token and every output secret removed. */
  _redactedConfig() {
    const c = structuredClone(this.cfg);
    c.apiTokenSet = !!c.apiToken;
    c.apiToken = '';
    for (const o of c.outputs || []) if (o.secret) o.secret = SECRET_MASK;
    return c;
  }
  /**
   * A console that was handed the redacted config posts it straight back. Restore
   * what it could not know: an empty token means "unchanged" (unless the client
   * asks for apiTokenClear), and the mask means "keep the stored secret".
   */
  _unredactPatch(body) {
    const patch = structuredClone(body && typeof body === 'object' ? body : {});
    delete patch.apiTokenSet;
    const clear = patch.apiTokenClear === true;
    delete patch.apiTokenClear;
    if ('apiToken' in patch && patch.apiToken === '' && !clear) delete patch.apiToken;
    if (Array.isArray(patch.outputs)) {
      const stored = this.cfg.outputs || [];
      patch.outputs.forEach((o, i) => {
        if (!o || typeof o !== 'object' || o.secret !== SECRET_MASK) return;
        const prev = (o.id && stored.find((x) => x.id === o.id)) || stored[i];
        o.secret = (prev && prev.secret) || '';
      });
    }
    return patch;
  }
  /** Same restore, for a single output posted to /api/outputs/test. */
  _unredactOutput(o) {
    if (!o || typeof o !== 'object' || o.secret !== SECRET_MASK) return o;
    const stored = this.cfg.outputs || [];
    const prev = stored.find((x) => x.id === o.id);
    return { ...o, secret: (prev && prev.secret) || '' };
  }
  /** Top-level keys whose serialized value differs. Never carries a value. */
  _changedKeys(before, after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  }

  async _post(p, body, res, ip = '?') {
    if (p === '/api/config') {
      const before = structuredClone(this.cfg);
      this.config.update(this._unredactPatch(body));
      this.log.setLevel(this.cfg.logLevel);
      const changed = this._changedKeys(before, this.cfg);
      if (changed.length) {
        this.log.warn('audit', `config changed by ${ip}: ${changed.join(', ')}`);
        await this.onConfigChange();
      }
      return this._json(res, 200, { data: this._redactedConfig(), envPins: this.config.envPins });
    }
    if (p === '/api/roster/reload') {
      this.roster.load();
      this.engine.setRoster(this.roster.getMap());
      return this._json(res, 200, { data: this.roster.status() });
    }
    if (p === '/api/outputs/test') {
      const o = this._unredactOutput(body.output || body.webhook);
      if (!o || typeof o !== 'object') return this._json(res, 400, { error: 'missing output' });
      this.log.warn('audit', `output test by ${ip}: ${o.kind || '?'} "${o.name || o.id || '?'}"`);
      try { return this._json(res, 200, { data: await this.outputs.test(o) }); }
      catch (err) { return this._json(res, 200, { data: { ok: false, error: err.message } }); }
    }
    return this._json(res, 404, { error: 'not_found' });
  }

  _static(p, res) {
    const rel = STATIC_ALLOW.get(p);
    if (!rel) return this._json(res, 404, { error: 'not_found' });
    fs.readFile(path.join(WEB_DIR, rel), (err, buf) => {
      if (err) return this._json(res, 404, { error: 'not_found' });
      this._sendFile(res, path.extname(rel), buf);
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

    // Immediate opener so a fresh client has state before the next shared tick.
    this._safe(ws, { type: 'hello', service: 'lf-live', ts: Date.now() });
    this._safe(ws, { type: 'state', data: this.engine.snapshot() });
  }
  _safe(ws, obj) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} } }

  markDirty() { this.stateDirty = true; }
  broadcastEvent(evt) {
    const payload = JSON.stringify({ type: 'event', data: evt });
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} }
  }
  /** Fan a pre-serialized {type:'state',...} string out to every WS client. */
  pushState(str) {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    if (this.clients.size === 0) return;
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) { try { ws.send(str); } catch {} }
  }
}

module.exports = { ApiServer, listEventLogFiles, eventLogNameOk };
