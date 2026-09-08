'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Configuration.
 *
 * Three layers, later wins:
 *   1. built-in defaults
 *   2. .env / environment variables     — ports, binds, secrets. Pinned: a value
 *      set here cannot be changed from the web console (it is shown read-only).
 *   3. config.json                       — match-day settings, edited in the console.
 *
 * config.json is created on first run, git-ignored, written with mode 0600.
 * See docs/CONFIG.md for the full variable list.
 */

function loadDotEnv() {
  for (const p of [process.env.LF_ENV_FILE, path.resolve(process.cwd(), '.env')]) {
    if (p && fs.existsSync(p)) { try { process.loadEnvFile(p); } catch {} return; }
  }
}

const E  = (k) => (process.env[k] === undefined || process.env[k] === '' ? undefined : process.env[k]);
const Ei = (k) => { const v = parseInt(E(k), 10); return Number.isNaN(v) ? undefined : v; };
const Eb = (k) => { const v = E(k); return v === undefined ? undefined : (v === '1' || v.toLowerCase() === 'true'); };
const Ecsv = (k) => { const v = E(k); return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean); };

function defaults() {
  return {
    logLevel: 'info',

    // Web console + JSON/WebSocket API
    http: { host: '0.0.0.0', port: 8080, trustProxy: false },
    apiToken: '',                 // empty => open on the LAN; set => Bearer required
    cors: [],                     // browser origins allowed to call the read API; [] = none, ['*'] = any
    rateLimitPerMin: 600,         // per-IP request cap on the HTTP API; 0 = off
    stateTickMs: 200,             // shared state-push cadence for WS / raw stream / outputs (ms)

    // Laserforce log stream comes IN here
    tcp: { host: '0.0.0.0', port: 9000 },

    // Raw newline-delimited-JSON stream goes OUT here (tools connect in)
    streamServer: { enabled: false, host: '127.0.0.1', port: 9100 },

    match: { defaultDurationMs: 720000 },

    // Statistics -> CSV files on this PC (docs/STATS.md)
    csv: {
      enabled: true,
      dir: 'data/stats',
      delimiter: ';',             // ";" German Excel · "," pandas · "\t" tab
      bom: true,
      writeEvents: true,
      writeLive: false,
    },

    // Optional self-maintained name list (CSV: id,name,team)
    localRoster: { enabled: false, file: 'data/roster.csv' },

    // Outbound targets — { id, name, kind:webhook|tcp|udp, enabled, events, sendEvents, sendState, ... }
    outputs: [],

    // Optional allowlist for outbound targets: "host" or "host:port", "*.suffix" ok. [] = allow all
    outputAllow: [],
  };
}

/** Apply env overrides. `pins` (a Set) collects the dotted keys env has locked. */
function applyEnv(cfg, pins) {
  const P = (k, cond) => { if (cond) pins.add(k); };

  if (E('LF_LOG_LEVEL')) { cfg.logLevel = E('LF_LOG_LEVEL'); P('logLevel', 1); }

  if (E('LF_HTTP_HOST')) { cfg.http.host = E('LF_HTTP_HOST'); P('http.host', 1); }
  if (Ei('LF_HTTP_PORT') !== undefined) { cfg.http.port = Ei('LF_HTTP_PORT'); P('http.port', 1); }
  if (process.env.LF_API_TOKEN !== undefined) { cfg.apiToken = process.env.LF_API_TOKEN; P('apiToken', 1); }
  if (Ecsv('LF_CORS_ORIGINS') !== undefined) { cfg.cors = Ecsv('LF_CORS_ORIGINS'); P('cors', 1); }
  if (Ei('LF_RATE_LIMIT_PER_MIN') !== undefined) { cfg.rateLimitPerMin = Ei('LF_RATE_LIMIT_PER_MIN'); P('rateLimitPerMin', 1); }
  if (Ei('LF_STATE_TICK_MS') !== undefined) { cfg.stateTickMs = Ei('LF_STATE_TICK_MS'); P('stateTickMs', 1); }
  if (Eb('LF_TRUST_PROXY') !== undefined) { cfg.http.trustProxy = Eb('LF_TRUST_PROXY'); P('http.trustProxy', 1); }
  if (Ecsv('LF_OUTPUT_ALLOW') !== undefined) { cfg.outputAllow = Ecsv('LF_OUTPUT_ALLOW'); P('outputAllow', 1); }

  if (E('LF_TCP_HOST')) { cfg.tcp.host = E('LF_TCP_HOST'); P('tcp.host', 1); }
  if (Ei('LF_TCP_PORT') !== undefined) { cfg.tcp.port = Ei('LF_TCP_PORT'); P('tcp.port', 1); }

  if (Eb('LF_STREAM_ENABLED') !== undefined) { cfg.streamServer.enabled = Eb('LF_STREAM_ENABLED'); P('streamServer.enabled', 1); }
  if (E('LF_STREAM_HOST')) { cfg.streamServer.host = E('LF_STREAM_HOST'); P('streamServer.host', 1); }
  if (Ei('LF_STREAM_PORT') !== undefined) { cfg.streamServer.port = Ei('LF_STREAM_PORT'); P('streamServer.port', 1); }

  if (Ei('LF_MATCH_DURATION_MS') !== undefined) { cfg.match.defaultDurationMs = Ei('LF_MATCH_DURATION_MS'); P('match.defaultDurationMs', 1); }

  if (Eb('LF_CSV_ENABLED') !== undefined) { cfg.csv.enabled = Eb('LF_CSV_ENABLED'); P('csv.enabled', 1); }
  if (E('LF_CSV_DIR')) { cfg.csv.dir = E('LF_CSV_DIR'); P('csv.dir', 1); }
  if (E('LF_CSV_DELIMITER')) { cfg.csv.delimiter = E('LF_CSV_DELIMITER'); P('csv.delimiter', 1); }
  if (Eb('LF_CSV_BOM') !== undefined) { cfg.csv.bom = Eb('LF_CSV_BOM'); P('csv.bom', 1); }
  if (Eb('LF_CSV_EVENTS') !== undefined) { cfg.csv.writeEvents = Eb('LF_CSV_EVENTS'); P('csv.writeEvents', 1); }
  if (Eb('LF_CSV_LIVE') !== undefined) { cfg.csv.writeLive = Eb('LF_CSV_LIVE'); P('csv.writeLive', 1); }

  if (Eb('LF_LOCAL_ROSTER_ENABLED') !== undefined) { cfg.localRoster.enabled = Eb('LF_LOCAL_ROSTER_ENABLED'); P('localRoster.enabled', 1); }
  if (E('LF_LOCAL_ROSTER_FILE')) { cfg.localRoster.file = E('LF_LOCAL_ROSTER_FILE'); cfg.localRoster.enabled = true; P('localRoster.file', 1); P('localRoster.enabled', 1); }

  return cfg;
}

// ---- validation / coercion of the web-console patch ----
const clampInt = (v, d, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const str = (v, d) => (typeof v === 'string' ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function validHttpUrl(u) {
  try { const x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.toString() : ''; }
  catch { return ''; }
}

const KINDS = ['webhook', 'tcp', 'udp'];
const eventFilter = (v) => (Array.isArray(v) && v.length ? v.filter((s) => typeof s === 'string').slice(0, 40) : ['*']);

function normalizeOutput(raw, i) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const kind = KINDS.includes(raw.kind) ? raw.kind : (raw.url ? 'webhook' : 'tcp');
  const base = {
    id: str(raw.id, '').trim() || `out_${Date.now().toString(36)}${i}`,
    name: str(raw.name, `${kind.toUpperCase()} ${i + 1}`).slice(0, 120),
    kind,
    enabled: bool(raw.enabled, false),
    events: eventFilter(raw.events),
    sendEvents: bool(raw.sendEvents, true),
    sendState: bool(raw.sendState, false),
  };
  if (kind === 'webhook') {
    base.url = validHttpUrl(raw.url);
    base.secret = str(raw.secret, '');
    base.includeState = bool(raw.includeState, base.sendState);
  } else {
    base.host = str(raw.host, '').trim().slice(0, 255);
    base.port = clampInt(raw.port, 0, 1, 65535);
  }
  return base;
}

function normalize(raw) {
  const d = defaults();
  raw = raw && typeof raw === 'object' ? raw : {};
  const c = defaults();

  c.logLevel = ['debug', 'info', 'warn', 'error'].includes(raw.logLevel) ? raw.logLevel : d.logLevel;

  c.http.host = str(raw.http?.host, d.http.host).trim() || d.http.host;
  c.http.port = clampInt(raw.http?.port, d.http.port, 1, 65535);
  c.http.trustProxy = bool(raw.http?.trustProxy, d.http.trustProxy);
  c.apiToken = str(raw.apiToken, d.apiToken);
  c.cors = Array.isArray(raw.cors) ? raw.cors.filter((s) => typeof s === 'string' && s.length < 300).slice(0, 30) : d.cors;
  c.rateLimitPerMin = clampInt(raw.rateLimitPerMin, d.rateLimitPerMin, 0, 100000);
  c.stateTickMs = clampInt(raw.stateTickMs, d.stateTickMs, 50, 5000);

  c.tcp.host = str(raw.tcp?.host, d.tcp.host).trim() || d.tcp.host;
  c.tcp.port = clampInt(raw.tcp?.port, d.tcp.port, 1, 65535);

  c.streamServer.enabled = bool(raw.streamServer?.enabled, d.streamServer.enabled);
  c.streamServer.host = str(raw.streamServer?.host, d.streamServer.host).trim() || d.streamServer.host;
  c.streamServer.port = clampInt(raw.streamServer?.port, d.streamServer.port, 1, 65535);

  c.match.defaultDurationMs = clampInt(raw.match?.defaultDurationMs, d.match.defaultDurationMs, 1000, 86400000);

  c.csv.enabled = bool(raw.csv?.enabled, d.csv.enabled);
  c.csv.dir = str(raw.csv?.dir, d.csv.dir).trim() || d.csv.dir;
  c.csv.delimiter = ([',', ';', '\t'].includes(raw.csv?.delimiter)) ? raw.csv.delimiter : d.csv.delimiter;
  c.csv.bom = bool(raw.csv?.bom, d.csv.bom);
  c.csv.writeEvents = bool(raw.csv?.writeEvents, d.csv.writeEvents);
  c.csv.writeLive = bool(raw.csv?.writeLive, d.csv.writeLive);

  c.localRoster.enabled = bool(raw.localRoster?.enabled, d.localRoster.enabled);
  c.localRoster.file = str(raw.localRoster?.file, d.localRoster.file).trim() || d.localRoster.file;

  const rawOutputs = Array.isArray(raw.outputs) ? raw.outputs
    : Array.isArray(raw.webhooks) ? raw.webhooks   // migrate legacy shape
    : [];
  c.outputs = rawOutputs.slice(0, 50).map(normalizeOutput);

  c.outputAllow = Array.isArray(raw.outputAllow)
    ? raw.outputAllow.filter((s) => typeof s === 'string' && s.length && s.length < 300).map((s) => s.trim().toLowerCase()).slice(0, 50)
    : d.outputAllow;

  return c;
}

class Config {
  constructor(file) {
    this._explicitFile = !!file;
    this.file = file || path.resolve(process.cwd(), 'config.json');
    this.data = defaults();
    this.envPins = [];
  }

  load() {
    loadDotEnv();
    if (!this._explicitFile && E('LF_CONFIG_FILE')) this.file = path.resolve(process.cwd(), E('LF_CONFIG_FILE'));

    let fromFile = {};
    try { fromFile = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') { try { fs.renameSync(this.file, `${this.file}.broken-${Date.now()}`); } catch {} }
    }
    const pins = new Set();
    this.data = applyEnv(normalize(fromFile), pins);
    this.envPins = [...pins];
    if (!fs.existsSync(this.file)) this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    return this.data;
  }

  /** Merge a console patch, re-normalize, re-pin env, persist. */
  update(patch) {
    const merged = deepMerge(structuredClone(this.data), patch && typeof patch === 'object' ? patch : {});
    const pins = new Set();
    this.data = applyEnv(normalize(merged), pins);
    this.envPins = [...pins];
    this.save();
    return this.data;
  }
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) base[k] = v;
    else if (v && typeof v === 'object') base[k] = deepMerge(base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? base[k] : {}, v);
    else base[k] = v;
  }
  return base;
}

module.exports = { Config, defaults, normalize };
