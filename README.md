# LF Live

Ein Programm für den **Hauptrechner in der Lasertag-Halle**. Es liest den
Laserforce-Log-Strom, hält den Match-Zustand im Speicher und macht ihn im
Hallen-Netz über **einen** Port verfügbar.

Kein Cloud-Server, kein Electron, kein Build-Schritt. Node.js ≥ 20, zwei
Abhängigkeiten (`ws`, `mqtt`), ein `npm start`.

---

## Was es kann

| | |
|---|---|
| **Web-Konsole** | Live-Scoreboard, Ausgänge, Statistik, Rohdaten, Einstellungen, Log — mit Admin-Login, im Browser, ohne Installation |
| **JSON-API + WebSocket** | Abfragen und Live-Push, dazu ein fertig aufbereiteter **Anzeige-Datensatz** für Scoreboards und Beamer ([docs/API.md](docs/API.md)) |
| **Roher TCP-Strom** | für Werkzeuge, die weder HTTP noch WebSocket sprechen |
| **Ausgänge** | Daten aktiv an eine `IP:Port` schicken — Webhook, TCP oder UDP ([docs/INTEGRATION.md](docs/INTEGRATION.md)) |
| **MQTT** | Rundenstart (mit der genauen Laufzeit), Rundenende und Missionsbericht an den **FunZone-Locationserver**. Standardmäßig aus; ohne Broker startet lf_live trotzdem sofort ([docs/MQTT.md](docs/MQTT.md)) |
| **Missionsbericht** | die Kurzfassung eines beendeten Matches, mit Warteschlange auf der Platte — ein nicht erreichbares Ziel kostet keine Mission, auch über einen Neustart hinweg |
| **Spielmodus-Erkennung** | erkennt an der Missionszeile, ob Laserball oder Space Marines läuft, und zählt entsprechend. Ein unbekannter Modus läuft trotzdem korrekt. Eigene Modus-Nummern trägt der Betreiber in **JSON-Dateien unter `modes/`** ein — eine Zahl in eine Liste, kein Code ([docs/GAMEMODES.md](docs/GAMEMODES.md#spielmodi-in-json-dateien)) |
| **Statistik als CSV** | nach jedem Match, pro Spieler, plus Gesamtwertung je Spielmodus-Familie, Match-Index und „wer hat wann welchen Modus gespielt" ([docs/STATS.md](docs/STATS.md)) |
| **Roh-Mitschnitt** | den eingehenden Strom byteweise mitschneiden und später zurückspielen — Diagnose, standardmäßig aus ([docs/CAPTURE.md](docs/CAPTURE.md)) |
| **Start-Benachrichtigung** | meldet beim Hochfahren IP und Port per Discord, ntfy, Telegram, Slack, Webhook oder E-Mail, damit man den Hallen-PC auch ohne Monitor findet ([docs/NOTIFY.md](docs/NOTIFY.md)) |

---

## Schnellstart

Voraussetzung: **Node.js ≥ 20** ([nodejs.org](https://nodejs.org)).

```bash
cd lf_live
npm install
npm start
```

→ Browser: **http://localhost:8080/**  ·  Laserforce-Log-Export auf `<Hallen-PC>:9000` richten.

### Der erste Start

Die Konsole ist passwortgeschützt und nie offen. Wie du an das erste Passwort
kommst, hängt davon ab, ob ein [Benachrichtigungskanal](docs/NOTIFY.md)
eingerichtet ist — beides funktioniert **ohne Monitor und ohne Shell** auf dem
Hallen-PC:

| | was passiert |
|---|---|
| **Kanal eingerichtet** (z. B. `LF_NOTIFY_DISCORD_WEBHOOK=…` in der `.env`) | Ein Passwort wird erzeugt und kommt per Discord/ntfy/Mail — zusammen mit IP und Port. Jeder weitere Start meldet nur noch IP und Port. |
| **kein Kanal** | Es wird keins erzeugt. Beim ersten Aufruf zeigt die Konsole `/setup`, dort vergibst du es im Browser. Alles andere bleibt bis dahin gesperrt. |

Danach unter *Einstellungen → Start-Benachrichtigung* einen Kanal anlegen (geht
auch komplett in der Konsole) — der meldet ab dann jeden Start und jeden
IP-Wechsel und liefert dir einen Code, falls du dich mal aussperrst
(*„Passwort vergessen?"* auf der Anmeldeseite).

### Ohne Anlage ausprobieren

```bash
npm run bench -- --players 50 --consoles 4 --duration 240        # Last + Messwerte
node scripts/replay.js <datei.tdf> --host 127.0.0.1 --port 9000  # Mitschnitt zurückspielen
```

`bench.js` startet dafür eine **eigene** Instanz in einem temporären Ordner —
nichts landet im Projekt ([docs/PERFORMANCE.md](docs/PERFORMANCE.md)).

---

## Konfiguration

Drei Ebenen, **die spätere gewinnt**:

1. eingebaute Vorgaben
2. **`config.json`** — Match-Tag-Einstellungen, über die **Konsole** bearbeitet.
   Wird beim ersten Start angelegt, ist git-ignored, Rechte `0600`.
3. **`.env` / Umgebung** — Ports, Binds, Zugangsdaten. Kommt zuletzt und ist
   damit **gepinnt**: die Konsole zeigt einen so gesetzten Wert nur lesbar an.

Vorlage: [`.env.example`](.env.example) — vollständig, komplett auskommentiert,
mit Vorgabewert und einer Zeile „wann muss man das überhaupt anfassen".

**Jede Einstellung genau einmal, mit Vorgabe, Wirkung und dem Ort, an den sie
gehört: [docs/CONFIG.md](docs/CONFIG.md).** Das ist die einzige vollständige
Liste; hier steht mit Absicht keine zweite.

Die häufigsten vier:

| Variable | Vorgabe | wofür |
|---|---|---|
| `LF_HTTP_PORT` | `8080` | Konsole + API |
| `LF_TCP_PORT` | `9000` | hierhin richtest du den Laserforce-Log-Export |
| `LF_API_TOKEN` | *(leer)* | Token für Programme: kommt ohne Anmeldung an API, WebSocket und Rohstrom |
| `LF_ADMIN_PASSWORD` | *(leer)* | Admin-Passwort fest vorgeben statt erzeugen lassen |

---

## Anbinden

| Weg | Wofür | Doku |
|---|---|---|
| **Regie-Software (Next.js)** | Scoreboard, Torgrafiken, Trigger | [docs/REGIE.md](docs/REGIE.md) — fertige Bridge + React-Hook |
| **FunZone-Locationserver** | Rundenstart mit genauer Laufzeit, Rundenende, Missionsbericht über MQTT | [docs/MQTT.md](docs/MQTT.md) |
| REST / WebSocket / Raw-TCP / Webhook / TCP / UDP | alles andere | [docs/INTEGRATION.md](docs/INTEGRATION.md) |

```bash
curl http://<hallen-pc>:8080/api/state
curl http://<hallen-pc>:8080/api/display     # fertig aufbereitet für eine Anzeige
```
```js
const ws = new WebSocket("ws://<hallen-pc>:8080/ws");
ws.onmessage = (e) => { const m = JSON.parse(e.data); /* hello | ready | state | event */ };
```

---

## Als Dienst

**Standortserver / PM2** — fertige [`ecosystem.config.js`](ecosystem.config.js) liegt bei:

```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

**Windows** — [NSSM](https://nssm.cc/), **Linux** — systemd: Beispiele in
[docs/CONFIG.md](docs/CONFIG.md#als-dienst).

---

## Selbsttest

```bash
npm run check     # Modul- und Logiktests, ohne Netz
npm run itest     # End-to-End: startet den Dienst, spielt Matches ein, prüft alles über HTTP
```

Beide müssen grün sein, bevor etwas auf den Hallen-PC geht.

---

## Wo steht was

```
src/
  index.js        Start + Verdrahtung, Startlog mit LAN-Adresse, Ersteinrichtung
  config.js       .env + config.json, Validierung, env-Pins
  auth.js         Admin-Login: scrypt-Hash, Sessions, Sperre, Wiederherstellungs-Code
  netinfo.js      IP-Adressen + erreichbare URLs dieses Rechners
  notify.js       Start-Benachrichtigung (Discord/ntfy/Telegram/Slack/Webhook/Mail)
  smtp.js         minimaler SMTP-Client für die E-Mail-Benachrichtigung
  logger.js       Ringpuffer-Logger (Konsolen-Log)
  tcpIngest.js    TCP-Server: Laserforce-Log rein
  tdfSchema.js    Spaltenzuordnung der TDF-Zeilen (`;`-Schemazeilen)
  engine.js       Laserforce-Parser + Match-State
  gameModes.js    Spielmodi, Anzeigeprofile, Kennzahlen und ihre Beschriftungen
  eventCatalog.js Event-Code-Nachschlagewerk (Label, Kategorie, Klartext)
  apiServer.js    HTTP-API + WebSocket + Konsole (ein Port) + Härtung
  streamServer.js roher TCP-Strom raus
  outputs.js      ausgehende Ziele: webhook / tcp / udp
  mqtt.js         MQTT-Ausgang zum FunZone-Locationserver (standardmäßig aus)
  matchReport.js  Missionsbericht + Warteschlange auf der Platte
  statsWriter.js  Statistik → CSV
  eventLog.js     lesbare Event-Logdatei (data/logs/)
  capture.js      Roh-Mitschnitt des TCP-Stroms (data/capture/, standardmäßig aus)
  localRoster.js  optionale Namensliste (CSV)
  web/            die Konsole (statisch, kein Build)
modes/            Spielmodi als JSON — je Modus eine Datei, von Hand pflegbar
  _vorlage.json   Vorlage für einen neuen Modus (Dateien mit _ werden nie geladen)
  standard.json   „Standard" — Nummer noch einzutragen (docs/GAMEMODES.md)
  sm5.json        Space Marines 5 (Nummer 5)
  laserball-ranked.json  Laserball Ranked (Nummer 28)
  profile/        Anzeigeprofile: welche Spalten ein Modus zeigt, was in den Bericht kommt
scripts/
  check.js        Selbsttest            npm run check
  itest.js        End-to-End-Test       npm run itest
  bench.js        Leistungsmessung      npm run bench -- --help
  setpw.js        Admin-Passwort setzen/zurücksetzen   npm run setpw
  inspect.js      Laserforce-Feed katalogisieren       npm run inspect
  replay.js       Mitschnitt zurückspielen   node scripts/replay.js <datei.tdf>
docs/
  CONFIG.md       jede Einstellung genau einmal, Dienst-Setup, Firewall
  SECURITY.md     Sicherheitsmodell, Login, Härtung
  PERFORMANCE.md  was der Dienst wirklich kostet — gemessen, nicht geschätzt
  NOTIFY.md       Start-Benachrichtigung: Kanäle einrichten
  API.md          Endpunkte, WS-Nachrichten, State-/Event-/Anzeige-Schema
  REGIE.md        Regie-Software (Next.js) anbinden
  INTEGRATION.md  Fremdsoftware allgemein, Missionsbericht
  MQTT.md         FunZone-Locationserver: Topics, Nutzlast, Fallstricke
  LASERFORCE.md   Anbindung, Log-Format, alle Event-Codes
  GAMEMODES.md    Spielmodi: Erkennung, Zähler je Familie, Modi eintragen
  STATS.md        CSV-Dateien, Spalten, Auswertung
  LOGGING.md      lesbare Event-Logdatei: Zeilenformat, Rotation
  CAPTURE.md      Roh-Mitschnitt: aufzeichnen, Grenzen, zurückspielen
ecosystem.config.js   PM2: Start, Neustart, Speichergrenze, Logpfade
.env.example          Vorlage für die .env — vollständig und kommentiert
```

`data/` entsteht zur Laufzeit (Statistik, Logs, Mitschnitte, Berichts-Warteschlange)
und ist git-ignored — dort stehen Spielernamen und Laserforce-Mitglieds-IDs.
