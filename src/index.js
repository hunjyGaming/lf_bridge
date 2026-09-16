'use strict';

const fs = require('fs');
const path = require('path');

const { Config } = require('./config');
const { Logger } = require('./logger');
const { Engine } = require('./engine');
const { LocalRoster } = require('./localRoster');
const { StatsWriter } = require('./statsWriter');
const { EventLog } = require('./eventLog');
const { TcpIngest } = require('./tcpIngest');
const { Outputs } = require('./outputs');
const { StreamServer } = require('./streamServer');
const { ApiServer } = require('./apiServer');
const { Notifier } = require('./notify');
const { hashPassword, generatePassword } = require('./auth');
const { reachability, addressSummary, ipv4Addresses } = require('./netinfo');

const config = new Config();
config.load();

const logger = new Logger({ level: config.data.logLevel });
const getConfig = () => config.data;
const getState = () => engine.snapshot();

const engine = new Engine({ logger, defaultDurationMs: config.data.match.defaultDurationMs, emitUnknownEvents: config.data.engine.emitUnknownEvents });
const roster = new LocalRoster({ logger, getConfig });
const stats = new StatsWriter({ logger, getConfig });
const eventLog = new EventLog(config.data, logger);
const tcp = new TcpIngest({ logger, getConfig });
const outputs = new Outputs({ logger, getConfig, getState });
const streamServer = new StreamServer({ logger, getConfig, getState });
const notifier = new Notifier({ logger, getConfig });

const api = new ApiServer({
  logger, config, engine, roster, stats, outputs, eventLog, notifier,
  getStatus,
  onConfigChange: reconcile,
});

// ---- wiring ----
tcp.on('line', (line) => {
  try { engine.processLogLine(line); }
  catch (err) { logger.error('engine', `parse error: ${err.message} :: ${line.slice(0, 160)}`); }
});
// Hot path: a `change` only flips dirty flags + hands stats a live reference.
// The actual snapshot()+JSON.stringify happens once per tick below, shared by all
// three push consumers. Event broadcasts stay immediate (see 'event' below).
engine.on('change', () => { api.markDirty(); streamServer.markDirty(); outputs.markDirty(); stats.onChange(engine.gameState); });
engine.on('event', (evt) => { api.broadcastEvent(evt); streamServer.broadcastEvent(evt); outputs.onEvent(evt); stats.onEvent(evt); eventLog.onEvent(evt); });
engine.on('match_start', () => { const s = engine.snapshot(); stats.onMatchStart(s); eventLog.onMatchStart(s); });
engine.on('match_end', () => { const s = engine.snapshot(); stats.onMatchEnd(s); eventLog.onMatchEnd(s); });

// ---- one shared state tick ----
// If any consumer is dirty, serialize the state exactly once and hand the same
// pre-serialized string to every consumer.
const stateTick = setInterval(() => {
  if (!api.stateDirty && !streamServer.stateDirty && !outputs.stateDirty) return;
  const snapshot = engine.snapshot();
  const str = JSON.stringify({ type: 'state', data: snapshot });
  api.pushState(str);
  streamServer.pushState(str);
  outputs.pushState(snapshot, str);
}, config.data.stateTickMs);
stateTick.unref?.();

function getStatus() {
  const s = engine.snapshot();
  const net = reachability(config.data);
  return {
    service: 'lf-live',
    lan: net.primary,
    network: net,
    notify: { configured: notifier.channels(), last: notifier.last, lastAt: notifier.lastAt },
    admin: {
      loginRequired: config.data.admin.enabled !== false && !!config.data.admin.passwordHash,
      passwordSet: !!config.data.admin.passwordHash,
      passwordPinned: config.isPinned('admin.passwordHash'),
      sessions: api.sessions.size,
      sessionHours: config.data.admin.sessionHours,
    },
    http: { ...config.data.http, clients: api.clientCount, tokenSet: !!config.data.apiToken, cors: config.data.cors, rateLimitPerMin: config.data.rateLimitPerMin },
    stateTickMs: config.data.stateTickMs,
    tcp: { ...tcp.stats },
    csv: stats.status(),
    eventLog: eventLog.status(),
    localRoster: roster.status(),
    outputs: outputs.statusList(),
    outputAllow: config.data.outputAllow,
    streamServer: { enabled: config.data.streamServer.enabled, host: streamServer.host, port: streamServer.port, clients: streamServer.clientCount },
    envPins: config.envPins,
    match: {
      active: s.missionActive,
      matchId: s.matchId,
      elapsedMs: s.elapsedTime,
      durationMs: s.duration,
      // ADDITIVE (contract E). `durationKnown === false` means the rig never told
      // us how long the game is: consumers count UP from 0 instead of inventing a
      // countdown, and `remainingMs` is null. Never recompute duration - elapsed.
      durationKnown: s.durationKnown === true,
      remainingMs: s.remainingMs == null ? null : s.remainingMs,
      mode: s.mode ? { ...s.mode } : null,
      scoreSource: s.scoreSource || 'internal',
      players: Object.keys(s.players).length,
      teams: s.teams,
      scores: s.scores,
    },
  };
}

// Re-apply config after a web-console change without a full restart where possible.
let lastHttp = JSON.stringify(config.data.http);
let lastTcp = JSON.stringify(config.data.tcp);
async function reconcile() {
  engine.defaultDurationMs = config.data.match.defaultDurationMs;
  engine.emitUnknownEvents = config.data.engine.emitUnknownEvents !== false;

  if (JSON.stringify(config.data.tcp) !== lastTcp) {
    lastTcp = JSON.stringify(config.data.tcp);
    try { await tcp.start(); logger.info('tcp', 'rebound to new address'); }
    catch (err) { logger.error('tcp', `rebind failed: ${err.message}`); }
  }
  roster.load();
  engine.setRoster(roster.getMap());
  outputs.reconcile();
  streamServer.reconcile();

  if (JSON.stringify(config.data.http) !== lastHttp) {
    lastHttp = JSON.stringify(config.data.http);
    logger.warn('http', 'Web/API port changed — restart the service for it to take effect');
  }
}

// ---- admin password ----
/**
 * Erster Start, noch kein Passwort. Zwei Wege — der Hallen-PC hat weder Monitor
 * noch Shell, also muss das Passwort auf einem Weg ankommen, der von außen
 * erreichbar ist:
 *
 *   a) Ein Benachrichtigungskanal ist eingerichtet (Discord/ntfy/Mail): eines
 *      wird erzeugt und geht mit der Startnachricht raus. Genau einmal.
 *   b) Kein Kanal: es wird KEINES erzeugt — die Konsole zeigt stattdessen die
 *      Einrichtungsseite `/setup`, auf der man es im Browser selbst vergibt.
 *      Alles andere bleibt solange gesperrt.
 *
 * So gibt es keinen Zustand, in dem ein Passwort existiert, das niemand kennt.
 */
async function ensureAdminPassword() {
  if (config.data.admin.enabled === false) {
    logger.warn('auth', 'admin login is switched off (LF_ADMIN_ENABLED=false) — the console is open to everyone who can reach it');
    return null;
  }
  if (config.data.admin.passwordHash) return null;

  if (!notifier.configured) {
    logger.warn('auth', 'no admin password yet and no notification channel — the console only serves /setup until one is chosen');
    return null;
  }

  const password = generatePassword();
  config.setAdminPasswordHash(await hashPassword(password));

  // Zusätzlich lokal ablegen — falls doch jemand an den Rechner kommt.
  const file = path.resolve(process.cwd(), 'data', 'initial-admin-password.txt');
  let written = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `LF Live — erstes Admin-Passwort\n${new Date().toISOString()}\n\n${password}\n\nNach dem ersten Login in der Konsole ändern; diese Datei danach löschen.\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
    written = file;
  } catch (err) {
    logger.error('auth', `could not write ${file}: ${err.message}`);
  }

  const bar = '─'.repeat(52);
  logger.warn('auth', bar);
  logger.warn('auth', `ADMIN-PASSWORT (erstmalig erzeugt):  ${password}`);
  if (written) logger.warn('auth', `steht auch in: ${written}`);
  logger.warn('auth', 'geht mit der Startnachricht raus — danach bitte ändern');
  logger.warn('auth', bar);

  return { password, file: written };
}

// ---- startup notification ----
/**
 * `initial` ist nur beim allerersten Start gesetzt — nur dann steht ein Passwort
 * in der Nachricht. Jeder weitere Start meldet ausschließlich IP und Ports.
 */
async function announceStart(initial) {
  const n = config.data.notify;
  if (n.enabled === false || n.onStart === false) return;
  if (!notifier.configured) {
    logger.info('notify', 'no notification channel configured — see docs/NOTIFY.md (one line in .env, or set it up in the console)');
    return;
  }
  try {
    // Noch nicht eingerichtet? Dann ist die Einrichtungsseite die Nachricht wert.
    if (!config.data.admin.passwordHash && config.data.admin.enabled !== false) {
      await notifier.send(notifier.setupMessage());
      return;
    }
    const extra = [];
    if (initial) {
      extra.push('', '── Erster Start ──');
      if (n.includeInitialPassword) extra.push(`Admin-Passwort:  ${initial.password}`);
      else if (initial.file) extra.push(`Admin-Passwort steht auf dem Rechner in: ${initial.file}`);
      extra.push('Bitte nach dem ersten Login in der Konsole ändern.');
    }
    await notifier.send(notifier.startupMessage(extra));
  } catch (err) {
    logger.warn('notify', `startup notification failed: ${err.message}`);
  }
}

/** DHCP-Lease abgelaufen, Kabel umgesteckt: melden, wo die Kiste jetzt hängt. */
let knownIps = '';
const ipWatch = setInterval(() => {
  const now = ipv4Addresses().map((a) => a.address).sort().join(',');
  if (now === knownIps) return;
  const before = knownIps;
  knownIps = now;
  if (!before) return;                       // erster Durchlauf nach dem Start
  logger.warn('net', `IP addresses changed: ${before || '—'} -> ${now || '—'}`);
  const n = config.data.notify;
  if (n.enabled === false || n.onIpChange === false || !notifier.configured) return;
  notifier.send(notifier.ipChangeMessage()).catch((err) => logger.warn('notify', err.message));
}, 60000);
ipWatch.unref?.();

// ---- boot ----
(async () => {
  const initial = await ensureAdminPassword();
  try {
    await api.start();
  } catch (err) {
    // Ohne Konsole gibt es auf einem Rechner ohne Monitor keinen Weg mehr rein —
    // also laut sterben, damit der Dienstmanager es als Fehler sieht und neu startet.
    logger.error('lf-live', `cannot bind ${config.data.http.host}:${config.data.http.port} — ${err.message}`);
    logger.error('lf-live', 'another instance running, or the port is taken. Nothing else will start.');
    return setTimeout(() => process.exit(1), 100);
  }
  try {
    await tcp.start();
  } catch (err) {
    logger.error('tcp', `cannot bind ${config.data.tcp.host}:${config.data.tcp.port} — ${err.message}`);
    logger.error('tcp', 'the web console still works; fix the port there or in .env and restart');
  }
  roster.load();
  engine.setRoster(roster.getMap());
  outputs.reconcile();
  streamServer.reconcile();

  const net = reachability(config.data);
  knownIps = net.addresses.map((a) => a.address).sort().join(',');
  logger.info('lf-live', `console: ${net.urls.join('   ·   ')}`);
  logger.info('lf-live', `this PC: ${net.hostname} — ${addressSummary(net.addresses)}`);
  logger.info('lf-live', `Laserforce log export -> ${config.data.tcp.host}:${config.data.tcp.port}`);
  if (config.data.csv.enabled) logger.info('stats', `CSV stats -> ${stats.dir()}`);

  if (!config.data.admin.passwordHash && config.data.admin.enabled !== false) {
    logger.warn('auth', `console is waiting to be set up — open ${net.urls.find((u) => !u.includes('localhost')) || net.urls[0]}setup`);
  }
  await announceStart(initial);
})();

// ---- shutdown ----
function shutdown() {
  logger.info('lf-live', 'shutting down');
  clearInterval(stateTick);
  clearInterval(ipWatch);
  tcp.stop(); outputs.stop(); streamServer.stop(); api.stop();
  eventLog.flush();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => logger.error('lf-live', `uncaught: ${err.stack}`));
process.on('unhandledRejection', (err) => logger.error('lf-live', `unhandled rejection: ${err}`));
