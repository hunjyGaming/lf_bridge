# Fremdsoftware anbinden

Zwei Grundrichtungen:

- **Ziehen** (die andere Software fragt lf_live) → REST oder WebSocket, unten 1–2.
- **Schicken** (lf_live pusht zur anderen Software) → im Konsolen-Tab „Ausgänge"
  ein Ziel anlegen: Webhook, TCP oder UDP, unten 3.

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
```

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
    case "state":                       // kompletter Snapshot (Anschluss + ~6/s)
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

Für ein reines Scoreboard reicht `GET /api/teams` alle paar Sekunden.

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

Read-only, kein Token. **Bindet per Default nur an `127.0.0.1`** — für Zugriff
aus dem LAN den Host auf `0.0.0.0` stellen. Schnelltest:

```bash
nc 192.168.1.10 9100
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

## Feld-Mapping fürs Scoreboard

```
Heim-Team   = state.teams[ ersteId ].name / .color   ( erste Team-id aufsteigend sortiert)
Gast-Team   = state.teams[ zweiteId ].name / .color
Heim-Score  = state.scores[ ersteId ]
Gast-Score  = state.scores[ zweiteId ]
Restzeit    = state.duration - state.elapsedTime      (ms; lokal weiterlaufen lassen)
Ballträger  = state.ballHolderId
```

Die Team-Reihenfolge ist stabil: aufsteigend nach Team-id. „Links/rechts" also
konsistent über das ganze Match.

---

## Hinweis zu Namen

Spielernamen kommen direkt aus dem Laserforce-Stream. Optional überschreibt eine
selbst gepflegte Namensliste (`data/roster.csv`) einzelne Namen/Teams. `avatar`
ist immer `null` (die frühere Avatar-Quelle wurde entfernt).
