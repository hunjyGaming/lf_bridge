# `app.js` — der Einhäng-Schnipsel

Zwei Stellen. Beide folgen exakt dem Muster, das `startLfPassthroughBridge()`
und `startPlayerBridge()` dort schon haben.

## 1. Import — bei den übrigen Bridge-Imports

Bestehender Block (Zeilen 16–20 der unveränderten `app.js`):

```js
const { startOnlineMqttSync, getOnlineClient, getBaseTopic } = require('./util/online-mqtt-sync');
const { startLfPassthroughBridge } = require('./util/lf-passthrough-bridge');
const { startPlayerBridge } = require('./util/player-bridge');
const { startFleetBridge } = require('./util/fleet-bridge');
const fleetAgent = require('./util/fleet-agent');
```

**Eine Zeile anhängen:**

```js
const { startLfBridge } = require('./util/lf-bridge');
```

> Das `require` allein zieht `util/lf-tdf/` mit hinein und liest dabei `modes/`.
> Das ist bewusst so: ein Tippfehler in einer Missionsnummer wird beim Start
> gemeldet, nicht erst beim ersten Match. Es öffnet keinen Port und startet
> nichts — das tut erst `startLfBridge()`, und nur bei `LF_BRIDGE_ENABLED=true`.

## 2. Start — in `startServer()`, hinter der Passthrough-Bridge

Bestehender Block in `startServer()`:

```js
    // start lf passthrough bridge (lokaler -> online broker)
    try {
      startLfPassthroughBridge();
    } catch (e) {
      console.error('Failed to start LF passthrough bridge:', e.message);
    }
// ---------------------------- HIER EINFÜGEN ----------------------------

    // start player bridge (briefing/audio status and commands)
    try {
      startPlayerBridge();
    } catch (e) {
      console.error('Failed to start player bridge:', e.message);
    }
```

**Einzufügen:**

```js
    // start lf tdf bridge (Laserforce verbindet sich per TCP zu uns)
    try {
      startLfBridge();
    } catch (e) {
      console.error('Failed to start LF bridge:', e.message);
    }
```

Mehr nicht. `startLfBridge()` wirft nie — das `try/catch` steht nur da, weil die
Nachbarzeilen es auch tun.

## Optional: Zustand über die bestehende HTTP-API

Wer den Zustand der Bridge sehen will, hängt in `routes.js` bzw. dem passenden
Controller eine Zeile an. `lfBridgeStatus()` enthält **keine Zugangsdaten** —
weder Broker-URL noch Benutzername noch Passwort.

```js
const { lfBridgeStatus } = require('./util/lf-bridge');
router.get('/api/lf-bridge/status', (req, res) => res.json(lfBridgeStatus()));
```

Das ist bewusst **nicht** Teil des Patches: der Locationserver hat seine eigenen
Regeln, welche Route wie abgesichert wird.

## Herunterfahren

Ein eigener Signal-Handler wird **nicht** registriert — der Locationserver soll
über sein eigenes Herunterfahren bestimmen. Wer ein laufendes Match beim Stoppen
noch sauber abrechnen will, ruft in seinem vorhandenen Shutdown-Pfad
`stopLfBridge()` auf:

```js
const { stopLfBridge } = require('./util/lf-bridge');
process.on('SIGTERM', () => { try { stopLfBridge(); } catch (e) {} });
```

Ohne diesen Aufruf geht beim Neustart höchstens die Auswertung eines gerade
laufenden Matches verloren — bereits fertige Berichte liegen in `storage/` und
werden nach dem Start weiter zugestellt.
