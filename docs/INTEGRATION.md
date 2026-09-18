# Fremdsoftware anbinden

> **Du baust eine Live-Anzeige** (Beamer, Overlay, Turniersystem)? Dann nimm den
> **Anzeige-Datensatz**: `ws://<hallen-pc>:8080/ws?feed=display&token=<token>`
> bzw. `GET /api/display`. Er bündelt genau das Nötige — Punktestand, Uhr mit
> Laufrichtung, Teams, modusrelevante Spielerzahlen, Herkunftskennzeichen — in
> einem Drittel der Bytes des vollen Snapshots. Vollständiges Beispiel,
> lauffähiges Minimalprogramm und die Feldgarantien:
> **[API.md → Für Anzeige-Entwickler](API.md#für-anzeige-entwickler)**. Läuft die
> Anzeige auf einem anderen Rechner, vorher
> [zwei Einstellungen setzen](SECURITY.md#anzeige-auf-einem-zweiten-rechner-anbinden).

> **Du brauchst nur das Ergebnis eines Matches** — für eine Buchungs- oder
> Mitgliederverwaltung, nicht für eine Live-Anzeige? Dann nimm den
> **[Missionsbericht](#missionsbericht-die-kurzfassung-eines-matches)**: eine
> Nachricht je beendetem Match, 19 KB statt 72 KB bei 50 Spielern, mit einer
> Warteschlange, die einen Neustart übersteht. Welche Zahlen drinstehen, stellt
> der Betreiber je Spielmodus selbst ein.

Zwei Grundrichtungen:

- **Ziehen** (die andere Software fragt lf_live) → REST oder WebSocket, unten 1–2.
- **Schicken** (lf_live pusht zur anderen Software) → im Konsolen-Tab „Ausgänge"
  ein Ziel anlegen: Webhook, TCP oder UDP, unten 3. Darüber geht auch der
  Missionsbericht.

| Weg | Wann | Latenz |
|---|---|---|
| **WebSocket** `/ws` | Software hält eine HTTP/WS-Verbindung offen | sofort |
| **Raw-TCP-Stream** | Software macht eine reine Socket-Verbindung auf | sofort |
| **Polling** `/api/events` | Software kann nur HTTP-GET | pro Poll |
| **Ausgang: Webhook** | Software hat einen HTTP-Endpunkt | sofort (Push) |
| **Ausgang: TCP / UDP** | Software lauscht auf einem Socket | sofort (Push) |

Adresse für die Zieh-Wege: `http(s)://<hallen-pc>:8080`. Bei gesetztem Token
`Authorization: Bearer <token>` mitschicken (WebSocket: `?token=`).

**Nachrichtenformat ist überall gleich** — eine JSON-Nachricht pro Ereignis:

```json
{ "type": "hello",  "service": "lf-live", "ts": 1699999999999 }
{ "type": "state",  "data": { …Snapshot… } }
{ "type": "event",  "data": { …Event… } }
{ "type": "report", "data": { …Missionsbericht… } }
```

`report` gibt es nur auf den **Ausgängen**, einmal je beendetem Match —
nicht auf dem WebSocket und nicht im Raw-Stream.

Über den WebSocket kommen — **nur auf ausdrückliche Anforderung** — zusätzlich
`{"type":"ready",…}` (worauf der Client angemeldet wurde),
`{"type":"display","data":{…}}` (der Anzeige-Datensatz) und
`{"type":"events","data":[…]}` (gebündelte Ereignisse). Siehe unten.

Bei Socket-Wegen (Raw-TCP, Ausgang TCP/UDP) ist jede Nachricht **eine Zeile**
(newline-getrennt, „NDJSON"). Bei Webhooks steckt sie in
`{ "event": "...", "ts": ..., "data": {...}, "state": {...} }`.

---

## 1. WebSocket (empfohlen für Regie/Live)

```js
const ws = new WebSocket("ws://192.168.1.10:8080/ws"); // + "?token=..." falls nötig

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "hello": break;
    case "state":                       // kompletter Snapshot (Anschluss + im Takt LF_STATE_TICK_MS, Default ~5/s)
      updateScoreboard(msg.data.scores, msg.data.teams);
      break;
    case "event":                       // ein Ereignis
      if (msg.data.type === "goal") flashGoal(msg.data.actorName, msg.data.scores);
      break;
  }
};
ws.onclose = () => setTimeout(reconnect, 2000);
```

Reconnect immer einbauen. Nach dem Reconnect kommt zuerst wieder ein `state`.

**Was ein Client zusätzlich anfordern kann** (alles rein optional — ohne
Parameter bleibt es beim bisherigen Verhalten):

| in der Verbindungs-URL | Wirkung |
|---|---|
| `?feed=display` | der schlanke [Anzeige-Datensatz](API.md#für-anzeige-entwickler) statt des vollen Snapshots |
| `?feed=display&players=none` | nur Punkte, Uhr und Teams (2,4 KiB statt 69,5 KiB bei 50 Spielern) |
| `?events=batch` | **gebündelte** Ereignisse: `{"type":"events","data":[…]}` statt eines Rahmens je Ereignis |

Bei hoher Ereignisrate lohnt `events=batch` deutlich: gemessen 1200 Ereignisse in
**6** statt 1200 WebSocket-Rahmen, bei einem Drittel der Auspack-Kosten auf der
Empfängerseite. Es geht dabei nichts verloren — Einzelheiten und das
`dropped`-Feld in [API.md](API.md#gebündelte-ereignisse--typeevents).

---

## 2. Polling

```python
import requests, time

BASE = "http://192.168.1.10:8080"
H = {}  # {"Authorization": "Bearer <token>"} falls nötig

seen = 0
while True:
    r = requests.get(f"{BASE}/api/events", params={"since": seen, "limit": 100}, headers=H, timeout=5)
    for ev in r.json()["data"]:
        seen = max(seen, ev["id"])
        handle(ev)
    time.sleep(1)
```

Für ein reines Scoreboard: `GET /api/display?players=none` alle 1–2 Sekunden —
Punktestand, Uhr mit Laufrichtung und Teams in einer Anfrage, rund 2,4 KiB.
(`GET /api/teams` gibt es weiterhin, hat aber weder Uhr noch Modus.)

---

## 3. Raw-TCP-Stream (Socket-Verbindung herein)

Für Tools, die keine WebSocket-, aber eine reine TCP-Verbindung können
(Bitfocus Companion „Generic TCP", eigene Overlays, schneller Test mit `nc`).

Konsole → **Ausgänge → Offene Kanäle → Raw TCP** einschalten, Host + Port wählen
(oder `LF_STREAM_ENABLED` / `LF_STREAM_HOST` / `LF_STREAM_PORT` in `.env`).
Dann verbindet sich das Tool auf `<host>:<port>` und bekommt sofort:

```
{"type":"hello","service":"lf-live","ts":...}
{"type":"state","data":{…}}
{"type":"event","data":{…}}      ← eine Zeile pro Ereignis
```

Read-only. **Bindet per Default nur an `127.0.0.1`** — für Zugriff aus dem LAN
den Host auf `0.0.0.0` stellen. Schnelltest:

```bash
nc 192.168.1.10 9100
```

Ist ein **Zugriffs-Token** gesetzt (`LF_API_TOKEN` / Konsole), muss der Client als
**erste Zeile** innerhalb von 2 Sekunden

```json
{"token":"<token>"}
```

schicken — sonst wird die Verbindung getrennt. Mit `nc` also:

```bash
printf '{"token":"%s"}\n' "$LF_API_TOKEN" | nc 192.168.1.10 9100
```

---

## 4. Ausgänge: an eine IP:Port schicken (Push)

Konsole → **Ausgänge → „Ziel hinzufügen"**. Pro Ziel:

| Feld | |
|---|---|
| **Art** | `webhook` (HTTP POST) · `tcp` (offene Verbindung) · `udp` (Pakete) |
| **Host / Port** bzw. **URL** | wohin |
| **Events** | `goal,match_start,match_end` oder `*` |
| **Events senden / State senden** | was |
| **Secret** (nur webhook) | aktiviert die HMAC-Signatur |

### TCP / UDP

lf_live verbindet sich (TCP) bzw. sendet Pakete (UDP) an `host:port` und schickt
dieselben NDJSON-Zeilen wie der Raw-Stream (`{"type":"event"…}` / `{"type":"state"…}`).
Eine TCP-Verbindung wird offen gehalten und bei Abbruch mit Backoff neu aufgebaut.
Beispiel-Empfänger (Node):

```js
require("net").createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));  // {type:"event"|"state"|"hello", …}
      buf = buf.slice(i + 1);
      if (msg.type === "event" && msg.data.type === "goal") { /* … */ }
    }
  });
}).listen(7000, "0.0.0.0");
```

### Webhook

Der Dienst schickt dann pro passendem Event:

```
POST <deine url>
Content-Type: application/json
X-LFB-Event: goal
X-LFB-Timestamp: 1699999999999
X-LFB-Signature: sha256=<hmac>        # nur wenn Secret gesetzt

{ "event": "goal", "ts": 1699999999999,
  "data": { …Event-Objekt… },
  "state": { … } }                    # nur wenn "State mitsenden" an
```

Zustellung: 8 s Timeout, bis zu 3 Versuche mit Backoff. Fehler eines Ziels
beeinflussen nichts anderes. Letzter Status pro Ziel in `GET /api/status`
(`outputs[].last`) und in der Konsole am Ziel-Kärtchen.

### Signatur prüfen (Node-Beispiel)

```js
const crypto = require("crypto");

function verify(req, rawBody, secret) {
  const ts = req.headers["x-lfb-timestamp"];
  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(req.headers["x-lfb-signature"] || ""),
    Buffer.from(expected)
  );
}
```

`rawBody` = der unveränderte Request-Body als String, **vor** JSON-Parsing.

---

## Missionsbericht: die Kurzfassung eines Matches

Alles bisher auf dieser Seite ist **live**: Events, während gespielt wird, und
Zustandsbilder mehrmals pro Sekunde. Wer nur wissen will, wie ein Match
**ausgegangen** ist, braucht davon nichts. Dafür gibt es den **Missionsbericht**:
genau **eine** Nachricht je beendetem Match, mit einer Missionsübersicht und je
Spieler einem schlanken Block.

Bei 50 Spielern gemessen: **72,2 KB** voller Zustand gegen **18,8 KB**
Kurzfassung — und die 18,8 KB sind schon die weite SM5-Auswahl mit zehn Zahlen je
Spieler. Mit den fünf Zahlen des Standardprofils sind es **14,1 KB**, ohne
Spielernamen **17,6 KB**.

### Wie er ankommt

**Über die Ausgänge**, genau wie Events und Zustand, nur mit einer dritten
Hüllen-Art:

```json
{"type":"report","data": { …Bericht… }}
```

Als Webhook:

```
POST <deine url>
X-LFB-Event: match_report
X-LFB-Timestamp: 1789722719825
X-LFB-Signature: sha256=<hmac>        # nur wenn Secret gesetzt

{ "event": "match_report", "ts": 1789722719825, "data": { …Bericht… } }
```

**Wer ihn bekommt:** jedes eingeschaltete Ziel mit „Events senden", dessen
Event-Liste `*` ist (die Vorgabe) oder `match_report` enthält. Ein Ziel, das
**ausschließlich** den Bericht bekommen soll und keine Live-Events, trägt unter
**Events** genau `match_report` ein — dann geht während des Spiels gar nichts
dorthin, und am Matchende genau eine Nachricht.

**Über MQTT** geht derselbe Bericht zusätzlich raus, sobald MQTT eingeschaltet
ist (siehe `docs/MQTT.md`), als Ereignis `match_report`.

### Er geht nicht verloren

Der Moment, in dem eine Mission endet, ist der Moment, in dem das Netz am
wenigsten verlässlich ist — und der einzige, in dem sich die Daten nicht noch
einmal erzeugen lassen. Deshalb:

1. Der Bericht wird **zuerst auf die Platte geschrieben** (`data/reports/`),
   über eine Temporärdatei und ein Umbenennen, **bevor** irgendetwas verschickt
   wird. Ein Stromausfall eine Millisekunde später kostet nichts.
2. Erst dann wird zugestellt. Klappt es nicht, **bleibt die Datei liegen** und
   wird erneut versucht — nach 5 s, 10, 20, 40, 80, 160, dann alle 5 Minuten.
3. Beim **nächsten Start** wird der Ordner gelesen und alles Liegengebliebene
   nachgereicht. Ein Neustart, ein Stromausfall, ein Backend-Wartungsfenster
   über Nacht: die Mission ist am nächsten Morgen da.

**Zustellung ist „mindestens einmal", nicht „genau einmal".** Ein Webhook, der
nach dem Verbindungsabbruch doch noch 200 antwortet, ist von einem, der nie
geantwortet hat, nicht zu unterscheiden. Darum:

> **Die Gegenseite muss auf `match.matchId` dedupliziert werden.**
> Derselbe `matchId` zweimal heißt: dieselbe Mission, nicht zwei Missionen.

**Was als zugestellt gilt:** ein Webhook, der 2xx geantwortet hat; ein TCP-Ziel,
dessen Verbindung stand. **UDP hält nie einen Bericht zurück** — UDP kann nichts
bestätigen, und ein 50-Spieler-Bericht passt ohnehin in kein Datagramm (er wird
dann übersprungen und das im Log vermerkt). Für vollständige Berichte also
**Webhook oder TCP**, nicht UDP.

**Wenn gar nichts mehr geht:** die Warteschlange ist auf **200 Berichte bzw.
8 MB** begrenzt. Läuft sie über, wird der **älteste** gelöscht — mit einer
ERROR-Zeile im Log und einem Zähler in `GET /api/status` unter
`report.queue.dropped`. Ein stiller Verlust wäre der eine Fehler, den niemand
bemerkt, bis die Monatsauswertung nicht stimmt.

```json
"report": {
  "enabled": true,
  "queue": { "pending": 0, "dropped": 0, "delivered": 17, "lastError": null }
}
```

### Der Bericht, vollständig

```json
{
  "schema": "lf-live.match-report/1",
  "generatedAt": "2026-09-18T09:11:07.987Z",
  "match": {
    "matchId": "mu6qo0r0",
    "startedAt": "2026-09-18T09:01:07.980Z",
    "endedAt": "2026-09-18T09:11:07.982Z",
    "mode": { "number": 5, "key": "sm5", "label": "Space Marines 5",
              "family": "sm5", "profile": "sm5" },
    "durationMs": 600000, "durationS": 600,
    "durationKnown": true, "plannedDurationMs": 600000,
    "teams": [
      { "teamId": "0", "name": "Rot Team",  "color": "#ef4444", "score": 850 },
      { "teamId": "1", "name": "Blau Team", "color": "#3b82f6", "score": 640 }
    ],
    "winner": { "teamId": "0", "name": "Rot Team", "score": 850 },
    "draw": false,
    "scoreSource": "tdf",
    "end": { "reason": "mission_end", "source": "0101",
             "exitCodes": { "4108331": "01", "1002": "01" },
             "exitCodesSeen": ["01"] },
    "playerCount": 4
  },
  "players": [
    {
      "playerId": "4108331",
      "entityId": "#4108331",
      "idKind": "member",
      "memberId": "4108331",
      "teamId": "0",
      "team": "Rot Team",
      "result": "win",
      "name": "MARA",
      "score": 430,
      "level": 9,
      "roleLabel": "Commander",
      "shotsFired": 31,
      "shotsHit": 12,
      "accuracy": 0.3871,
      "accuracySource": "tdf7",
      "accuracyIsEstimate": false,
      "livesLeft": 5,
      "shotsLeft": 47,
      "deactivations": 12,
      "timesDeactivated": 3,
      "statsSource": "tdf7"
    }
  ]
}
```

### Die Felder der Übersicht

| Feld | Bedeutung |
|---|---|
| `schema` | Format-Kennung. Hierauf festnageln, auf nichts anderes. Eine unverträgliche Änderung erhöht die Zahl. |
| `matchId` | **Die Kennung des Matches.** Danach deduplizieren. Sie steht auch im Namen der CSV-Dateien. |
| `startedAt` / `endedAt` | ISO-8601 in UTC. |
| `durationMs` / `durationS` | Wie lange das Match **tatsächlich** gelaufen ist. |
| `durationKnown` | `false` = die Anlage hat keine Solldauer gemeldet; `plannedDurationMs` ist dann `null` und darf **nicht** ausgerechnet werden. |
| `mode.number` | Missionsnummer der Anlage; `null`, wenn keine kam. |
| `mode.key` | Gleichbleibender Kurzname. **Danach gruppieren**, nicht nach `label` — das kann die Anlage jederzeit ändern. |
| `mode.family` | `sm5` (Schüsse, Treffer) oder `laserball` (Tore, Pässe). Bestimmt, welche Zahlen es überhaupt gibt. |
| `mode.profile` | Welcher Spaltensatz — und damit, welche Felder in den Spielerblöcken stehen. |
| `winner` / `draw` | Siegerteam, oder `null` bei `draw: true`. Beides `null`/`false` heißt: keine Punkte gemeldet. |
| `scoreSource` | `tdf` = Punkte von der Anlage. `internal` = **von lf_live selbst gezählt**, weil die Anlage keine geschickt hat. |
| `end.reason` | `mission_end` (die Anlage hat `0101` geschickt) · `watchdog` · `stream_lost` · `next_match` · `shutdown`. Alles außer `mission_end` heißt: das Ende wurde **erschlossen**, das Match kann unvollständig sein. |
| `end.source` | Woran es erkannt wurde. |
| `end.exitCodes` | Rohe Typ-6-Exitcodes je Spieler. Reine Diagnose — sie entscheiden nichts. |

### Die Felder eines Spielerblocks

**Immer vorhanden:**

| Feld | Bedeutung |
|---|---|
| `playerId` | Kennung **ohne** Präfix — derselbe Wert wie `player_id` in den CSV-Dateien. |
| `entityId` | Die Kennung **genau so, wie die Anlage sie geschickt hat**, mit Präfix. `null`, wenn keine Anmeldezeile gesehen wurde. |
| `idKind` | `member` · `guest` · `unknown`. **Siehe nächster Abschnitt.** |
| `memberId` | Die weltweit eindeutige Laserforce-Mitglieds-ID, ohne `#`. **Nur hier**, und bei einem Gast `null`. |
| `memberIdReported` | *(nur wenn vorhanden)* Dieselbe Angabe aus der `memberId`-Spalte der Anmeldezeile — die schicken nur späte TDF-2.006-Anlagen. Zweite, unabhängige Quelle. |
| `teamId` / `team` | Team-Nummer und Teamname. |
| `result` | `win` · `loss` · `draw` · `null` (keine Punkte gemeldet). |
| `name` | Spielername. **Fehlt**, wenn Namen abgeschaltet sind (siehe Datenschutz). |
| `statsSource` | `live` = von lf_live aus dem Ereignisstrom gezählt · `tdf7` = die amtlichen Zahlen der Anlage aus ihrer Endabrechnung. |

**Dazu die Kennzahlen des Profils** — was der Betreiber sich zusammenstellt.
Die Namen sind dieselben wie in der Konsole und (in `snake_case`) in den
CSV-Dateien; die Bedeutung jeder einzelnen steht in
[GAMEMODES.md → Spaltenbeschriftungen](GAMEMODES.md#spaltenbeschriftungen) und
kommt über `GET /api/modes` auch maschinenlesbar mit Beschriftung und
Erklärtext.

Der Wunsch, wie er gestellt wurde, und wie er heißt:

| gewünscht | im Bericht |
|---|---|
| `memberID` | `memberId` (+ `entityId`, `idKind`) |
| `score` | `score` |
| `total_shots` | `shotsFired` |
| `shots_hit` | `shotsHit` |
| `avrage_hit` | `accuracy` (+ `accuracySource`, `accuracyIsEstimate`) |

> **Schreibweise:** `camelCase`, wie im übrigen JSON von lf_live, im
> Anzeige-Datensatz und im Mongo-Schema der Gegenseite (`countryCode`,
> `centerCode`, `laserforceData`). `snake_case` gibt es nur in den CSV-Dateien.

### `null` heißt nicht `0`

Das ist die wichtigste Regel des ganzen Formats.

| Was im JSON steht | Was es heißt |
|---|---|
| **Feld fehlt** | Dieser Modus hat diesen Zähler gar nicht. In Laserball protokolliert die Anlage keine Schüsse — also gibt es dort kein `shotsFired`. |
| **`null`** | Der Zähler existiert, die Anlage hat ihn aber **noch nicht gemeldet**. `livesLeft: null` = „unbekannt", nicht „keine Leben mehr". |
| **`0`** | Eine gemessene Null. |

Ein `0` statt `null` wäre die eine Lüge, die niemandem auffällt — deshalb steht
dort nie eine.

### `accuracy` ist live eine Schätzung, und sie ist zu hoch

`accuracy` ist ein **Anteil von 0 bis 1** (`0.3871` = 38,71 %), nicht Prozent.

Laserforce meldet einen Schuss, der **nichts bewirkt hat**, gar nicht. Jeder
Treffer erzeugt ein Ereignis und landet in Zähler und Nenner; ein folgenloser
Schuss fehlt **nur im Nenner**. Der Nenner ist also zu klein, der Quotient zu
groß. Deshalb reisen zwei Felder mit:

| `accuracySource` | `accuracyIsEstimate` | Bedeutung |
|---|---|---|
| `live` | `true` | Von lf_live während des Spiels gezählt. **Zu hoch.** Als Näherung behandeln, nicht als Messwert. |
| `tdf7` | `false` | Aus der Endabrechnung der Anlage. **Amtlich.** |

Ein Backend, das `accuracyIsEstimate` ignoriert, verrechnet eine Schätzung wie
eine Messung. Wer eine belastbare Quote braucht, wertet nur Spieler mit
`statsSource: "tdf7"` aus. Ausführlich:
[GAMEMODES.md](GAMEMODES.md#die-trefferquote--und-warum-sie-live-zu-hoch-ist).

### Mitglied oder Gast — und was offen bleibt

Die Anlage kennt **zwei** Arten von Kennung (docs/LASERFORCE.md):

| Im Strom | `idKind` | `memberId` | Was es ist |
|---|---|---|---|
| `#4108331` | `member` | `"4108331"` | Die **weltweit eindeutige Laserforce-Mitglieds-ID**. Das Einzige, womit sich eine Person über mehrere Besuche wiedererkennen lässt. |
| `@1002` | `guest` | `null` | Nur die **Hardware-Nummer einer Weste**. Morgen trägt sie jemand anderes, in der Nachbarhalle bedeutet sie etwas völlig anderes. |
| *(keine Anmeldezeile gesehen)* | `unknown` | `null` | lf_live weiß es nicht — und rät nicht. |

> **`@1002` und `#1002` wären ohne `idKind` nicht zu unterscheiden.** Die Zahl
> allein sagt nichts: die Länge ist kein verlässliches Merkmal. Deshalb steht
> die rohe Kennung mit Präfix im Bericht, und deshalb ist `memberId` bei einem
> Gast konsequent `null` statt einer Zahl, die nach einer Mitgliedsnummer
> aussieht.

**Zuordnung im Backend:** `memberId` ist ein String und wird **unverändert**
durchgereicht.

> **Offen, und bewusst nicht geraten:** wie `#xxxxxxx` auf die Felder
> `countryCode` / `centerCode` / `memberCode` des Mongo-`Member`-Schemas
> abzubilden ist. Der Locationserver liest `dbo.Member` und schickt das Feld
> `id` **unzerlegt** ans Backend (`util/laserforce-import.js`); nirgends im
> Locationserver wird es in drei Teile zerlegt, und ob `cardNumber` dieselbe
> Zahl trägt, ist ebenfalls nicht belegt. Eine Zerlegung wäre geraten —
> stattdessen liefert lf_live die Kennung roh. **Wer die Aufteilung kennt (oder
> ein Beispiel-Mitglied mit beiden Darstellungen hat), sollte sie beisteuern;
> bis dahin ist der Vergleich mit dem importierten `id` der einzige belegbare
> Weg.**

### Datenschutz

**Der Bericht enthält Spielernamen und weltweit eindeutige Mitglieds-IDs und
verlässt den Rechner.** Das ist der Zweck, aber es ist bewusst zu entscheiden:

- Ein Ziel sollte im eigenen Netz stehen oder über HTTPS mit **Secret**
  (HMAC-Signatur) angesprochen werden. Die Egress-Liste `outputAllow` begrenzt,
  wohin überhaupt gesendet werden darf (docs/SECURITY.md).
- **Namen weglassen**, wenn nur die Kennung gebraucht wird — zwei Wege:
  - je Profil: `"namen": false` im Abschnitt `_bericht` von
    `modes/profile/<profil>.json`;
  - für die ganze Bridge: `LF_REPORT_NAMES=false` in der `.env`.
  Dann fehlt `name` in jedem Spielerblock; `playerId`, `entityId`, `idKind` und
  `memberId` bleiben.
- **Ganz abschalten:** `LF_REPORT_ENABLED=false`. Dann wird kein Bericht gebaut
  und keiner verschickt; CSV-Dateien und Live-Feeds sind davon unberührt.
- Die Warteschlange `data/reports/` enthält dieselben Daten und wird mit
  Dateirechten `0600` angelegt. `data/` ist `.gitignore`-t. Eine zugestellte
  Datei wird sofort gelöscht.

### Einstellen, was drinsteht

Die Auswahl je Spielmodus steht im Anzeigeprofil, nicht im Programm:
[GAMEMODES.md → Der Abschnitt `_bericht`](GAMEMODES.md#der-abschnitt-_bericht--was-ans-backend-geht).
Ein Feld aufnehmen heißt, seinen Namen in eine Liste zu schreiben; ein
unbekannter Name wird auf Deutsch gemeldet, übersprungen — und der Bericht geht
trotzdem raus.

---

## Feld-Mapping fürs Scoreboard

**Für eine Anzeige ist das hier der falsche Weg.** Nimm den
[Anzeige-Datensatz](API.md#für-anzeige-entwickler) (`/api/display` bzw.
`/ws?feed=display`): der liefert Teams als fertig sortiertes Array mit Punkten
und Farbe, die Spalten des laufenden Modus mit Beschriftung, und die Uhr mit
ihrer Laufrichtung — bei 50 Spielern in einem Drittel der Bytes. Das Folgende
gilt nur, wenn du ohnehin den vollen Snapshot verarbeitest.

```
Heim-Team   = state.teams[ ersteId ].name / .color   ( erste Team-id aufsteigend sortiert)
Gast-Team   = state.teams[ zweiteId ].name / .color
Heim-Score  = state.scores[ ersteId ]
Gast-Score  = state.scores[ zweiteId ]
Uhr         = state.remainingMs ?? state.elapsedTime  (siehe unten — NICHT selbst rechnen)
Ballträger  = state.ballHolderId
```

Die Team-Reihenfolge ist stabil: aufsteigend nach Team-id. „Links/rechts" also
konsistent über das ganze Match. Aber: `state.teams` kann Teams aus einem
**früheren** Match enthalten — filtere auf Teams, in denen wirklich jemand steht.

> ### Die Uhr: niemals `duration - elapsedTime` rechnen
>
> `state.remainingMs` kommt **fertig** aus der Engine.
>
> | | `remainingMs` | Anzeige |
> |---|---|---|
> | `durationKnown: true` | Zahl ≥ 0 | **Restzeit** herunterzählen |
> | `durationKnown: false` | `null` | **Laufzeit** `elapsedTime` von 0 an **hoch**zählen |
>
> Meldet die Anlage keine Missionsdauer, steht in `state.duration` ein
> Vorgabewert, der mit dem laufenden Spiel nichts zu tun hat — eine
> Eigenberechnung ergibt dann einen erfundenen Countdown, der negativ wird.
> Und sobald `missionActive` auf `false` steht, muss die Uhr **stehen**.
> Ausführlich: [API.md](API.md#die-uhr--die-eine-regel-an-der-alles-hängt).
>
> *(Eine frühere Fassung dieser Seite nannte hier
> `state.duration - state.elapsedTime`. Das war falsch.)*

---

## Hinweis zu Namen

Spielernamen kommen direkt aus dem Laserforce-Stream. Optional überschreibt eine
selbst gepflegte Namensliste (`data/roster.csv`) einzelne Namen/Teams. `avatar`
ist immer `null` (die frühere Avatar-Quelle wurde entfernt).
