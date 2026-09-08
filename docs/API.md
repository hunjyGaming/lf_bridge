# API-Referenz

Basis: `http://<hallen-pc>:8080` (Port aus der Konfiguration).

Wenn ein **Zugriffs-Token** gesetzt ist, braucht jede Route außer `/api/health`
einen der beiden:

```
Authorization: Bearer <token>
?token=<token>                 (für den WebSocket und Download-Links)
```

Antworten sind JSON. Weitere Regeln (siehe [SECURITY.md](SECURITY.md)):

- **CORS**: nur Origins aus `config.cors` bekommen `Access-Control-Allow-Origin`
  (per Default **leer** = keine). Cross-Origin geht **nur GET**.
- **Rate-Limit**: `config.rateLimitPerMin` je IP → sonst `429` mit `Retry-After`.
  IP = Socket-Adresse, außer `http.trustProxy` ist an (dann der linkeste
  `X-Forwarded-For`-Eintrag).
- **Mutierende Anfrage ohne gültiges Token** (`POST/PUT/PATCH/DELETE`): braucht
  `Sec-Fetch-Site: same-origin` **oder** den Header `X-LF-Console: 1`, sonst
  `403 cross_origin_blocked`. Skripte/curl schicken also `X-LF-Console: 1`.

---

## REST

### `GET /api/health`  — immer offen

```json
{ "ok": true, "service": "lf-live", "matchActive": true, "ts": 1699999999999 }
```

### `GET /api/state`

Kompletter Snapshot. Siehe [State-Objekt](#state-objekt).

### `GET /api/teams`

```json
{ "data": { "teams": { "0": { "name": "Rot", "color": "#ef4444" } },
            "scores": { "0": 3, "1": 2 }, "missionActive": true } }
```

### `GET /api/players`

```json
{ "data": [ { "id": "1001", "name": "Mara", "teamId": "0", "goals": 2, ... } ] }
```

### `GET /api/events?since=<id>&limit=<n>`

Strukturierte Events mit `id` **größer als** `since` (Default `0`), älteste zuerst,
`limit` ≤ 200 (Default 50). Es werden die letzten 50 Events pro Match vorgehalten.
Für Polling: den höchsten `id`-Wert merken und als `since` mitgeben.

```json
{ "data": [ { "id": 42, "type": "goal", "actorName": "Tim", ... } ] }
```

### `GET /api/status`

Dienst-Status: `lan` (LAN-IP), Ports (`http` inkl. `trustProxy`, `cors`,
`rateLimitPerMin`, `clients`, `tokenSet`), `stateTickMs`, Laserforce-Verbindung,
CSV-Status, Ausgangs-Zustände (`outputs[]` mit `last`/`connected`), `outputAllow`,
Stream-Server, `envPins`, Match-Kurzinfo. Für Monitoring.

### `GET /api/config` · `POST /api/config`

`{ data: <config.json>, envPins: [...] }`. `envPins` sind die per `.env`
festgelegten Felder (in der Konsole nur lesbar). `POST` mit einem Teil-Objekt
ändert die Konfiguration und übernimmt sie sofort (CSV, Ausgänge, Namensliste,
TCP-Bind, Stream-Server, CORS, Rate-Limit, `outputAllow`, `trustProxy`). Ein
geänderter `http.port` oder `stateTickMs` greift **erst nach einem Neustart**.
Env-Pins bleiben unverändert.

**Secrets:** `GET` liefert nie Klartext — `apiToken` ist immer `""`, dazu kommt
`apiTokenSet: true|false`; jedes gesetzte `outputs[].secret` erscheint als
`"••••••"`. Beim `POST` gilt deshalb:

| gesendet | Wirkung |
|---|---|
| `apiToken: ""` | gespeicherter Token bleibt |
| `apiToken: ""` + `apiTokenClear: true` | Token wird gelöscht |
| `apiToken: "neu"` | Token wird gesetzt |
| `outputs[].secret: "••••••"` | gespeichertes Secret bleibt (Zuordnung über `id`, sonst Position) |

Jede angenommene Änderung erzeugt eine `warn`-Logzeile im Scope `audit` mit
Client-IP und den geänderten Top-Level-Schlüsseln (nie mit Werten).

### `POST /api/outputs/test`

`{ "output": { …Ziel-Objekt… } }` → sendet ein `test`-Event an genau dieses Ziel
und gibt `{ ok, detail }` zurück. Stört eine bestehende TCP-Verbindung nicht.

### `POST /api/roster/reload`

Liest die lokale Namensliste-CSV neu ein, gibt Anzahl + evtl. Fehler zurück.

### `GET /api/stats/totals` · `GET /api/stats/files` · `GET /api/stats/file?name=`

Gesamtwertung als JSON · Liste aller CSV-Dateien · eine Datei herunterladen.
Siehe [STATS.md](STATS.md).

### `GET /api/logs?limit=<n>`

Die letzten Logzeilen (Ringpuffer), wie sie die Konsole zeigt.

---

## WebSocket  `GET /ws`

```
ws://<hallen-pc>:8080/ws
ws://<hallen-pc>:8080/ws?token=<token>      (falls Token gesetzt)
```

Einweg-Stream (eingehende Nachrichten werden ignoriert):

```jsonc
{ "type": "hello", "service": "lf-live", "ts": 1699999999999 }
{ "type": "state", "data": { …kompletter Snapshot… } }   // bei Verbindung + danach im Takt LF_STATE_TICK_MS (Default 200 ms ≈ 5/s), nur wenn sich etwas geändert hat
{ "type": "event", "data": { …ein Event… } }             // sofort pro Ereignis
```

Bei Verbindungsabbruch mit kurzem Backoff neu verbinden; nach dem Reconnect kommt
zuerst wieder ein `state`.

---

## State-Objekt

```jsonc
{
  "missionActive": true,
  "duration": 720000,            // ms, aus Laserforce Log-Typ 1
  "elapsedTime": 123000,         // ms
  "teams":  { "0": { "name": "Rot", "color": "#ef4444" }, "1": { … } },
  "scores": { "0": 3, "1": 2 },
  "ballHolderId": "1001",        // id des aktuellen Ballträgers, oder null
  "players": {
    "1001": {
      "id": "1001", "name": "Mara", "teamId": "0",
      "avatar": null,           // immer null (Avatar-Quelle entfernt)
      "status": 0,               // Laserforce-Hardware-Status (0 normal, 2 reset, 3 aus)
      "goals": 2, "assists": 1,
      "stealsDone": 0, "stealsReceived": 1,
      "blocksDone": 3, "blocksReceived": 0,
      "resetsDone": 0, "resetsReceived": 0,
      "clearsDone": 4, "clearsReceived": 1,
      "passesDone": 12, "passesReceived": 9
    }
  },
  "events": [ /* die letzten ~50, gleiche Form wie /api/events */ ],
  "updatedAt": 1699999999999
}
```

---

## Event-Objekt

```jsonc
{
  "id": 42,                 // fortlaufend, für ?since=
  "ts": 1699999999999,      // Uhrzeit (ms)
  "elapsedMs": 123000,      // Spielzeit (ms)
  "type": "goal",
  "code": "1101",           // Laserforce-Rohcode, falls vorhanden
  "actorId": "2002", "actorName": "Tim", "actorTeamId": "1",
  "targetId": null, "targetName": null, "targetTeamId": null,
  "assistId": "2001", "assistName": "Lea",   // nur bei goal
  "scores": { "0": 0, "1": 1 },              // nur bei goal
  "text": "Tim SCORED"      // Klartext, nie HTML
}
```

| `type` | Auslöser |
|---|---|
| `match_start` / `match_end` | Mission `0100` / `0101` |
| `player_join` | Spieler-Login (Log-Typ 3) |
| `pass` | Pass (`1100`) |
| `clear` | Clear (`1109`) |
| `steal` | Steal (`1103`) |
| `block` | Block auf aktiven Gegner (`1104`) |
| `reset` | Block auf Gegner in Reset (`1104`, Ziel-Status 2) |
| `failed_clear` | fehlgeschlagener Clear (`110A`) |
| `goal` | Tor (`1101` / `1102`) inkl. Assist-Berechnung + neuem Score |
| `status` | Hardware-Status eines Spielers (Log-Typ 9) |

Die Assist-Logik: ein Pass/Clear an den Torschützen, der ≤ 10 s vor dem Tor lag,
gilt als Vorlage (genau wie im Originalsystem).

---

## Fehlercodes

| Status | Bedeutung |
|---|---|
| `401` | Token fehlt oder falsch |
| `403` | mutierende Anfrage ohne Token und ohne `Sec-Fetch-Site: same-origin` / `X-LF-Console: 1` |
| `429` | Rate-Limit erreicht (mit `Retry-After`) |
| `404` | unbekannte Route oder Datei |
| `400` | ungültiges JSON im POST-Body |
| `500` | interner Fehler (wird geloggt) |
