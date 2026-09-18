# MQTT — Anbindung an den FunZone-Locationserver

lf_live kann Rundenstart, Rundenende und den Missionsbericht über **MQTT**
veröffentlichen. Empfänger ist der **FunZone-Locationserver**, der am Standort
läuft: er hört auf einem lokalen Broker mit und reicht alles, was dort ankommt,
**unverändert** an den Online-Broker weiter.

> **Standardmäßig aus.** Ohne `LF_MQTT_ENABLED=true` passiert nichts, und ohne
> laufenden Broker startet lf_live trotzdem sofort und wertet den TDF-Strom
> vollständig aus. Siehe [„Kein Broker da"](#kein-broker-da).

---

## Der Weg einer Nachricht

```
 Laserforce-Anlage
        │  TDF-Log (TCP)
        ▼
 ┌──────────────┐   /decs/lfpassthrough    ┌──────────────┐
 │   lf_live    │ ───────────────────────▶ │ lokaler MQTT │
 │  (diese SW)  │        QoS 1             │    Broker    │
 └──────────────┘                          └──────┬───────┘
                                                  │ abonniert
                                                  ▼
                                        ┌────────────────────┐
                                        │  Locationserver    │
                                        │ lf-passthrough-    │
                                        │    bridge.js       │
                                        └─────────┬──────────┘
                                                  │ 1:1 weitergereicht
                                                  ▼
                                   location/<LOCATION_ID>/LFstatus
                                        (Online-Broker, QoS 1)
```

lf_live ist nur der **Absender auf der lokalen Seite**. Alles danach gehört dem
Locationserver; wir abonnieren nichts und erwarten keine Antwort.

---

## Topics

| Topic | Vorgabe | Inhalt |
|---|---|---|
| Datentopic | `/decs/lfpassthrough` | `match_start`, `match_end`, `match_report` |
| Statustopic | *(dasselbe Topic)* | `bridge_online` beim Verbinden, `bridge_offline` als **Last Will** |

**Alle Nachrichten gehen auf dasselbe Topic** und werden über das Feld `event`
unterschieden. Das ist kein Schönheitsfehler, sondern Pflicht:

> Der Locationserver abonniert **genau dieses eine Topic**, ohne Platzhalter,
> und seine Nachrichtenbehandlung verwirft zusätzlich alles andere
> (`if (topic !== LOCAL_TOPIC) return;`). Ein Untertopic wie
> `/decs/lfpassthrough/match_start` **erreicht ihn nie.**

Wer einen eigenen Broker mit Platzhalter-Abonnement betreibt, kann
`LF_MQTT_TOPIC_SUFFIXES=true` setzen — dann geht jede Nachricht auf
`<topic>/<event>`. **Für den Locationserver muss das aus bleiben.**

QoS ist einstellbar, Vorgabe **1** (wie das Abonnement und die Weiterleitung des
Locationservers). `retain` ist standardmäßig **aus**, ebenfalls wie dort.

---

## ⚠ Der Allowlist-Fehler des Locationservers

**Das Wichtigste auf dieser Seite.** Ohne die richtige Einstellung auf der
Gegenseite kommt von uns **gar nichts** an.

Der Locationserver filtert, was er weiterreicht, über die Umgebungsvariable
`LF_PASSTHROUGH_EVENTS` (Komma-Liste, `*` = alles). In `handleLocalMessage()`
steht dazu sinngemäß:

```js
const rawPayload = messageBuffer.toString('utf8').trim();
let parsed = rawPayload;

const eventName = parsed;          // <— die KOMPLETTE Nutzlast als Zeichenkette
if (!shouldForwardEvent(eventName)) return;
```

Die daneben vorhandene Hilfsfunktion `extractEventName()`, die `payload.event`
bzw. `payload.type` aus dem JSON lesen würde, wird **nie aufgerufen** — toter
Code.

**Folge:** Verglichen wird der Name aus der Allowlist gegen die *ganze*
JSON-Nutzlast. Eine namentliche Allowlist wie `LF_PASSTHROUGH_EVENTS=match_start`
trifft deshalb **niemals** zu, und es wird **nichts** weitergeleitet. Dasselbe
gilt für den Auslieferungszustand: `LF_PASSTHROUGH_EVENTS` ist dort per Vorgabe
**leer**, und leer heißt ebenfalls *nichts weiterleiten*.

**Das ist ein Fehler auf deren Seite, nicht auf unserer.** lf_live baut nichts
dagegen — eine Nutzlast, die sich in eine Allowlist mogelt, wäre eine
Zeitbombe, sobald der Fehler behoben wird. Es gibt genau **zwei Auswege**:

1. **Betrieblich, sofort wirksam:** auf dem Locationserver
   ```
   LF_PASSTHROUGH_EVENTS=*
   ```
   setzen und ihn neu starten. Dann greift der Kurzschluss `hasWildcardForward`
   vor dem fehlerhaften Vergleich, und alles wird weitergereicht.

2. **Sauber, im fremden Repository:** in `util/lf-passthrough-bridge.js` die
   vorhandene Funktion tatsächlich benutzen —
   ```js
   let parsed = rawPayload;
   try { parsed = JSON.parse(rawPayload); } catch { /* Klartext bleibt Klartext */ }
   const eventName = typeof parsed === 'object' ? extractEventName(parsed) : parsed;
   ```
   Danach funktioniert auch eine namentliche Allowlist, zum Beispiel
   `LF_PASSTHROUGH_EVENTS=match_start,match_end,match_report,bridge_online,bridge_offline`.

**Damit Weg 2 ohne weitere Änderung funktioniert, trägt jede unserer
Nachrichten den Namen doppelt: in `event` *und* in `type`.** `extractEventName()`
liest `event` zuerst und `type` als Rückfallebene — beide Wege treffen.

---

## Nutzlasten

Jede Nachricht ist ein JSON-Objekt mit gemeinsamem Kopf:

| Feld | Bedeutung |
|---|---|
| `schema` | `"lf-bridge/mqtt/1"` — Formatkennung |
| `event` / `type` | Nachrichtenart, zweimal (siehe oben) |
| `service` | immer `"lf-live"` |
| `name` | Name dieser Installation (`LF_NOTIFY_NAME`, sonst Rechnername) |
| `ts` / `iso` | Sendezeitpunkt, Millisekunden bzw. ISO-8601 |

### Wie „Dauer unbekannt" gekennzeichnet ist

**Der kritische Punkt der ganzen Anbindung.** `gameState.durationKnown` kann
`false` sein — dann hat die Anlage in der Typ-1-Zeile **keine** Spieldauer
gemeldet, und der Wert, mit dem lf_live intern rechnet, ist bloß die eingestellte
Vorgabe `match.defaultDurationMs`. **Eine erfundene Dauer, die auf der
Gegenseite wie eine Messung aussieht, wäre schlimmer als gar keine Angabe.**

Deshalb sagen **drei voneinander unabhängige Felder** dasselbe:

| Fall | `durationMs` | `durationKnown` | `durationSource` |
|---|---|---|---|
| Anlage hat die Dauer gemeldet | die gemeldete Länge in ms | `true` | `"arena"` |
| Anlage hat **nichts** gemeldet | **`null`** | `false` | `"unknown"` |

Der Platzhalter aus der Konfiguration fährt in einem **eigenen** Feld mit,
`configuredDurationMs`, und zwar in **beiden** Fällen. Er steht **nie** in
`durationMs`. Ein Empfänger, der naiv `durationMs` liest, bekommt also `null` —
keine ausgedachte Zahl. Im `match_end` gilt dasselbe für `plannedDurationMs`.

### `match_start` — Rundenstart

Wird in dem Moment gesendet, in dem die Anlage den Startcode `0100` schickt.
Die Typ-1-Zeile mit der Spieldauer und die Typ-2-Zeilen mit den Teams kommen
**vor** `0100`, sind hier also vollständig.

```json
{
  "schema": "lf-bridge/mqtt/1",
  "event": "match_start",
  "matchId": "mu6rdikm",
  "match": {
    "matchId": "mu6rdikm",
    "startedAt": 1789723857478,
    "startedAtIso": "2026-09-18T09:30:57.478Z",
    "durationMs": 600000,
    "durationSeconds": 600,
    "durationKnown": true,
    "durationSource": "arena",
    "configuredDurationMs": 720000,
    "mode": {
      "number": 5,
      "key": "sm5",
      "label": "Space Marines 5",
      "family": "sm5",
      "profile": "sm5",
      "known": true,
      "source": "tdf"
    },
    "missionDesc": "Space Marines 5",
    "teams": [
      { "id": "0", "name": "Rote Kugeln", "color": "#ef4444" },
      { "id": "1", "name": "Blaue Kugeln", "color": "#3b82f6" }
    ],
    "players": 0,
    "playersFinal": false
  },
  "type": "match_start",
  "service": "lf-live",
  "name": "Halle 1",
  "ts": 1789723857478,
  "iso": "2026-09-18T09:30:57.478Z"
}
```

Dieselbe Runde, aber die Anlage hat **keine** Dauer gemeldet — nur der
Dauer-Block unterscheidet sich:

```json
"durationMs": null,
"durationSeconds": null,
"durationKnown": false,
"durationSource": "unknown",
"configuredDurationMs": 720000
```

> **`players` ist beim Start fast immer `0` — das ist ehrlich, nicht kaputt.**
> Die Anlage meldet ihre Spieler (Typ-3-Zeilen) **nach** dem Startcode, und
> `0100` leert die Spielerliste. `playersFinal: false` sagt genau das. Die
> endgültige Zahl steht im `match_end` (`playersFinal: true`) und im
> Missionsbericht. Die **Teams** dagegen sind schon hier vollständig.

### `match_end` — Rundenende

```json
{
  "schema": "lf-bridge/mqtt/1",
  "event": "match_end",
  "matchId": "mu6rdikm",
  "match": {
    "matchId": "mu6rdikm",
    "startedAt": 1789723857478,
    "endedAt": 1789724438000,
    "endedAtIso": "2026-09-18T09:40:38.000Z",
    "actualDurationMs": 581000,
    "actualDurationSeconds": 581,
    "plannedDurationMs": 600000,
    "durationKnown": true,
    "durationSource": "arena",
    "configuredDurationMs": 720000,
    "wallClockMs": 580522,
    "endReason": "mission_end",
    "endSource": "0101",
    "mode": {
      "number": 5,
      "key": "sm5",
      "label": "Space Marines 5",
      "family": "sm5",
      "profile": "sm5",
      "known": true,
      "source": "tdf"
    },
    "missionDesc": "Space Marines 5",
    "teams": [
      { "id": "0", "name": "Rote Kugeln", "color": "#ef4444" },
      { "id": "1", "name": "Blaue Kugeln", "color": "#3b82f6" }
    ],
    "players": 3,
    "playersFinal": true,
    "scores": { "0": 4200, "1": 3100 },
    "scoreSource": "tdf"
  },
  "type": "match_end",
  "service": "lf-live",
  "name": "Halle 1",
  "ts": 1789724438004,
  "iso": "2026-09-18T09:40:38.004Z"
}
```

| Feld | Bedeutung |
|---|---|
| `actualDurationMs` | **die tatsächlich gespielte Laufzeit** — die Spieluhr der Anlage (`elapsedTime`, Spalte 1 jeder In-Game-Zeile) |
| `plannedDurationMs` | was vorgesehen war; `null`, wenn die Anlage nie eine Dauer gemeldet hat |
| `wallClockMs` | was diese Bridge zwischen ihrer eigenen `match_start`-Nachricht und jetzt gemessen hat. **Kein Ersatz** für die Anlagenuhr, nur eine Gegenprobe. `null`, wenn lf_live mitten im Match dazugekommen ist. |
| `endReason` | `mission_end` \| `watchdog` \| `stream_lost` \| `next_match` \| `shutdown` |
| `endSource` | `0101` \| `summary_type6` \| `summary_type7` \| `silence` \| `stream_lost` \| `next_match` \| `shutdown` |

`endReason` und `endSource` sind zwei verschiedene Aussagen: *warum* das Match
als beendet gilt und *woran* das erkannt wurde. Ein `0101` der Anlage und ein
ausgelaufener Watchdog sind grundverschiedene Dinge — Einzelheiten in
[LASERFORCE.md](LASERFORCE.md).

### `bridge_online` / `bridge_offline` — Lebenszeichen

```json
{
  "schema": "lf-bridge/mqtt/1",
  "event": "bridge_online",
  "type": "bridge_online",
  "service": "lf-live",
  "name": "Halle 1",
  "status": "online",
  "cause": "connect",
  "ts": 1789723780424,
  "iso": "2026-09-18T09:29:40.424Z"
}
```

`bridge_offline` ist als **Last Will** beim Broker hinterlegt (`cause:
"last_will"`, QoS wie eingestellt, `retain: false`) — stirbt der Hallen-PC oder
reißt die Verbindung, meldet der Broker das von sich aus. Beim geordneten
Beenden schickt lf_live dieselbe Nachricht vorher selbst
(`cause: "shutdown"`). Abschaltbar mit `LF_MQTT_STATUS=false`.

Das ist dieselbe Bauart wie im Locationserver selbst, der für seine eigene
Verbindung zum Online-Broker ein `offline` als Last Will hinterlegt und beim
Verbinden ein `online` schickt.

### `match_report` — Missionsbericht

Wird nicht von diesem Modul gebaut, sondern von
[`src/matchReport.js`](../src/matchReport.js), und nur durchgereicht. Aufbau:
siehe [STATS.md](STATS.md). Er landet auf **demselben Topic** und trägt
`event: "match_report"`.

---

## Zustellung: mindestens einmal, und wer was aufbewahrt

`publish()` ist **Transport, keine Zustellgarantie**:

* Rückgabe `true` **nur**, wenn die Nachricht an einen **verbundenen** Broker
  übergeben wurde. Bei QoS 1 wiederholt die MQTT-Bibliothek sie danach bis zum
  `PUBACK`; bei **QoS 0 gibt es keine Bestätigung**, dort heißt `true` nur
  „in den Socket geschrieben".
* Rückgabe `false` bei: MQTT aus, keine Verbindung, unbrauchbare Nutzlast,
  Schreibfehler — **und auch dann, wenn die Nachricht nur im Speicherpuffer
  gelandet ist.** Ein Speicherpuffer übersteht keinen Neustart; ihn als Erfolg
  zu melden würde einen Aufrufer mit Platten-Warteschlange dazu bringen, seine
  einzige dauerhafte Kopie wegzuwerfen.

Deshalb ist `LF_MQTT_QUEUE_MAX` **standardmäßig `0`** — kein Speicherpuffer.
Die Aufbewahrung gehört dorthin, wo sie einen Neustart übersteht: in die
Platten-Warteschlange des Missionsberichts. Wer die Bridge ohne Missionsbericht
betreibt, kann den Puffer heraufsetzen; er hat dann eine harte Obergrenze,
wirft bei Überlauf die **ältesten** Nachrichten weg und zählt jede einzelne
(`dropped` in `/api/status`).

**Die Zustellung ist ausdrücklich „mindestens einmal".** Die Gegenseite
dedupliziert über `matchId`; ein Wiederholungsversuch für eine Nachricht, die
`false` gemeldet hat, ist also unschädlich, selbst wenn sie doch angekommen war.

---

## Kein Broker da

Ein nicht erreichbarer Broker ist ein **Normalzustand**, kein Notfall:

* lf_live **startet ohne Verzögerung**. Der Verbindungsaufbau läuft nebenher und
  es wird auf nichts gewartet.
* Der TDF-Strom wird **vollständig** ausgewertet — API, WebSocket, CSV,
  Event-Log, Ausgänge, Missionsbericht arbeiten unverändert weiter. Nachgewiesen:
  die Ereignisfolge eines eingespeisten Matches ist mit und ohne Broker
  identisch.
* Es wird **eine** Meldung geschrieben, danach ist Ruhe: dieselbe Fehlermeldung
  erscheint höchstens alle fünf Minuten erneut, mit der Zahl der unterdrückten
  Wiederholungen. Der Wiederverbindungsversuch selbst steht nur auf `debug`.
* Fällt der Broker **mitten im Match** aus und kommt zurück, verbindet sich
  lf_live von selbst wieder. Nichts stürzt ab und nichts wächst unbegrenzt.

Der MQTT-Pfad kann den TDF-Parser **nicht** blockieren: `publish()` wirft nie,
wartet nie und wird erst nach allen anderen Abnehmern aufgerufen.

---

## Konfiguration

Voller Variablenverzeichnis: [CONFIG.md](CONFIG.md). Kurzfassung:

| Variable | Standard | Bedeutung |
|---|---|---|
| `LF_MQTT_ENABLED` | `false` | MQTT-Ausgang an/aus |
| `LF_MQTT_URL` | `mqtt://127.0.0.1:1883` | Broker. `mqtt` · `mqtts` · `tcp` · `ssl` · `tls` · `ws` · `wss` |
| `LF_MQTT_TOPIC` | `/decs/lfpassthrough` | Datentopic. **Ändern trennt die Verbindung zum Locationserver.** |
| `LF_MQTT_TOPIC_SUFFIXES` | `false` | `true` = `<topic>/<event>`. **Für den Locationserver aus lassen.** |
| `LF_MQTT_STATUS_TOPIC` | *(leer)* | eigenes Topic für `bridge_online`/Last Will; leer = das Datentopic |
| `LF_MQTT_QOS` | `1` | `0` · `1` · `2` |
| `LF_MQTT_RETAIN` | `false` | Nachrichten beim Broker aufbewahren lassen |
| `LF_MQTT_CLIENT_ID` | *(automatisch)* | `lf-bridge-<rechner>-<zufall>` |
| `LF_MQTT_RECONNECT_SECONDS` | `5` | Abstand der Wiederverbindungsversuche |
| `LF_MQTT_QUEUE_MAX` | `0` | Nachrichten im **Arbeitsspeicher**, solange der Broker weg ist. `0` = keine (siehe oben) |
| `LF_MQTT_TLS_INSECURE` | `false` | `mqtts://` mit selbstsigniertem Zertifikat zulassen |
| `LF_MQTT_MATCH_START` | `true` | Rundenstart senden |
| `LF_MQTT_MATCH_END` | `true` | Rundenende senden |
| `LF_MQTT_STATUS` | `true` | `bridge_online` + Last Will |
| **`LF_MQTT_USERNAME`** | *(leer)* | **nur Umgebung** |
| **`LF_MQTT_PASSWORD`** | *(leer)* | **nur Umgebung** |

### Zugangsdaten

`LF_MQTT_USERNAME` und `LF_MQTT_PASSWORD` werden **absichtlich nicht** in
`config.json` übernommen und tauchen in der Konsole gar nicht erst auf. Sie
werden in dem Moment, in dem die Verbindung aufgebaut wird, direkt aus der
Umgebung gelesen (`mqttCredentials()` in `src/config.js`) und sonst nirgends
abgelegt. `GET /api/status` meldet nur `authConfigured: true|false`, nie einen
Wert. Trägt die Broker-URL Zugangsdaten (`mqtt://benutzer:geheim@host`), werden
sie in Log und Status zu `mqtt://***@host` gekürzt.

---

## Status

`GET /api/status` liefert unter `mqtt`:

```json
{
  "enabled": true,
  "connected": true,
  "state": "connected",
  "broker": "mqtt://127.0.0.1:1883",
  "topic": "/decs/lfpassthrough",
  "statusTopic": "/decs/lfpassthrough",
  "topicSuffixes": false,
  "qos": 1,
  "retain": false,
  "authConfigured": false,
  "queued": 0,
  "queueMax": 0,
  "published": 7,
  "confirmed": 7,
  "unconfirmed": 0,
  "dropped": 0,
  "errors": 0,
  "connects": 1,
  "lastPublishAt": 1789724438004,
  "lastError": null,
  "lastErrorAt": null
}
```

| Feld | Bedeutung |
|---|---|
| `state` | `off` · `connecting` · `connected` |
| `published` | an einen verbundenen Broker übergeben |
| `confirmed` / `unconfirmed` | davon vom Broker bestätigt (`PUBACK`) bzw. mit Fehler zurückgemeldet |
| `dropped` | konnte **nicht** übergeben werden — verworfen und gezählt |
| `queued` | liegt gerade im Speicherpuffer (nur wenn `queueMax > 0`) |
| `lastError` | letzte Fehlermeldung, ohne Zugangsdaten |

---

## Warum eine zweite Abhängigkeit

lf_live kam bis hierher mit **einer** Laufzeitabhängigkeit aus (`ws`) — das war
Absicht: auf einem Hallen-PC ohne Betreuung soll `npm install` niemals an einem
fehlenden Compiler scheitern. Für MQTT ist das Paket **`mqtt`**
([`^5.16.0`](https://www.npmjs.com/package/mqtt)) dazugekommen. Die Gründe:

* MQTT 3.1.1/5 mit QoS 1, Last Will und Wiederverbindung selbst zu schreiben
  wäre ein Protokoll-Nachbau mit eigener Fehlerklasse — genau die Art Code, die
  man an einem Eventabend nicht debuggen will.
* **`mqtt` ist reines JavaScript**, ohne native Erweiterung und ohne Compiler.
  Die Regel hinter „nur `ws`" bleibt damit gewahrt.
* Der Locationserver, mit dem wir sprechen, benutzt **dasselbe Paket in
  derselben Hauptversion** (`mqtt ^5.10`). Gleiche Bibliothek auf beiden Seiten
  heißt: gleiches Verhalten bei QoS, Last Will und Wiederverbindung.

Ein fehlendes oder kaputtes `mqtt`-Paket hält lf_live trotzdem nicht auf: das
Modul lädt es erst beim Verbindungsaufbau und meldet einen Fehlschlag als
Warnung — alles andere läuft weiter.

---

## Inbetriebnahme

1. Auf dem Hallen-PC bzw. am Standort muss ein **MQTT-Broker** laufen — derselbe,
   den der Locationserver mit `LF_PASSTHROUGH_MQTT_URL` abonniert (dort per
   Vorgabe `mqtt://localhost:1883`).
2. In der `.env` von lf_live:
   ```
   LF_MQTT_ENABLED=true
   LF_MQTT_URL=mqtt://127.0.0.1:1883
   ```
3. Auf dem Locationserver prüfen — **ohne das kommt nichts an**:
   ```
   LF_PASSTHROUGH_ENABLED=true
   LF_PASSTHROUGH_MQTT_URL=mqtt://localhost:1883
   LF_PASSTHROUGH_EVENTS=*
   LOCATION_ID=<die Standort-Kennung>
   ONLINE_MQTT_URL=<der Online-Broker>
   ```
4. lf_live neu starten und `GET /api/status` ansehen: `mqtt.state` muss
   `connected` sein.
5. Eine Runde starten. Auf dem Online-Broker muss unter
   `location/<LOCATION_ID>/LFstatus` eine `match_start`-Nachricht auftauchen.

Kommt nichts an, ist der **Allowlist-Fehler** die mit Abstand wahrscheinlichste
Ursache — siehe oben.
