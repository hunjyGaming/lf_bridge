# Leistung — gemessen, nicht geschätzt

Diese Datei hält fest, **was der Dienst wirklich kostet**, womit das gemessen
wurde und was bewusst **nicht** verändert wurde. Sie ist die Grundlage für die
Entscheidung, ob lf_live auf einen gemeinsam genutzten, missionskritischen
Location Server darf.

- [Das Messwerkzeug](#das-messwerkzeug)
- [Der Betriebsfall](#der-betriebsfall)
- [Nachmessung nach MQTT, Missionsbericht, Anzeige-API und Rohdatenansicht](#nachmessung-nach-mqtt-missionsbericht-anzeige-api-und-rohdatenansicht)
- [Vorher / nachher](#vorher--nachher)
- [Was tatsächlich Last erzeugt](#was-tatsächlich-last-erzeugt)
- [Dauerlauf: wächst etwas?](#dauerlauf-wächst-etwas)
- [Was bewusst NICHT verändert wurde](#was-bewusst-nicht-verändert-wurde)
- [Die Grenze](#die-grenze)

---

## Das Messwerkzeug

`scripts/bench.js` — läuft auf dem Zielserver, ohne zusätzliche Abhängigkeit.

```
node scripts/bench.js --players 50 --consoles 4 --duration 240
node scripts/bench.js --players 50 --matches 60 --duration 900 --speed 45   # Dauerlauf
node scripts/bench.js --help
```

Es startet eine **eigene** Instanz des Dienstes in einem temporären Ordner
(nichts landet im Projekt oder in `data/`), spielt einen realistischen TDF-Strom
hinein, hängt simulierte WebSocket-Konsolen an und misst von **innen**:

| Messgröße | woher |
|---|---|
| CPU-Zeit des Dienstes | `process.cpuUsage()` |
| Heap nach erzwungener GC | `node --expose-gc` + `process.memoryUsage()` |
| Handle-Zahl | `process.getActiveResourcesInfo()` |
| Verzögerung der Event-Loop | `perf_hooks.monitorEventLoopDelay()` |
| Schreiblast auf Platte | `fs.{append,write}File{,Sync}` umschlossen |
| Bytes je Zustands-Push | an den simulierten Konsolen gezählt |
| Ereignisdurchsatz | gesendete Zeilen / Laufzeit |

Dieselbe Datei ist Treiber **und** Sonde: der Treiber startet den Dienst mit
`--expose-gc --require scripts/bench.js`, die Sonde erkennt das an
`require.main !== module` und öffnet nur einen winzigen Messdienst auf
127.0.0.1. Im normalen Betrieb wird `bench.js` nie geladen.

> **Windows-Eigenheit.** Die Timer-Auflösung liegt bei ~15,6 ms; die Event-Loop
> meldet das als Verzögerung, ohne dass irgendetwas blockiert. `bench.js` misst
> deshalb zuerst den **Leerlauf-Grundwert** und zieht ihn in der Bewertung ab.

### Die Ereignismischung

Aus [LASERFORCE.md](LASERFORCE.md) abgeleitet, nicht geraten. Kern der Ableitung:
`0201` (Miss) ist der **einzige** Code, den die Doku als „Sehr häufig" markiert,
und jeder Schuss ins Leere erzeugt ihn. Bei einer Trefferquote von 25–30 %
folgen daraus rund 60 % Fehlschüsse. Der Rest verteilt sich nach den in der Doku
beschriebenen Mechaniken: `0204` ist rund ein Drittel von `0203` (drei Treffer
zerstören ein Ziel), jedem Raketenschuss geht ein `0300`-Lock voraus, Nuke und
Rapid Fire hängen an Rollen und Sonderpunkten, Achievements sind Einzelfälle.
Die vollständige Tabelle mit Begründung je Code steht im Kopf von
`scripts/bench.js`. Dazu kommen die begleitenden Typ-5-Score-Zeilen, die
Typ-9-Respawn-Ketten (`3` → 4000 ms → `2` → 4000 ms → `0`) und die Endabrechnung
aus Typ 6, Typ 7 und `0101` — in der Reihenfolge, die die Doku vorschreibt.

---

## Der Betriebsfall

| | |
|---|---|
| Spieler gleichzeitig | 50 |
| Ereignisse | 30/s Spielzeit (50 Spieler × 0,6) |
| Konsolen | 0–4 gleichzeitig |
| Matchdauer | 15 Minuten |
| Betrieb | Tage ohne Neustart, geteilter Rechner |

Gemessen auf 8 Kernen / 16 GB, Node 20, Windows 11. Jeder Wert unten ist der
Mittelwert über **drei** aufeinanderfolgende Matches in Echtzeit.

---

## Nachmessung nach MQTT, Missionsbericht, Anzeige-API und Rohdatenansicht

Seit der Messrunde weiter unten sind vier Dinge dazugekommen: der
**MQTT-Ausgang**, der **Missionsbericht** samt Warteschlange auf der Platte, die
**Anzeige-API** (`/api/display`, `feed=display`) und die **Live-Rohdatenansicht**
der Konsole. Diese Runde beantwortet nur eine Frage: kostet davon etwas?

**Antwort: nein.** Nichts davon ist im Betriebsfall messbar, und es wurde
deshalb auch nichts geändert.

### Die Läufe

Jede Zeile ist **ein** Lauf, derselbe Befehl, hintereinander auf einem sonst
unbeschäftigten Rechner:

```
node scripts/bench.js --players 50 --consoles 4 --duration 240
```

| Lauf | Konsolen | Missionsbericht | CPU (% eines Kerns) | Event-Loop Mittel | 99 % unter | längste Verzögerung | Bytes je Zustands-Push |
|---|---|---|---|---|---|---|---|
| 1 | 4 | an | 6,36 % | — | — | 170 ms | 73 347 |
| 2 | 4 | an | 6,77 % | 16,2 ms | 25,1 ms | 160 ms | 73 268 |
| 3 | 4 | an | 6,97 % | 16,4 ms | 24,5 ms | 229 ms | 73 332 |
| 4 | 4 | **aus** (`LF_REPORT_ENABLED=false`) | 7,01 % | 16,5 ms | 24,5 ms | 147 ms | 73 284 |
| 5 | **0** | an | **3,81 %** | 16,4 ms | 23,2 ms | 129 ms | — |

Leerlauf-Grundwert dieses Rechners im selben Zeitraum: **16,4–16,8 ms** im
Mittel, 22–35 ms Maximum. Der Mittelwert der Event-Loop-Verzögerung ist also
vollständig der Windows-Timerauflösung zuzuschreiben, nicht dem Dienst.

**Der Missionsbericht ist nicht messbar.** 6,8 % mit und 7,0 % ohne — der
Unterschied liegt unter der Streuung der drei Läufe mit identischer
Einstellung (6,36 / 6,77 / 6,97 %). Direkt gemessen kostet er 4–6 ms je Match
und 0,0–0,5 µs je Stream-Zeile (siehe unten).

> **Zur Streuung, ehrlich:** dieselbe Einstellung ergab 6,36 %, 6,77 % und
> 6,97 %. Jede Aussage unterhalb von etwa einem halben Prozentpunkt ist
> Rauschen. Und das Urteil des Messwerkzeugs am Ende („hält die Last aus" /
> „so NICHT") hängt an der **längsten** Verzögerung — einem einzigen Ausreißer
> beim Matchabschluss. Lauf 3 kippte damit auf „so NICHT", bei sonst
> identischen Zahlen. Wer das Urteil liest, muss die Zeile darüber mitlesen.
>
> Läuft auf demselben Rechner nebenher etwas anderes, verschiebt sich alles:
> in einem Lauf während einer parallelen Dateisuche stieg der Leerlauf-Grundwert
> auf 170 ms und die längste Verzögerung auf 763 ms. Das ist eine Eigenschaft
> des Messrechners, keine des Dienstes — deshalb misst `bench.js` den
> Grundwert überhaupt.

### Vergleich mit der letzten Messrunde

| | letzte Runde | jetzt | |
|---|---|---|---|
| CPU, 4 Konsolen offen | 6,00 % | 6,4–7,0 % | im Rahmen der Streuung |
| CPU, keine Konsole offen | 4,43 % | **3,81 %** | eher besser |
| Bytes je Zustands-Push | 72 354 | 73 268–73 347 | **+1,3 %** |
| Heap nach GC | 8,6 MB | 9,1–9,4 MB | unverändert klein |
| Handles | 8 | 6 (0 Konsolen) / 10 (4 Konsolen) | = Zahl der offenen Sockets |

Die **+1,3 % je Push** sind die einzige echte Veränderung: das Spielerobjekt hat
seit damals ein paar Felder mehr. 73 KB statt 72 KB je Push je Konsole.

> Die Zahlen der letzten Runde stammen aus einer Laufform, die dort nicht
> festgehalten ist („Mittelwert über drei Matches", aber der Gegenprobe-Befehl
> nennt einen einzelnen Lauf). Direkt vergleichbar sind deshalb nur die Größen,
> die nicht von der Zahl der Matches abhängen: **CPU-Prozent** und **Bytes je
> Push**. Der Befehl dieser Runde steht oben, damit die nächste Messung nicht
> wieder raten muss.

### Die neuen Kostenstellen, einzeln gemessen

Alles gegen denselben Zustand: 50 Spieler, 2 Teams, 2000 Ereignisse im Match.

| Was | Kosten | Bedeutung |
|---|---|---|
| `buildDisplay()` mit Spielern | **590 µs** je Aufruf | einmal je Takt, wenn ein Anzeige-Verbraucher hängt |
| `buildDisplay()` ohne Spieler (`players=none`) | **53 µs** | ein reines Scoreboard kostet fast nichts |
| `JSON.stringify(state)` zum Vergleich | 598 µs | die Anzeige-API ist **nicht teurer** als der Zustands-Push |
| Roh-Tap: `onData()` **ohne** Zuschauer | **0,1 µs** je TCP-Paket | eine Null-Prüfung, sonst nichts |
| Roh-Tap: `onData()` **mit** offener Rohdatenansicht | 14,3 µs je TCP-Paket (40 Zeilen) | nur solange jemand hinsieht |
| `noteLine()` des Missionsberichts, Typ-4-Zeile | **0,0 µs** | ein Zeichenvergleich, läuft für jede Zeile |
| `noteLine()` des Missionsberichts, Typ-3-Zeile | 0,5 µs | nur beim Login eines Spielers |

Und die Größen auf der Leitung:

| Rahmen | Bytes |
|---|---|
| `state` (der vollständige Zustand) | 74 078 |
| `display` mit Spielern | **31 908** |
| `display` ohne Spieler | **2 471** |

**Das ist der praktische Befund für den Standortserver:** eine Anzeige, die
`feed=display` abonniert, zieht **57 % weniger Bytes** als eine, die `state`
nimmt — ohne Spielerliste sogar 97 % weniger. Wer viele Anzeigen hängen hat,
spart hier, nicht an der Taktrate.

### Der Matchabschluss, aufgeschlüsselt

Der eine Ausreißer in der Event-Loop-Verzögerung liegt beim Abschluss eines
Matches. Direkt gemessen (50 Spieler, 7 200 Ereignisse, alle drei Verbraucher
nacheinander, synchron):

| | |
|---|---|
| Statistik-CSV (`statsWriter.onMatchEnd`) | **76–110 ms** |
| Ereignis-Logdatei | 4 ms |
| Missionsbericht (bauen + in die Warteschlange legen) | **4–6 ms** |
| zusammen | **84–119 ms** |

Der Rest bis zu den gemessenen 130–230 ms ist die Speicherbereinigung nach der
Heap-Spitze des Abschlusses. Die Statistik-CSV ist damit unverändert die einzige
nennenswerte Position — und die ist weiter unten unter
[Was bewusst NICHT verändert wurde](#was-bewusst-nicht-verändert-wurde)
begründet stehen gelassen worden.

---

## Vorher / nachher

*Die Messrunde, die die Schreib-Bündelung gebracht hat. Sie steht hier
unverändert; die aktuellen Zahlen sind die
[Nachmessung](#nachmessung-nach-mqtt-missionsbericht-anzeige-api-und-rohdatenansicht)
weiter oben.*

„% eines Kerns" heißt: so viel **eines einzelnen** Prozessorkerns belegt der
Dienst, während ein Match läuft. Zwischen den Matches geht der Wert gegen null.

| | CPU (% eines Kerns) | Schreibaufrufe | geschriebene Bytes | Bytes je Zustands-Push |
|---|---|---|---|---|
| **4 Konsolen offen** | | | | |
| vorher | 9,86 % | 29 558 | 6,0 MB | 72 403 |
| nachher | **6,00 %** | **3 820** | 6,0 MB | 72 354 |
| | −39 % | −87 % | unverändert | unverändert |
| **keine Konsole offen** (Normalfall) | | | | |
| vorher | 7,32 % | 29 538 | 6,0 MB | — |
| nachher | **4,43 %** | **3 354** | 6,0 MB | — |
| | −39 % | −89 % | unverändert | unverändert |

**Geschriebene Bytes und Bytes je Push sind unverändert** — das ist der Beleg,
dass sich nur die Last geändert hat, nicht das Verhalten. Die Ereignis-Logdatei
enthält dieselben Zeilen in derselben Reihenfolge; nur die Zahl der
Schreibaufrufe sank.

**Wem die 39 % gehören, ehrlich aufgeteilt:** praktisch alles der
Schreib-Bündelung (Änderung 1). Änderung 2 wurde separat gemessen und bringt
**0,18 % eines Kerns** — real, aber unter der Streuung des Gesamtlaufs. Sie
bleibt trotzdem drin: sie kostet drei Zeilen, macht die Bedingung des Takts
lesbarer und skaliert mit Spielerzahl und Taktrate (bei 100 Spielern oder
`LF_STATE_TICK_MS=50` wäre sie das Vierfache).

### Was geändert wurde

**1. Die Ereignis-Logdatei bündelt Schreibvorgänge** (`src/eventLog.js`)

Vorher kostete **jedes einzelne Ereignis** einen eigenen `appendFile`-Aufruf —
bei 50 Spielern rund 29 500 Aufrufe je drei Matches und damit 99,9 % aller
Schreibaufrufe des Dienstes. Jetzt teilen sich alle Zeilen, die innerhalb von
`eventLog.flushMs` anfallen, **einen** Aufruf.

- Vorgabewert **250 ms**, einstellbar über `LF_EVENTLOG_FLUSH_MS` (0–5000).
- `0` stellt das alte Verhalten wieder her (jede Zeile einzeln).
- Inhalt und Reihenfolge der Datei sind in beiden Fällen identisch.
- Preis: bei einem **harten Stromausfall** können bis zu 250 ms Logzeilen
  fehlen. Bei geordnetem Beenden nicht — `flush()` hängt an `process.exit`
  und an `shutdown()` und schreibt synchron.
- Bei `rotate: 'match'` wird zusätzlich beim Matchwechsel synchron geleert,
  damit Restzeilen des alten Matches nicht in die neue Datei rutschen.

**2. Nichts wird serialisiert, wenn es niemand bekommt**
(`src/index.js`, `src/apiServer.js`, `src/streamServer.js`, `src/outputs.js`)

Der gemeinsame Zustands-Takt (alle 200 ms) baute bisher einen vollständigen
Snapshot und ein `JSON.stringify` des **kompletten** Matchzustands — **auch wenn
keine Konsole offen war, der Rohstrom aus war und kein Ausgang Zustände wollte**.
Das ist auf einem Hallen-PC der Normalfall. Jeder Verbraucher hat jetzt ein
`wantsState`, das der Takt **vor** dem Serialisieren fragt. Dasselbe für
Ereignisse: `broadcastEvent()` serialisiert nur noch, wenn es einen Empfänger
gibt. Der Rohstrom-Server ist standardmäßig aus und hat bis dahin jedes einzelne
Ereignis für niemanden in JSON verwandelt.

Beide Änderungen sind reine Weglass-Änderungen: jeder `pushState()` prüfte seine
Bedingung ohnehin schon und tat dann nichts. Ein Verbraucher sieht exakt dasselbe
wie vorher.

> **Nebenbefund von damals, inzwischen erledigt:** `engine._dirty` wurde
> gesetzt, aber **nirgends gelesen** — die Verdrahtung läuft über die
> `stateDirty`-Kennzeichen der drei Verbraucher. Das Feld war wirkungslos und
> ist beim Aufräumen entfernt worden. Kein Messwert ändert sich dadurch; es ist
> schlicht eine Zeile weniger, über die jemand nachdenken muss.

---

## Was tatsächlich Last erzeugt

Ermittelt durch Abschalten einzelner Pfade (`--no-eventlog`, `--consoles 0`),
je drei Matches, 50 Spieler:

| Pfad | Anteil vorher | Befund |
|---|---|---|
| Ereignis-Logdatei | ~39 % der CPU, 99,9 % aller Schreibaufrufe | **der Engpass** — behoben |
| Zustands-Push an 4 Konsolen | 2,5 Prozentpunkte | ~72 KB je Push, 5×/s je Konsole — unverändert, das ist die API |
| Zustands-Serialisierung ohne Empfänger | 0,18 % eines Kerns | kleine, aber vollständig vermeidbare Verschwendung — behoben |
| Ereignis-Serialisierung ohne Empfänger | < 0,01 % | behoben, weil es im selben Handgriff lag |
| TDF-Parser + Engine | der Rest | unauffällig, **nicht angefasst** |

### Woraus die 72 KB je Zustands-Push bestehen

| Teil | Bytes | Anteil |
|---|---|---|
| `players` (50 Spieler × 66 Felder) | 58 404 | 80 % |
| `events` (Ring der letzten 50) | 13 760 | 19 % |
| `teams`, `scores`, Rest | 594 | 1 % |

Bei 5 Pushs/s und 4 Konsolen sind das **1,4 MB/s** über das Hallennetz. Das ist
kein Fehler, sondern die Folge davon, dass ein Spielerobjekt 66 Felder hat und
der Takt 200 ms beträgt. Wer das senken will, dreht an `LF_STATE_TICK_MS` —
ohne Konsole kostet es seit der Änderung ohnehin nichts mehr.

---

## Dauerlauf: wächst etwas?

### `_match.events` — die Ereignisliste eines Matches

Gemessen an einem vollen Match: **50 Spieler, 15 Minuten, 30 Ereignisse/s**.

| | |
|---|---|
| Einträge | 27 050 |
| Heap dafür | **9,4 MB** (363 B je Eintrag) |
| als JSON | 8,7 MB |
| Abschluss (`0101`) | 165 ms synchron |
| Heap-Spitze beim Abschluss | +45,5 MB kurzzeitig (Zeilenobjekte + die eine große CSV-Zeichenkette) |
| nach der GC | vollständig freigegeben |
| Ereignis-CSV | 4,0 MB je Match → 0,19 GB/Tag bei 50 Matches |

**Kein Leck.** Die Liste wächst mit der Matchdauer (rund **630 KB je Minute** bei
50 Spielern) und wird beim Abschluss vollständig freigegeben.

> **Es wurde KEINE Obergrenze eingeführt — nirgends.** 9,4 MB je Match sind auf
> einem Server nichts, die Liste ist durch die Matchdauer begrenzt, und sie soll
> künftig die Grundlage des Missions-Pakets an den Location Server werden. Eine
> Grenze hätte nichts gerettet und hätte Daten gekostet. Wer das Paket baut,
> rechnet mit **rund 8,7 MB JSON je 15-Minuten-Match bei 50 Spielern**, davon
> rund 60 % Fehlschuss-Ereignisse (`0201`) — die einzige Position, die sich
> ohne Informationsverlust kürzen ließe, weil sie als Zähler ohnehin im
> Spielerobjekt der Engine steht.

### Der eine Weg, auf dem es doch unbegrenzt wächst

Ein Match endet über `0101`, über den Watchdog (120 s Stille), über
Verbindungsverlust oder über das nächste `0100`. Eine Anlage, die **dauerhaft
sendet, aber nie ein `0101` schickt**, läuft an allen vier Wegen vorbei. Dann
wächst `_match.events` mit 630 KB/min = **38 MB/Stunde = 900 MB/Tag**.

Das ist nicht gemessen worden, weil es sich nicht auslösen ließ — es ist ein
rechnerischer Restrisiko-Hinweis, kein Befund. Wer es absichern will, begrenzt
nach der Regel „nur Rekonstruierbares kappen": Fehlschüsse (`0201`) machen rund
60 % der Liste aus und stehen als Zähler ohnehin im Spielerobjekt.

### 60 Matches hintereinander

```
node scripts/bench.js --players 50 --consoles 2 --duration 900 --rate 12 --speed 45 --matches 60
```

60 Matches, **1 197 506 TDF-Zeilen**, Heap jeweils **nach** abgeschlossenem Match
und **nach erzwungener GC** (`node --expose-gc`):

| Match | 1 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Heap MB | 8,6 | 8,1 | 8,6 | 9,2 | 9,7 | 10,2 | 10,6 | 11,1 | 11,5 | 12,1 | 12,5 | 13,0 | **13,4** |
| Handles | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | **8** |

**Handles bleiben konstant bei 8** über alle 60 Matches, und es sind exakt die
erwarteten: `{UDPWrap:1, TCPServerWrap:2, TCPSocketWrap:4, PipeWrap:1}` — der
UDP-Ausgangssocket, die beiden Server (HTTP, TDF), die vier offenen Sockets und
die Elternverbindung. **Kein Handle-Leck.**

Der Heap steigt um **95 KB je Match**. Das ist **kein Leck, sondern die
Gesamtwertung** — dieser Lauf lässt in jedem Match 50 **fremde** Spieler
antreten, also 3000 verschiedene Personen, und `_totals` + `_playerModes` halten
jede davon dauerhaft. Rund **1,6 KB je jemals gesehenem Spieler**.

Hochgerechnet: 30 000 Spieler (ein bis zwei Jahre Vollbetrieb) ≈ **48 MB**
Arbeitsspeicher. Unkritisch — die Kosten dieser Historie liegen in der
**Rechenzeit** beim Matchabschluss, nicht im Speicher (siehe unten).

### Derselbe Lauf mit Stammkundschaft — der Normalfall

```
node scripts/bench.js --players 50 --consoles 2 --duration 900 --rate 12 --speed 45 --matches 60 --roster 300
```

Gleiche 60 Matches, gleiche 1 197 506 Zeilen, aber die Spieler kommen aus einem
festen Bestand von 300 Mitgliedern — so, wie eine Halle wirklich betrieben wird:

| Match | 1 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Heap MB | 8,6 | 8,1 | 8,3 | 8,4 | 8,4 | 8,4 | 8,4 | 8,4 | 8,4 | 8,5 | 8,5 | 8,5 | **8,5** |
| Handles | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | **8** |

| | |
|---|---|
| Heap Anfang → Ende | 8,61 MB → **8,46 MB** |
| Trend | **+3,3 KB je Match** (Rauschen) |
| Handles | 8 → 8, unverändert |
| RSS | 119 MB → 123 MB |
| CPU je Match | 4,57 s |
| längste Verzögerung | 194 ms (Leerlauf 16 ms) |

**Die Kurve ist flach.** Nach rund sechs Matches haben alle 300 Mitglieder
gespielt, die Gesamtwertung ist vollständig, und ab da wächst nichts mehr. Der
Heap am Ende liegt sogar knapp **unter** dem Wert nach dem ersten Match.

Damit ist belegt: **es gibt kein Leck.** Was im Lauf davor wuchs, war
ausschließlich die Gesamtwertung über neue Spieler — gewollt, gebraucht und
1,6 KB je Person.

---

## Was bewusst NICHT verändert wurde

**1. Die Gesamtwertung wird bei jedem Matchende komplett neu geschrieben.**

`_writeTotals()` und `_writePlayerModes()` in `src/statsWriter.js` schreiben
`totals_<family>.csv` und `player_modes.csv` bei **jedem** Matchabschluss
vollständig neu — sortiert, synchron, im Event-Loop. Die Kosten wachsen linear
mit der Zahl **aller jemals gesehenen Spieler**:

| Historie (Spieler) | `totals_*.csv` | `player_modes.csv` | ein Matchabschluss |
|---|---|---|---|
| 0 | 0,03 MB | 0,03 MB | 23 ms |
| 2 000 | 0,29 MB | 0,24 MB | 88 ms |
| 10 000 | 1,30 MB | 1,06 MB | 367 ms |
| 30 000 | 3,84 MB | 3,12 MB | **1 045 ms** |

Die Zeit geht fast vollständig in **Formatieren und Sortieren**, nicht in die
Platte (mit abgeschalteten Schreibaufrufen bleibt sie gleich).

**Nicht geändert, weil jede Beschleunigung die Dateien verändern würde.** Die
Sortierung ist Teil des Ergebnisses, und die Dateien wertet der Betreiber aus.
Ein Zahlen-Schnellweg in `csvCell()` wurde gemessen: er spart rund 20 % des
Zellenbaus, aber nur ~5 % des Abschlusses — zu wenig, um den Code dafür
schlechter lesbar zu machen.

**Das ist die Stelle, die auf einem Location Server über Monate zum Problem
wird.** Handlungsempfehlung an den Betrieb, nicht an den Code: die Historie
jährlich archivieren. Ab rund **10 000 Spielern** blockiert jedes Matchende den
Dienst spürbar (> 350 ms), ab rund 30 000 über eine Sekunde.

**2. Der Startvorgang liest die Historie ein.**

`_loadTotals()` liest beim Start `totals_<family>.csv` (eine Zeile je Spieler) —
das ist klein. Die große, append-only `all_players_<family>.csv` wird **nur**
gelesen, wenn die Totals-Datei fehlt. Im Normalbetrieb passiert das nie. Fehlt
sie doch, wird eine Datei gelesen, die um rund **300 KB je Match** wächst — nach
einem Jahr Vollbetrieb also einige Hundert MB am Stück. Auch hier ist die
Antwort Archivierung, keine Codeänderung.

**3. `csvCell()`, `stats.onChange()`, der TDF-Parser.**
Alle drei standen im Verdacht, keiner ließ sich als relevant messen. Unberührt.

**4. Die Größe des Zustands-Pushs.**
72 KB je Push sind viel, aber jedes Feld ist Teil der API. Kürzen hieße
Verhalten ändern.

---

## Die Grenze

Bei 50 Spielern, 30 Ereignissen/s und 4 offenen Konsolen belegt der Dienst
**6,4–7,0 % eines Kerns** während eines Matches; **ohne offene Konsole 3,8 %**.
Hochgerechnet wäre **ein** Kern erst bei rund **430 Ereignissen/s** voll — das
entspricht grob **700 Spielern** bei gleicher Spielweise. Der Dienst benutzt
immer nur einen Kern; die übrigen bleiben für die anderen Dienste des Servers
frei.

Die praktische Grenze ist deshalb **nicht** die Spielerzahl, sondern die
**Größe der Statistik-Historie** (siehe oben) und die Zahl gleichzeitig offener
Konsolen (73 KB × 5/s je Konsole). Eine Anzeige, die statt des vollen Zustands
den **Anzeige-Datensatz** abonniert (`feed=display`, notfalls `players=none`),
kostet 32 KB bzw. 2,5 KB statt 74 KB — das ist der wirksamste Hebel, wenn viele
Anzeigen hängen.

Gegenprobe auf dem Zielserver vor der Inbetriebnahme:

```
node scripts/bench.js --players 50 --consoles 4 --duration 240
node scripts/bench.js --players 50 --matches 60 --duration 900 --rate 12 --speed 45 --roster 300
```

Die erste Zeile beantwortet „hält er die Last aus", die zweite „wächst über Tage
etwas". `--roster 300` bildet eine Stammkundschaft ab; ohne die Option treten in
jedem Match fremde Spieler an, was die Gesamtwertung absichtlich auf den
schlimmsten Fall treibt.
