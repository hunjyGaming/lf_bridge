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
const { redactUrl } = require('./mqtt');
const {
  FAMILIES, DEFAULT_FAMILY, DEFAULT_PROFILE, PROFILE_LIST, FAMILY_DEFAULT_PROFILE,
  listModes, listProfiles, scoreboardColumns, metricLabels, metricGroups, profileLabel,
  resolveProfile, profileSort, metricInfo, modeConfigStatus,
} = require('./gameModes');

/** The only family names a request may name. Everything else falls back. */
const FAMILY_KEYS = [FAMILIES.LASERBALL, FAMILIES.SM5];

/**
 * The display profiles — resolved PER REQUEST, not once at start.
 *
 * The profiles and mode numbers live in hand-editable JSON under `modes/`, and
 * src/config.js re-reads them on every console save (`reloadModes()`) so the
 * hall operator can add a mission number he just measured without restarting
 * the service. Resolving `listProfiles()` once at module load would have made
 * that reload path end here: the console would keep showing the old columns
 * until a restart.
 *
 * Rebuilding it on every call is wasted work though — `/api/modes` is what
 * every console asks for the moment it connects. So it is cached against
 * `modeConfigStatus().loadedAt`, the stamp `reloadModes()` sets: unchanged
 * config -> the cached array; a reload -> rebuilt exactly once, on the next
 * request. Measured cost of the rebuild: see docs/API.md.
 *
 * `PROFILE_LIST` and `FAMILY_DEFAULT_PROFILE` above need no such treatment —
 * `reloadModes()` mutates those in place, so the imported bindings stay live.
 */
let _profileCache = null;
function profileInfo() {
  const stamp = (modeConfigStatus() || {}).loadedAt || null;
  if (!_profileCache || _profileCache.stamp !== stamp) {
    _profileCache = { stamp, info: listProfiles() };
  }
  return _profileCache.info;
}

// The German display name of a profile comes from gameModes.profileLabel() —
// it lives next to the profile definitions, so console, API and legend all read
// the same string. This file no longer keeps a table of its own.

/** The family a profile belongs to; null for anything that is not a profile. */
const profileFamily = (p) => (profileInfo().find((x) => x.profile === p) || {}).family || null;
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

// Live raw-line view (console section "Rohdaten", docs/CAPTURE.md).
//
// The lines are BUNDLED, never one WebSocket frame per line: at fifty-plus
// players the line rate runs into the hundreds per second, and a measurement
// showed that the per-message cost then dominates everything else the console
// does. One frame every RAW_BATCH_MS carries whatever arrived in between; a
// burst that reaches RAW_BATCH_LINES is sent straight away so the view stays
// live. Beyond RAW_QUEUE_MAX lines the queue drops — the console is told how
// many, rather than the service growing a buffer for a viewer that cannot keep
// up. Nothing is queued at all while no console has the section open.
const RAW_BATCH_MS = 250;
const RAW_BATCH_LINES = 400;
const RAW_QUEUE_MAX = 4000;
/** Longest control frame a client may send us; anything larger is dropped unparsed. */
const WS_MSG_MAX = 256;
/** Hard ceiling for a request body, in BYTES. */
const BODY_MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Bundled event frames (docs/API.md "Gebündelte Ereignisse")
//
// One WebSocket frame PER EVENT is what this service has always sent, and it is
// what every existing consumer expects — so that stays the default and is never
// taken away. But a measurement at a high event rate showed the per-frame cost
// dominating: at ~120 events/s the unpacking alone (one JSON.parse + one event
// handler per frame) kept a browser consumer's queue growing. A consumer may
// therefore ASK for bundling, either at connect time (`/ws?events=batch`) or
// with a `subscribe` control frame; it then gets `{"type":"events","data":[…]}`
// instead of many `{"type":"event","data":{…}}`.
//
// The queue is per client, so a slow consumer cannot slow down a fast one, and
// it is bounded: past EV_QUEUE_MAX the oldest events are dropped and the count
// is carried in the next frame, rather than the service growing a buffer for a
// consumer that cannot keep up. Same rule as the raw-line tap above.
const EV_BATCH_MS_DEFAULT = 100;
const EV_BATCH_MS_MIN = 20;
const EV_BATCH_MS_MAX = 1000;
/** A burst this long goes out at once instead of waiting for the timer. */
const EV_BATCH_MAX = 200;
/** Hard ceiling per client; beyond it the OLDEST events are dropped. */
const EV_QUEUE_MAX = 2000;

/** Version of the `display` payload — bumped only on a breaking change. */
const DISPLAY_VERSION = 1;

/**
 * Written-out German reason a match ended. The vocabulary itself is the
 * engine's (`END_REASONS` in src/engine.js); only the wording lives here,
 * because it is a display concern and nothing else reads it. Identical to the
 * table in docs/API.md.
 */
const END_REASON_LABEL = {
  mission_end: 'regulär beendet',
  watchdog: 'vom Spielleiter beendet bzw. Zeitüberschreitung',
  stream_lost: 'Verbindung zur Anlage verloren',
  next_match: 'durch ein neues Match abgelöst',
  shutdown: 'Dienst beendet',
};
/** Written-out German form of `endSource` — through WHAT the end was noticed. */
const END_SOURCE_LABEL = {
  '0101': 'Mission-End-Zeile 0101 der Anlage',
  summary_type6: 'Abschluss-Zeilen (Typ 6) aller Spieler',
  summary_type7: 'SM5-Endblock (Typ 7)',
  silence: 'keine Daten mehr von der Anlage',
  stream_lost: 'TCP-Verbindung abgebrochen',
  next_match: 'Start des nächsten Matches',
  shutdown: 'Dienst wurde beendet',
};
/** Where the points on screen come from. */
const SCORE_SOURCE_LABEL = {
  tdf: 'von der Anlage gemeldet',
  internal: 'von der Bridge mitgezählt',
};
/** Where a player's counters come from. */
const STATS_SOURCE_LABEL = {
  live: 'laufend mitgezählt (Untergrenze)',
  tdf7: 'amtliche Endabrechnung der Anlage',
};
/** The unit a `format` implies. `null` means "a bare number, no unit". */
const FORMAT_UNIT = { percent: '%', int: null, text: null };

/**
 * A display needs at least three teams, each with exactly one player, before
 * "everybody against everybody" is a fair description. Two one-player teams are
 * a duel, and one team with many players is a co-op game.
 */
const FFA_MIN_TEAMS = 3;

/** How often the same disallowed Origin produces a log line. */
const ORIGIN_LOG_MS = 60000;

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

// ---------------------------------------------------------------------------
// The display payload
// ---------------------------------------------------------------------------

/** `undefined` and `NaN` both mean "not reported" and become `null`, never 0. */
function orNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}
/** A number, or 0 — for things that are honestly counted from zero. */
function num0(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Rank a list that is already sorted best-first: equal keys share a rank, and
 * the next rank skips (1, 2, 2, 4) — what a scoreboard shows.
 */
function withRanks(list, keyOf) {
  let lastKey = null;
  let lastRank = 0;
  return list.map((item, i) => {
    const k = JSON.stringify(keyOf(item));
    if (k !== lastKey) { lastRank = i + 1; lastKey = k; }
    return { ...item, rank: lastRank };
  });
}

/**
 * Everything a scoreboard, a beamer overlay or a tournament system needs, and
 * nothing else — built from ONE `engine.snapshot()` so it can never drift away
 * from `/api/state`. See docs/API.md, "Der Anzeige-Datensatz".
 *
 * What it does that a consumer would otherwise have to do itself, wrongly:
 *   - it decides the DIRECTION of the clock (`clock.direction`) and hands over
 *     the single number to put on screen (`clock.displayMs`). Nobody may ever
 *     compute `durationMs - elapsedMs`: without a duration from the rig,
 *     `durationMs` is a default that has nothing to do with the running game.
 *   - it turns the team MAP into an ordered ARRAY with the id inside, so one
 *     team, seven teams and "everyone against everyone" all render the same way.
 *   - it picks the columns that matter for THIS game mode and gives each one its
 *     written-out label, its unit and its display format.
 *   - it never turns "not reported yet" into 0 — an unreported value is `null`.
 *   - it carries the provenance flags along: estimated accuracy, live counters
 *     vs. the rig's official end block, and where the points come from.
 */
function buildDisplay(s, { withPlayers = true, now = Date.now() } = {}) {
  const mode = s.mode || {};
  const profile = resolveProfile(mode.profile || mode.family || DEFAULT_PROFILE);

  // --- columns for exactly this mode -----------------------------------------
  // Deliberately WITHOUT `help`, `group` and `groupLabel`: they are static per
  // mode and would be re-sent five times a second for nothing. They come from
  // the very same scoreboardColumns() call in `GET /api/modes`, which a display
  // fetches once — see docs/API.md.
  const columns = scoreboardColumns(profile).map((c) => {
    const col = {
      key: c.key,
      label: c.label,
      short: c.short,
      format: c.format,
      // ADDITIVE over scoreboardColumns(): the unit that `format` implies, so a
      // renderer does not need a format->unit table of its own.
      unit: Object.prototype.hasOwnProperty.call(FORMAT_UNIT, c.format) ? FORMAT_UNIT[c.format] : null,
    };
    if (c.received) {
      col.received = c.received;
      col.receivedLabel = (metricInfo(c.received) || {}).label || c.received;
    }
    return col;
  });
  const sortKeys = profileSort(profile);

  // --- teams -----------------------------------------------------------------
  // The map is keyed by the raw team token. Sorted numerically where possible so
  // "left/right" stays the same for the whole match, then ranked by score.
  const teamIds = Object.keys(s.teams || {}).sort((a, b) => {
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  });
  const headcount = new Map();
  for (const p of Object.values(s.players || {})) {
    const t = String(p.teamId);
    headcount.set(t, (headcount.get(t) || 0) + 1);
  }
  const teamsPlain = teamIds.map((id) => ({
    id,
    name: (s.teams[id] && s.teams[id].name) || `Team ${id}`,
    color: (s.teams[id] && s.teams[id].color) || null,
    score: num0((s.scores || {})[id]),
    players: headcount.get(id) || 0,
  }));
  // Rank is by score; the ARRAY ORDER stays by id, so a display that just walks
  // the array keeps its left/right assignment stable across the whole match.
  const byScore = teamsPlain.slice().sort((a, b) => b.score - a.score);
  const rankOf = new Map(withRanks(byScore, (t) => t.score).map((t) => [t.id, t.rank]));
  const teams = teamsPlain.map((t) => ({ ...t, rank: rankOf.get(t.id) }));

  const manned = teams.filter((t) => t.players > 0);
  const freeForAll = manned.length >= FFA_MIN_TEAMS && manned.every((t) => t.players === 1);

  // --- players ---------------------------------------------------------------
  let players = null;
  if (withPlayers) {
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const rows = Object.values(s.players || {}).map((p) => {
      const t = teamById.get(String(p.teamId)) || null;
      const stats = {};
      for (const c of columns) {
        stats[c.key] = orNull(p[c.key]);
        if (c.received) stats[c.received] = orNull(p[c.received]);
      }
      return {
        id: p.id,
        name: p.name,
        teamId: p.teamId == null ? null : String(p.teamId),
        teamName: t ? t.name : null,
        teamColor: t ? t.color : null,
        score: num0(p.score),
        status: orNull(p.status),
        roleLabel: orNull(p.roleLabel),
        stats,
        // Provenance — a display that shows a number should be able to say where
        // it came from without a second request.
        statsSource: p.statsSource || 'live',
        statsSourceLabel: STATS_SOURCE_LABEL[p.statsSource || 'live'] || null,
        accuracy: orNull(p.accuracy),
        accuracyIsEstimate: p.accuracyIsEstimate === undefined ? null : !!p.accuracyIsEstimate,
        accuracySource: p.accuracySource || null,
        /** true once the rig delivered this player's official end block (type 7). */
        officialStats: !!p.official,
      };
    });
    // Best first, by the mode's own ranking metric, then score, then name.
    // `null` (not reported) always sorts LAST, never as a zero — the same rule
    // the rendering side follows. One helper, so the order and the rank that is
    // handed out afterwards can never disagree.
    const sortVals = (p) => sortKeys
      .map((k) => (p.stats[k] == null ? (k === 'score' ? p.score : null) : p.stats[k]))
      .concat(p.score);
    rows.sort((a, b) => {
      const av = sortVals(a);
      const bv = sortVals(b);
      for (let i = 0; i < av.length; i++) {
        if (av[i] === bv[i]) continue;
        if (av[i] == null) return 1;         // a has no value -> a goes last
        if (bv[i] == null) return -1;
        return bv[i] - av[i];                // bigger is better
      }
      return String(a.name).localeCompare(String(b.name));
    });
    players = withRanks(rows, sortVals);
  }

  // --- the clock -------------------------------------------------------------
  // `remainingMs === null` <=> `durationKnown === false` <=> count UP.
  const durationKnown = s.durationKnown === true;
  const elapsedMs = num0(s.elapsedTime);
  const remainingMs = s.remainingMs == null ? null : s.remainingMs;
  const direction = remainingMs == null ? 'up' : 'down';

  return {
    v: DISPLAY_VERSION,
    service: 'lf-live',
    ts: now,
    /** when the engine last changed anything; `ageMs` = how stale that is */
    updatedAt: orNull(s.updatedAt),
    ageMs: s.updatedAt == null ? null : Math.max(0, now - s.updatedAt),
    match: {
      active: s.missionActive === true,
      matchId: orNull(s.matchId),
      mode: {
        number: orNull(mode.number),
        key: mode.key || 'unknown',
        /** written-out name of the running mode; may come FROM THE STREAM — text only, never HTML */
        label: mode.label || 'Unbekannter Modus',
        family: mode.family || DEFAULT_FAMILY,
        profile,
        /** written-out name of the DISPLAY profile the columns below belong to */
        profileLabel: profileLabel(profile),
        known: mode.known === true,
        source: mode.source || 'default',
        /** the rig's own description from the type-1 line, or null */
        description: orNull(s.missionDesc),
      },
      clock: {
        /** 'down' = show `remainingMs`, 'up' = show `elapsedMs`. Never compute it yourself. */
        direction,
        /** the one number to put on screen, already chosen by direction */
        displayMs: direction === 'down' ? remainingMs : elapsedMs,
        elapsedMs,
        remainingMs,
        durationMs: num0(s.duration),
        durationKnown,
        /** false => the clock must STAND STILL, whatever arrives afterwards */
        running: s.missionActive === true,
      },
      scoreSource: s.scoreSource || 'internal',
      scoreSourceLabel: SCORE_SOURCE_LABEL[s.scoreSource || 'internal'] || null,
      end: {
        reason: orNull(s.endReason),
        reasonLabel: s.endReason ? (END_REASON_LABEL[s.endReason] || s.endReason) : null,
        /** through WHAT the end was noticed — the only way to tell the two watchdog cases apart */
        source: orNull(s.endSource),
        sourceLabel: s.endSource ? (END_SOURCE_LABEL[s.endSource] || s.endSource) : null,
        at: orNull(s.endedAt),
      },
    },
    teams,
    teamCount: teams.length,
    /** teams that actually have a player in them right now */
    teamsWithPlayers: manned.length,
    /** every manned team holds exactly one player, and there are at least three */
    freeForAll,
    playerCount: Object.keys(s.players || {}).length,
    ballHolderId: orNull(s.ballHolderId),
    columns,
    /** `null` only when the caller asked for `?players=none` */
    players,
  };
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
 *     none), and cross-origin requests can only ever be GET (Allow-Methods: GET, OPTIONS).
 *     A rejected origin is never SILENT: the answer carries X-LF-Origin-Allowed: 0,
 *     the service logs it (throttled), and /api/access says so to the caller.
 *     The allow LIST itself is never handed out. Note that browsers do not apply
 *     CORS to WebSockets at all — for /ws the token is the only gate.
 *   - a refused WebSocket handshake carries a reason (X-LF-Reason + JSON body)
 *     and a log line, instead of closing without a word
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
    this._rawQueue = [];       // live raw lines waiting for the next bundle
    this._rawDropped = 0;      // lines thrown away because the queue was full
    this._rawTimer = null;     // runs only while somebody watches
    this._evTimer = null;      // event-bundle timer; runs only while somebody asked for bundles
    this._evTimerMs = 0;       // the window it currently runs at (shortest anybody asked for)
    this._originLogged = new Map(); // throttle for the "Origin not allowed" warning
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
        if (url.pathname !== '/ws') return this._rejectUpgrade(req, socket, 404, 'not_found', 'nur /ws ist ein WebSocket-Endpunkt');
        if (!this._allowed(req, url)) {
          return this._rejectUpgrade(req, socket, 401, 'unauthorized', this._loginRequired()
            ? 'gültiges ?token=<token> anhängen oder im selben Browser angemeldet sein (/login)'
            : 'gültiges ?token=<token> anhängen');
        }
        wss.handleUpgrade(req, socket, head, (ws) => this._onWs(ws, req, url));
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
    this._stopRawTap();
    this._stopEventBatch();
    for (const ws of this.clients) { try { ws.close(1001); } catch {} }
    this.clients.clear();
    if (this.wss) { try { this.wss.close(); } catch {} this.wss = null; }
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
  }

  /**
   * Turn a refused WebSocket handshake into something a human can debug.
   *
   * It used to be a bare `HTTP/1.1 401 Unauthorized` with no body and no log
   * line: from the outside indistinguishable from a wrong port, a firewall or a
   * crashed service, and that is the worst thing to hit at a tournament. Now the
   * handshake carries a reason header and a short JSON body, and the service
   * writes one warn line naming the client.
   *
   * It says nothing an attacker does not already know: WHETHER they are let in
   * is the one bit they can always measure, and the hint only repeats what
   * docs/API.md says in public. It never says whether a token is set, whether
   * the one they sent was close, or what the allowed origins are.
   */
  _rejectUpgrade(req, socket, status, reason, hint) {
    const ip = this._clientIp(req);
    const origin = req.headers.origin || '';
    const body = JSON.stringify({ error: reason, hint });
    const text = status === 404 ? 'Not Found' : 'Unauthorized';
    try {
      socket.write(
        `HTTP/1.1 ${status} ${text}\r\n`
        + 'Content-Type: application/json; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n`
        + `X-LF-Reason: ${reason}\r\n`
        + 'Cache-Control: no-store\r\n'
        + 'Connection: close\r\n'
        + '\r\n' + body,
      );
    } catch {}
    this.log.warn('ws', `Upgrade abgelehnt (${reason}) von ${ip}${origin ? ` Origin ${origin}` : ''} — ${hint}`);
    return socket.destroy();
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
   * Second factor for a destructive action (deleting statistics, resetting them,
   * wiping all recordings): the admin password, TYPED AGAIN, even inside a valid
   * session. A confirmation box in the browser proves nothing — whoever walks up
   * to an unlocked console has one.
   *
   * Checked here, server-side, against the same scrypt hash the login uses
   * (src/auth.js verifyPassword) and behind the same per-IP LoginGuard, so this
   * route cannot be used to guess the password any faster than /api/auth/login.
   * A wrong attempt costs the same deliberate 400 ms.
   *
   * Returns true when the caller may proceed. On false the response is already
   * written and the caller must return at once.
   */
  async _passwordOk(res, body, ip, what) {
    const hash = this.cfg.admin?.passwordHash || '';
    if (!hash) {
      // No admin password on this installation (token-only, or a closed network
      // with the admin area switched off). There is nothing to verify against,
      // so the action stays behind the normal gate — and is said out loud.
      this.log.warn('audit', `${what} von ${ip} ohne Passwortbestätigung — für diese Installation ist kein Admin-Passwort gesetzt`);
      return true;
    }
    const locked = this.guard.lockedFor(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(Math.ceil(locked / 1000)));
      this._json(res, 429, { error: 'locked_out', retryAfterMs: locked });
      return false;
    }
    const ok = await verifyPassword(String(body?.password ?? ''), hash);
    if (!ok) {
      const e = this.guard.fail(ip);
      this.log.warn('audit', `${what} von ${ip} ABGELEHNT — falsches Passwort (Versuch ${e.fails})`);
      await new Promise((r) => setTimeout(r, 400));
      const left = this.guard.lockedFor(ip);
      this._json(res, 401, { error: 'bad_password', retryAfterMs: left || undefined });
      return false;
    }
    this.guard.succeed(ip);
    return true;
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
  /** Is this Origin on the allow list? (`*` lets everything through.) */
  /**
   * The origin THIS request was addressed to — `scheme://host[:port]`, built
   * from the `Host` header the browser itself filled in.
   */
  _selfOrigin(req) {
    const host = req.headers?.host;
    if (!host) return '';
    const fwd = this.cfg.http?.trustProxy
      ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      : '';
    const proto = req.socket?.encrypted ? 'https' : (fwd || 'http');
    return `${proto}://${host}`;
  }
  _originAllowed(origin, req) {
    if (!origin) return true;               // not a browser request at all
    // OUR OWN console. A browser sends `Origin` on every same-origin POST too,
    // so without this the console's own login and every save produced a "this
    // origin is not in cors[] — the browser will silently discard the answer"
    // warning. For a same-origin request that sentence is simply false: CORS
    // does not apply to it at all. The warning is the one thing an operator
    // chases on tournament day, so it must not cry wolf. A forged Origin gains
    // nothing here: a browser fills in `Host` itself, and a non-browser client
    // is not subject to CORS in the first place.
    if (req && origin === this._selfOrigin(req)) return true;
    const allowed = this.cfg.cors || [];
    return allowed.includes('*') || allowed.includes(origin);
  }
  /**
   * Say out loud that a browser request came from an Origin nobody allowed.
   *
   * This is THE failure that costs an hour on tournament day: the service
   * answers 200, the browser throws the answer away without a word, and the
   * display stays empty. One log line per origin per minute names it. Nothing
   * secret is said — the caller sent us that origin, and the *missing*
   * `Access-Control-Allow-Origin` header already tells them the answer.
   */
  _noteBlockedOrigin(origin, what) {
    const now = Date.now();
    const last = this._originLogged.get(origin) || 0;
    if (now - last < ORIGIN_LOG_MS) return;
    if (this._originLogged.size > 200) this._originLogged.clear();
    this._originLogged.set(origin, now);
    this.log.warn('http', `CORS: Origin ${origin} steht nicht in cors[] (${what}) — der Browser wird die Antwort STILL verwerfen. Origin in LF_CORS_ORIGINS eintragen (docs/SECURITY.md).`);
  }
  _cors(req, res, path = '') {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = this.cfg.cors || [];
    const ok = this._originAllowed(origin, req);
    if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (ok) res.setHeader('Access-Control-Allow-Origin', origin);
    else this._noteBlockedOrigin(origin, path || req.url || '?');
    // Always vary on Origin: the answer really does differ per origin, with or
    // without an allow header, so a cache must not serve one origin's answer to
    // another.
    res.setHeader('Vary', 'Origin');
    // ADDITIVE, purely diagnostic: visible in the browser's network tab even
    // when the CORS check then hides the body from the page's JavaScript, so
    // "why is my display empty" has an answer without reading the server log.
    res.setHeader('X-LF-Origin-Allowed', ok ? '1' : '0');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'X-LF-Origin-Allowed');
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
  /**
   * The request body, parsed, or `null` for anything unusable.
   *
   * Collected as BYTES and decoded once at the end. Appending each chunk to a
   * string instead decoded every chunk on its own, so a multi-byte character
   * (every umlaut in a German output name) split across a chunk boundary came
   * out as two replacement characters and the whole save failed with
   * `bad_json`. Counting bytes also makes the 512 KiB cap mean 512 KiB rather
   * than "512 Ki characters", which for UTF-8 was up to three times as much.
   */
  _readBody(req) {
    return new Promise((resolve) => {
      const parts = [];
      let bytes = 0;
      let big = false;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > BODY_MAX_BYTES) { big = true; req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', () => {
        if (big) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(parts, bytes).toString('utf8') || '{}')); } catch { resolve(null); }
      });
      req.on('error', () => resolve(null));
    });
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const ip = this._clientIp(req);

    this._cors(req, res, p);
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

    // Deliberately BEFORE the rate limit: a monitoring probe must never be
    // locked out. That is also why it reads the one flag it needs straight off
    // `gameState` instead of going through `snapshot()` — the same answer, but
    // without the derived-field pass over every player, so an unauthenticated
    // caller cannot make the service do work by polling it.
    if (p === '/api/health') {
      return this._json(res, 200, { ok: true, service: 'lf-live', matchActive: !!this.engine.gameState.missionActive, ts: Date.now() });
    }

    if (!this._rateOk(ip)) { res.setHeader('Retry-After', '30'); return this._json(res, 429, { error: 'rate_limited' }); }

    // "Warum komme ich nicht rein?" — the one endpoint that answers that from
    // the OUTSIDE, for a display on a second machine. Deliberately reachable
    // without credentials, exactly like /api/auth/session, because a caller who
    // cannot get in is precisely the one who needs the answer.
    //
    // It tells the caller nothing they cannot already measure themselves:
    // their own Origin (they sent it), whether it is on the allow list (the
    // presence of `Access-Control-Allow-Origin` already says so), whether the
    // credential they sent was accepted (they can try), and whether a token or
    // a login is demanded at all (/api/auth/session already says that). It
    // never lists the allowed origins and never says anything about the token
    // itself. Rate-limited like every other route.
    if (p === '/api/access') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this._json(res, 405, { error: 'method_not_allowed' });
      // Echoed straight back to the caller who sent it, and to nobody else —
      // but capped all the same, so no answer of ours is ever bulkier than it
      // needs to be.
      const origin = req.headers.origin ? String(req.headers.origin).slice(0, 256) : null;
      const originAllowed = this._originAllowed(req.headers.origin || null, req);
      const tokenRequired = !!this.cfg.apiToken;
      const tokenSent = !!this._token(req, url);
      const authenticated = this._allowed(req, url);
      const problems = [];
      if (!authenticated) {
        if (tokenRequired && !tokenSent) problems.push('kein Token mitgeschickt: Authorization: Bearer <token> bzw. ?token=<token>');
        else if (tokenRequired && tokenSent) problems.push('das mitgeschickte Token passt nicht');
        else if (this._setupPending()) problems.push('die Ersteinrichtung ist noch offen — erst /setup im Browser aufrufen');
        else if (this._loginRequired()) problems.push('Anmeldung nötig: entweder am Browser über /login oder ein Zugriffs-Token setzen');
      }
      if (origin && !originAllowed) {
        problems.push(`die Herkunft ${origin} steht nicht in cors[] — der Browser verwirft die Antwort still; Origin in LF_CORS_ORIGINS eintragen`);
      }
      return this._json(res, 200, {
        data: {
          service: 'lf-live',
          origin,
          /** false => a browser at this origin throws every answer away, whatever the status code was */
          originAllowed,
          /** true => this very request would be let through */
          authenticated,
          tokenRequired,
          tokenSent,
          tokenAccepted: tokenRequired ? this._hasToken(req, url) : null,
          loginRequired: this._loginRequired(),
          viaSession: this._sessionOk(req),
          setupPending: this._setupPending(),
          /** the WebSocket is NOT subject to cors[] — browsers do not apply CORS to it */
          websocket: { path: '/ws', corsApplies: false, tokenRequired },
          /** in plain words, what to fix; empty when nothing is wrong */
          problems,
          ts: Date.now(),
        },
      });
    }

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
        // ADDITIVE, all of it already knowable from the outside: whether a token
        // is demanded (/api/auth/session says so), whether this caller sent one,
        // and whether their Origin is allowed (the missing allow header says so).
        tokenRequired: !!this.cfg.apiToken,
        tokenSent: !!this._token(req, url),
        originAllowed: this._originAllowed(req.headers.origin || null, req),
        see: '/api/access',
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
    // The display payload (docs/API.md "Der Anzeige-Datensatz"). Same auth,
    // CORS, token and rate-limit chain as every other GET. `?players=none`
    // leaves the player list out for a pure scoreboard.
    if (p === '/api/display') {
      const withPlayers = (url.searchParams.get('players') || '') !== 'none';
      return this._json(res, 200, { data: buildDisplay(this.engine.snapshot(), { withPlayers }) });
    }
    // Game-mode registry + the mode detected right now (contract E). Read-only,
    // rides the same auth/CORS/rate-limit chain as every other GET above, and
    // carries nothing but the registry — no paths, no files, no config.
    if (p === '/api/modes') {
      const s = this.engine.snapshot();
      const cfgStatus = modeConfigStatus() || {};
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
          profiles: profileInfo().map((x) => ({
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
          // ADDITIVE: a one-glance verdict on the hand-edited files under
          // modes/. Without this, a typo in a mode file (broken JSON, unknown
          // family, a mission number claimed twice) only ever appears in the
          // log — and nobody reads the log on tournament day. The full detail,
          // including which file and what is wrong, is GET /api/modes/status.
          config: { ok: cfgStatus.ok !== false, problems: (cfgStatus.problems || []).length, loadedAt: cfgStatus.loadedAt || null },
        },
      });
    }
    // The hand-editable mode files under modes/: which were read, what they
    // define, and everything that is wrong with them. Read-only, behind the
    // same gate as every other GET.
    if (p === '/api/modes/status') return this._json(res, 200, { data: modeConfigStatus() });
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
      // `inline=1` is what the console's reader view asks for: same bytes, same
      // path handling, only without the attachment disposition — so the file can
      // be READ instead of landing in the download folder. It stays text/plain
      // with nosniff, so a browser never renders it as anything but text.
      const inline = url.searchParams.get('inline') === '1';
      const head = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (!inline) head['Content-Disposition'] = `attachment; filename="${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}"`;
      res.writeHead(200, head);
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
    // What a reset would delete, in the operator's words. Read-only on purpose:
    // the console shows this sentence BEFORE it asks for the password.
    if (p === '/api/stats/reset/plan') return this._json(res, 200, { data: this.stats.resetPlan() });
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

    // The broker URL may carry `user:passwort@` — docs/MQTT.md says so itself.
    // The log and /api/status have always redacted it (mqtt.status()); this
    // endpoint did not, so the one place that was meant to hold NO broker
    // credential handed the whole URL to every console. Same masking here, and
    // _unredactPatch() puts the stored value back when the mask comes home.
    if (c.mqtt && typeof c.mqtt.url === 'string') {
      const shown = redactUrl(c.mqtt.url);
      c.mqttUrlHasCredentials = shown !== c.mqtt.url;
      c.mqtt.url = shown;
    }

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
    delete patch.mqttUrlHasCredentials;
    // The console was handed `mqtt://***@host` — posting that back means "keep
    // the URL as it is", never "the broker user is literally ***".
    if (patch.mqtt && typeof patch.mqtt.url === 'string'
      && /:\/\/\*\*\*@/.test(patch.mqtt.url)
      && redactUrl(this.cfg.mqtt?.url || '') === patch.mqtt.url) {
      patch.mqtt.url = this.cfg.mqtt.url;
    }
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
        // Wiping the whole folder is the one capture action that cannot be
        // undone and cannot be repeated — it needs the password again.
        if (!await this._passwordOk(res, body, ip, 'alle Mitschnitte löschen')) return;
        const r = this.capture.deleteAll();
        this.log.warn('audit', `capture: alle Mitschnitte gelöscht von ${ip} (${r.deleted} Dateien)`);
        return this._json(res, 200, { data: { ...r, files: this.capture.listFiles() } });
      }
      const r = this.capture.deleteFile(String(body?.name ?? ''));
      if (!r.ok) return this._json(res, r.error === 'not_found' ? 404 : 400, { error: r.error });
      this.log.warn('audit', `capture: Mitschnitt gelöscht von ${ip}: ${String(body?.name ?? '').slice(0, 120)}`);
      return this._json(res, 200, { data: { ...r, files: this.capture.listFiles() } });
    }
    // Deleting or resetting the CSV statistics. Both need the admin password
    // typed again (_passwordOk), both are audited, and the reset clears the
    // writer's in-memory aggregates as well — see StatsWriter.forgetAll().
    if (p === '/api/stats/delete') {
      const name = String(body?.name ?? '');
      if (!await this._passwordOk(res, body, ip, `Statistik-Datei löschen (${name.slice(0, 120)})`)) return;
      const r = this.stats.deleteFile(name);
      if (!r.ok) return this._json(res, r.error === 'not_found' ? 404 : 400, { error: r.error, hint: r.hint });
      this.log.warn('audit', `stats: Datei gelöscht von ${ip}: ${name.slice(0, 120)}`);
      return this._json(res, 200, { data: { ...r, files: this.stats.listFiles(), plan: this.stats.resetPlan() } });
    }
    if (p === '/api/stats/reset') {
      if (!await this._passwordOk(res, body, ip, 'Statistik zurücksetzen')) return;
      const r = this.stats.resetAll();
      this.log.warn('audit', `stats: zurückgesetzt von ${ip} — ${r.deleted} Dateien gelöscht, Gesamtwertungen und Modus-Historie im Speicher geleert${r.failed.length ? `, ${r.failed.length} nicht löschbar` : ''}`);
      return this._json(res, 200, { data: { ...r, files: this.stats.listFiles(), plan: this.stats.resetPlan() } });
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
  /**
   * What a client is subscribed to. The DEFAULTS are exactly what this service
   * has always sent — a full `state` frame per tick and one `event` frame per
   * event — so a consumer written before any of this keeps working untouched.
   * Everything else has to be asked for, either in the connect URL or with a
   * `subscribe` control frame.
   */
  _defaultSub() {
    return { feed: 'state', batch: false, batchMs: EV_BATCH_MS_DEFAULT, players: true };
  }
  /**
   * Read a subscription out of the connect URL (`/ws?feed=display&events=batch`)
   * or out of a `subscribe` control frame. Anything unknown is ignored and the
   * previous value stays — a typo must never silently turn a feed off.
   */
  _applySub(sub, get) {
    const feed = get('feed');
    if (feed === 'state' || feed === 'display' || feed === 'both') sub.feed = feed;
    const events = get('events');
    if (events === 'batch') sub.batch = true;
    else if (events === 'single') sub.batch = false;
    const ms = parseInt(get('batchMs'), 10);
    if (Number.isFinite(ms)) sub.batchMs = Math.min(EV_BATCH_MS_MAX, Math.max(EV_BATCH_MS_MIN, ms));
    const players = get('players');
    if (players === 'none' || players === 'false' || players === false) sub.players = false;
    else if (players === 'full' || players === 'true' || players === true) sub.players = true;
    return sub;
  }

  _onWs(ws, req, url) {
    this.clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.rawTap = false;
    ws.sub = this._defaultSub();
    ws.evQueue = [];
    ws.evDropped = 0;
    if (url) this._applySub(ws.sub, (k) => url.searchParams.get(k));
    ws.on('message', (data, isBinary) => this._onWsMessage(ws, data, isBinary));
    ws.on('error', () => {});
    ws.on('close', () => {
      this.clients.delete(ws);
      if (ws.rawTap) { ws.rawTap = false; this._syncRawTap(); }
      this._syncEventBatch();
      this.log.info('ws', `client disconnected (${this.clientCount})`);
    });
    this._syncEventBatch();
    this.log.info('ws', `client connected (${this.clientCount}) — feed=${ws.sub.feed}, events=${ws.sub.batch ? `batch/${ws.sub.batchMs}ms` : 'single'}`);

    // Immediate opener so a fresh client has state before the next shared tick.
    // `ready` is additive and tells the client what it actually got subscribed
    // to — a typo in the query string is then visible instead of silent.
    this._safe(ws, { type: 'hello', service: 'lf-live', ts: Date.now() });
    this._safe(ws, { type: 'ready', ...ws.sub, ts: Date.now() });
    this._openerFor(ws);
  }
  /** The first payload a fresh (or newly re-subscribed) client gets. */
  _openerFor(ws) {
    const sub = ws.sub || this._defaultSub();
    if (sub.feed === 'state' || sub.feed === 'both') this._safe(ws, { type: 'state', data: this.engine.snapshot() });
    if (sub.feed === 'display' || sub.feed === 'both') {
      this._safe(ws, { type: 'display', data: buildDisplay(this.engine.snapshot(), { withPlayers: sub.players }) });
    }
  }
  _safe(ws, obj) { if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)); } catch {} } }

  // ---- live raw lines (console section "Rohdaten") ----
  /**
   * The two things a client may send us:
   *   {"type":"rawtap","on":true|false}   — "I have the raw section open"
   *   {"type":"subscribe","feed":…,"events":…} — pick feed / bundling
   * Everything else is ignored, and a frame over WS_MSG_MAX bytes is dropped
   * without even being parsed.
   */
  _onWsMessage(ws, data, isBinary) {
    if (isBinary) return;
    let s;
    try { s = String(data); } catch { return; }
    if (!s || s.length > WS_MSG_MAX) return;
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (!m) return;
    if (m.type === 'rawtap') {
      const on = m.on === true;
      if (!!ws.rawTap === on) return;
      ws.rawTap = on;
      this._syncRawTap();
      return;
    }
    if (m.type === 'subscribe') {
      const before = JSON.stringify(ws.sub);
      this._applySub(ws.sub, (k) => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null));
      if (!ws.sub.batch) { ws.evQueue.length = 0; ws.evDropped = 0; }
      this._syncEventBatch();
      this._safe(ws, { type: 'ready', ...ws.sub, ts: Date.now() });
      // Only re-open the feed when it actually changed — a client that merely
      // switches event bundling on does not need another full state frame.
      if (JSON.stringify(ws.sub) !== before) this._openerFor(ws);
    }
  }

  // ---- bundled event frames ----
  /**
   * Run the bundle timer only while at least one client asked for bundles, and
   * run it at the SHORTEST window anybody asked for — a client that wants 20 ms
   * must not be served at another client's 500 ms. Re-created when that minimum
   * changes, so a later, more impatient client is honoured too.
   */
  _syncEventBatch() {
    let want = 0;
    let ms = EV_BATCH_MS_MAX;
    for (const ws of this.clients) {
      if (ws.sub && ws.sub.batch && ws.readyState === ws.OPEN) { want++; ms = Math.min(ms, ws.sub.batchMs); }
    }
    if (want === 0) return this._stopEventBatch();
    ms = Math.max(EV_BATCH_MS_MIN, ms);
    if (this._evTimer && this._evTimerMs === ms) return;
    if (this._evTimer) clearInterval(this._evTimer);
    this._evTimerMs = ms;
    this._evTimer = setInterval(() => this._flushEvents(), ms);
    this._evTimer.unref?.();
  }
  _stopEventBatch() {
    if (this._evTimer) { clearInterval(this._evTimer); this._evTimer = null; }
    this._evTimerMs = 0;
    for (const ws of this.clients) { if (ws.evQueue) { ws.evQueue.length = 0; ws.evDropped = 0; } }
  }
  /** One `events` frame per bundling client with whatever piled up since the last one. */
  _flushEvents() {
    const now = Date.now();
    for (const ws of this.clients) {
      if (!ws.sub || !ws.sub.batch || ws.readyState !== ws.OPEN) continue;
      if (!ws.evQueue.length && !ws.evDropped) continue;
      const data = ws.evQueue;
      const dropped = ws.evDropped;
      ws.evQueue = [];
      ws.evDropped = 0;
      try { ws.send(JSON.stringify({ type: 'events', data, dropped, ts: now })); } catch {}
    }
  }

  /**
   * Hang the capture tap in exactly while at least one console is looking, and
   * take it out again the moment the last one closes the section. With nobody
   * watching, the TCP path does not frame a single line for us and no timer
   * runs — the live view costs nothing when it is not on screen.
   */
  _syncRawTap() {
    let want = 0;
    for (const ws of this.clients) if (ws.rawTap && ws.readyState === ws.OPEN) want++;
    if (!this.capture) return;
    if (want > 0 && !this.capture.tapped) {
      this.capture.setTap((lines) => this._queueRaw(lines));
      this._rawTimer = setInterval(() => this._flushRaw(), RAW_BATCH_MS);
      this._rawTimer.unref?.();
      this.log.info('ws', 'Rohdaten-Ansicht: ein Betrachter — Live-Zeilen werden gebündelt gesendet');
    } else if (want === 0 && this.capture.tapped) {
      this._stopRawTap();
      this.log.info('ws', 'Rohdaten-Ansicht: niemand schaut mehr hin — Live-Zeilen aus');
    }
  }

  _stopRawTap() {
    if (this.capture && this.capture.tapped) { try { this.capture.setTap(null); } catch {} }
    if (this._rawTimer) { clearInterval(this._rawTimer); this._rawTimer = null; }
    this._rawQueue.length = 0;
    this._rawDropped = 0;
  }

  /** Collect what the tap handed us; a long burst goes out without waiting. */
  _queueRaw(lines) {
    for (const l of lines) {
      if (this._rawQueue.length >= RAW_QUEUE_MAX) { this._rawDropped++; continue; }
      this._rawQueue.push(l);
    }
    if (this._rawQueue.length >= RAW_BATCH_LINES) this._flushRaw();
  }

  /** One frame with everything that arrived since the last one. */
  _flushRaw() {
    if (!this._rawQueue.length && !this._rawDropped) return;
    const payload = JSON.stringify({ type: 'raw', lines: this._rawQueue, dropped: this._rawDropped, ts: Date.now() });
    this._rawQueue = [];
    this._rawDropped = 0;
    for (const ws of this.clients) {
      if (ws.rawTap && ws.readyState === ws.OPEN) { try { ws.send(payload); } catch {} }
    }
  }

  markDirty() { this.stateDirty = true; }
  /**
   * Would pushState() actually send anything? The shared state tick in
   * src/index.js asks every consumer this BEFORE it serializes, so a closed
   * console costs nothing at all instead of a full JSON.stringify of the whole
   * match state five times a second.
   */
  get wantsState() { return this.stateDirty && this.clients.size > 0; }
  /**
   * One frame per event for everybody who did not ask for anything else (the
   * unchanged, default behaviour), and a queue entry for everybody who did.
   * The single-event payload is serialized lazily: with only bundling consumers
   * connected, it is never built at all.
   */
  broadcastEvent(evt) {
    if (this.clients.size === 0) return;      // nobody to serialize for
    let payload = null;
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.sub && ws.sub.batch) {
        if (ws.evQueue.length >= EV_QUEUE_MAX) { ws.evQueue.shift(); ws.evDropped++; }
        ws.evQueue.push(evt);
        if (ws.evQueue.length >= EV_BATCH_MAX) this._flushEvents();
        continue;
      }
      if (payload === null) payload = JSON.stringify({ type: 'event', data: evt });
      try { ws.send(payload); } catch {}
    }
  }
  /**
   * Fan the pre-serialized {type:'state',…} string out to every WS client that
   * still wants the full snapshot, and a `display` frame to everybody who asked
   * for the lean one. The display payload is built at most ONCE per tick, from
   * the same `engine.snapshot()` the string was made of, so the two can never
   * describe different moments.
   */
  pushState(str) {
    if (!this.stateDirty) return;
    this.stateDirty = false;
    if (this.clients.size === 0) return;
    let full = null;      // display payload with players
    let lean = null;      // display payload without players
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const feed = (ws.sub && ws.sub.feed) || 'state';
      if (feed === 'state' || feed === 'both') { try { ws.send(str); } catch {} }
      if (feed === 'display' || feed === 'both') {
        const wantPlayers = !ws.sub || ws.sub.players !== false;
        if (wantPlayers && full === null) full = JSON.stringify({ type: 'display', data: buildDisplay(this.engine.snapshot(), { withPlayers: true }) });
        if (!wantPlayers && lean === null) lean = JSON.stringify({ type: 'display', data: buildDisplay(this.engine.snapshot(), { withPlayers: false }) });
        try { ws.send(wantPlayers ? full : lean); } catch {}
      }
    }
  }
}

module.exports = { ApiServer, listEventLogFiles, eventLogNameOk, buildDisplay };
