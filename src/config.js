'use strict';

const fs = require('fs');
const path = require('path');
const { isHash, hashPasswordSync } = require('./auth');
const { reloadModes, modeConfigStatus } = require('./gameModes');

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
 *
 * THE MODE FILES RIDE ALONG. `modes/*.json` is not part of config.json — it is
 * hand-edited next to it and has its own validation (src/gameModes.js). But it
 * is applied at exactly the same two moments: on `load()` and on every
 * `update()` from the web console. Editing a mode file and hitting Save in the
 * console is therefore enough; the service does not have to be restarted for a
 * new mission number to be recognised. See docs/GAMEMODES.md.
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

    // Admin login for the web console (docs/SECURITY.md)
    admin: {
      enabled: true,              // false => no login at all (only sensible on a closed bench network)
      passwordHash: '',           // scrypt hash; generated on first run if empty
      sessionHours: 12,           // how long a login lasts
      maxFailedLogins: 8,         // failed attempts per IP before a lockout
      lockoutMinutes: 10,         // length of that lockout
    },

    cors: [],                     // browser origins allowed to call the read API; [] = none, ['*'] = any
    rateLimitPerMin: 600,         // per-IP request cap on the HTTP API; 0 = off
    stateTickMs: 200,             // shared state-push cadence for WS / raw stream / outputs (ms)

    // Laserforce log stream comes IN here
    tcp: { host: '0.0.0.0', port: 9000 },

    // Raw newline-delimited-JSON stream goes OUT here (tools connect in)
    streamServer: { enabled: false, host: '127.0.0.1', port: 9100 },

    match: { defaultDurationMs: 720000 },

    // Wann gilt ein Match als beendet, wenn die Anlage kein `0101` schickt?
    // (docs/LASERFORCE.md). Jeder Wert in Sekunden, 0 = dieser Weg ist aus.
    matchEnd: {
      watchdogSeconds: 120,     // keine Zeile mehr von der Anlage -> beendet
      streamLostSeconds: 30,    // TCP-Verbindung weg und kommt nicht zurück -> beendet
      endBlockSeconds: 10,      // Endabrechnung (6/7) gesehen und kein `0101` danach -> beendet
    },

    // Match engine
    engine: {
      emitUnknownEvents: true,     // emit a generic lf_event for every type-4 code the parser does not act on

      // Verdacht „Hinterherlaufen" (docs/GAMEMODES.md, Abschnitt
      // „Hinterherlaufen"). Reine Beobachtung — es wird nichts bestraft,
      // nichts gespeichert und nichts am Spiel verändert.
      chase: {
        // Wieviele Treffer hintereinander auf DIESELBE Person, bevor das Paar
        // in der Liste auftaucht. 0 oder 1 = Erkennung aus.
        // 5 statt 3: an vier echten Standardspielen der Anlage erreichten bei 3
        // zwischen 32 % und 63 % aller Spieler die Schwelle mindestens einmal je
        // Match - als Auffaelligkeitsliste wertlos. Bei 5 sind es 0-5 %.
        threshold: 5,
        // Für welche ANZEIGEPROFILE die Erkennung läuft — nicht nach
        // Missionsnummer und nicht nach Familie: Modus 7 steht inzwischen in
        // modes/standard.json und zieht das Profil `standard`, weitere
        // Standard-Varianten brauchen dort nur ihre Nummer.
        profiles: ['standard'],
      },
    },

    // Verdacht „Hinterherlaufen" mitschreiben (docs/GAMEMODES.md).
    // Vorgabe AN — anders als beim Roh-Mitschnitt, und mit Absicht: die Datei
    // ist der eigentliche Zweck der Funktion („erstmal nur für die
    // Auswertung"), sie wächst um wenige Kilobyte am Tag statt um Megabyte, und
    // geschrieben wird einmal je Matchende statt laufend. Sie enthält
    // Spielernamen und liegt darum unter data/ (per .gitignore nicht im Repo).
    chaseLog: {
      enabled: true,
      dir: 'data/chase',
      summary: true,               // zusätzlich die Tagesübersicht schreiben
    },

    // Human-readable append-only event-log file (docs/LOGGING.md)
    eventLog: {
      enabled: true,
      dir: 'data/logs',
      rotate: 'daily',             // 'daily' | 'match' | 'none'
      filenamePrefix: 'events',
      // How long a line may wait so a burst shares ONE write call. Content and
      // order of the file are unaffected; only the number of writes changes.
      // 0 = write every event on its own (costly: see docs/PERFORMANCE.md).
      flushMs: 250,
    },

    // Statistics -> CSV files on this PC (docs/STATS.md)
    csv: {
      enabled: true,
      dir: 'data/stats',
      delimiter: ';',             // ";" German Excel · "," pandas · "\t" tab
      bom: true,
      writeEvents: true,
      writeLive: false,
    },

    // Raw TDF capture — a diagnosis tool for a test phase (docs/CAPTURE.md).
    // OFF by default: a recording contains player names and Laserforce member
    // ids, and an unattended hall PC must never be filled up by it.
    capture: {
      enabled: false,
      dir: 'data/capture',
      maxFileMB: 20,              // per mission; then that recording stops
      maxFiles: 50,               // oldest are deleted
      maxTotalMB: 500,            // whole folder; oldest are deleted
    },

    // Optional self-maintained name list (CSV: id,name,team)
    localRoster: { enabled: false, file: 'data/roster.csv' },

    // Outbound targets — { id, name, kind:webhook|tcp|udp, enabled, events, sendEvents, sendState, ... }
    outputs: [],

    // Optional allowlist for outbound targets: "host" or "host:port", "*.suffix" ok. [] = allow all
    outputAllow: [],

    // MQTT out -> FunZone location server (docs/MQTT.md).
    // OFF by default: without a broker on the hall PC this must cost nothing.
    // NOTE there is no username/password here on purpose — see mqttCredentials()
    // below. Broker credentials live in the environment and never in config.json.
    mqtt: {
      enabled: false,
      url: 'mqtt://127.0.0.1:1883',
      // The location server subscribes to exactly this literal topic and drops
      // anything that is not it — no wildcard. Changing it cuts the link.
      topic: '/decs/lfpassthrough',
      // false = every message goes to `topic` and is told apart by its `event`
      // field. That is the ONLY thing the location server can receive; true is
      // for your own broker with a wildcard subscription.
      topicSuffixes: false,
      statusTopic: '',            // '' = the data topic (online notice + last will)
      qos: 1,
      retain: false,
      clientId: '',               // '' = lf-bridge-<hostname>-<random>
      reconnectSeconds: 5,
      // Messages buffered in MEMORY while the broker is away. 0 = none, and
      // that is the default on purpose: a memory buffer does not survive a
      // restart, so `publish()` may not report a buffered message as delivered
      // (src/mqtt.js). Retention belongs to the caller that has a disk queue —
      // the mission report has one. Raise it only for an installation that has
      // no such caller and wants best-effort catch-up; the oldest is dropped
      // first and every drop is counted in getStatus().
      queueMax: 0,
      tlsInsecure: false,         // mqtts:// with a self-signed certificate
      publishMatchStart: true,
      publishMatchEnd: true,
      publishStatus: true,        // online notice on connect + last will on death
    },

    // Startup / IP-change notification — "which IP and port am I on?" (docs/NOTIFY.md)
    notify: {
      enabled: true,
      name: '',                   // shown in the message; empty => hostname
      onStart: true,
      onIpChange: true,
      // On the very first start the generated admin password travels with the
      // message — on a PC with no monitor and no shell that is the only way to
      // ever learn it. Set false and only its file path is mentioned.
      includeInitialPassword: true,
      discordWebhook: '',
      slackWebhook: '',
      ntfy: { server: 'https://ntfy.sh', topic: '', token: '' },
      telegram: { botToken: '', chatId: '' },
      webhook: { url: '', secret: '' },
      email: { host: '', port: 587, secure: false, user: '', pass: '', from: '', to: '', rejectUnauthorized: true },
    },
  };
}

/** Apply env overrides. `pins` (a Set) collects the dotted keys env has locked. */
function applyEnv(cfg, pins) {
  const P = (k, cond) => { if (cond) pins.add(k); };

  if (E('LF_LOG_LEVEL')) { cfg.logLevel = E('LF_LOG_LEVEL'); P('logLevel', 1); }

  if (E('LF_HTTP_HOST')) { cfg.http.host = E('LF_HTTP_HOST'); P('http.host', 1); }
  if (Ei('LF_HTTP_PORT') !== undefined) { cfg.http.port = Ei('LF_HTTP_PORT'); P('http.port', 1); }
  if (process.env.LF_API_TOKEN !== undefined) { cfg.apiToken = process.env.LF_API_TOKEN; P('apiToken', 1); }

  if (Eb('LF_ADMIN_ENABLED') !== undefined) { cfg.admin.enabled = Eb('LF_ADMIN_ENABLED'); P('admin.enabled', 1); }
  if (Ei('LF_ADMIN_SESSION_HOURS') !== undefined) { cfg.admin.sessionHours = Ei('LF_ADMIN_SESSION_HOURS'); P('admin.sessionHours', 1); }
  if (E('LF_ADMIN_PASSWORD_HASH') && isHash(E('LF_ADMIN_PASSWORD_HASH'))) { cfg.admin.passwordHash = E('LF_ADMIN_PASSWORD_HASH'); P('admin.passwordHash', 1); }
  else if (E('LF_ADMIN_PASSWORD')) { cfg.admin.passwordHash = cachedHash(E('LF_ADMIN_PASSWORD')); P('admin.passwordHash', 1); }
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

  if (Ei('LF_MATCH_END_WATCHDOG_SECONDS') !== undefined) { cfg.matchEnd.watchdogSeconds = Ei('LF_MATCH_END_WATCHDOG_SECONDS'); P('matchEnd.watchdogSeconds', 1); }
  if (Ei('LF_MATCH_END_STREAM_LOST_SECONDS') !== undefined) { cfg.matchEnd.streamLostSeconds = Ei('LF_MATCH_END_STREAM_LOST_SECONDS'); P('matchEnd.streamLostSeconds', 1); }
  if (Ei('LF_MATCH_END_BLOCK_SECONDS') !== undefined) { cfg.matchEnd.endBlockSeconds = Ei('LF_MATCH_END_BLOCK_SECONDS'); P('matchEnd.endBlockSeconds', 1); }

  if (Eb('LF_EMIT_UNKNOWN_EVENTS') !== undefined) { cfg.engine.emitUnknownEvents = Eb('LF_EMIT_UNKNOWN_EVENTS'); P('engine.emitUnknownEvents', 1); }

  if (Ei('LF_CHASE_STREAK') !== undefined) { cfg.engine.chase.threshold = Ei('LF_CHASE_STREAK'); P('engine.chase.threshold', 1); }
  if (E('LF_CHASE_PROFILES')) { cfg.engine.chase.profiles = E('LF_CHASE_PROFILES').split(',').map((s) => s.trim()).filter(Boolean); P('engine.chase.profiles', 1); }
  if (Eb('LF_CHASE_LOG_ENABLED') !== undefined) { cfg.chaseLog.enabled = Eb('LF_CHASE_LOG_ENABLED'); P('chaseLog.enabled', 1); }
  if (E('LF_CHASE_LOG_DIR')) { cfg.chaseLog.dir = E('LF_CHASE_LOG_DIR'); P('chaseLog.dir', 1); }
  if (Eb('LF_CHASE_LOG_SUMMARY') !== undefined) { cfg.chaseLog.summary = Eb('LF_CHASE_LOG_SUMMARY'); P('chaseLog.summary', 1); }

  // ---- MQTT out (docs/MQTT.md) ----
  // LF_MQTT_USERNAME / LF_MQTT_PASSWORD are NOT read here on purpose: they must
  // never end up in cfg, because cfg is what gets written to config.json and
  // handed to the console. See mqttCredentials().
  if (Eb('LF_MQTT_ENABLED') !== undefined) { cfg.mqtt.enabled = Eb('LF_MQTT_ENABLED'); P('mqtt.enabled', 1); }
  if (E('LF_MQTT_URL')) { cfg.mqtt.url = E('LF_MQTT_URL'); P('mqtt.url', 1); }
  if (E('LF_MQTT_TOPIC')) { cfg.mqtt.topic = E('LF_MQTT_TOPIC'); P('mqtt.topic', 1); }
  if (Eb('LF_MQTT_TOPIC_SUFFIXES') !== undefined) { cfg.mqtt.topicSuffixes = Eb('LF_MQTT_TOPIC_SUFFIXES'); P('mqtt.topicSuffixes', 1); }
  if (process.env.LF_MQTT_STATUS_TOPIC !== undefined) { cfg.mqtt.statusTopic = process.env.LF_MQTT_STATUS_TOPIC; P('mqtt.statusTopic', 1); }
  if (Ei('LF_MQTT_QOS') !== undefined) { cfg.mqtt.qos = Ei('LF_MQTT_QOS'); P('mqtt.qos', 1); }
  if (Eb('LF_MQTT_RETAIN') !== undefined) { cfg.mqtt.retain = Eb('LF_MQTT_RETAIN'); P('mqtt.retain', 1); }
  if (E('LF_MQTT_CLIENT_ID')) { cfg.mqtt.clientId = E('LF_MQTT_CLIENT_ID'); P('mqtt.clientId', 1); }
  if (Ei('LF_MQTT_RECONNECT_SECONDS') !== undefined) { cfg.mqtt.reconnectSeconds = Ei('LF_MQTT_RECONNECT_SECONDS'); P('mqtt.reconnectSeconds', 1); }
  if (Ei('LF_MQTT_QUEUE_MAX') !== undefined) { cfg.mqtt.queueMax = Ei('LF_MQTT_QUEUE_MAX'); P('mqtt.queueMax', 1); }
  if (Eb('LF_MQTT_TLS_INSECURE') !== undefined) { cfg.mqtt.tlsInsecure = Eb('LF_MQTT_TLS_INSECURE'); P('mqtt.tlsInsecure', 1); }
  if (Eb('LF_MQTT_MATCH_START') !== undefined) { cfg.mqtt.publishMatchStart = Eb('LF_MQTT_MATCH_START'); P('mqtt.publishMatchStart', 1); }
  if (Eb('LF_MQTT_MATCH_END') !== undefined) { cfg.mqtt.publishMatchEnd = Eb('LF_MQTT_MATCH_END'); P('mqtt.publishMatchEnd', 1); }
  if (Eb('LF_MQTT_STATUS') !== undefined) { cfg.mqtt.publishStatus = Eb('LF_MQTT_STATUS'); P('mqtt.publishStatus', 1); }

  if (Eb('LF_EVENTLOG_ENABLED') !== undefined) { cfg.eventLog.enabled = Eb('LF_EVENTLOG_ENABLED'); P('eventLog.enabled', 1); }
  if (E('LF_EVENTLOG_DIR')) { cfg.eventLog.dir = E('LF_EVENTLOG_DIR'); P('eventLog.dir', 1); }
  if (['daily', 'match', 'none'].includes(E('LF_EVENTLOG_ROTATE'))) { cfg.eventLog.rotate = E('LF_EVENTLOG_ROTATE'); P('eventLog.rotate', 1); }
  if (Ei('LF_EVENTLOG_FLUSH_MS') !== undefined) { cfg.eventLog.flushMs = Ei('LF_EVENTLOG_FLUSH_MS'); P('eventLog.flushMs', 1); }

  if (Eb('LF_CSV_ENABLED') !== undefined) { cfg.csv.enabled = Eb('LF_CSV_ENABLED'); P('csv.enabled', 1); }
  if (E('LF_CSV_DIR')) { cfg.csv.dir = E('LF_CSV_DIR'); P('csv.dir', 1); }
  if (E('LF_CSV_DELIMITER')) { cfg.csv.delimiter = E('LF_CSV_DELIMITER'); P('csv.delimiter', 1); }
  if (Eb('LF_CSV_BOM') !== undefined) { cfg.csv.bom = Eb('LF_CSV_BOM'); P('csv.bom', 1); }
  if (Eb('LF_CSV_EVENTS') !== undefined) { cfg.csv.writeEvents = Eb('LF_CSV_EVENTS'); P('csv.writeEvents', 1); }
  if (Eb('LF_CSV_LIVE') !== undefined) { cfg.csv.writeLive = Eb('LF_CSV_LIVE'); P('csv.writeLive', 1); }

  if (Eb('LF_CAPTURE_ENABLED') !== undefined) { cfg.capture.enabled = Eb('LF_CAPTURE_ENABLED'); P('capture.enabled', 1); }
  if (E('LF_CAPTURE_DIR')) { cfg.capture.dir = E('LF_CAPTURE_DIR'); P('capture.dir', 1); }
  if (Ei('LF_CAPTURE_MAX_FILE_MB') !== undefined) { cfg.capture.maxFileMB = Ei('LF_CAPTURE_MAX_FILE_MB'); P('capture.maxFileMB', 1); }
  if (Ei('LF_CAPTURE_MAX_FILES') !== undefined) { cfg.capture.maxFiles = Ei('LF_CAPTURE_MAX_FILES'); P('capture.maxFiles', 1); }
  if (Ei('LF_CAPTURE_MAX_TOTAL_MB') !== undefined) { cfg.capture.maxTotalMB = Ei('LF_CAPTURE_MAX_TOTAL_MB'); P('capture.maxTotalMB', 1); }

  if (Eb('LF_LOCAL_ROSTER_ENABLED') !== undefined) { cfg.localRoster.enabled = Eb('LF_LOCAL_ROSTER_ENABLED'); P('localRoster.enabled', 1); }
  if (E('LF_LOCAL_ROSTER_FILE')) { cfg.localRoster.file = E('LF_LOCAL_ROSTER_FILE'); cfg.localRoster.enabled = true; P('localRoster.file', 1); P('localRoster.enabled', 1); }

  // ---- notification channels (all optional, one line each in .env) ----
  const n = cfg.notify;
  if (Eb('LF_NOTIFY_ENABLED') !== undefined) { n.enabled = Eb('LF_NOTIFY_ENABLED'); P('notify.enabled', 1); }
  if (E('LF_NOTIFY_NAME')) { n.name = E('LF_NOTIFY_NAME'); P('notify.name', 1); }
  if (Eb('LF_NOTIFY_ON_START') !== undefined) { n.onStart = Eb('LF_NOTIFY_ON_START'); P('notify.onStart', 1); }
  if (Eb('LF_NOTIFY_ON_IP_CHANGE') !== undefined) { n.onIpChange = Eb('LF_NOTIFY_ON_IP_CHANGE'); P('notify.onIpChange', 1); }
  if (Eb('LF_NOTIFY_INCLUDE_INITIAL_PASSWORD') !== undefined) { n.includeInitialPassword = Eb('LF_NOTIFY_INCLUDE_INITIAL_PASSWORD'); P('notify.includeInitialPassword', 1); }

  if (E('LF_NOTIFY_DISCORD_WEBHOOK')) { n.discordWebhook = E('LF_NOTIFY_DISCORD_WEBHOOK'); P('notify.discordWebhook', 1); }
  if (E('LF_NOTIFY_SLACK_WEBHOOK')) { n.slackWebhook = E('LF_NOTIFY_SLACK_WEBHOOK'); P('notify.slackWebhook', 1); }

  if (E('LF_NOTIFY_NTFY_TOPIC')) { n.ntfy.topic = E('LF_NOTIFY_NTFY_TOPIC'); P('notify.ntfy.topic', 1); }
  if (E('LF_NOTIFY_NTFY_SERVER')) { n.ntfy.server = E('LF_NOTIFY_NTFY_SERVER'); P('notify.ntfy.server', 1); }
  if (E('LF_NOTIFY_NTFY_TOKEN')) { n.ntfy.token = E('LF_NOTIFY_NTFY_TOKEN'); P('notify.ntfy.token', 1); }

  if (E('LF_NOTIFY_TELEGRAM_TOKEN')) { n.telegram.botToken = E('LF_NOTIFY_TELEGRAM_TOKEN'); P('notify.telegram.botToken', 1); }
  if (E('LF_NOTIFY_TELEGRAM_CHAT_ID')) { n.telegram.chatId = E('LF_NOTIFY_TELEGRAM_CHAT_ID'); P('notify.telegram.chatId', 1); }

  if (E('LF_NOTIFY_WEBHOOK_URL')) { n.webhook.url = E('LF_NOTIFY_WEBHOOK_URL'); P('notify.webhook.url', 1); }
  if (E('LF_NOTIFY_WEBHOOK_SECRET')) { n.webhook.secret = E('LF_NOTIFY_WEBHOOK_SECRET'); P('notify.webhook.secret', 1); }

  if (E('LF_NOTIFY_EMAIL_TO')) { n.email.to = E('LF_NOTIFY_EMAIL_TO'); P('notify.email.to', 1); }
  if (E('LF_NOTIFY_SMTP_HOST')) { n.email.host = E('LF_NOTIFY_SMTP_HOST'); P('notify.email.host', 1); }
  if (Ei('LF_NOTIFY_SMTP_PORT') !== undefined) { n.email.port = Ei('LF_NOTIFY_SMTP_PORT'); P('notify.email.port', 1); }
  if (Eb('LF_NOTIFY_SMTP_SECURE') !== undefined) { n.email.secure = Eb('LF_NOTIFY_SMTP_SECURE'); P('notify.email.secure', 1); }
  if (E('LF_NOTIFY_SMTP_USER')) { n.email.user = E('LF_NOTIFY_SMTP_USER'); P('notify.email.user', 1); }
  if (process.env.LF_NOTIFY_SMTP_PASS !== undefined) { n.email.pass = process.env.LF_NOTIFY_SMTP_PASS; P('notify.email.pass', 1); }
  if (E('LF_NOTIFY_SMTP_FROM')) { n.email.from = E('LF_NOTIFY_SMTP_FROM'); P('notify.email.from', 1); }
  if (Eb('LF_NOTIFY_SMTP_TLS_INSECURE') !== undefined) { n.email.rejectUnauthorized = !Eb('LF_NOTIFY_SMTP_TLS_INSECURE'); P('notify.email.rejectUnauthorized', 1); }

  return cfg;
}

/**
 * Hashing LF_ADMIN_PASSWORD costs ~100 ms — applyEnv runs again on every console
 * save, so the result is memoized per plaintext value. Only ever one entry.
 */
let _pwCache = { plain: null, hash: null };
function cachedHash(plain) {
  if (_pwCache.plain === plain && _pwCache.hash) return _pwCache.hash;
  _pwCache = { plain, hash: hashPasswordSync(plain) };
  return _pwCache.hash;
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

  c.admin.enabled = bool(raw.admin?.enabled, d.admin.enabled);
  // only ever accept something that really looks like a scrypt hash — never a plaintext
  c.admin.passwordHash = isHash(raw.admin?.passwordHash) ? raw.admin.passwordHash : '';
  c.admin.sessionHours = clampInt(raw.admin?.sessionHours, d.admin.sessionHours, 1, 720);
  c.admin.maxFailedLogins = clampInt(raw.admin?.maxFailedLogins, d.admin.maxFailedLogins, 1, 1000);
  c.admin.lockoutMinutes = clampInt(raw.admin?.lockoutMinutes, d.admin.lockoutMinutes, 1, 1440);

  c.cors = Array.isArray(raw.cors) ? raw.cors.filter((s) => typeof s === 'string' && s.length < 300).slice(0, 30) : d.cors;
  c.rateLimitPerMin = clampInt(raw.rateLimitPerMin, d.rateLimitPerMin, 0, 100000);
  c.stateTickMs = clampInt(raw.stateTickMs, d.stateTickMs, 50, 5000);

  c.tcp.host = str(raw.tcp?.host, d.tcp.host).trim() || d.tcp.host;
  c.tcp.port = clampInt(raw.tcp?.port, d.tcp.port, 1, 65535);

  c.streamServer.enabled = bool(raw.streamServer?.enabled, d.streamServer.enabled);
  c.streamServer.host = str(raw.streamServer?.host, d.streamServer.host).trim() || d.streamServer.host;
  c.streamServer.port = clampInt(raw.streamServer?.port, d.streamServer.port, 1, 65535);

  c.match.defaultDurationMs = clampInt(raw.match?.defaultDurationMs, d.match.defaultDurationMs, 1000, 86400000);

  // 0 = abgeschaltet. Untergrenze sonst bewusst großzügig: ein fälschlich
  // beendetes Match ist schlimmer als ein zu spät beendetes.
  c.matchEnd.watchdogSeconds = clampInt(raw.matchEnd?.watchdogSeconds, d.matchEnd.watchdogSeconds, 0, 86400);
  c.matchEnd.streamLostSeconds = clampInt(raw.matchEnd?.streamLostSeconds, d.matchEnd.streamLostSeconds, 0, 86400);
  c.matchEnd.endBlockSeconds = clampInt(raw.matchEnd?.endBlockSeconds, d.matchEnd.endBlockSeconds, 0, 86400);

  c.engine.emitUnknownEvents = bool(raw.engine?.emitUnknownEvents, d.engine.emitUnknownEvents);

  // 0 und 1 heißen beide „aus": eine Serie von einem Treffer wäre keine Serie.
  c.engine.chase.threshold = clampInt(raw.engine?.chase?.threshold, d.engine.chase.threshold, 0, 50);
  // Profilnamen sind kleingeschrieben und kurz (`standard`, `sm5`, `laserball`
  // sowie eigene aus modes/). Alles andere fliegt raus, die Liste ist begrenzt.
  c.engine.chase.profiles = Array.isArray(raw.engine?.chase?.profiles)
    ? raw.engine.chase.profiles
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40))
      .filter(Boolean)
      .slice(0, 16)
    : d.engine.chase.profiles.slice();

  c.chaseLog.enabled = bool(raw.chaseLog?.enabled, d.chaseLog.enabled);
  c.chaseLog.dir = str(raw.chaseLog?.dir, d.chaseLog.dir).trim() || d.chaseLog.dir;
  c.chaseLog.summary = bool(raw.chaseLog?.summary, d.chaseLog.summary);

  c.eventLog.enabled = bool(raw.eventLog?.enabled, d.eventLog.enabled);
  c.eventLog.dir = str(raw.eventLog?.dir, d.eventLog.dir).trim() || d.eventLog.dir;
  c.eventLog.rotate = (['daily', 'match', 'none'].includes(raw.eventLog?.rotate)) ? raw.eventLog.rotate : d.eventLog.rotate;
  c.eventLog.filenamePrefix = (str(raw.eventLog?.filenamePrefix, d.eventLog.filenamePrefix).trim() || d.eventLog.filenamePrefix).replace(/[^a-zA-Z0-9._-]/g, '') || d.eventLog.filenamePrefix;
  // 0 = jede Zeile sofort schreiben. Obergrenze 5 s: länger darf eine Zeile
  // nicht auf die Platte warten, sonst fehlt bei einem harten Stromausfall zu viel.
  c.eventLog.flushMs = clampInt(raw.eventLog?.flushMs, d.eventLog.flushMs, 0, 5000);

  c.csv.enabled = bool(raw.csv?.enabled, d.csv.enabled);
  c.csv.dir = str(raw.csv?.dir, d.csv.dir).trim() || d.csv.dir;
  c.csv.delimiter = ([',', ';', '\t'].includes(raw.csv?.delimiter)) ? raw.csv.delimiter : d.csv.delimiter;
  c.csv.bom = bool(raw.csv?.bom, d.csv.bom);
  c.csv.writeEvents = bool(raw.csv?.writeEvents, d.csv.writeEvents);
  c.csv.writeLive = bool(raw.csv?.writeLive, d.csv.writeLive);

  c.capture.enabled = bool(raw.capture?.enabled, d.capture.enabled);
  c.capture.dir = str(raw.capture?.dir, d.capture.dir).trim() || d.capture.dir;
  c.capture.maxFileMB = clampInt(raw.capture?.maxFileMB, d.capture.maxFileMB, 1, 2000);
  c.capture.maxFiles = clampInt(raw.capture?.maxFiles, d.capture.maxFiles, 1, 1000);
  c.capture.maxTotalMB = clampInt(raw.capture?.maxTotalMB, d.capture.maxTotalMB, 1, 100000);

  c.localRoster.enabled = bool(raw.localRoster?.enabled, d.localRoster.enabled);
  c.localRoster.file = str(raw.localRoster?.file, d.localRoster.file).trim() || d.localRoster.file;

  const rawOutputs = Array.isArray(raw.outputs) ? raw.outputs
    : Array.isArray(raw.webhooks) ? raw.webhooks   // migrate legacy shape
    : [];
  c.outputs = rawOutputs.slice(0, 50).map(normalizeOutput);

  c.outputAllow = Array.isArray(raw.outputAllow)
    ? raw.outputAllow.filter((s) => typeof s === 'string' && s.length && s.length < 300).map((s) => s.trim().toLowerCase()).slice(0, 50)
    : d.outputAllow;

  c.mqtt = normalizeMqtt(raw.mqtt, d.mqtt);

  c.notify = normalizeNotify(raw.notify, d.notify);

  return c;
}

/**
 * Broker URL. Only the schemes the `mqtt` package actually speaks; anything
 * else falls back to the default, because a typo here would otherwise produce
 * a reconnect loop against nothing.
 */
const MQTT_SCHEMES = ['mqtt:', 'mqtts:', 'tcp:', 'ssl:', 'tls:', 'ws:', 'wss:'];
function validMqttUrl(u, fallback) {
  try {
    const x = new URL(String(u));
    return MQTT_SCHEMES.includes(x.protocol) ? x.toString().replace(/\/$/, '') : fallback;
  } catch { return fallback; }
}

/**
 * A publish topic, never a subscription: `+` and `#` are wildcards and must not
 * appear, and MQTT forbids the NUL character outright. An empty result falls
 * back so we can never publish to "".
 */
function mqttTopic(v, fallback) {
  const s = String(typeof v === 'string' ? v : '').trim();
  if (!s) return fallback;
  if (/[+#\x00]/.test(s)) return fallback;
  return s.slice(0, 300);
}

function normalizeMqtt(raw, d) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const m = structuredClone(d);
  m.enabled = bool(raw.enabled, d.enabled);
  m.url = validMqttUrl(raw.url, d.url);
  m.topic = mqttTopic(raw.topic, d.topic);
  m.topicSuffixes = bool(raw.topicSuffixes, d.topicSuffixes);
  // '' is a legal value here and means "use the data topic"
  m.statusTopic = typeof raw.statusTopic === 'string' && !raw.statusTopic.trim() ? '' : mqttTopic(raw.statusTopic, d.statusTopic);
  m.qos = clampInt(raw.qos, d.qos, 0, 2);
  m.retain = bool(raw.retain, d.retain);
  m.clientId = str(raw.clientId, d.clientId).trim().slice(0, 96);
  m.reconnectSeconds = clampInt(raw.reconnectSeconds, d.reconnectSeconds, 1, 3600);
  // 0 (the default) = buffer nothing at all; the ceiling keeps a broker outage
  // from eating RAM in the installations that do raise it
  m.queueMax = clampInt(raw.queueMax, d.queueMax, 0, 10000);
  m.tlsInsecure = bool(raw.tlsInsecure, d.tlsInsecure);
  m.publishMatchStart = bool(raw.publishMatchStart, d.publishMatchStart);
  m.publishMatchEnd = bool(raw.publishMatchEnd, d.publishMatchEnd);
  m.publishStatus = bool(raw.publishStatus, d.publishStatus);
  return m;
}

/**
 * Broker credentials — deliberately NOT part of `config.data`.
 *
 * Everything in `config.data` is written to `config.json` and handed to the web
 * console by `GET /api/config`. A broker password has no business in either, so
 * it is read straight from the environment at the moment it is needed and never
 * stored anywhere else. src/mqtt.js is the only caller, `getStatus()` only ever
 * reports WHETHER credentials exist.
 */
function mqttCredentials() {
  return {
    username: process.env.LF_MQTT_USERNAME || '',
    password: process.env.LF_MQTT_PASSWORD || '',
  };
}

function normalizeNotify(raw, d) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const n = structuredClone(d);
  n.enabled = bool(raw.enabled, d.enabled);
  n.name = str(raw.name, d.name).trim().slice(0, 80);
  n.onStart = bool(raw.onStart, d.onStart);
  n.onIpChange = bool(raw.onIpChange, d.onIpChange);
  n.includeInitialPassword = bool(raw.includeInitialPassword, d.includeInitialPassword);

  n.discordWebhook = validHttpUrl(raw.discordWebhook);
  n.slackWebhook = validHttpUrl(raw.slackWebhook);

  // without the trailing-slash trim, normalize() would not be idempotent
  // (new URL('https://ntfy.sh').toString() adds one) and every save would look like a change
  n.ntfy.server = (validHttpUrl(raw.ntfy?.server) || d.ntfy.server).replace(/\/+$/, '');
  // a topic is a path segment, never a slash-separated path
  n.ntfy.topic = str(raw.ntfy?.topic, '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  n.ntfy.token = str(raw.ntfy?.token, '').trim().slice(0, 300);

  n.telegram.botToken = str(raw.telegram?.botToken, '').trim().slice(0, 200);
  n.telegram.chatId = String(raw.telegram?.chatId ?? '').trim().slice(0, 64);

  n.webhook.url = validHttpUrl(raw.webhook?.url);
  n.webhook.secret = str(raw.webhook?.secret, '').slice(0, 300);

  n.email.host = str(raw.email?.host, '').trim().slice(0, 255);
  n.email.port = clampInt(raw.email?.port, d.email.port, 1, 65535);
  n.email.secure = bool(raw.email?.secure, d.email.secure);
  n.email.user = str(raw.email?.user, '').trim().slice(0, 255);
  n.email.pass = str(raw.email?.pass, '').slice(0, 300);
  n.email.from = str(raw.email?.from, '').trim().slice(0, 255);
  n.email.to = str(raw.email?.to, '').trim().slice(0, 500);
  n.email.rejectUnauthorized = bool(raw.email?.rejectUnauthorized, d.email.rejectUnauthorized);

  return n;
}

class Config {
  constructor(file) {
    this._explicitFile = !!file;
    this.file = file || path.resolve(process.cwd(), 'config.json');
    this.data = defaults();
    this.envPins = [];
    /** Last result of reading `modes/` — see `reloadModes()` / `modeStatus()`. */
    this.modes = null;
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
    this.reloadModes();
    if (!fs.existsSync(this.file)) this.save();
    return this.data;
  }

  /**
   * Re-read `modes/*.json`. Problems are reported by gameModes itself (German,
   * with the file name, on stderr) and kept in `this.modes` so a status view can
   * show them. Never throws: a broken mode file leaves the built-in modes in
   * place and must not stop the config from loading.
   */
  reloadModes() {
    try { this.modes = reloadModes(); }
    catch (_err) { try { this.modes = modeConfigStatus(); } catch { this.modes = null; } }
    return this.modes;
  }

  /** The state of the mode files — for the status endpoint and the console. */
  modeStatus() {
    try { return this.modes || modeConfigStatus(); }
    catch (_err) { return null; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch {}
    return this.data;
  }

  /** True when .env owns this dotted key — the console may only display it. */
  isPinned(key) { return this.envPins.includes(key); }

  /**
   * Store an already-hashed admin password. Kept out of `update()` on purpose:
   * the password never travels through the generic config patch path.
   */
  setAdminPasswordHash(hash) {
    if (this.isPinned('admin.passwordHash')) throw new Error('admin.passwordHash ist in .env festgelegt');
    if (!isHash(hash)) throw new Error('kein gültiger Passwort-Hash');
    this.data.admin.passwordHash = hash;
    this.save();
    return this.data.admin.passwordHash;
  }

  /** Merge a console patch, re-normalize, re-pin env, persist. */
  update(patch) {
    const merged = deepMerge(structuredClone(this.data), patch && typeof patch === 'object' ? patch : {});
    const pins = new Set();
    this.data = applyEnv(normalize(merged), pins);
    this.envPins = [...pins];
    // A console save is the operator's "apply now" — re-read the mode files too,
    // so a mission number added by hand takes effect without a restart.
    this.reloadModes();
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

module.exports = { Config, defaults, normalize, mqttCredentials };
