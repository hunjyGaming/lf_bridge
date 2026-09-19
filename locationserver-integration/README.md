# Laserforce-TDF-Bridge im FunZone-Locationserver

Diese Ordner enthalten alles, was aus der eigenständigen `lf_bridge` in den
Locationserver wandert: ein Prozess statt zwei, in dessen Konventionen, mit
dessen Konfiguration und dessen MQTT-Client.

Der innere Aufbau entspricht **genau** der Ablage im Locationserver — die
Dateien lassen sich eins zu eins hineinkopieren.

```
locationserver-integration/
├── util/
│   ├── lf-bridge.js          ← neu, in Locationserver-Stil: TCP-Annahme,
│   │                            Auswertung anstoßen, über util/mqtt-client.js
│   │                            veröffentlichen, Selbstabschaltung
│   ├── lf-report-store.js    ← neu: Missionsberichte bis zur Zustellung,
│   │                            auf dem Muster von util/persistence.js
│   └── lf-tdf/               ← inhaltlich UNVERÄNDERT aus der eigenständigen
│       ├── engine.js            Bridge übernommen (reine Auswertung, kein
│       ├── gameModes.js         Ein-/Ausgabe, durchgetestet)
│       ├── tdfSchema.js
│       ├── eventCatalog.js
│       └── matchReport.js
├── modes/                    ← Modus-Konfiguration, gehört in den Wurzelordner
│   ├── standard.json            des Locationservers (neben app.js)
│   ├── sm5.json
│   ├── laserball-ranked.json
│   ├── _vorlage.json
│   └── profile/
├── app.js.patch.md           ← der Einhäng-Schnipsel, mit Zeilenkontext
├── config.js.patch.md        ← der neue Abschnitt für util/config.js
├── env.additions.md          ← die neuen Umgebungsvariablen
├── ecosystem.config.js       ← PM2-Vorlage
└── README.md                 ← diese Datei
```

---

## Einbau in Schritten

### 1. Dateien kopieren

Aus diesem Ordner in den Wurzelordner des Locationservers:

```
util/lf-bridge.js         →  <locationserver>/util/lf-bridge.js
util/lf-report-store.js   →  <locationserver>/util/lf-report-store.js
util/lf-tdf/              →  <locationserver>/util/lf-tdf/
modes/                    →  <locationserver>/modes/
ecosystem.config.js       →  nur vergleichen, siehe Schritt 5
```

Keine neue Abhängigkeit. Die Bridge braucht nur `net` und `fs` aus Node selbst
und den bereits vorhandenen `mqtt`-Client des Locationservers. `npm install`
ist nach dem Kopieren **nicht** nötig.

### 2. `util/config.js` ergänzen

Siehe `config.js.patch.md` — ein Block am Ende des `config`-Objekts. Alle neuen
Werte tragen die Vorsilbe `LF_BRIDGE_` und hängen am Funktionsschalter
`LF_BRIDGE_ENABLED`, der **standardmäßig aus** ist.

### 3. `app.js` ergänzen

Siehe `app.js.patch.md` — eine `require`-Zeile und ein `try`-Block in
`startServer()`, hinter `startLfPassthroughBridge()`. Mehr nicht.

### 4. `.env` ergänzen

Siehe `env.additions.md`. Zum Anschalten genügt `LF_BRIDGE_ENABLED=true`; alles
andere hat brauchbare Vorgaben.

### 5. PM2 prüfen

`ecosystem.config.js` steht in der `.gitignore` des Locationservers, jeder
Standort pflegt seine eigene. Die mitgelieferte Datei ist eine **Vorlage**;
wichtig sind nur `instances: 1`, `exec_mode: 'fork'` und
`name: 'locationserver'`.

### 6. Starten und nachsehen

```bash
pm2 restart locationserver
pm2 logs locationserver --lines 50
```

Erwartete Zeilen:

```
LF bridge: Modus-Dateien aus /pfad/modes — 3 Modus/Modi, 3 Profil(e).
LF bridge: wartet auf Laserforce auf 0.0.0.0:9000.
LF bridge: veröffentlicht auf funzone/lasertag/# über den lokalen Broker.
```

Dann im Laserforce-Server den Log-Export auf `<IP des Locationservers>:9000`
stellen. Sobald die Anlage verbindet:

```
LF bridge: Laserforce verbunden (10.0.0.42:51934).
LF bridge: Mission gestartet (mu6slrek).
LF bridge: Mission beendet (mu6slrek, Grund: mission_end).
```

Zum Mitlesen:

```bash
mosquitto_sub -h localhost -t 'funzone/lasertag/#' -v
```

---

## Die Modus-Konfiguration

**Ort: `<locationserver>/modes/`** — im Wurzelordner, neben `app.js`, nicht
unter `util/`. Damit steht sie dort, wo der Betreiber sie sucht, und nicht in
einem Ordner mit Programmcode.

```
<locationserver>/modes/standard.json          ein Modus je Datei
<locationserver>/modes/sm5.json
<locationserver>/modes/laserball-ranked.json
<locationserver>/modes/_vorlage.json          Vorlage mit Erklärungen
<locationserver>/modes/profile/*.json         Anzeigeprofile, Berichtsfelder
```

Hier trägt der Betreiber seine **gemessenen Missionsnummern** ein. Die Dateien
werden beim Start gelesen; ein Tippfehler wird beim Start namentlich gemeldet
und die betroffene Datei übersprungen — es gelten dann die eingebauten Vorgaben,
die Bridge läuft weiter. Nach einer Änderung: `pm2 restart locationserver`.

Ein anderer Ort geht über `LF_MODES_DIR` (absoluter Pfad). Wer die Dateien vom
`git pull` fernhalten will, legt sie außerhalb des Repositories ab und zeigt mit
`LF_MODES_DIR` dorthin.

---

## Was der Betreiber hier NICHT mehr hat

Die eigenständige Bridge kann mehr als das, was hier eingebaut wird. Bewusst
weggelassen, weil der Locationserver es entweder selbst hat oder es an einem
missionskritischen Dienst nichts verloren hat:

| Weggelassen | Warum | Ersatz |
|---|---|---|
| **Web-Konsole** | Der Locationserver hat eigene HTTP-Server (3001/3002) mit eigener Absicherung. Eine zweite Konsole mit eigener Anmeldung wäre eine zweite Angriffsfläche am Eingangsrechner. | Die eigenständige Bridge parallel betreiben, oder `lfBridgeStatus()` an eine bestehende Route hängen (siehe `app.js.patch.md`). |
| **HTTP-API und WebSocket-Strom** (`/api/state`, `/ws`) | Live-Zustand fünfmal pro Sekunde zu serialisieren ist genau die Last, die ein Dienst nicht tragen soll, der über Check-ins entscheidet. | Anzeigen und Regie-Werkzeuge hängen weiter an der eigenständigen Bridge. |
| **CSV-Statistik** | Schreibt je Match mehrere Dateien synchron. Der Locationserver hat mit `util/persistence.js` seine eigene Ablage und mit dem Backend sein eigenes Ziel. | Der Missionsbericht über MQTT enthält dieselben Zahlen je Spieler. |
| **Roh-Mitschnitt** (`capture`) | Schreibt den vollen TCP-Strom mit Spielernamen und Mitglieds-IDs auf die Platte. Ein Diagnosewerkzeug, kein Dauerbetrieb. | Zum Fehlersuchen die eigenständige Bridge parallel laufen lassen — die Anlage kann an zwei Ziele exportieren. |
| **Benachrichtigungen** (Discord/ntfy/Mail) | Der Locationserver meldet sich über den Fleet-Agenten. | `util/fleet-agent.js`. |
| **Live-Ereignisstrom über MQTT** | Ein Abonnent auf jedes Einzelereignis würde in einem Pfad der Auswertung sitzen, der aus einem `setImmediate` heraus läuft — dort käme ein Fehler in die Ereignisschleife des Locationservers. | Missionsstart, Missionsende und der Bericht decken ab, was ein Backend braucht. |

Die eigenständige Bridge bleibt also weiterhin sinnvoll — für Anzeigen in der
Halle, für die Regie, für CSV-Auswertungen und zur Fehlersuche. Beides
gleichzeitig ist möglich: der Laserforce-Log-Export kann an mehrere Ziele gehen.

---

## Wie die Bridge sich verhält, wenn etwas schiefgeht

Der Locationserver entscheidet über RFID-Check-ins und Kartendrucke. Fällt er
aus, steht der Eingang. Deshalb gilt: **lieber keine Lasertag-Daten als kein
Check-in.**

### Nichts wird weitergereicht

Jeder Einstiegspunkt — `connection`, `data`, `close` am Socket, jeder Zeitgeber,
jeder MQTT-Aufruf — liegt in `try/catch`. Ein Fehler wird gemeldet und
verschluckt. Die Bridge registriert **keinen** eigenen `uncaughtException`- oder
`SIGTERM`-Handler; darüber bestimmt der Locationserver.

### Selbstabschaltung

Jeder abgefangene Fehler wird gezählt. **50 Fehler innerhalb von 60 Sekunden**
schalten die Bridge ab: TCP-Port zu, Verbindungen weg, Zeitgeber aus,
Auswertung los. Im Log steht dann:

```
LF bridge: ================================================
LF bridge: SELBSTABSCHALTUNG — 50 Fehler in 60 Sekunden — zuletzt in "mqtt"
LF bridge: Der Lasertag-Teil ist ab jetzt aus. Der Locationserver
LF bridge: laeuft unveraendert weiter (Check-in, Druck, Sync).
LF bridge: Zuruecksetzen: pm2 restart funzone-locationserver
LF bridge: ================================================
```

Sofort abgeschaltet wird außerdem, wenn der TCP-Port nicht zu haben ist (schon
belegt) — das ist ein Einrichtungsfehler, kein Dauerfehler.

**Zurücksetzen:** `pm2 restart locationserver`. Wer den Dienst nicht anfassen
will, ruft `resetLfBridge()` aus `util/lf-bridge.js` auf; das setzt den Zähler
zurück und fährt die Bridge neu hoch.

### Alle Grenzen

| Grenze | Wert | Wo |
|---|---|---|
| Zeilenpuffer je Verbindung ohne Zeilenumbruch | 1 MiB, dann verworfen | `lf-bridge.js` |
| gleichzeitige TCP-Verbindungen | 4, weitere werden abgewiesen | `lf-bridge.js` |
| Fehlerfenster / Fehlergrenze | 60 s / 50 Fehler → Selbstabschaltung | `lf-bridge.js` |
| Ereignisliste im Zustandsobjekt | 50 Einträge, älteste fallen raus | `lf-tdf/engine.js` |
| gemerkte Spielerkennungen je Match | 512 | `lf-tdf/matchReport.js` |
| Spieler je Bericht | 256 | `lf-tdf/matchReport.js` |
| Kennzahlen je Spieler im Bericht | 64 | `lf-tdf/matchReport.js` |
| Länge eines Namens aus dem Strom | 64 Zeichen, Steuerzeichen entfernt | `lf-tdf/engine.js` |
| Warteschlange der Berichte | 50 Stück **und** 2 MiB, älteste fallen raus | `lf-report-store.js` |
| Abstand der Zustellversuche | 30 s | `lf-report-store.js` |

### Kein blockierendes Schreiben im heißen Pfad

Im Socket-Pfad wird nichts auf die Platte geschrieben. Die einzigen
Schreibvorgänge sind die Warteschlange der Berichte in
`<locationserver>/storage/lf-bridge-reports.json` — **höchstens einmal je Match**
und einmal je Zustellversuch, also alle paar Minuten, nicht je Ereignis.
`storage/` steht bereits in der `.gitignore` des Locationservers.

### Der TCP-Port nimmt einen ungesicherten Strom entgegen

Keine Anmeldung, keine Verschlüsselung — er gehört ins Hallennetz, nicht ins
Internet. Keine Eingabe daraus wird ungeprüft als Zahl, Objektschlüssel oder
Dateiname verwendet: die Auswertung unter `util/lf-tdf/` prüft jede Kennung
gegen ein Muster und schützt gegen Prototyp-Verschmutzung, und diese Hülle
reicht nur rohe Zeilen hinein und fertige Objekte heraus. Getestet mit
Binärmüll, 20 000 Zeichen langen Feldern, `__proto__`, `constructor`,
`Infinity` und `NaN` als Feldwerten.

### Zugangsdaten

Kommen ausschließlich aus der Umgebung und werden von der Bridge nie selbst
gelesen: sie veröffentlicht über `util/mqtt-client.js`, der `MQTT_URL`,
`MQTT_USERNAME` und `MQTT_PASSWORD` schon kennt. `lfBridgeStatus()` enthält
weder Broker-URL noch Benutzername noch Passwort.

---

## Was veröffentlicht wird

Alles auf dem **lokalen** Broker (`MQTT_URL`), QoS 1, jede Nachricht mit
`ts` und `locationId`.

| Topic | Wann | Inhalt |
|---|---|---|
| `funzone/lasertag/match_start` | Missionsstart (`0100`) | Kennung, Modus, Teams, gemeldete Rundenlänge |
| `funzone/lasertag/match_end` | Missionsende | tatsächliche Laufzeit, Punktstand, `endReason` und `endSource` |
| `funzone/lasertag/report` | nach dem Missionsende | Kurzfassung: Teams, Sieger, je Spieler Kennung, Team, Ergebnis und die Kennzahlen des Profils |
| `funzone/lasertag/status` | Start, Stopp, Selbstabschaltung | `online` · `offline` · `disabled` (retained) |

`endReason` unterscheidet, **warum** ein Match als beendet gilt
(`mission_end` · `watchdog` · `stream_lost` · `next_match` · `shutdown`),
`endSource`, **woran** es erkannt wurde (`0101` · `summary_type6` ·
`summary_type7` · `silence` · …). Ein `0101` der Anlage und ein Wachhund-Ende
sind zwei sehr verschiedene Aussagen und bleiben unterscheidbar.

Bei `durationKnown: false` hat die Anlage nie gesagt, wie lang die Runde ist —
dann ist `durationMs` `null` und eine Anzeige zählt hoch statt herunter. Die
konfigurierte Platzhalterlänge wandert nie als Messwert mit.
