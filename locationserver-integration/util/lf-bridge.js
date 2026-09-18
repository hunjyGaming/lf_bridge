//  Laserforce-TDF-Bridge im Locationserver
//
//  Die Lasertag-Anlage verbindet sich zu UNS und schickt ihren Log-Strom
//  zeilenweise über TCP. Diese Datei nimmt den Strom entgegen, füttert damit die
//  übernommene Auswertung unter util/lf-tdf/ und veröffentlicht Missionsstart,
//  Missionsende und den Missionsbericht über den lokalen MQTT-Client des
//  Locationservers (util/mqtt-client.js).
//
//  MISSIONSKRITISCH — der Locationserver entscheidet über Check-ins und
//  Kartendrucke. Fällt er aus, steht der Eingang. Deshalb gilt hier:
//    · jeder Einstiegspunkt (Socket, Zeitgeber, MQTT-Rückruf) liegt in try/catch,
//      ein Fehler wird gemeldet und verschluckt, nie weitergereicht;
//    · häufen sich Fehler, schaltet sich die Bridge selbst ab (SELBSTABSCHALTUNG
//      weiter unten) und lässt den Rest des Dienstes unberührt;
//    · alles ist gedeckelt: Verbindungen, Zeilenpuffer, Warteschlange;
//    · im heißen Pfad wird nichts blockierend geschrieben.
//
//  Keine Eingabe vom TCP-Port wird ungeprüft als Zahl, Objektschlüssel oder
//  Dateiname verwendet — die Auswertung unter util/lf-tdf/ macht das bereits
//  richtig, diese Hülle reicht nur rohe Zeilen hinein und fertige Objekte heraus.

const net = require('net');
const config = require('./config');
const { getClient } = require('./mqtt-client');
const { startReportStore, stopReportStore, enqueueReport, reportStoreStatus } = require('./lf-report-store');
const { Engine, matchEndMs } = require('./lf-tdf/engine');
const { buildMatchReport, EntityIds } = require('./lf-tdf/matchReport');
const { modeConfigStatus } = require('./lf-tdf/gameModes');

//  ---- Grenzen ----------------------------------------------------------------
//  Der Prozess läuft tagelang ohne Neustart. Jede Sammelstelle hat eine Obergrenze.
const MAX_LINE_BYTES = 1024 * 1024; //  Zeilenpuffer je Socket ohne Zeilenumbruch
const MAX_CONNECTIONS = 4; //  gleichzeitige Verbindungen; weitere werden abgewiesen
const FAULT_WINDOW_MS = 60 * 1000; //  Zeitfenster der Fehlerzählung
const FAULT_LIMIT = 50; //  so viele Fehler im Fenster -> Selbstabschaltung
//  Die Auswertung selbst deckelt zusätzlich: höchstens 50 Ereignisse im
//  Zustandsobjekt (lf-tdf/engine.js) und höchstens 512 Spielerkennungen je Match
//  (lf-tdf/matchReport.js). Die Warteschlange der Berichte deckelt lf-report-store.js.

const TOPIC_MATCH_START = 'match_start';
const TOPIC_MATCH_END = 'match_end';
const TOPIC_REPORT = 'report';
const TOPIC_STATUS = 'status';

let started = false;
let disabled = false;
let disabledReason = null;
let server = null;
let engine = null;
let entityIds = null;
let mqttClient = null;
let onMqttConnect = null;
let startedAtIso = null;
const sockets = new Set();
const faults = [];
const counters = { connections: 0, lines: 0, bytes: 0, published: 0, dropped: 0, matches: 0, lastLineAt: null };

//  ---- kleine Helfer ----------------------------------------------------------

const getBaseTopic = () => {
  const raw = config.lf_bridge_mqtt_topic || 'funzone/lasertag';
  return String(raw).replace(/\/+$/, '');
};

//  Die Auswertung erwartet einen Logger mit (scope, message). Der Locationserver
//  kennt keinen Logger, also führt der Schreibtisch hier auf die Konsole.
const engineLogger = {
  debug: () => {},
  info: (scope, msg) => console.log(`LF bridge (${scope}): ${msg}`),
  warn: (scope, msg) => console.warn(`LF bridge (${scope}): ${msg}`),
  error: (scope, msg) => console.error(`LF bridge (${scope}): ${msg}`),
};

//  ---- SELBSTABSCHALTUNG ------------------------------------------------------
//
//  Jeder abgefangene Fehler landet hier. Überschreiten die Fehler innerhalb von
//  FAULT_WINDOW_MS die Zahl FAULT_LIMIT, schaltet sich die Bridge ab: TCP-Port
//  zu, Verbindungen weg, Zeitgeber aus, Auswertung los. Der Locationserver läuft
//  unberührt weiter — lieber keine Lasertag-Daten als kein Check-in.
//
//  Zurücksetzen: resetLfBridge() aufrufen, oder den Dienst neu starten
//  (`pm2 restart funzone-locationserver`). Beides fährt die Bridge wieder hoch;
//  ein Neustart ist der Weg, den das Handbuch ohnehin beschreibt.
const noteFault = (scope, err) => {
  try {
    const now = Date.now();
    faults.push(now);
    while (faults.length && now - faults[0] > FAULT_WINDOW_MS) {
      faults.shift();
    }
    console.error(`LF bridge (${scope}): ${(err && err.message) || err}`);
    if (faults.length >= FAULT_LIMIT) {
      disableLfBridge(
        `${faults.length} Fehler in ${Math.round(FAULT_WINDOW_MS / 1000)} Sekunden — zuletzt in "${scope}"`
      );
    }
  } catch (_) {
    //  Selbst die Fehlerzählung darf nicht werfen.
  }
};

//  Alles zumachen, was diese Bridge aufgemacht hat. Nie werfend.
const teardown = () => {
  for (const socket of sockets) {
    try {
      socket.destroy();
    } catch (_) {}
  }
  sockets.clear();
  if (server) {
    try {
      server.close();
    } catch (_) {}
    server = null;
  }
  if (engine) {
    try {
      engine.removeAllListeners();
      engine.reset();
    } catch (_) {}
    engine = null;
  }
  entityIds = null;
  //  Der MQTT-Client gehört dem Locationserver — nur unseren eigenen Zuhörer
  //  wieder abmelden, damit ein resetLfBridge() sie nicht ansammelt.
  if (mqttClient && onMqttConnect) {
    try {
      mqttClient.removeListener('connect', onMqttConnect);
    } catch (_) {}
  }
  onMqttConnect = null;
  try {
    stopReportStore();
  } catch (_) {}
};

const disableLfBridge = reason => {
  if (disabled) {
    return;
  }
  disabled = true;
  disabledReason = reason || 'unbekannt';
  console.error('LF bridge: ================================================');
  console.error(`LF bridge: SELBSTABSCHALTUNG — ${disabledReason}`);
  console.error('LF bridge: Der Lasertag-Teil ist ab jetzt aus. Der Locationserver');
  console.error('LF bridge: laeuft unveraendert weiter (Check-in, Druck, Sync).');
  console.error('LF bridge: Zuruecksetzen: pm2 restart funzone-locationserver');
  console.error('LF bridge: ================================================');
  publish(TOPIC_STATUS, { event: 'lf_bridge_status', status: 'disabled', reason: disabledReason }, true);
  teardown();
  started = false;
};

//  ---- MQTT -------------------------------------------------------------------
//
//  Über DEN Client des Locationservers, nicht über einen eigenen. Nie werfend,
//  nie wartend: lieber eine Nachricht verwerfen als den Parser aufhalten.
const publish = (suffix, payload, retain) => {
  try {
    if (!mqttClient) {
      mqttClient = getClient();
    }
    if (!mqttClient || !mqttClient.connected) {
      counters.dropped++;
      return false;
    }
    const topic = `${getBaseTopic()}/${suffix}`;
    const body = JSON.stringify({ ts: new Date().toISOString(), locationId: config.location_id || null, ...payload });
    mqttClient.publish(topic, body, { qos: 1, retain: retain === true });
    counters.published++;
    return true;
  } catch (err) {
    counters.dropped++;
    noteFault('mqtt', err);
    return false;
  }
};

const publishOnlineStatus = () =>
  publish(
    TOPIC_STATUS,
    { event: 'lf_bridge_status', status: 'online', host: config.lf_bridge_host || '0.0.0.0', port: config.lf_bridge_port },
    true
  );

//  ---- Momentaufnahmen in Nachrichten übersetzen -------------------------------

const modeOf = s => {
  const m = (s && s.mode) || null;
  if (!m || typeof m !== 'object') {
    return null;
  }
  return {
    number: m.number == null ? null : m.number,
    key: m.key || null,
    label: m.label || null,
    family: m.family || null,
    profile: m.profile || null,
    known: m.known === true,
    source: m.source || null,
  };
};

const teamsOf = s => {
  const t = (s && s.teams) || {};
  try {
    return Object.keys(t).map(id => ({
      id,
      name: (t[id] && t[id].name) || null,
      color: (t[id] && t[id].color) || null,
    }));
  } catch (_) {
    return [];
  }
};

const playerCount = s => {
  try {
    return Object.keys((s && s.players) || {}).length;
  } catch (_) {
    return 0;
  }
};

//  ---- Rundenbeginn und Rundenende --------------------------------------------

const handleMatchStart = () => {
  try {
    const s = engine.snapshot();
    startedAtIso = new Date().toISOString();
    counters.matches++;
    if (entityIds) {
      entityIds.reset();
    }
    const known = s.durationKnown === true;
    publish(TOPIC_MATCH_START, {
      event: 'match_start',
      matchId: s.matchId || null,
      match: {
        matchId: s.matchId || null,
        startedAt: startedAtIso,
        //  Rundenlänge wie GEMELDET — null, solange die Anlage nichts gesagt hat.
        durationMs: known && Number.isFinite(s.duration) ? s.duration : null,
        durationKnown: known,
        mode: modeOf(s),
        missionDesc: s.missionDesc || null,
        teams: teamsOf(s),
        //  Die Anlage schickt ihre Spielerzeilen NACH dem Startcode; hier steht
        //  darum normalerweise 0. `playersFinal: false` sagt genau das.
        players: playerCount(s),
        playersFinal: false,
      },
    });
    console.log(`LF bridge: Mission gestartet (${s.matchId || 'ohne Kennung'}).`);
  } catch (err) {
    noteFault('match_start', err);
  }
};

const handleMatchEnd = () => {
  try {
    const s = engine.snapshot();
    const endedAt = Number.isFinite(s.endedAt) ? s.endedAt : Date.now();
    const elapsed = Number.isFinite(s.elapsedTime) ? s.elapsedTime : null;
    const known = s.durationKnown === true;
    publish(TOPIC_MATCH_END, {
      event: 'match_end',
      matchId: s.matchId || null,
      match: {
        matchId: s.matchId || null,
        startedAt: startedAtIso,
        endedAt: new Date(endedAt).toISOString(),
        //  tatsächlich gespielte Laufzeit nach der Uhr der Anlage
        actualDurationMs: elapsed,
        plannedDurationMs: known && Number.isFinite(s.duration) ? s.duration : null,
        durationKnown: known,
        //  WARUM das Match als beendet gilt — ein `0101` der Anlage und ein
        //  Wachhund-Ende sind zwei sehr verschiedene Aussagen.
        endReason: s.endReason || null,
        endSource: s.endSource || null,
        mode: modeOf(s),
        missionDesc: s.missionDesc || null,
        teams: teamsOf(s),
        players: playerCount(s),
        playersFinal: true,
        scores: s.scores && typeof s.scores === 'object' ? { ...s.scores } : {},
        scoreSource: s.scoreSource || 'internal',
      },
    });
    console.log(
      `LF bridge: Mission beendet (${s.matchId || 'ohne Kennung'}, Grund: ${s.endReason || 'unbekannt'}).`
    );
    buildAndQueueReport(s);
  } catch (err) {
    noteFault('match_end', err);
  } finally {
    startedAtIso = null;
  }
};

//  Der Missionsbericht: die Kurzfassung eines beendeten Matches. Er geht NICHT
//  direkt raus, sondern in die Warteschlange auf der Platte — ein nicht
//  erreichbarer Broker kostet keine Mission, auch über einen Neustart hinweg.
const buildAndQueueReport = state => {
  try {
    if (config.lf_bridge_report_enabled === false) {
      return;
    }
    const report = buildMatchReport(state, {
      entityIds: entityIds || new EntityIds(),
      startedAt: startedAtIso || undefined,
      includeNames: config.lf_bridge_report_names !== false,
      onProblem: p => {
        try {
          console.warn(`LF bridge (Bericht): ${p.file ? `${p.file}: ` : ''}${p.message}`);
        } catch (_) {}
      },
    });
    if (report) {
      enqueueReport(report);
    }
  } catch (err) {
    noteFault('report', err);
  }
};

//  ---- TCP --------------------------------------------------------------------

const handleSocket = socket => {
  try {
    if (sockets.size >= MAX_CONNECTIONS) {
      console.warn(
        `LF bridge: mehr als ${MAX_CONNECTIONS} gleichzeitige Verbindungen — neue Verbindung abgewiesen.`
      );
      try {
        socket.destroy();
      } catch (_) {}
      return;
    }
    sockets.add(socket);
    counters.connections++;
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`LF bridge: Laserforce verbunden (${peer}).`);
    socket.setNoDelay(true);

    try {
      engine.noteStreamResumed();
    } catch (err) {
      noteFault('stream-start', err);
    }

    let buffer = '';

    socket.on('data', data => {
      try {
        counters.bytes += data.length;
        buffer += data.toString('utf8');
        if (buffer.length > MAX_LINE_BYTES) {
          console.warn(
            `LF bridge: Zeilenpuffer über ${MAX_LINE_BYTES} Byte ohne Zeilenumbruch — verworfen.`
          );
          buffer = '';
          return;
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          counters.lines++;
          counters.lastLineAt = Date.now();
          //  Zuerst der Bericht: er merkt sich die ROHE Spielerkennung mit
          //  Präfix (# Mitglied · @ Gast), die der Parser gleich darauf entfernt.
          try {
            if (entityIds) entityIds.noteLine(trimmed);
          } catch (err) {
            noteFault('entity-ids', err);
          }
          try {
            engine.processLogLine(trimmed);
          } catch (err) {
            noteFault('parser', err);
          }
        }
      } catch (err) {
        buffer = '';
        noteFault('socket-data', err);
      }
    });

    socket.on('error', err => {
      console.warn(`LF bridge: Socket-Fehler (${peer}):`, err.message);
    });

    socket.on('close', () => {
      try {
        sockets.delete(socket);
        console.log(`LF bridge: Laserforce getrennt (${peer}).`);
        //  Verbindungsabbruch mitten im Match: NICHT sofort beenden — die Anlage
        //  verbindet sich womöglich gleich wieder. Solange noch eine andere
        //  Verbindung steht, ist gar nichts verloren.
        if (!sockets.size && engine) {
          engine.noteStreamLost();
        }
      } catch (err) {
        noteFault('socket-close', err);
      }
    });
  } catch (err) {
    noteFault('connection', err);
    try {
      socket.destroy();
    } catch (_) {}
  }
};

//  ---- Start und Stopp --------------------------------------------------------

const startLfBridge = () => {
  if (started || disabled) {
    return;
  }
  if (!config.lf_bridge_enabled) {
    return;
  }
  started = true;

  try {
    //  Wie die Modus-Dateien unter modes/ gelesen wurden. Ein Tippfehler in einer
    //  Missionsnummer ist der wahrscheinlichste Fehler im Betrieb, also gehört er
    //  sichtbar ins Log — er schaltet die Bridge NICHT ab, es gelten dann die
    //  eingebauten Vorgaben.
    const modes = modeConfigStatus();
    console.log(
      `LF bridge: Modus-Dateien aus ${modes.dir} — ${modes.modes.length} Modus/Modi, ${modes.profiles.length} Profil(e)${modes.ok ? '' : `, ${modes.problems.length} Problem(e)`}.`
    );
    for (const p of modes.problems || []) {
      console.warn(`LF bridge (Modi): ${p.file ? `${p.file}: ` : ''}${p.message}`);
    }
  } catch (err) {
    noteFault('modes', err);
  }

  try {
    entityIds = new EntityIds();
    engine = new Engine({
      logger: engineLogger,
      defaultDurationMs: config.lf_bridge_default_duration_seconds * 1000,
      emitUnknownEvents: false,
      matchEnd: matchEndMs({
        watchdogSeconds: config.lf_bridge_watchdog_seconds,
        streamLostSeconds: config.lf_bridge_stream_lost_seconds,
        endBlockSeconds: config.lf_bridge_end_block_seconds,
      }),
    });
    //  Bewusst NUR diese beiden. Ein Abonnent auf `change` oder `event` würde je
    //  Ereignis laufen und säße in einem Pfad der Auswertung, der aus einem
    //  setImmediate heraus aufgerufen wird — dort käme ein Fehler in die
    //  Ereignisschleife des Locationservers. Start und Ende reichen für MQTT.
    engine.on('match_start', handleMatchStart);
    engine.on('match_end', handleMatchEnd);
  } catch (err) {
    noteFault('engine', err);
    disableLfBridge('Die Auswertung konnte nicht aufgebaut werden.');
    return;
  }

  try {
    mqttClient = getClient();
    //  Der gemeinsame Client ist beim Start des Dienstes so gut wie nie schon
    //  verbunden — eine Statusmeldung jetzt würde verworfen. Also einmal jetzt
    //  (falls doch) und danach bei jedem Verbindungsaufbau, damit die
    //  retained-Statusmeldung nach jedem Broker-Neustart wieder steht.
    if (mqttClient.connected) {
      publishOnlineStatus();
    }
    onMqttConnect = () => {
      try {
        if (started && !disabled) publishOnlineStatus();
      } catch (err) {
        noteFault('mqtt-connect', err);
      }
    };
    mqttClient.on('connect', onMqttConnect);
  } catch (err) {
    noteFault('mqtt', err);
    mqttClient = null;
  }

  try {
    startReportStore(report => publish(TOPIC_REPORT, { event: 'match_report', ...report }));
  } catch (err) {
    noteFault('report-store', err);
  }

  const host = config.lf_bridge_host || '0.0.0.0';
  const port = config.lf_bridge_port;

  try {
    server = net.createServer(handleSocket);
    server.on('error', err => {
      //  Ein belegter Port ist ein Einrichtungsfehler, kein Dauerfehler: melden
      //  und die Bridge abschalten, aber den Dienst nicht anfassen.
      console.error(`LF bridge: TCP-Server-Fehler auf ${host}:${port}:`, err.message);
      disableLfBridge(`TCP-Port ${host}:${port} nicht verfügbar (${err.message})`);
    });
    server.listen(port, host, () => {
      console.log(`LF bridge: wartet auf Laserforce auf ${host}:${port}.`);
      console.log(`LF bridge: veröffentlicht auf ${getBaseTopic()}/# über den lokalen Broker.`);
      publishOnlineStatus();
    });
  } catch (err) {
    noteFault('tcp', err);
    disableLfBridge('Der TCP-Port konnte nicht geöffnet werden.');
  }
};

//  Geordnet herunterfahren. Ein laufendes Match wird noch abgerechnet, damit
//  seine Auswertung nicht verloren geht.
const stopLfBridge = () => {
  if (!started) {
    return;
  }
  try {
    if (engine) {
      engine.endMatch('shutdown');
    }
  } catch (err) {
    console.error('LF bridge: laufendes Match konnte nicht abgerechnet werden:', err.message);
  }
  publish(TOPIC_STATUS, { event: 'lf_bridge_status', status: 'offline' }, true);
  teardown();
  started = false;
};

//  Nach einer Selbstabschaltung von Hand wieder hochfahren, ohne Neustart.
const resetLfBridge = () => {
  if (!disabled) {
    return false;
  }
  disabled = false;
  disabledReason = null;
  faults.length = 0;
  started = false;
  console.warn('LF bridge: Selbstabschaltung zurückgesetzt, Bridge wird neu gestartet.');
  startLfBridge();
  return true;
};

//  Zustand für ein Status-Endpunkt oder das Log. Enthält KEINE Zugangsdaten:
//  weder Broker-URL noch Benutzername noch Passwort tauchen hier auf.
const lfBridgeStatus = () => ({
  enabled: !!config.lf_bridge_enabled,
  running: started && !disabled,
  disabled,
  disabledReason,
  host: config.lf_bridge_host || '0.0.0.0',
  port: config.lf_bridge_port,
  topic: getBaseTopic(),
  connections: sockets.size,
  totalConnections: counters.connections,
  lines: counters.lines,
  bytes: counters.bytes,
  matches: counters.matches,
  published: counters.published,
  droppedMessages: counters.dropped,
  lastLineAt: counters.lastLineAt,
  faultsInWindow: faults.length,
  faultLimit: FAULT_LIMIT,
  report: reportStoreStatus(),
});

module.exports = {
  startLfBridge,
  stopLfBridge,
  resetLfBridge,
  lfBridgeStatus,
};
