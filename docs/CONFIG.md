# Konfiguration

Zwei Ebenen, die spätere gewinnt:

| | Wo | Wofür | Ändern |
|---|---|---|---|
| 1 | **`.env`** | Ports, Binds, Secrets — pro Rechner einmal | Texteditor, dann Neustart |
| 2 | **`config.json`** | Match-Tag-Einstellungen | **Web-Konsole → Einstellungen** |

Reihenfolge beim Start: **Defaults → `config.json` → `.env`**.

> **Dritte, eigenständige Sache: die Spielmodi.** Welche Modus-Nummer welcher
> Spielmodus ist und welche Spalten er zeigt, steht **nicht** in `config.json`,
> sondern in eigenen JSON-Dateien unter **[`modes/`](../modes)** — je Modus eine
> Datei, dazu je Anzeigeprofil eine unter `modes/profile/`. Sie werden von Hand
> im Texteditor gepflegt, sind **versioniert** (anders als `config.json`) und
> werden **zu denselben zwei Zeitpunkten gelesen** wie die Konfiguration: beim
> Start und bei jedem Speichern in der Web-Konsole. Eine neu eingetragene
> Modus-Nummer greift damit ohne Dienstneustart. Ein Tippfehler in einer dieser
> Dateien legt nichts lahm: lf_live meldet ihn auf Deutsch mit Dateinamen im Log
> und läuft mit den eingebauten Vorgaben weiter.
> Vollständige Anleitung: [GAMEMODES.md](GAMEMODES.md#spielmodi-in-json-dateien).

**Env-Pins:** Ein in `.env` gesetzter Wert ist gepinnt — die Konsole zeigt das
Feld dann nur lesbar mit der Markierung *„aus .env"*. Ein Speichern in der
Konsole kann ihn nicht überschreiben. Lass einen Wert also entweder nur in
`.env` **oder** nur in der Konsole.

`config.json` wird beim ersten Start angelegt, ist `.gitignore`-t und wird mit
Dateirechten `0600` geschrieben.

---

## `.env` — alle Variablen

| Variable | Standard | Config-Feld | Bedeutung |
|---|---|---|---|
| `LF_HTTP_HOST` | `0.0.0.0` | `http.host` | Bind der Konsole/API · `127.0.0.1` = nur dieser PC |
| `LF_HTTP_PORT` | `8080` | `http.port` | Konsole + API. Änderung wirkt **erst nach Neustart**. |
| `LF_ADMIN_PASSWORD` | *(leer)* | `admin.passwordHash` | Admin-Passwort der Konsole. Hier gesetzt = **gepinnt**: weder Konsole noch `npm run setpw` können es ändern. Leer lassen → beim ersten Start wird eines erzeugt **und über den Benachrichtigungskanal geschickt**; ohne Kanal zeigt die Konsole stattdessen `/setup` ([SECURITY.md](SECURITY.md)). |
| `LF_ADMIN_PASSWORD_HASH` | *(leer)* | `admin.passwordHash` | Alternative: fertiger `scrypt$…`-Hash statt Klartext. Hat Vorrang vor `LF_ADMIN_PASSWORD`. |
| `LF_ADMIN_ENABLED` | `true` | `admin.enabled` | `false` = **kein Login** — die Konsole ist für jeden im LAN offen. Nur für ein geschlossenes Testnetz. |
| `LF_ADMIN_SESSION_HOURS` | `12` | `admin.sessionHours` | Gültigkeit einer Anmeldung (1–720). Danach ist eine erneute Anmeldung nötig. |
| `LF_API_TOKEN` | *(leer)* | `apiToken` | Token **für Programme**: gesetzt → man kommt mit `Authorization: Bearer <token>` bzw. `?token=` auch ohne Login an jede `/api/*` (außer `/api/health`), den WebSocket und den Raw-TCP-Stream |
| `LF_CORS_ORIGINS` | *(leer = keine)* | `cors` | Browser-Origins, die die Lese-API aufrufen dürfen (Komma-Liste). `*` = beliebige (nur GET). Für curl/Server irrelevant; die Konsole ist same-origin und braucht keinen Eintrag. |
| `LF_RATE_LIMIT_PER_MIN` | `600` | `rateLimitPerMin` | Anfragen/Minute je IP auf der HTTP-API. `0` = aus. |
| `LF_STATE_TICK_MS` | `200` | `stateTickMs` | Takt für den gemeinsamen State-Push an WebSocket, Raw-TCP-Stream und Ausgänge. Ein `change` markiert nur „dirty"; einmal pro Takt wird der Snapshot einmal serialisiert und an alle drei weitergereicht. Events gehen weiterhin sofort raus. min `50`, max `5000`. Änderung über die Konsole wirkt **erst nach Neustart**. |
| `LF_TRUST_PROXY` | `false` | `http.trustProxy` | `true` → Client-IP kommt aus dem **linkesten** `X-Forwarded-For`-Eintrag (Rate-Limit + Audit-Log). Nur einschalten, wenn ein eigener Reverse-Proxy davorsteht — sonst ist der Header fälschbar. |
| `LF_OUTPUT_ALLOW` | *(leer = alles)* | `outputAllow` | Komma-Liste erlaubter Ausgangs-Ziele: `host` oder `host:port`, `*.suffix` möglich. Nicht gelistete Ziele werden mit einer Warnung übersprungen. |
| `LF_MQTT_ENABLED` | `false` | `mqtt.enabled` | MQTT-Ausgang zum FunZone-Locationserver ([MQTT.md](MQTT.md)). Aus = es passiert nichts; ohne laufenden Broker startet lf_live trotzdem sofort. |
| `LF_MQTT_URL` | `mqtt://127.0.0.1:1883` | `mqtt.url` | Broker-Adresse. Erlaubt: `mqtt` `mqtts` `ws` `wss` `tcp` `tls`. Ein anderes Schema wird verworfen und die Vorgabe benutzt. |
| `LF_MQTT_TOPIC` | `/decs/lfpassthrough` | `mqtt.topic` | Das Topic, das der Locationserver abonniert — **wörtlich, ohne Platzhalter**. Ändern trennt die Anbindung. |
| `LF_MQTT_TOPIC_SUFFIXES` | `false` | `mqtt.topicSuffixes` | `true` = jede Nachricht geht auf `<topic>/<event>`. **Der Locationserver kann das nicht empfangen** — nur für einen eigenen Broker mit Platzhalter-Abonnement. |
| `LF_MQTT_STATUS_TOPIC` | *(leer)* | `mqtt.statusTopic` | eigenes Topic für `bridge_online` und den Last Will; leer = dasselbe wie `mqtt.topic` |
| `LF_MQTT_QOS` | `1` | `mqtt.qos` | `0` \| `1` \| `2`. `1` entspricht Abonnement und Weiterleitung der Gegenseite. |
| `LF_MQTT_RETAIN` | `false` | `mqtt.retain` | Nachrichten vom Broker aufbewahren lassen |
| `LF_MQTT_CLIENT_ID` | *(automatisch)* | `mqtt.clientId` | leer = `lf-bridge-<rechner>-<zufall>` |
| `LF_MQTT_RECONNECT_SECONDS` | `5` | `mqtt.reconnectSeconds` | Abstand der Wiederverbindungsversuche (1–3600) |
| `LF_MQTT_QUEUE_MAX` | `0` | `mqtt.queueMax` | Nachrichten im **Arbeitsspeicher**, solange der Broker weg ist. `0` = keine — ein Speicherpuffer übersteht keinen Neustart, deshalb liegt die Aufbewahrung beim Missionsbericht. Höher gesetzt gilt eine harte Obergrenze: bei Überlauf fällt die **älteste** Nachricht heraus und wird gezählt (0–10000). |
| `LF_MQTT_TLS_INSECURE` | `false` | `mqtt.tlsInsecure` | `mqtts://` mit selbstsigniertem Zertifikat zulassen |
| `LF_MQTT_MATCH_START` | `true` | `mqtt.publishMatchStart` | Rundenstart-Nachricht senden |
| `LF_MQTT_MATCH_END` | `true` | `mqtt.publishMatchEnd` | Rundenende-Nachricht senden |
| `LF_MQTT_STATUS` | `true` | `mqtt.publishStatus` | `bridge_online` beim Verbinden + `bridge_offline` als Last Will |
| `LF_MQTT_USERNAME` | *(leer)* | **–** | Broker-Benutzer. **Nur Umgebung**: steht bewusst in keinem Config-Feld, siehe unten. |
| `LF_MQTT_PASSWORD` | *(leer)* | **–** | Broker-Passwort. **Nur Umgebung.** |
| `LF_TCP_HOST` | `0.0.0.0` | `tcp.host` | Bind des Laserforce-Eingangs |
| `LF_TCP_PORT` | `9000` | `tcp.port` | Laserforce verbindet sich hierher. Änderung wird im Betrieb übernommen (Neu-Bind). |
| `LF_STREAM_ENABLED` | `false` | `streamServer.enabled` | roher TCP-Stream-Server an/aus |
| `LF_STREAM_HOST` | `127.0.0.1` | `streamServer.host` | dessen Bind. Für LAN-Zugriff `0.0.0.0`. |
| `LF_STREAM_PORT` | `9100` | `streamServer.port` | dessen Port |
| `LF_CSV_ENABLED` | `true` | `csv.enabled` | Statistik-CSV schreiben |
| `LF_CSV_DIR` | `data/stats` | `csv.dir` | Zielordner (relativ zum Programm) |
| `LF_CSV_DELIMITER` | `;` | `csv.delimiter` | `;` Excel DE · `,` pandas · Tab |
| `LF_CSV_BOM` | `true` | `csv.bom` | BOM voranstellen (Excel + Umlaute) |
| `LF_CSV_EVENTS` | `true` | `csv.writeEvents` | zusätzlich Event-Log pro Match |
| `LF_CSV_LIVE` | `false` | `csv.writeLive` | Match-CSV schon während des Matches aktualisieren |

> Für die Modus-Erkennung gibt es in `.env` und `config.json` **keine**
> Einstellungen — die Spielmodi stehen in [`modes/`](../modes), siehe
> [GAMEMODES.md](GAMEMODES.md#spielmodi-in-json-dateien). Die einzige
> Umgebungsvariable dazu ist `LF_MODES_DIR` (Standard: `modes/` neben `src/`);
> sie verschiebt nur das Verzeichnis und wird im Normalbetrieb nicht gebraucht.
> Dass die CSV-Ablage seit dieser Version je Spielmodus-Familie getrennt
> schreibt, passiert automatisch — Dateinamen und Spalten: [STATS.md](STATS.md).
| `LF_CAPTURE_ENABLED` | `false` | `capture.enabled` | rohen TDF-Stream mitschneiden ([CAPTURE.md](CAPTURE.md)) — **Diagnose, kein Dauerbetrieb**; die Dateien enthalten Spielernamen und Mitglieds-IDs. Konsolen-Änderung wirkt sofort |
| `LF_CAPTURE_DIR` | `data/capture` | `capture.dir` | Zielordner der Mitschnitte |
| `LF_CAPTURE_MAX_FILE_MB` | `20` | `capture.maxFileMB` | Grenze je Datei; danach endet der Mitschnitt dieser Mission (1–2000) |
| `LF_CAPTURE_MAX_FILES` | `50` | `capture.maxFiles` | Höchstzahl Dateien, älteste werden gelöscht (1–1000) |
| `LF_CAPTURE_MAX_TOTAL_MB` | `500` | `capture.maxTotalMB` | Grenze für den ganzen Ordner (1–100000) |
| `LF_EVENTLOG_ENABLED` | `true` | `eventLog.enabled` | lesbare Event-Log-Datei schreiben ([LOGGING.md](LOGGING.md)) |
| `LF_EVENTLOG_DIR` | `data/logs` | `eventLog.dir` | Zielordner der Event-Log-Datei (relativ zum Programm) |
| `LF_EVENTLOG_ROTATE` | `daily` | `eventLog.rotate` | `daily` = `events-YYYY-MM-DD.log` · `match` = `events-<matchId>.log` (neue Datei je Match) · `none` = `events.log` |
| `LF_EVENTLOG_FLUSH_MS` | `250` | `eventLog.flushMs` | wie lange eine Zeile höchstens wartet, um sich einen Schreibvorgang mit den nächsten zu teilen (0–5000; `0` = jede Zeile einzeln). Inhalt und Reihenfolge der Datei sind in beiden Fällen gleich — siehe [PERFORMANCE.md](PERFORMANCE.md) |
| `LF_EMIT_UNKNOWN_EVENTS` | `true` | `engine.emitUnknownEvents` | zusätzlich ein generisches `lf_event` für jeden Typ-4-Code, den der Parser nicht auswertet. Konsolen-Änderung wirkt sofort. |
| `LF_LOCAL_ROSTER_ENABLED` | `false` | `localRoster.enabled` | Namensliste nutzen |
| `LF_LOCAL_ROSTER_FILE` | `data/roster.csv` | `localRoster.file` | deren Pfad (setzt automatisch `enabled=true`) |
| `LF_MATCH_DURATION_MS` | `720000` | `match.defaultDurationMs` | Platzhalter, solange Laserforce keine Dauer gemeldet hat (Log-Typ 1). **Er wird nicht mehr als Countdown angezeigt**: meldet die Anlage keine Dauer, zählt die Uhr hoch — siehe [GAMEMODES.md](GAMEMODES.md#die-spieluhr) |
| `LF_MATCH_END_WATCHDOG_SECONDS` | `120` | `matchEnd.watchdogSeconds` | kommt **gar keine** Zeile mehr von der Anlage, gilt das Match nach dieser Zeit als beendet (`endReason: watchdog`). `0` = aus (0–86400) |
| `LF_MATCH_END_STREAM_LOST_SECONDS` | `30` | `matchEnd.streamLostSeconds` | TCP-Verbindung mitten im Match weg: so lange wird auf eine neue gewartet, danach `endReason: stream_lost`. `0` = aus |
| `LF_MATCH_END_BLOCK_SECONDS` | `10` | `matchEnd.endBlockSeconds` | Endabrechnung (Typ 6/7) erkannt und **kein** `0101` danach: Frist bis zum Ende. `0` = Erkennung aus, dann greift nur der Watchdog |
| `LF_LOG_LEVEL` | `info` | `logLevel` | `debug` \| `info` \| `warn` \| `error` |
| `LF_CONFIG_FILE` | `config.json` | – | wo die Konsolen-Konfiguration liegt |
| `LF_MODES_DIR` | `modes` | – | wo die Spielmodus-Dateien liegen ([GAMEMODES.md](GAMEMODES.md#spielmodi-in-json-dateien)). Standard ist der Ordner `modes/` im Programmverzeichnis; im Normalbetrieb nicht setzen |
| `LF_ENV_FILE` | `.env` | – | alternative .env-Datei |

Dazu die Benachrichtigungs-Variablen (`LF_NOTIFY_*`) — eigene Seite:
[NOTIFY.md](NOTIFY.md).

Leere Werte (`LF_API_TOKEN=`) zählen als „nicht gesetzt".

> **Broker-Zugangsdaten gehören ausschließlich in die Umgebung.**
> `LF_MQTT_USERNAME` und `LF_MQTT_PASSWORD` haben **keine** Entsprechung in
> `config.json` und sind deshalb in der Spalte „Config-Feld" mit `–` markiert.
> Alles, was in `config.json` steht, wird in diese Datei geschrieben **und** von
> `GET /api/config` an die Konsole ausgeliefert; ein Broker-Passwort hat in
> beidem nichts zu suchen. Die beiden Werte werden erst im Moment des
> Verbindungsaufbaus direkt aus der Umgebung gelesen (`mqttCredentials()` in
> `src/config.js`) und nirgends zwischengespeichert. `GET /api/status` meldet
> nur `authConfigured: true|false`. Trägt die Broker-URL Zugangsdaten
> (`mqtt://benutzer:geheim@host`), erscheinen sie in Log und Status als
> `mqtt://***@host`. Einzelheiten: [MQTT.md](MQTT.md).

---

## `config.json` — Struktur

```jsonc
{
  "logLevel": "info",
  "http": { "host": "0.0.0.0", "port": 8080, "trustProxy": false },
  "apiToken": "",             // nie über GET /api/config ausgeliefert
  "admin": {                  // Konsolen-Login — siehe SECURITY.md
    "enabled": true,
    "passwordHash": "scrypt$…",  // nur der Hash; nie ausgeliefert, nie über /api/config änderbar
    "sessionHours": 12,
    "maxFailedLogins": 8,        // Fehlversuche je IP bis zur Sperre
    "lockoutMinutes": 10         // Dauer dieser Sperre
  },
  "notify": {                 // Start-Benachrichtigung — siehe NOTIFY.md
    "enabled": true, "name": "", "onStart": true, "onIpChange": true,
    "includeInitialPassword": true,   // erstes Admin-Passwort mit in die Startnachricht
    // Kanäle: entweder hier/in der Konsole oder per .env (dann gepinnt).
    // GET /api/config liefert alles Geheime als "••••••".
    "discordWebhook": "", "slackWebhook": "",
    "ntfy": { "server": "https://ntfy.sh", "topic": "", "token": "" },
    "telegram": { "botToken": "", "chatId": "" },
    "webhook": { "url": "", "secret": "" },
    "email": { "host": "", "port": 587, "secure": false, "user": "", "pass": "", "from": "", "to": "" }
  },
  "cors": [],                 // leer = keine Cross-Origin-Browser-Zugriffe
  "rateLimitPerMin": 600,
  "stateTickMs": 200,         // State-Push-Takt (ms); Konsolen-Änderung erst nach Neustart
  "outputAllow": [],          // leer = jedes Ausgangs-Ziel erlaubt
  "tcp": { "host": "0.0.0.0", "port": 9000 },
  "streamServer": { "enabled": false, "host": "127.0.0.1", "port": 9100 },
  "match": { "defaultDurationMs": 720000 },
  "matchEnd": {                              // wann gilt ein Match als beendet? LASERFORCE.md
    "watchdogSeconds": 120,                  // keine Zeile mehr von der Anlage
    "streamLostSeconds": 30,                 // Verbindung weg und kommt nicht zurück
    "endBlockSeconds": 10                    // Endabrechnung (Typ 6/7) ohne folgendes 0101
  },                                         // je 0 = dieser Weg ist abgeschaltet
  "engine": { "emitUnknownEvents": true },   // generisches lf_event für nicht ausgewertete Typ-4-Codes
  "csv": {
    "enabled": true, "dir": "data/stats", "delimiter": ";",
    "bom": true, "writeEvents": true, "writeLive": false
  },
  "eventLog": {                              // lesbare Event-Log-Datei — Änderungen wirken erst nach Neustart
    "enabled": true, "dir": "data/logs",
    "rotate": "daily",                       // "daily" | "match" | "none"
    "filenamePrefix": "events"
  },
  "capture": {                               // Roh-Mitschnitt, Diagnose — CAPTURE.md
    "enabled": false, "dir": "data/capture",
    "maxFileMB": 20, "maxFiles": 50, "maxTotalMB": 500
  },
  "localRoster": { "enabled": false, "file": "data/roster.csv" },
  "mqtt": {                                  // Anbindung an den FunZone-Locationserver — MQTT.md
    "enabled": false,                        // standardmäßig aus
    "url": "mqtt://127.0.0.1:1883",
    "topic": "/decs/lfpassthrough",          // WÖRTLICH das Topic der Gegenseite; Ändern trennt die Anbindung
    "topicSuffixes": false,                  // true = <topic>/<event> — das empfängt der Locationserver NICHT
    "statusTopic": "",                       // "" = dasselbe wie "topic"
    "qos": 1, "retain": false,
    "clientId": "",                          // "" = lf-bridge-<rechner>-<zufall>
    "reconnectSeconds": 5,
    "queueMax": 0,                           // Nachrichten im Arbeitsspeicher bei totem Broker; 0 = keine
    "tlsInsecure": false,
    "publishMatchStart": true,
    "publishMatchEnd": true,
    "publishStatus": true
    // KEIN username/password: die stehen nur in der Umgebung (siehe oben)
  },
  "outputs": [
    {
      "id": "out_…",              // automatisch
      "name": "Regie-Trigger",
      "kind": "webhook",          // "webhook" | "tcp" | "udp"
      "enabled": true,
      "events": ["goal", "match_start"],   // oder ["*"]
      "sendEvents": true,
      "sendState": false,

      // kind = "webhook":
      "url": "https://…",         // nur http/https
      "secret": "geheim",         // optional → HMAC-Signatur (X-LFB-Signature).
                                  // GET /api/config zeigt stattdessen "••••••";
                                  // schickst du die Maske zurück, bleibt das Secret stehen.
      "includeState": false,      // Snapshot an jeden POST hängen

      // kind = "tcp" / "udp":
      "host": "192.168.1.50",
      "port": 7000
    }
  ]
}
```

`outputs` verwaltest du am besten in der Konsole (Tab „Ausgänge"). Eine alte
`webhooks: […]`-Datei wird beim Start automatisch nach `outputs` migriert.
Details zu Ausgängen: [INTEGRATION.md](INTEGRATION.md).

---

## Namensliste (optional)

Spielernamen kommen direkt aus dem Laserforce-Stream (Log-Typ 3). Wer eigene
Namen/Teams anzeigen will, pflegt eine **eigene CSV** (`localRoster.file`):

```
id,name,team
1234,Mara,Rot
5678,Jonas,Rot
@91,Gast 1,
```

- `id` = Laserforce-ID aus einer Typ-3-Zeile, mit oder ohne `@`/`#`
- `name` überschreibt den Stream-Namen
- `team` (optional) überschreibt den Teamnamen für das Team dieses Spielers
- Header-Zeile optional, `;` oder `,` als Trenner

Aktivieren: Konsole → „Einstellungen → Namensliste", oder `LF_LOCAL_ROSTER_FILE`.
„Liste neu laden" liest sofort neu ein. Ohne Liste → Stream-Namen.

---

## Als Dienst

### Windows (NSSM)

```
nssm install LF-Live "C:\Program Files\nodejs\node.exe" "C:\pfad\zu\lf_live\src\index.js"
nssm set LF-Live AppDirectory "C:\pfad\zu\lf_live"
nssm start LF-Live
```

### Linux (systemd) — `/etc/systemd/system/lf-live.service`

```ini
[Unit]
Description=LF Live
After=network.target

[Service]
WorkingDirectory=/opt/lf_live
ExecStart=/usr/bin/node src/index.js
Restart=always
User=lflive
# Environment=LF_HTTP_PORT=8080
# Environment=LF_API_TOKEN=…

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lf-live && journalctl -u lf-live -f
```

---

## Windows-Firewall

Beim ersten Start fragt Windows, ob `node.exe` im Netzwerk kommunizieren darf →
**für „Privates Netzwerk" erlauben**, sonst erreicht weder Laserforce Port 9000
noch ein anderer Rechner die Konsole auf 8080.

---

## Sicherheit

Eigene Seite: [SECURITY.md](SECURITY.md).
