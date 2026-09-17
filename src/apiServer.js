'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const {
  hashPassword, verifyPassword, passwordProblem,
  SessionStore, LoginGuard, RecoveryCode, parseCookies,
} = require('./auth');
const { reachability } = require('./netinfo');
const {
  FAMILIES, DEFAULT_FAMILY, DEFAULT_PROFILE, PROFILE_LIST, FAMILY_DEFAULT_PROFILE,
  listModes, listProfiles, scoreboardColumns, metricLabels, metricGroups, profileLabel,
} = require('./gameModes');

/** The only family names a request may name. Everything else falls back. */
const FAMILY_KEYS = [FAMILIES.LASERBALL, FAMILIES.SM5];

/**
 * The display profiles, resolved once — the registry is static.
 * `listProfiles()` gives { profile, family, scoreboard, csv, sort } per profile.
 */
const PROFILE_INFO = listProfiles();

// The German display name of a profile comes from gameModes.profileLabel() —
// it lives next to the profile definitions, so console, API and legend all read
// the same string. This file no longer keeps a table of its own.

/** The family a profile belongs to; null for anything that is not a profile. */
const profileFamily = (p) => (PROFILE_INFO.find((x) => x.profile === p) || {}).family || null;
/** The profile a family's files are shown under (its default profile). */
const familyProfile = (f) => FAMILY_DEFAULT_PROFILE[f] || DEFAULT_PROFILE;

const WEB_DIR = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The console is a fixed file list — nothing else under src/web/ is servable.
const STATIC_ALLOW = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/login', 'login.html'],
  ['/login.html', 'login.html'],
  ['/login.js', 'login.js'],
  ['/setup', 'setup.html'],
  ['/setup.html', 'setup.html'],
  ['/setup.js', 'setup.js'],
]);
// Reachable before a login — the pages that perform it, plus what they need to render.
const PUBLIC_STATIC = new Set(['/login', '/login.html', '/login.js', '/setup', '/setup.html', '/setup.js', '/styles.css']);

// What a set secret looks like on the wire; posting it back keeps the stored value.
const SECRET_MASK = '••••••';
const WS_PING_MS = 30000;
const SESSION_COOKIE = 'lf_sess';

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
 *   - admin login (config.admin / LF_ADMIN_PASSWORD): while a password is set,
 *     the console and every /api/* except /api/health + /api/auth/* need a valid
 *     session cookie (HttpOnly, SameSite=Lax). scrypt hash, per-IP lockout after
 *     repeated failures. A password is generated on first run, so the console is
 *     never silently open.
 *   - optional access token (config.apiToken / LF_API_TOKEN): for machines —
 *     a valid Bearer token is accepted everywhere instead of a session
 *     (constant-time compare)
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
  constructor({ logger, config, engine, getStatus, roster, stats, outputs, eventLog, notifier, capture, onConfigChange }) {
    this.log = logger;
    this.config = config;
    this.engine = engine;
    this.getStatus = getStatus;
    this.roster = roster;
    this.stats = stats;
    this.outputs = outputs;
    this.eventLog = eventLog || null;
    this.notifier = notifier || null;
    this.capture = capture || null;
    this.onConfigChange = onConfigChange;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
    this.stateDirty = false;
    this._reaper = null;
    this._rate = new Map();
    this.sessions = new SessionStore({ ttlMs: (config.data.admin?.sessionHours || 12) * 3600000 });
    this.guard = new LoginGuard({
      maxFails: config.data.admin?.maxFailedLogins || 8,
      lockoutMs: (config.data.admin?.lockoutMinutes || 10) * 60000,
    });
    this.recovery = new RecoveryCode();
  }

  get cfg() { return this.config.data; }
  get clientCount() { return this.clients.size; }

  /** Re-read admin settings after a console save. */
  reconcileAuth() {
    this.sessions.setTtl((this.cfg.admin?.sessionHours || 12) * 3600000);
    this.guard.configure({
      maxFails: this.cfg.admin?.maxFailedLogins || 8,
      lockoutMs: (this.cfg.admin?.lockoutMinutes || 10) * 60000,
    });
  }

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
        if (url.pathname !== '/ws' || !this._allowed(req, url)) {
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
        if (host === '0.0.0.0' && !this.cfg.apiToken && !this._loginRequired()) {
          this.log.warn('http', 'reachable from the whole LAN, no admin password and no access token — anyone on the network can open the console');
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

  // ---- admin session ----
  /** A login is demanded as soon as the admin area is on AND a password exists. */
  _loginRequired() {
    return this.cfg.admin?.enabled !== false && !!this.cfg.admin?.passwordHash;
  }
  /**
   * Admin area on, but nobody has chosen a password yet. The console then shows
   * the setup page instead of the login — the only way in on a machine without
   * a monitor or a shell. Everything else stays shut until that is done.
   */
  _setupPending() {
    return this.cfg.admin?.enabled !== false && !this.cfg.admin?.passwordHash;
  }
  _sessionToken(req) {
    return parseCookies(req.headers?.cookie)[SESSION_COOKIE] || '';
  }
  _sessionOk(req) {
    return !!this.sessions.get(this._sessionToken(req));
  }
  /**
   * The one gate every protected route goes through.
   *   nothing configured        -> open (unchanged behaviour on a closed network)
   *   admin password set        -> valid session cookie
   *   access token set          -> valid Bearer/?token= (machines, overlays)
   * Either credential on its own is enough.
   */
  _allowed(req, url) {
    const needToken = !!this.cfg.apiToken;
    const needLogin = this._loginRequired();
    if (needToken && this._hasToken(req, url)) return true;
    if (needLogin && this._sessionOk(req)) return true;
    // Nothing configured at all -> open, as before. But an admin area that is
    // merely *not set up yet* stays shut: otherwise the window between first
    // start and the first password would be a wide-open console.
    if (!needToken && !needLogin && !this._setupPending()) return true;
    return false;
  }
  /** Cookies get `Secure` only when the request really arrived over TLS. */
  _cookieSecure(req) {
    if (req.socket?.encrypted) return true;
    if (this.cfg.http?.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
    return false;
  }
  _setSessionCookie(req, res, token, maxAgeSec) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (this._cookieSecure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  _clearSessionCookie(req, res) {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (this._cookieSecure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  /** What the login/setup page needs to decide what to show. Deliberately public. */
  _sessionInfo(req, url, ip) {
    return {
      loginRequired: this._loginRequired(),
      setupPending: this._setupPending(),
      authenticated: this._allowed(req, url),
      viaSession: this._sessionOk(req),
      tokenRequired: !!this.cfg.apiToken,
      passwordSet: !!this.cfg.admin?.passwordHash,
      passwordPinned: this.config.isPinned('admin.passwordHash'),
      lockedForMs: this.guard.lockedFor(ip),
      sessionHours: this.cfg.admin?.sessionHours || 12,
      // can "forgot password" actually deliver anything?
      recoveryChannels: this.notifier ? this.notifier.channels().map((c) => c.label) : [],
      recoveryPending: this.recovery.pending,
      recoveryCooldownMs: this.recovery.cooldownLeft(),
    };
  }

  /** Hand out a session cookie and return the seconds it is good for. */
  _openSession(req, res, ip) {
    const ttlSec = Math.floor(this.sessions.ttlMs / 1000);
    const { token } = this.sessions.create({ ip, ua: req.headers['user-agent'] });
    this._setSessionCookie(req, res, token, ttlSec);
    return ttlSec;
  }

  /**
   * First-run setup: the machine has no monitor and no shell, so the very first
   * password is chosen here, in the browser. Only reachable while none is set —
   * afterwards this route is dead and /setup redirects to /login.
   */
  async _setup(req, res, body, ip) {
    if (!this._setupPending()) return this._json(res, 409, { error: 'already_set_up' });
    if (this.config.isPinned('admin.passwordHash')) return this._json(res, 409, { error: 'pinned' });

    const next = String(body?.next ?? '');
    const problem = passwordProblem(next);
    if (problem) return this._json(res, 400, { error: 'weak_password', hint: problem });

    const hash = await hashPassword(next);
    try { this.config.setAdminPasswordHash(hash); }
    catch (err) { return this._json(res, 409, { error: 'not_stored', hint: err.message }); }

    this.sessions.destroyAll();
    const expiresInSec = this._openSession(req, res, ip);
    this.log.warn('audit', `console set up from ${ip} — admin password now set`);
    return this._json(res, 200, { data: { ok: true, expiresInSec } });
  }

  /**
   * "Forgot password" for a machine nobody can log into: a one-time code goes
   * out over the configured notification channels (docs/NOTIFY.md). Whoever
   * receives it can set a new password. The old one keeps working until then,
   * so pressing this cannot lock the operator out.
   */
  async _recover(req, res, ip) {
    if (!this._loginRequired()) return this._json(res, 400, { error: 'login_disabled' });
    if (this.config.isPinned('admin.passwordHash')) {
      return this._json(res, 409, { error: 'pinned', hint: 'LF_ADMIN_PASSWORD steht in der .env — dort ändern' });
    }
    if (!this.notifier || !this.notifier.configured) {
      return this._json(res, 409, { error: 'no_channel' });
    }
    const wait = this.recovery.cooldownLeft();
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return this._json(res, 429, { error: 'cooldown', retryAfterMs: wait });
    }

    const { code, expiresAt } = this.recovery.issue();
    this.log.warn('audit', `password recovery requested from ${ip} — code sent to ${this.notifier.channels().map((c) => c.label).join(', ')}`);
    const sent = await this.notifier.send(this.notifier.recoveryMessage(code, expiresAt));
    if (!sent.some((s) => s.ok)) {
      this.recovery.clear();
      return this._json(res, 502, { error: 'send_failed', sent });
    }
    // never echo the code back over HTTP — only the channel gets it
    return this._json(res, 200, { data: { ok: true, sentTo: sent.filter((s) => s.ok).map((s) => s.label), expiresAt } });
  }

  async _recoverConfirm(req, res, body, ip) {
    if (!this._loginRequired()) return this._json(res, 400, { error: 'login_disabled' });
    const locked = this.guard.lockedFor(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      return this._json(res, 429, { error: 'locked_out', retryAfterMs: locked });
    }
    const next = String(body?.next ?? '');
    const problem = passwordProblem(next);
    if (problem) return this._json(res, 400, { error: 'weak_password', hint: problem });

    if (!this.recovery.consume(String(body?.code ?? ''))) {
      this.guard.fail(ip);
      this.log.warn('audit', `bad recovery code from ${ip}`);
      await new Promise((r) => setTimeout(r, 400));
      return this._json(res, 401, { error: 'bad_code' });
    }

    const hash = await hashPassword(next);
    try { this.config.setAdminPasswordHash(hash); }
    catch (err) { return this._json(res, 409, { error: 'not_stored', hint: err.message }); }

    this.sessions.destroyAll();
    this.guard.succeed(ip);
    const expiresInSec = this._openSession(req, res, ip);
    this.log.warn('audit', `admin password reset via recovery code by ${ip} — all sessions invalidated`);
    return this._json(res, 200, { data: { ok: true, expiresInSec } });
  }

  async _login(req, res, body, ip) {
    if (!this._loginRequired()) return this._json(res, 400, { error: 'login_disabled' });

    const locked = this.guard.lockedFor(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      return this._json(res, 429, { error: 'locked_out', retryAfterMs: locked });
    }

    const ok = await verifyPassword(String(body?.password ?? ''), this.cfg.admin.passwordHash);
    if (!ok) {
      const e = this.guard.fail(ip);
      this.log.warn('audit', `failed console login from ${ip} (attempt ${e.fails})`);
      // deliberately slow: a wrong password costs a moment even without a lockout
      await new Promise((r) => setTimeout(r, 400));
      const left = this.guard.lockedFor(ip);
      return this._json(res, 401, { error: 'bad_password', retryAfterMs: left || undefined });
    }

    this.guard.succeed(ip);
    const ttlSec = Math.floor(this.sessions.ttlMs / 1000);
    const { token } = this.sessions.create({ ip, ua: req.headers['user-agent'] });
    this._setSessionCookie(req, res, token, ttlSec);
    this.log.warn('audit', `console login from ${ip}`);
    return this._json(res, 200, { data: { ok: true, expiresInSec: ttlSec } });
  }

  _logout(req, res) {
    this.sessions.destroy(this._sessionToken(req));
    this._clearSessionCookie(req, res);
    return this._json(res, 200, { data: { ok: true } });
  }

  async _changePassword(req, res, url, body, ip) {
    if (!this._allowed(req, url)) return this._json(res, 401, { error: 'unauthorized' });
    if (this.config.isPinned('admin.passwordHash')) {
      return this._json(res, 409, { error: 'pinned', hint: 'LF_ADMIN_PASSWORD steht in der .env — dort ändern' });
    }
    const next = String(body?.next ?? '');
    const problem = passwordProblem(next);
    if (problem) return this._json(res, 400, { error: 'weak_password', hint: problem });

    // A session-holder must prove the current password; a token-only caller
    // (scripted reset from a trusted machine) does not have one to prove.
    if (this.cfg.admin.passwordHash && this._sessionOk(req)) {
      const ok = await verifyPassword(String(body?.current ?? ''), this.cfg.admin.passwordHash);
      if (!ok) { await new Promise((r) => setTimeout(r, 400)); return this._json(res, 401, { error: 'bad_password' }); }
    }

    const hash = await hashPassword(next);
    try { this.config.setAdminPasswordHash(hash); }
    catch (err) { return this._json(res, 409, { error: 'not_stored', hint: err.message }); }

    // every other browser is logged out; this one gets a fresh cookie
    this.sessions.destroyAll();
    this.guard.succeed(ip);
    const ttlSec = Math.floor(this.sessions.ttlMs / 1000);
    const { token } = this.sessions.create({ ip, ua: req.headers['user-agent'] });
    this._setSessionCookie(req, res, token, ttlSec);
    this.log.warn('audit', `admin password changed by ${ip} — all other sessions invalidated`);
    return this._json(res, 200, { data: { ok: true } });
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

    // static console — login/setup pages are public, everything else needs a session
    if (!p.startsWith('/api/') && p !== '/ws') {
      const gate = this._setupPending() ? '/setup' : (this._loginRequired() ? '/login' : null);
      if (gate && !this._allowed(req, url)) {
        // send people at the wrong gate to the right one
        const wrongGate = (gate === '/setup' && (p === '/login' || p === '/login.html'))
          || (gate === '/login' && (p === '/setup' || p === '/setup.html'));
        if (wrongGate || (!PUBLIC_STATIC.has(p) && STATIC_ALLOW.has(p))) {
          res.writeHead(302, { Location: gate, 'Cache-Control': 'no-store' });
          return res.end();
        }
        if (!PUBLIC_STATIC.has(p)) return this._json(res, 404, { error: 'not_found' });
      }
      return this._static(p, res);
    }

    if (p === '/api/health') {
      return this._json(res, 200, { ok: true, service: 'lf-live', matchActive: !!this.engine.snapshot().missionActive, ts: Date.now() });
    }

    if (!this._rateOk(ip)) { res.setHeader('Retry-After', '30'); return this._json(res, 429, { error: 'rate_limited' }); }

    // Auth endpoints run before the gate — they are how you get through it.
    if (p.startsWith('/api/auth/')) {
      if (req.method === 'GET' && p === '/api/auth/session') return this._json(res, 200, { data: this._sessionInfo(req, url, ip) });
      if (req.method !== 'POST') return this._json(res, 405, { error: 'method_not_allowed' });
      if (!this._hasToken(req, url) && !this._sameOrigin(req)) {
        this.log.warn('http', `cross-origin ${req.method} ${p} blocked from ${ip}`);
        return this._json(res, 403, { error: 'cross_origin_blocked' });
      }
      const body = await this._readBody(req);
      if (body === null) return this._json(res, 400, { error: 'bad_json' });
      if (p === '/api/auth/login') return this._login(req, res, body, ip);
      if (p === '/api/auth/logout') return this._logout(req, res);
      if (p === '/api/auth/password') return this._changePassword(req, res, url, body, ip);
      if (p === '/api/auth/setup') return this._setup(req, res, body, ip);
      if (p === '/api/auth/recover') return this._recover(req, res, ip);
      if (p === '/api/auth/recover/confirm') return this._recoverConfirm(req, res, body, ip);
      return this._json(res, 404, { error: 'not_found' });
    }

    if (!this._allowed(req, url)) {
      return this._json(res, 401, {
        error: 'unauthorized',
        loginRequired: this._loginRequired(),
        hint: this._loginRequired() ? 'am Bildschirm anmelden (/login) oder Authorization: Bearer <token> senden' : 'send Authorization: Bearer <token>',
      });
    }

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
    // Game-mode registry + the mode detected right now (contract E). Read-only,
    // rides the same auth/CORS/rate-limit chain as every other GET above, and
    // carries nothing but the registry — no paths, no files, no config.
    if (p === '/api/modes') {
      const s = this.engine.snapshot();
      // `scoreboard` is keyed by BOTH axes: the two FAMILY keys it always had
      // (nothing is removed — consumers may hang off them) and one key per
      // display PROFILE. `sm5`/`laserball` exist in both name spaces and mean
      // the same column set there; only `standard` is new.
      const scoreboard = {
        [FAMILIES.LASERBALL]: scoreboardColumns(FAMILIES.LASERBALL),
        [FAMILIES.SM5]: scoreboardColumns(FAMILIES.SM5),
      };
      for (const pr of PROFILE_LIST) scoreboard[pr] = scoreboardColumns(pr);
      return this._json(res, 200, {
        data: {
          families: [FAMILIES.LASERBALL, FAMILIES.SM5],
          defaultFamily: DEFAULT_FAMILY,
          // display profiles — which columns are SHOWN, independent of the
          // family, which only decides what can be counted at all
          profiles: PROFILE_INFO.map((x) => ({
            profile: x.profile, label: profileLabel(x.profile), family: x.family, sort: x.sort,
          })),
          defaultProfile: DEFAULT_PROFILE,
          modes: listModes(),
          current: s.mode ? { ...s.mode } : null,
          // the console builds its player table from these — one source of truth
          scoreboard,
          // the whole label table (gameModes.metricLabels()), keyed by camelCase
          // AND snake_case, so no consumer keeps a column-label map of its own.
          // Every entry carries label / short / help / group / groupLabel /
          // format — everything the console legend needs.
          metrics: metricLabels(),
          // Section order for that legend: the metric groups in display order.
          // Additive; nothing above changed shape.
          metricGroups: metricGroups(),
        },
      });
    }
    if (p === '/api/network') {
      return this._json(res, 200, {
        data: {
          ...reachability(this.cfg),
          notify: this.notifier ? { configured: this.notifier.channels(), last: this.notifier.last, lastAt: this.notifier.lastAt } : null,
        },
      });
    }
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
    if (p === '/api/stats/totals') {
      // Totals are kept per FAMILY on disk (totals_<family>.csv, statsWriter.js)
      // because a sum over another family's counters is meaningless. A display
      // PROFILE may therefore be named too — it is resolved to its family here.
      // Both parameters are validated against the registry and never passed
      // through raw; without either, the writer's own default applies (the
      // family played last), so existing calls keep working unchanged.
      const askedFamily = url.searchParams.get('family');
      const askedProfile = url.searchParams.get('profile');
      const profile = PROFILE_LIST.includes(String(askedProfile)) ? String(askedProfile) : null;
      const family = FAMILY_KEYS.includes(String(askedFamily))
        ? String(askedFamily)
        : (profile ? profileFamily(profile) : null);
      const families = this.stats.totalsFamilies();
      return this._json(res, 200, {
        data: this.stats.totalsJson(family || undefined),
        family,
        families,
        // Which profile the rows on screen belong to, and which profiles have
        // any recorded data at all — one entry per family with a totals file,
        // under that family's own profile (profiles sharing a family share the
        // file, so offering them twice would show the same table twice).
        profile: profile || (family ? familyProfile(family) : null),
        profiles: families.map((f) => ({ profile: familyProfile(f), label: profileLabel(familyProfile(f)), family: f })),
      });
    }
    // Raw TDF recordings (docs/CAPTURE.md). Same auth / CORS / rate-limit chain
    // and the same path handling as the CSV endpoints above.
    if (p === '/api/capture/files') {
      if (!this.capture) return this._json(res, 200, { data: [], status: null });
      return this._json(res, 200, { data: this.capture.listFiles(), status: this.capture.status() });
    }
    if (p === '/api/capture/file') {
      if (!this.capture) return this._json(res, 404, { error: 'not_found' });
      const name = url.searchParams.get('name') || '';
      const buf = this.capture.readFile(name);
      if (!buf) return this._json(res, 404, { error: 'not_found' });
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    }
    if (p === '/api/capture/bundle') {
      if (!this.capture) return this._json(res, 404, { error: 'not_found' });
      const b = this.capture.bundle();
      if (!b.ok) return this._json(res, b.error === 'too_large' ? 413 : 404, b);
      const name = `lf-mitschnitte-${new Date().toISOString().slice(0, 10)}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': b.buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(b.buffer);
    }
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
  /** Deep copy of the running config with every secret removed. */
  _redactedConfig() {
    const c = structuredClone(this.cfg);
    c.apiTokenSet = !!c.apiToken;
    c.apiToken = '';
    for (const o of c.outputs || []) if (o.secret) o.secret = SECRET_MASK;

    // the password hash never leaves the process, not even hashed
    c.adminPasswordSet = !!c.admin?.passwordHash;
    if (c.admin) c.admin.passwordHash = '';

    // notification channels: keep the shape, drop everything secret-ish
    if (c.notify) {
      const mask = (v) => (v ? SECRET_MASK : '');
      c.notify.discordWebhook = mask(c.notify.discordWebhook);
      c.notify.slackWebhook = mask(c.notify.slackWebhook);
      if (c.notify.ntfy) c.notify.ntfy.token = mask(c.notify.ntfy.token);
      if (c.notify.telegram) c.notify.telegram.botToken = mask(c.notify.telegram.botToken);
      if (c.notify.webhook) { c.notify.webhook.url = mask(c.notify.webhook.url); c.notify.webhook.secret = mask(c.notify.webhook.secret); }
      if (c.notify.email) { c.notify.email.pass = mask(c.notify.email.pass); }
      c.notifyChannels = this.notifier ? this.notifier.channels() : [];
      c.notifyLast = this.notifier ? this.notifier.last : [];
    }
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
    delete patch.adminPasswordSet;
    delete patch.notifyChannels;
    delete patch.notifyLast;
    const clear = patch.apiTokenClear === true;
    delete patch.apiTokenClear;
    if ('apiToken' in patch && patch.apiToken === '' && !clear) delete patch.apiToken;

    // The password is only ever set through /api/auth/password.
    if (patch.admin && typeof patch.admin === 'object') delete patch.admin.passwordHash;

    // Notification channels can be set up from the console (a hall PC has no
    // shell). Same rule as an output secret: the mask means "keep what is
    // stored", an empty field means "remove it".
    if (patch.notify && typeof patch.notify === 'object') this._unredactNotify(patch.notify);
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
  /**
   * Every secret-ish notification field the console got as `••••••` is put back
   * to the stored value; anything the operator actually retyped (or cleared)
   * wins. Mirrors what _redactedConfig() masked.
   */
  _unredactNotify(patch) {
    const stored = this.cfg.notify || {};
    const keep = (obj, key, prev) => {
      if (obj && typeof obj === 'object' && obj[key] === SECRET_MASK) obj[key] = prev || '';
    };
    keep(patch, 'discordWebhook', stored.discordWebhook);
    keep(patch, 'slackWebhook', stored.slackWebhook);
    keep(patch.ntfy, 'token', stored.ntfy?.token);
    keep(patch.telegram, 'botToken', stored.telegram?.botToken);
    keep(patch.webhook, 'url', stored.webhook?.url);
    keep(patch.webhook, 'secret', stored.webhook?.secret);
    keep(patch.email, 'pass', stored.email?.pass);
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
        this.reconcileAuth();
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
    // Deleting a recording is a mutating request and goes through exactly the
    // same gate as every other one (session or bearer token, plus the CSRF check
    // in _route). Audited like a config change.
    if (p === '/api/capture/delete') {
      if (!this.capture) return this._json(res, 404, { error: 'not_found' });
      if (body && body.all === true) {
        const r = this.capture.deleteAll();
        this.log.warn('audit', `capture: alle Mitschnitte gelöscht von ${ip} (${r.deleted} Dateien)`);
        return this._json(res, 200, { data: { ...r, files: this.capture.listFiles() } });
      }
      const r = this.capture.deleteFile(String(body?.name ?? ''));
      if (!r.ok) return this._json(res, r.error === 'not_found' ? 404 : 400, { error: r.error });
      this.log.warn('audit', `capture: Mitschnitt gelöscht von ${ip}: ${String(body?.name ?? '').slice(0, 120)}`);
      return this._json(res, 200, { data: { ...r, files: this.capture.listFiles() } });
    }
    if (p === '/api/notify/test') {
      if (!this.notifier) return this._json(res, 200, { data: { sent: [], configured: [] } });
      this.log.warn('audit', `notification test by ${ip}`);
      const sent = await this.notifier.test();
      return this._json(res, 200, { data: { sent, configured: this.notifier.channels() } });
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
