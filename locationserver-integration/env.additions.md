# Neue Umgebungsvariablen für die `.env` des Locationservers

Alles hat eine Vorgabe. Wer nur `LF_BRIDGE_ENABLED=true` setzt, bekommt einen
funktionierenden Standardbetrieb. Die Zeilen gehören ans Ende der bestehenden
`.env` — sie liegt nicht im Repository, ein `git pull` fasst sie nicht an.

```dotenv
# ── Laserforce-TDF-Bridge ───────────────────────────────────────────────
# Die Lasertag-Anlage verbindet sich zu UNS und schickt ihren Log-Strom.
# Aus per Vorgabe: ohne diese Zeile wird kein Port geoeffnet.
LF_BRIDGE_ENABLED=true

# Wo wir auf die Anlage warten. 0.0.0.0 = alle Netzwerkkarten.
# Im Laserforce-Server muss der Log-Export auf genau diese Adresse zeigen.
LF_BRIDGE_HOST=0.0.0.0
LF_BRIDGE_PORT=9000

# Basis-Topic auf dem LOKALEN Broker (MQTT_URL). Es entstehen daraus:
#   <topic>/match_start   Missionsstart
#   <topic>/match_end     Missionsende mit Punktstand und Endgrund
#   <topic>/report        Missionsbericht (Kurzfassung je Spieler)
#   <topic>/status        online | offline | disabled der Bridge (retained)
# Bewusst NICHT /decs/lfpassthrough — das abonniert bereits
# util/lf-passthrough-bridge.js und wuerde unsere JSON-Nachrichten als
# Ereignisnamen missverstehen.
LF_BRIDGE_MQTT_TOPIC=funzone/lasertag

# Platzhalter-Rundenlaenge in Sekunden, solange die Anlage keine meldet.
# Wandert NIE als Messwert mit: im Bericht steht dann durationKnown=false.
LF_BRIDGE_DEFAULT_DURATION_SECONDS=720

# Matchende erkennen, alles in Sekunden. 0 schaltet den jeweiligen Weg ab.
#   WATCHDOG     laengste plausible Stille INNERHALB eines laufenden Matches
#   STREAM_LOST  so lange darf die Verbindung weg sein, bevor das Match faellt
#   END_BLOCK    Frist zwischen erkannter Endabrechnung und dem 0101 der Anlage
LF_BRIDGE_WATCHDOG_SECONDS=120
LF_BRIDGE_STREAM_LOST_SECONDS=30
LF_BRIDGE_END_BLOCK_SECONDS=10

# Missionsbericht. REPORT_NAMES=false laesst Spielernamen weg — die Kennungen
# (#Mitglied / @Gast) und alle Zahlen bleiben.
LF_BRIDGE_REPORT_ENABLED=true
LF_BRIDGE_REPORT_NAMES=true
```

## Was NICHT dazukommt

**Keine Zugangsdaten.** Die Bridge veröffentlicht über `util/mqtt-client.js` und
benutzt damit `MQTT_URL`, `MQTT_USERNAME` und `MQTT_PASSWORD`, die bereits
gesetzt sind. Sie liest diese Werte nie selbst, protokolliert sie nie und zeigt
sie auch nicht in `lfBridgeStatus()`.

**Keine zweite Broker-Verbindung.** Anders als `lf-passthrough-bridge.js` und
`player-bridge.js` baut die Bridge keinen eigenen `mqtt.connect()` auf — weder
lokal noch online. Wer die Daten im Backend braucht, leitet sie mit der
bestehenden Passthrough-Bridge weiter oder abonniert lokal.

## PM2

`ecosystem.config.js` steht in der `.gitignore` des Locationservers; jeder
Standort hat seine eigene. Die mitgelieferte Datei ist eine **Vorlage**. Wer
bereits eine hat, prüft nur zwei Dinge:

- `instances: 1` und `exec_mode: 'fork'` — im Cluster-Modus könnte nur die erste
  Instanz den TCP-Port öffnen, jede weitere würde sich selbst abschalten;
- `name: 'locationserver'` — `util/fleet-agent.js` sucht den PM2-Prozess unter
  genau diesem Namen.

## Firewall

Der TCP-Port (Vorgabe 9000) muss aus dem Hallennetz erreichbar sein, sonst
kommt die Anlage nicht durch. Er nimmt einen **ungesicherten** Strom entgegen:
keine Anmeldung, keine Verschlüsselung. Er gehört deshalb ins Hallennetz und
**nicht** ins Internet.
