'use strict';

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

const api = new ApiServer({
  logger, config, engine, roster, stats, outputs, eventLog,
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
  return {
    service: 'lf-live',
    lan: lanAddress(),
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

// ---- boot ----
(async () => {
  await api.start();
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

  const port = config.data.http.port;
  const lan = lanAddress();
  logger.info('lf-live', `console: http://localhost:${port}/${lan ? `   ·   from the LAN: http://${lan}:${port}/` : ''}`);
  logger.info('lf-live', `Laserforce log export -> ${config.data.tcp.host}:${config.data.tcp.port}`);
  if (config.data.csv.enabled) logger.info('stats', `CSV stats -> ${stats.dir()}`);
})();

function lanAddress() {
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

// ---- shutdown ----
function shutdown() {
  logger.info('lf-live', 'shutting down');
  clearInterval(stateTick);
  tcp.stop(); outputs.stop(); streamServer.stop(); api.stop();
  eventLog.flush();
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => logger.error('lf-live', `uncaught: ${err.stack}`));
process.on('unhandledRejection', (err) => logger.error('lf-live', `unhandled rejection: ${err}`));
