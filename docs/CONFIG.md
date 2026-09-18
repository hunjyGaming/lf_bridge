# Konfiguration

Alles, was sich einstellen lässt — **jede Einstellung genau einmal**, mit
Vorgabewert, Wirkung und dem Ort, an den sie gehört.

- [Die drei Ebenen](#die-drei-ebenen)
- [Die Gesamttabelle](#die-gesamttabelle)
- [Was es nur in der Umgebung gibt](#was-es-nur-in-der-umgebung-gibt)
- [Was es nur in config.json gibt](#was-es-nur-in-configjson-gibt)
- [Was gar nicht hierher gehört: die Spielmodi](#was-gar-nicht-hierher-gehört-die-spielmodi)
- [Wann eine Änderung greift](#wann-eine-änderung-greift)
- [`config.json` — Struktur](#configjson--struktur)
- [Namensliste](#namensliste)
- [Als Dienst](#als-dienst)
- [Windows-Firewall](#windows-firewall)

---

## Die drei Ebenen

| | Wo | Wofür | Wie ändern |
|---|---|---|---|
| 1 | eingebaute Vorgaben | der Stand, mit dem lf_live ohne jede Datei läuft | gar nicht — `defaults()` in `src/config.js` |
| 2 | **`config.json`** | Match-Tag-Einstellungen | **Web-Konsole → Einstellungen** |
| 3 | **`.env` / Umgebung** | Ports, Binds, Zugangsdaten | Texteditor, dann Neustart |

**Die spätere Ebene gewinnt, und die `.env` ist die späteste.** Beim Start wird
zuerst `config.json` über die Vorgaben gelegt und *danach* die Umgebung darüber
(`applyEnv(normalize(fromFile))` in `src/config.js`). Genauso bei jedem
Speichern in der Konsole.

**Env-Pins.** Weil die Umgebung zuletzt kommt, ist ein dort gesetzter Wert
**gepinnt**: die Konsole zeigt das Feld nur noch lesbar mit der Markierung
*„aus .env"*, und ein Speichern kann ihn nicht überschreiben. Lass einen Wert
deshalb entweder nur in `.env` **oder** nur in der Konsole.

Die mitgelieferte [`.env.example`](../.env.example) ist bewusst **komplett
auskommentiert** und führt trotzdem jede Einstellung auf: eine frisch kopierte
`.env` pinnt damit nichts, und du nimmst genau die Zeilen wieder her, die du
wirklich festlegen willst.

`config.json` wird beim ersten Start angelegt, ist `.gitignore`-t und mit den
Dateirechten `0600` geschrieben. Ein leerer Umgebungswert (`LF_API_TOKEN=`)
zählt als „nicht gesetzt" — Ausnahmen sind in der Tabelle vermerkt.

---

## Die Gesamttabelle

Spalte **„gehört nach"**: wo die Einstellung im Normalfall stehen sollte.
Steht sie an beiden Stellen, **gewinnt immer die `.env`**.

### Wo liegt was, wie laut ist das Log

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_CONFIG_FILE` | – | `config.json` | Pfad der Konsolen-Konfiguration | `.env`, nur bei mehreren Instanzen |
| `LF_ENV_FILE` | – | `.env` | alternative Umgebungsdatei | `.env` bzw. Dienstmanager |
| `LF_MODES_DIR` | – | `modes` | Ordner der Spielmodus-Dateien | `.env`, im Normalbetrieb nie |
| `LF_LOG_LEVEL` | `logLevel` | `info` | `debug` \| `info` \| `warn` \| `error` | Konsole |

### Web-Konsole + JSON/WebSocket-API

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_HTTP_HOST` | `http.host` | `0.0.0.0` | Bind der Konsole/API · `127.0.0.1` = nur dieser PC | `.env` |
| `LF_HTTP_PORT` | `http.port` | `8080` | Port für Konsole, API und WebSocket (1–65535) | `.env` |
| `LF_API_TOKEN` | `apiToken` | *(leer)* | gesetzt → `Authorization: Bearer <token>` bzw. `?token=` kommt ohne Anmeldung an jede `/api/*` außer `/api/health`, an `/ws` und an den rohen TCP-Strom | `.env` |
| `LF_CORS_ORIGINS` | `cors` | *(leer = keine)* | Komma-Liste erlaubter Browser-Origins, `*` = beliebige (nur GET). Die Konsole selbst braucht keinen Eintrag | `.env` |
| `LF_RATE_LIMIT_PER_MIN` | `rateLimitPerMin` | `600` | Anfragen/Minute je IP auf der HTTP-API, `0` = aus (0–100000) | Konsole |
| `LF_TRUST_PROXY` | `http.trustProxy` | `false` | `true` → Client-IP aus dem **linkesten** `X-Forwarded-For`. Nur hinter eigenem Reverse-Proxy, sonst fälschbar | `.env` |
| `LF_STATE_TICK_MS` | `stateTickMs` | `200` | Takt des gemeinsamen Zustands-Pushs an WebSocket, Rohstrom und Ausgänge (50–5000). Ereignisse gehen unabhängig sofort raus | `.env` |

### Admin-Login der Konsole ([SECURITY.md](SECURITY.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_ADMIN_ENABLED` | `admin.enabled` | `true` | `false` = **kein Login**, die Konsole ist für jeden im LAN offen. Nur für ein geschlossenes Testnetz | `.env` |
| `LF_ADMIN_PASSWORD` | `admin.passwordHash` | *(leer)* | Klartext-Passwort. Hier gesetzt = gepinnt: weder Konsole noch `npm run setpw` können es ändern | `.env` oder gar nicht |
| `LF_ADMIN_PASSWORD_HASH` | `admin.passwordHash` | *(leer)* | fertiger `scrypt$…`-Hash aus `npm run setpw`. **Hat Vorrang vor `LF_ADMIN_PASSWORD`** | `.env` oder gar nicht |
| `LF_ADMIN_SESSION_HOURS` | `admin.sessionHours` | `12` | Gültigkeit einer Anmeldung in Stunden (1–720) | Konsole |
| – | `admin.maxFailedLogins` | `8` | Fehlversuche je IP bis zur Sperre (1–1000) | Konsole |
| – | `admin.lockoutMinutes` | `10` | Dauer dieser Sperre; jeder weitere Fehlversuch verlängert sie, gedeckelt auf das Achtfache (1–1440) | Konsole |

Ohne gesetztes Passwort erzeugt der **erste Start** eines — und schickt es über
den Benachrichtigungskanal. Gibt es keinen Kanal, wird auch keines erzeugt und
die Konsole liefert nur `/setup` aus, bis eines vergeben ist.

### Laserforce-Log-Strom herein

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_TCP_HOST` | `tcp.host` | `0.0.0.0` | Bind des Laserforce-Eingangs | `.env` |
| `LF_TCP_PORT` | `tcp.port` | `9000` | hierhin richtest du den Log-Export der Anlage (1–65535) | `.env` |

### Wann gilt ein Match als beendet ([LASERFORCE.md](LASERFORCE.md))

Jeder Wert in **Sekunden**, `0` schaltet genau diesen Weg ab.

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_MATCH_END_WATCHDOG_SECONDS` | `matchEnd.watchdogSeconds` | `120` | gar keine Zeile mehr von der Anlage → `endReason: watchdog` (0–86400) | Konsole |
| `LF_MATCH_END_STREAM_LOST_SECONDS` | `matchEnd.streamLostSeconds` | `30` | TCP-Verbindung weg und kommt nicht zurück → `endReason: stream_lost` (0–86400) | Konsole |
| `LF_MATCH_END_BLOCK_SECONDS` | `matchEnd.endBlockSeconds` | `10` | Endabrechnung (Typ 6/7) gesehen und kein `0101` danach (0–86400) | Konsole |
| `LF_MATCH_DURATION_MS` | `match.defaultDurationMs` | `720000` | Platzhalter, solange die Anlage keine Dauer meldet. **Kein Countdown** — ohne gemeldete Dauer zählt die Uhr hoch (1000–86400000), siehe [GAMEMODES.md](GAMEMODES.md#die-spieluhr) | Konsole |

### Match-Engine

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_EMIT_UNKNOWN_EVENTS` | `engine.emitUnknownEvents` | `true` | zusätzlich ein generisches `lf_event` für jeden Typ-4-Code, den der Parser nicht auswertet | Konsole |

### Roher NDJSON-Strom hinaus

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_STREAM_ENABLED` | `streamServer.enabled` | `false` | roher TCP-Strom-Server an/aus | Konsole |
| `LF_STREAM_HOST` | `streamServer.host` | `127.0.0.1` | dessen Bind. Für LAN-Zugriff `0.0.0.0` — dann `LF_API_TOKEN` setzen | `.env` |
| `LF_STREAM_PORT` | `streamServer.port` | `9100` | dessen Port (1–65535) | Konsole |

### Ausgänge ([INTEGRATION.md](INTEGRATION.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_OUTPUT_ALLOW` | `outputAllow` | *(leer = alles)* | Komma-Liste erlaubter Ziele: `host`, `host:port`, `*.endung`, `*.endung:port`. Ein nicht gelistetes Ziel wird mit einer Warnung übersprungen | `.env` |
| – | `outputs[]` | `[]` | die Ausgänge selbst (Webhook/TCP/UDP) — Aufbau siehe [unten](#configjson--struktur) | Konsole |

### MQTT → FunZone-Locationserver ([MQTT.md](MQTT.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_MQTT_ENABLED` | `mqtt.enabled` | `false` | MQTT-Ausgang an/aus. Ohne laufenden Broker startet lf_live trotzdem sofort | Konsole |
| `LF_MQTT_URL` | `mqtt.url` | `mqtt://127.0.0.1:1883` | Broker-Adresse. Schemata `mqtt` `mqtts` `tcp` `ssl` `tls` `ws` `wss`; ein anderes fällt auf die Vorgabe zurück | Konsole |
| `LF_MQTT_TOPIC` | `mqtt.topic` | `/decs/lfpassthrough` | wörtlich das Topic der Gegenseite, ohne Platzhalter. **Ändern trennt die Anbindung** | Konsole |
| `LF_MQTT_TOPIC_SUFFIXES` | `mqtt.topicSuffixes` | `false` | `true` = `<topic>/<event>`. **Der Locationserver kann das nicht empfangen** | Konsole |
| `LF_MQTT_STATUS_TOPIC` | `mqtt.statusTopic` | *(leer)* | eigenes Topic für `bridge_online` und Last Will; leer = das Datentopic | Konsole |
| `LF_MQTT_QOS` | `mqtt.qos` | `1` | `0` \| `1` \| `2` | Konsole |
| `LF_MQTT_RETAIN` | `mqtt.retain` | `false` | Nachrichten vom Broker aufbewahren lassen | Konsole |
| `LF_MQTT_CLIENT_ID` | `mqtt.clientId` | *(automatisch)* | leer = `lf-bridge-<rechner>-<zufall>` (max. 96 Zeichen) | Konsole |
| `LF_MQTT_RECONNECT_SECONDS` | `mqtt.reconnectSeconds` | `5` | Abstand der Wiederverbindungsversuche (1–3600) | Konsole |
| `LF_MQTT_QUEUE_MAX` | `mqtt.queueMax` | `0` | Nachrichten im **Arbeitsspeicher** bei totem Broker (0–10000). Bei Überlauf fällt die älteste heraus und wird gezählt | Konsole |
| `LF_MQTT_TLS_INSECURE` | `mqtt.tlsInsecure` | `false` | `mqtts://` mit selbstsigniertem Zertifikat zulassen | `.env` |
| `LF_MQTT_MATCH_START` | `mqtt.publishMatchStart` | `true` | Rundenstart senden (mit der genauen Laufzeit) | Konsole |
| `LF_MQTT_MATCH_END` | `mqtt.publishMatchEnd` | `true` | Rundenende senden | Konsole |
| `LF_MQTT_STATUS` | `mqtt.publishStatus` | `true` | `bridge_online` beim Verbinden + `bridge_offline` als Last Will | Konsole |

### Missionsbericht ([INTEGRATION.md](INTEGRATION.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_REPORT_ENABLED` | – | `true` | `false` erzeugt gar keinen Missionsbericht mehr | `.env` |
| `LF_REPORT_NAMES` | – | `true` | `false` lässt jeden Spielernamen weg; die Spieler bleiben über ihre ID unterscheidbar. Wirkt **zusammen** mit `_bericht.namen` der Profildatei: ein `false` von einer der beiden Seiten genügt | `.env` |

Welche Kennzahlen im Bericht stehen, entscheidet der Abschnitt `_bericht` der
Profildatei unter `modes/profile/` — siehe [GAMEMODES.md](GAMEMODES.md).

### Statistik → CSV ([STATS.md](STATS.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_CSV_ENABLED` | `csv.enabled` | `true` | Statistik-CSV schreiben | Konsole |
| `LF_CSV_DIR` | `csv.dir` | `data/stats` | Zielordner, relativ zum Arbeitsverzeichnis | Konsole |
| `LF_CSV_DELIMITER` | `csv.delimiter` | `;` | nur `;` `,` und Tabulator; `;` deutsches Excel, `,` pandas | Konsole |
| `LF_CSV_BOM` | `csv.bom` | `true` | BOM voranstellen, damit Excel die Umlaute zeigt | Konsole |
| `LF_CSV_EVENTS` | `csv.writeEvents` | `true` | zusätzlich eine Ereignisdatei je Match (die größte Datei) | Konsole |
| `LF_CSV_LIVE` | `csv.writeLive` | `false` | Match-CSV schon während des Matches aktualisieren | Konsole |

Die Trennung nach Spielmodus-Familie (`all_players_laserball.csv` /
`_sm5.csv`, `totals_*`) passiert automatisch und hat keine eigene Einstellung.

### Lesbare Ereignis-Logdatei ([LOGGING.md](LOGGING.md))

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_EVENTLOG_ENABLED` | `eventLog.enabled` | `true` | eine lesbare Zeile je Ereignis | Konsole |
| `LF_EVENTLOG_DIR` | `eventLog.dir` | `data/logs` | Zielordner, relativ zum Arbeitsverzeichnis | Konsole |
| `LF_EVENTLOG_ROTATE` | `eventLog.rotate` | `daily` | `daily` = `events-JJJJ-MM-TT.log` · `match` = `events-<matchId>.log` · `none` = `events.log` | Konsole |
| `LF_EVENTLOG_FLUSH_MS` | `eventLog.flushMs` | `250` | wie lange eine Zeile höchstens wartet, um sich **einen** Schreibvorgang mit den nächsten zu teilen (0–5000). Inhalt und Reihenfolge der Datei sind in jedem Fall gleich, siehe [PERFORMANCE.md](PERFORMANCE.md) | Konsole |
| – | `eventLog.filenamePrefix` | `events` | Präfix des Dateinamens; alles außer `A-Z a-z 0-9 . _ -` wird entfernt | Konsole |

### Roh-Mitschnitt des TDF-Stroms ([CAPTURE.md](CAPTURE.md))

**Diagnose, kein Dauerbetrieb** — ein Mitschnitt enthält Spielernamen und die
weltweit eindeutigen Laserforce-Mitglieds-IDs.

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_CAPTURE_ENABLED` | `capture.enabled` | `false` | Mitschnitt an/aus; wirkt ohne Neustart | Konsole |
| `LF_CAPTURE_DIR` | `capture.dir` | `data/capture` | Zielordner | Konsole |
| `LF_CAPTURE_MAX_FILE_MB` | `capture.maxFileMB` | `20` | Grenze je Mission; danach endet dieser Mitschnitt, die Auswertung läuft weiter (1–2000) | Konsole |
| `LF_CAPTURE_MAX_FILES` | `capture.maxFiles` | `50` | Höchstzahl Dateien, älteste werden gelöscht (1–1000) | Konsole |
| `LF_CAPTURE_MAX_TOTAL_MB` | `capture.maxTotalMB` | `500` | Grenze für den ganzen Ordner, älteste werden gelöscht (1–100000) | Konsole |

### Eigene Namensliste

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_LOCAL_ROSTER_ENABLED` | `localRoster.enabled` | `false` | Namensliste nutzen | Konsole |
| `LF_LOCAL_ROSTER_FILE` | `localRoster.file` | `data/roster.csv` | deren Pfad. **Diese Variable setzt `enabled` automatisch auf `true`** | Konsole |

### Start-Benachrichtigung ([NOTIFY.md](NOTIFY.md))

Es reicht **ein** Kanal. Alles davon lässt sich auch in der Konsole einrichten —
dann aber nicht zusätzlich in der `.env`, sonst ist es gepinnt. Alles
Geheime liefert `GET /api/config` nur als `••••••` aus.

| `.env` | `config.json` | Vorgabe | Wirkung | gehört nach |
|---|---|---|---|---|
| `LF_NOTIFY_ENABLED` | `notify.enabled` | `true` | Benachrichtigungen ganz an/aus | Konsole |
| `LF_NOTIFY_NAME` | `notify.name` | *(leer = Rechnername)* | Name dieser Installation in der Nachricht (max. 80 Zeichen) | Konsole |
| `LF_NOTIFY_ON_START` | `notify.onStart` | `true` | bei jedem Start melden | Konsole |
| `LF_NOTIFY_ON_IP_CHANGE` | `notify.onIpChange` | `true` | bei IP-Wechsel melden | Konsole |
| `LF_NOTIFY_INCLUDE_INITIAL_PASSWORD` | `notify.includeInitialPassword` | `true` | beim allerersten Start reist das erzeugte Admin-Passwort mit; `false` nennt nur den Dateipfad | `.env` |
| `LF_NOTIFY_NTFY_TOPIC` | `notify.ntfy.topic` | *(leer = ntfy aus)* | ntfy-Topic; nur `A-Z a-z 0-9 _ -`, max. 64 Zeichen. **Wer es kennt, liest mit** | Konsole |
| `LF_NOTIFY_NTFY_SERVER` | `notify.ntfy.server` | `https://ntfy.sh` | eigener ntfy-Server | Konsole |
| `LF_NOTIFY_NTFY_TOKEN` | `notify.ntfy.token` | *(leer)* | nur bei geschütztem ntfy-Server | `.env` |
| `LF_NOTIFY_DISCORD_WEBHOOK` | `notify.discordWebhook` | *(leer)* | Discord-Webhook-URL (nur `http`/`https`) | `.env` |
| `LF_NOTIFY_SLACK_WEBHOOK` | `notify.slackWebhook` | *(leer)* | Slack-Incoming-Webhook-URL | `.env` |
| `LF_NOTIFY_TELEGRAM_TOKEN` | `notify.telegram.botToken` | *(leer)* | Token von @BotFather | `.env` |
| `LF_NOTIFY_TELEGRAM_CHAT_ID` | `notify.telegram.chatId` | *(leer)* | Chat- oder Gruppen-ID; beide Felder werden gebraucht | Konsole |
| `LF_NOTIFY_WEBHOOK_URL` | `notify.webhook.url` | *(leer)* | eigener Endpunkt, bekommt alles als JSON | `.env` |
| `LF_NOTIFY_WEBHOOK_SECRET` | `notify.webhook.secret` | *(leer)* | gesetzt → HMAC in `X-LFB-Signature` | `.env` |
| `LF_NOTIFY_EMAIL_TO` | `notify.email.to` | *(leer = E-Mail aus)* | Empfänger, Komma-Liste möglich | Konsole |
| `LF_NOTIFY_SMTP_HOST` | `notify.email.host` | *(leer)* | Postausgangsserver; ohne ihn wird nichts verschickt | Konsole |
| `LF_NOTIFY_SMTP_PORT` | `notify.email.port` | `587` | `587` STARTTLS · `465` sofortiges TLS (1–65535) | Konsole |
| `LF_NOTIFY_SMTP_SECURE` | `notify.email.secure` | `false` | `true` für Port 465 | Konsole |
| `LF_NOTIFY_SMTP_USER` | `notify.email.user` | *(leer)* | ohne Benutzer wird nicht angemeldet | Konsole |
| `LF_NOTIFY_SMTP_PASS` | `notify.email.pass` | *(leer)* | Postfach-Passwort | `.env` |
| `LF_NOTIFY_SMTP_FROM` | `notify.email.from` | *(leer)* | leer = der Benutzername, sonst `lf-live@<rechner>` | Konsole |
| `LF_NOTIFY_SMTP_TLS_INSECURE` | `notify.email.rejectUnauthorized` | `false` / `true` | **umgekehrte Bedeutung**: `LF_NOTIFY_SMTP_TLS_INSECURE=true` setzt `rejectUnauthorized: false`, lässt also ein selbstsigniertes Serverzertifikat zu | `.env` |

---

## Was es nur in der Umgebung gibt

Diese Werte haben mit Absicht **kein** Gegenstück in `config.json` und tauchen
in keiner API-Antwort auf:

| Variable | Vorgabe | Wirkung |
|---|---|---|
| `LF_MQTT_USERNAME` | *(leer)* | Broker-Benutzer |
| `LF_MQTT_PASSWORD` | *(leer)* | Broker-Passwort |

**Warum.** Alles, was in `config.json` steht, wird in diese Datei geschrieben
**und** von `GET /api/config` an die Konsole ausgeliefert. Ein Broker-Passwort
hat in beidem nichts zu suchen. Die beiden Werte werden erst im Moment des
Verbindungsaufbaus direkt aus der Umgebung gelesen (`mqttCredentials()` in
`src/config.js`), nirgends zwischengespeichert, und `GET /api/status` meldet nur
`authConfigured: true|false`.

**Trägt die Broker-URL selbst Zugangsdaten** (`mqtt://benutzer:geheim@host`),
erscheint sie überall als `mqtt://***@host` — im Log, in `GET /api/status` und
seit dieser Fassung auch in `GET /api/config`. Schickt die Konsole die
maskierte Form zurück, bleibt der gespeicherte Wert unverändert. Besser ist
trotzdem der Weg über die beiden Variablen oben: in `config.json` steht dann gar
kein Passwort.

---

## Was es nur in `config.json` gibt

`admin.maxFailedLogins`, `admin.lockoutMinutes`, `eventLog.filenamePrefix` und
`outputs[]` haben keine Umgebungsvariable — sie werden in der Konsole gepflegt
oder direkt in der Datei. Alle vier stehen mit Vorgabewert in den Tabellen oben.

---

## Was gar nicht hierher gehört: die Spielmodi

Welche Modus-Nummer welcher Spielmodus ist, welche Spalten er zeigt und was im
Missionsbericht steht, liegt **nicht** in `config.json`, sondern in eigenen
JSON-Dateien unter [`modes/`](../modes) — je Modus eine Datei, dazu je
Anzeigeprofil eine unter `modes/profile/`.

Sie werden von Hand im Texteditor gepflegt, sind **versioniert** (anders als
`config.json`) und zu denselben zwei Zeitpunkten gelesen wie die Konfiguration:
beim Start und bei jedem Speichern in der Web-Konsole. Eine neu eingetragene
Modus-Nummer greift damit **ohne Dienstneustart**. Ein Tippfehler legt nichts
lahm: lf_live meldet ihn auf Deutsch mit Dateinamen im Log und läuft mit den
eingebauten Vorgaben weiter. Anleitung:
[GAMEMODES.md](GAMEMODES.md#spielmodi-in-json-dateien).

---

## Wann eine Änderung greift

| Änderung an | wirkt |
|---|---|
| `modes/*.json`, `modes/profile/*.json` | beim nächsten Speichern in der Konsole, ohne Neustart |
| `tcp.host` / `tcp.port` | sofort — der Eingang wird neu gebunden |
| `outputs`, `outputAllow`, `mqtt.*`, `capture.*`, `localRoster.*`, `streamServer.*` | sofort beim Speichern |
| `logLevel`, `match.*`, `matchEnd.*`, `engine.*`, `csv.*` | sofort beim Speichern |
| `apiToken`, `cors`, `rateLimitPerMin`, `http.trustProxy` | sofort — sie werden bei jeder Anfrage neu gelesen |
| `admin.sessionHours`, `admin.maxFailedLogins`, `admin.lockoutMinutes` | sofort beim Speichern |
| `http.host` / `http.port` / `stateTickMs` | **erst nach einem Neustart** (das Log sagt es beim Speichern) |
| `eventLog.*` | **erst nach einem Neustart** |
| jede `.env`-Zeile | **erst nach einem Neustart** |

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
    "email": {
      "host": "", "port": 587, "secure": false,
      "user": "", "pass": "", "from": "", "to": "",
      "rejectUnauthorized": true      // false = selbstsigniertes Serverzertifikat zulassen
    }
  },
  "cors": [],                 // leer = keine Cross-Origin-Browser-Zugriffe
  "rateLimitPerMin": 600,
  "stateTickMs": 200,         // State-Push-Takt (ms); Änderung erst nach Neustart
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
  "eventLog": {                              // lesbare Event-Logdatei — Änderungen erst nach Neustart
    "enabled": true, "dir": "data/logs",
    "rotate": "daily",                       // "daily" | "match" | "none"
    "filenamePrefix": "events",
    "flushMs": 250                           // 0 = jede Zeile einzeln schreiben
  },
  "capture": {                               // Roh-Mitschnitt, Diagnose — CAPTURE.md
    "enabled": false, "dir": "data/capture",
    "maxFileMB": 20, "maxFiles": 50, "maxTotalMB": 500
  },
  "localRoster": { "enabled": false, "file": "data/roster.csv" },
  "mqtt": {                                  // Anbindung an den FunZone-Locationserver — MQTT.md
    "enabled": false,                        // standardmäßig aus
    "url": "mqtt://127.0.0.1:1883",
    "topic": "/decs/lfpassthrough",          // WÖRTLICH das Topic der Gegenseite
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
      "events": ["goal", "match_start"],   // oder ["*"] · "match_report" für den Missionsbericht
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
Details: [INTEGRATION.md](INTEGRATION.md).

---

## Namensliste

Spielernamen kommen direkt aus dem Laserforce-Strom (Log-Typ 3). Wer eigene
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
- Header-Zeile optional, `;` oder `,` als Trenner, `#` am Zeilenanfang = Kommentar

Aktivieren: Konsole → „Einstellungen → Namensliste", oder `LF_LOCAL_ROSTER_FILE`.
„Liste neu laden" liest sofort neu ein. Ohne Liste → Stream-Namen.

---

## Als Dienst

### PM2 (Standortserver) — empfohlen

Im Projekt liegt eine fertige [`ecosystem.config.js`](../ecosystem.config.js):
eine Instanz, Neustart mit Bremse, Speicher-Reißleine bei 512 MB, Logpfade unter
`data/pm2/`, 8 s Zeit zum sauberen Beenden (ein laufendes Match wird dabei noch
abgerechnet).

```bash
pm2 start ecosystem.config.js
pm2 logs lf-live
pm2 save && pm2 startup       # nach einem Rechner-Neustart automatisch mitstarten
```

PM2 dreht seine Logdateien **nicht** von selbst:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
```

Die `.env` liest lf_live selbst ein (`process.loadEnvFile()`), nicht PM2 —
entscheidend ist das Arbeitsverzeichnis `cwd`, von dort werden `.env`,
`config.json`, `modes/` und `data/` gesucht.

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
