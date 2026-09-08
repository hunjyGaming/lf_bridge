# LF Live

Ein Programm für den **Hauptrechner in der Lasertag-Halle**. Es liest den
Laserforce-Log-Stream, hält den Match-Zustand im Speicher und macht ihn im
**Hallen-Netz** über einen Port verfügbar:

- **Web-Konsole** im Browser — Live-Scoreboard, Ausgänge, Statistik, Einstellungen, Log
- **JSON-API + WebSocket** zum Abfragen / für Live-Push ([docs/API.md](docs/API.md))
- **Roher TCP-Stream** für Tools ohne HTTP
- **Ausgänge** — Daten aktiv an eine `IP:Port` schicken, per **Webhook / TCP / UDP**
- **Statistik als CSV** — nach jedem Match, pro Spieler, plus Gesamtwertung ([docs/STATS.md](docs/STATS.md))

Kein Cloud-Server, kein Electron, kein OBS. **Keine externen Dienste.** Ein `npm start`.

---

## Schnellstart

Voraussetzung: **Node.js ≥ 20** ([nodejs.org](https://nodejs.org)).

```bash
cd lf_live
npm install
npm start
```

→ Browser: **http://localhost:8080/**  ·  Laserforce-Log-Export auf `<Hallen-PC>:9000` richten.

Kein Laserforce zur Hand? Der Test-Kit `../lf_simulate` spielt echte Matches ein
und prüft, ob die Events feuern.

```bash
node ../lf_simulate/simulate.js --rounds 8 --players 10 --duration 300 --speed 8
```

---

## Konfiguration

Zwei Ebenen, die spätere gewinnt:

1. **`.env`** — Ports, Binds, Secrets. Ein hier gesetzter Wert ist **gepinnt**:
   die Konsole zeigt ihn dann nur lesbar an. Vorlage: `.env.example`.
2. **`config.json`** — Match-Tag-Einstellungen, über die **Konsole** bearbeitet.
   Wird beim ersten Start angelegt, git-ignored, Rechte `0600`.

### `.env` — alle Variablen

| Variable | Standard | Zweck |
|---|---|---|
| `LF_HTTP_HOST` | `0.0.0.0` | Bind der Konsole/API · `127.0.0.1` = nur dieser PC |
| `LF_HTTP_PORT` | `8080` | Konsole + API |
| `LF_API_TOKEN` | *(leer)* | gesetzt → Bearer-Token für API + Konsole nötig (und Token-Zeile für den Raw-Stream) |
| `LF_CORS_ORIGINS` | *(leer = keine)* | Browser-Origins für die API (Komma-Liste) · `*` = beliebige |
| `LF_RATE_LIMIT_PER_MIN` | `600` | Anfragen/Minute je IP · `0` = aus |
| `LF_STATE_TICK_MS` | `200` | Takt für den gemeinsamen State-Push an WebSocket, Raw-Stream und Ausgänge · min `50`, max `5000` |
| `LF_TRUST_PROXY` | `false` | `X-Forwarded-For` auswerten — nur hinter eigenem Reverse-Proxy |
| `LF_OUTPUT_ALLOW` | *(leer = alles)* | erlaubte Ausgangs-Ziele: `host` / `host:port` / `*.suffix` (Komma-Liste) |
| `LF_TCP_HOST` | `0.0.0.0` | Bind für den Laserforce-Eingang |
| `LF_TCP_PORT` | `9000` | Laserforce verbindet sich hierher |
| `LF_STREAM_ENABLED` | `false` | roher TCP-Stream-Server an/aus |
| `LF_STREAM_HOST` | `127.0.0.1` | dessen Bind · für LAN-Zugriff `0.0.0.0` |
| `LF_STREAM_PORT` | `9100` | dessen Port |
| `LF_CSV_ENABLED` | `true` | Statistik-CSV schreiben |
| `LF_CSV_DIR` | `data/stats` | Zielordner |
| `LF_CSV_DELIMITER` | `;` | `;` Excel DE · `,` pandas · Tab |
| `LF_CSV_BOM` | `true` | BOM (Excel + Umlaute) |
| `LF_CSV_EVENTS` | `true` | zusätzlich Event-Log pro Match |
| `LF_CSV_LIVE` | `false` | Match-CSV schon während des Matches aktualisieren |
| `LF_LOCAL_ROSTER_ENABLED` | `false` | eigene Namensliste nutzen |
| `LF_LOCAL_ROSTER_FILE` | `data/roster.csv` | deren Pfad |
| `LF_MATCH_DURATION_MS` | `720000` | Fallback bis Laserforce die Dauer meldet |
| `LF_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LF_CONFIG_FILE` | `config.json` | Ort der Konsolen-Konfiguration |

Feld-für-Feld: [docs/CONFIG.md](docs/CONFIG.md) · Sicherheit: [docs/SECURITY.md](docs/SECURITY.md)

---

## Anbinden

| Weg | Wofür | Doku |
|---|---|---|
| **Regie-Software (Next.js)** | Scoreboard, Torgrafiken, Trigger | [docs/REGIE.md](docs/REGIE.md) — fertige Bridge + React-Hook |
| REST / WebSocket / Raw-TCP / Webhook / TCP / UDP | alles andere | [docs/INTEGRATION.md](docs/INTEGRATION.md) |

```bash
curl http://<hallen-pc>:8080/api/state
```
```js
const ws = new WebSocket("ws://<hallen-pc>:8080/ws");
ws.onmessage = (e) => { const m = JSON.parse(e.data); /* hello | state | event */ };
```

---

## Als Dienst (Event-Tag)

**Windows** — [NSSM](https://nssm.cc/):

```
nssm install LF-Live "C:\Program Files\nodejs\node.exe" "C:\pfad\zu\lf_live\src\index.js"
nssm set LF-Live AppDirectory "C:\pfad\zu\lf_live"
nssm start LF-Live
```

**Linux** — systemd-Beispiel in [docs/CONFIG.md](docs/CONFIG.md).

---

## Projektstruktur

```
src/
  index.js        Start + Verdrahtung, Startlog mit LAN-Adresse
  config.js       .env + config.json, Validierung, env-Pins
  logger.js       Ringpuffer-Logger (Konsolen-Log)
  engine.js       Laserforce-Parser + Match-State  (Logik unverändert übernommen)
  tcpIngest.js    TCP-Server: Laserforce-Log rein
  apiServer.js    HTTP-API + WebSocket + Konsole (ein Port) + Härtung
  streamServer.js roher TCP-Stream raus
  outputs.js      ausgehende Ziele: webhook / tcp / udp
  statsWriter.js  Statistik → CSV
  localRoster.js  optionale Namensliste (CSV)
  web/            die Konsole (statisch, kein Build)
scripts/
  check.js        Selbsttest            npm run check
  itest.js        End-to-End-Test       npm run itest
  inspect.js      Laserforce-Feed katalogisieren   node scripts/inspect.js [port]
docs/
  CONFIG.md       jede Einstellung, Dienst-Setup, Firewall
  SECURITY.md     Sicherheitsmodell + Härtung
  API.md          Endpunkte, WS-Nachrichten, State-/Event-Schema
  REGIE.md        Regie-Software (Next.js) anbinden
  INTEGRATION.md  Fremdsoftware allgemein
  LASERFORCE.md   Anbindung, Log-Format, alle Event-Codes
  STATS.md        CSV-Dateien, Spalten, Auswertung
```

Der Test-Kit `../lf_simulate` (Match-Generator + Event-Monitor + E2E-Verify)
liegt daneben und hat seine eigene README.
