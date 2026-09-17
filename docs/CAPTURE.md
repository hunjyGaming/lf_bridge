# Roh-Mitschnitt — den Laserforce-Stream aufzeichnen und zurückspielen

Ein **Diagnosewerkzeug für eine Testphase**, kein Dauerbetrieb. Es schneidet den
TCP-Datenstrom der Anlage **byteweise unverändert** mit, eine Datei je Spiel.
Damit lässt sich ein Spiel andernorts exakt nachstellen — genau dafür ist es da.

- [Datenschutz zuerst](#datenschutz-zuerst)
- [Wo das in der Konsole steht](#wo-das-in-der-konsole-steht)
- [Einschalten](#einschalten)
- [Was entsteht](#was-entsteht)
- [Der Begleitzettel](#der-begleitzettel)
- [Grenzen — damit die Platte nicht vollläuft](#grenzen--damit-die-platte-nicht-vollläuft)
- [Dateien aus der Konsole holen](#dateien-aus-der-konsole-holen)
- [Im Browser ansehen](#im-browser-ansehen)
- [Live-Rohdaten](#live-rohdaten)
- [Zurückspielen](#zurückspielen)
- [Wie eine Mission erkannt wird](#wie-eine-mission-erkannt-wird)
- [API](#api)

---

## Datenschutz zuerst

> **Ein Mitschnitt enthält Spielernamen und die weltweit eindeutigen
> Laserforce-Mitglieds-IDs (`#…`) der Spieler.** Wer die Datei bekommt, bekommt
> diese Daten. Nur an Personen weitergeben, denen sie anvertraut werden dürfen,
> und danach wieder löschen. Die Konsole weist beim Einschalten darauf hin, und
> jeder Begleitzettel wiederholt es.

`data/capture/` ist über `data/` in der `.gitignore` abgedeckt; zusätzlich ist
`*.tdf` dort ausgeschlossen. Ein Mitschnitt gehört in kein Repository.

---

## Wo das in der Konsole steht

Der Mitschnitt hat einen **eigenen Bereich** in der Konsole: oben in der
Reiterleiste, zwischen *Statistik* und *Einstellungen*, der Reiter **Rohdaten**.
Alles, was mit den Rohdaten zu tun hat, steht dort beieinander:

| | |
|---|---|
| **Schalter** | ein/aus, mit Rückmeldung an Ort und Stelle — er wirkt **sofort**, ohne „Änderungen speichern" |
| **Grenzen** | die drei Größenwerte, zusammengeklappt (sie gelten erst nach dem Speichern) |
| **Leseansicht** | eine aufgezeichnete Datei im Browser lesen, mit Suche und Zeilentyp-Filter |
| **Live-Rohdaten** | die eingehenden Zeilen, während sie ankommen |
| **Mitschnitte** | die Dateiliste: ansehen, herunterladen, löschen, alles als ZIP |

> Früher steckte das am Ende der Einstellungen. Es war da, nur nicht zu finden —
> deshalb der eigene Reiter.

---

## Einschalten

**Standardmäßig aus.** Zwei Wege, beide ohne Neustart wirksam (der `.env`-Weg
erst beim nächsten Start, dafür in der Konsole schreibgeschützt):

| Weg | wo |
|---|---|
| Web-Konsole | *Rohdaten* — den Schalter oben umlegen; er greift sofort |
| `.env` | `LF_CAPTURE_ENABLED=true` (siehe `.env.example`) |

```
capture: { enabled: false, dir: 'data/capture', maxFileMB: 20, maxFiles: 50, maxTotalMB: 500 }
```

| Schlüssel | Umgebungsvariable | Bedeutung |
|---|---|---|
| `enabled` | `LF_CAPTURE_ENABLED` | aus/an. Aus kostet der Pfad praktisch nichts |
| `dir` | `LF_CAPTURE_DIR` | Ordner, relativ zum Programmordner |
| `maxFileMB` | `LF_CAPTURE_MAX_FILE_MB` | Grenze je Datei (1–2000) |
| `maxFiles` | `LF_CAPTURE_MAX_FILES` | Höchstzahl Dateien (1–1000) |
| `maxTotalMB` | `LF_CAPTURE_MAX_TOTAL_MB` | Grenze für den ganzen Ordner (1–100000) |

Solange der Mitschnitt aus ist, entsteht **keine Datei und kein Verzeichnis**.

---

## Was entsteht

Je Mission zwei Dateien in `data/capture/`:

```
2026-09-16_143012_mode28_laserball-ranked_abc123.tdf     der rohe Stream
2026-09-16_143012_mode28_laserball-ranked_abc123.txt     der Begleitzettel
```

Der Name ist `<Datum>_<Uhrzeit>_mode<Nummer>_<Modusname>_<Kennung>`. Ist die
Modus-Nummer nicht zu ermitteln, steht dort `mode-unbekannt`. Alles, was vor der
ersten erkannten Mission hereinkommt, landet in `…_vorlauf_<Kennung>.tdf`.

**Der Inhalt ist byteweise das, was ankam** — Tabulatoren, `\r\n`, die
`;`-Schema-Kommentarzeilen. Nichts wird normalisiert, neu serialisiert oder
umgebrochen. Eine Prüfsumme über die Datei ist identisch mit der Prüfsumme über
die gesendeten Bytes.

> **Warum der Dateiname erst spät feststeht.** Er trägt den Modus, und der steht
> erst mit der Typ-1-Zeile fest. Statt die Datei früh anzulegen und später
> umzubenennen — ein Umbenennen mit offenem Schreib-Handle ist genau das, was auf
> einem Windows-Hallen-PC schiefgeht —, werden die ersten Bytes einer Mission im
> Speicher gehalten, bis der Modus bekannt ist: an der Typ-1-Zeile, spätestens
> an `0100`, in jedem Fall nach 64 KiB. Der Kopf eines TDF ist eine Handvoll
> Zeilen; das Fenster ist winzig und begrenzt.

---

## Der Begleitzettel

Die `.txt` neben jeder `.tdf` — damit der Betreiber weiß, welche Datei welches
Spiel ist, und gezielt sagen kann, was wann passiert ist:

```
LF Live — Begleitzettel zum Roh-Mitschnitt
==============================================================

Datei            2026-09-16_143012_mode28_laserball-ranked_abc123.tdf
Beginn           16.09.2026, 14:30:12
Ende             16.09.2026, 14:45:31  (15:19 min Wanduhr)
Spielmodus       28 · Laserball Ranked (Familie laserball)
Teams            0 Rot · 1 Blau
Spieler          8
Spieldauer       900.0 s (letzte Zeitmarke im Stream)
Missionsstart    ja (0100 gesehen)
Ende des Matches regulär beendet (Mission End 0101)
Umfang           412.50 kB · 2318 Zeilen

Zeilen je Typ
  ;  Schema-Kommentar             6
  0  Kopf / Version               1
  …
Gesehene Typ-4-Codes
  0100   Mission Start                        1
  1100   Pass                                84
  …
```

„Ende des Matches" kennt fünf Fälle: regulär per `0101`, abgelöst vom Start des
nächsten Matches, Stream-Abbruch, Zeitgeber (fünf Minuten ohne Daten), oder in
der Konsole abgeschaltet bzw. Dienstende.

---

## Grenzen — damit die Platte nicht vollläuft

Der Hallen-PC läuft unbeaufsichtigt und ohne Monitor. Ein Mitschnitt, der die
Platte füllt, legt den Betrieb lahm. Deshalb, alle drei konfigurierbar:

| Grenze | Standard | was passiert |
|---|---|---|
| je Datei | 20 MB | der Mitschnitt **dieser** Mission endet; Log-Eintrag **und** ein `!! ABGESCHNITTEN`-Vermerk im Begleitzettel. Stream und Auswertung laufen unberührt weiter |
| Dateizahl | 50 | die ältesten werden automatisch gelöscht |
| Ordner | 500 MB | die ältesten werden automatisch gelöscht |

Aufgeräumt wird jeweils am Ende einer Mission; die gerade laufende Aufzeichnung
wird nie gelöscht.

**Schreibfehler stören nie den Stream.** Der Mitschnitt ist nachrangig: jeder
Fehler (Platte voll, keine Rechte) wird abgefangen und protokolliert, nach fünf
Fehlern in Folge schaltet er sich selbst ab und sagt das im Log. Zum
Wiedereinschalten in der Konsole aus- und wieder anschalten.

Geschrieben wird **gepuffert** — die Bytes sammeln sich und gehen in Blöcken
(64 KiB, spätestens einmal je Sekunde) auf die Platte. Der TCP-Pfad selbst legt
nur einen Puffer in ein Array.

---

## Dateien aus der Konsole holen

*Rohdaten → Mitschnitte*: Liste mit Name, Größe, Zeitpunkt und Modus, neueste
zuerst.

- **Ansehen** öffnet die Rohzeilen im Browser — siehe unten.
- **Herunterladen** je Datei.
- **Alle als ZIP** — in Node eingebaut (`zlib`), keine zusätzliche Abhängigkeit.
  Ab 64 MB Gesamtumfang wird das Paket abgelehnt (es entsteht im Speicher);
  dann einzeln herunterladen.
- **Löschen** einzeln mit Rückfrage. Beim Löschen einer `.tdf` geht der
  zugehörige Begleitzettel mit.
- **Alle löschen** verlangt zusätzlich das **Admin-Passwort**, erneut getippt —
  das ist der eine Knopf, der alles auf einmal wegnimmt. Geprüft wird
  serverseitig gegen denselben Hash wie die Anmeldung, hinter derselben
  Fehlversuchs-Bremse ([SECURITY.md](SECURITY.md)). Eine gerade laufende
  Aufzeichnung bleibt stehen.

Anmeldung, Token, CORS und Rate-Limit gelten unverändert wie für die
CSV-Endpunkte; das Löschen ist ein schreibender Vorgang mit derselben
CSRF-Absicherung wie jede andere Änderung und wird im Audit-Log vermerkt.

---

## Im Browser ansehen

*Rohdaten → Mitschnitte → **Ansehen***. Die Datei wird geholt und gelesen — sie
landet **nicht** im Download-Ordner.

- **Zeilennummern** links, fest stehend beim seitlichen Rollen.
- **Tabulatoren sichtbar** als `→`. An ihnen hängt die ganze Spaltenlogik des
  TDF-Formats ([LASERFORCE.md](LASERFORCE.md)); wer sie nicht sieht, kann eine
  Zeile nicht lesen. Abschaltbar über *Tabulatoren zeigen*.
- **Suche** über den ganzen Dateiinhalt — Text, ein Ereigniscode wie `0100`, ein
  Spielername. Klein-/Großschreibung egal.
- **Zeilentyp-Filter**: die Typen, die in *dieser* Datei wirklich vorkommen, je
  mit Anzahl (`Typ 4 · 8.601`), plus `;` für die Schema-Kommentare.
- **Herunterladen** und **Schließen** oben rechts.

> **Warum das auch bei 60 000 Zeilen flüssig bleibt.** Im DOM hängt immer nur
> der sichtbare Ausschnitt — rund sechzig Zeilen. Ein Abstandhalter gibt dem
> Bildlauf die volle Höhe (Zeilen × 18 px), der gezeichnete Block wird darin
> verschoben, und beim Rollen wird höchstens einmal je Bild neu gezeichnet.
> Gemessen an einer 60 012-Zeilen-Datei (1.8 MB): Neuzeichnen 21 ms, eine Suche
> über die ganze Datei 67 ms — und die Suche ist zusätzlich um 150 ms verzögert,
> damit Tippen nie ins Stocken gerät.

Ab 24 MB fragt die Konsole vorher nach, denn zum Lesen wird die Datei ganz in
den Browser geladen.

---

## Live-Rohdaten

*Rohdaten → Live-Rohdaten*: was die Anlage **gerade** schickt, wie ein
mitlaufendes Terminal — unabhängig davon, ob mitgeschnitten wird. Damit sieht
man beim Testen sofort, was ankommt, statt auf das Missionsende zu warten.

- **Anhalten / Fortsetzen.** Angehalten wird auch nichts mehr empfangen.
- **Leeren** setzt Ansicht und Zähler zurück.
- Im Speicher bleiben die **letzten 2000 Zeilen**; ältere fallen unten heraus.
- Gezeigt werden Zeilennummer, Tabulatoren als `→`, Schema-Kommentare kursiv.

**Was das den Dienst kostet — und wann gar nichts.** Die Zeilen gehen
**gebündelt** über den vorhandenen WebSocket: eine Nachricht je 250 ms, oder
sofort, sobald 400 Zeilen zusammengekommen sind. Einzelne Nachrichten je Zeile
wären bei über fünfzig Spielern messbar teurer als die Arbeit selbst. Die
Konsole sagt dem Dienst ausdrücklich Bescheid, ob sie hinschaut
(`{"type":"rawtap","on":…}`); ist der Bereich **zu**, die Ansicht angehalten
oder das Fenster im Hintergrund, wird **überhaupt nichts** erzeugt, gepuffert
oder gesendet — der Mitschnitt zerlegt dann nicht einmal Zeilen dafür.

Kommt mehr an, als abfließen kann, wirft der Dienst ab 4000 wartenden Zeilen
weg und sagt der Konsole wie viele; sie schreibt es neben den Zähler
(`… · 1.204 übersprungen`). Gezeichnet wird höchstens einmal je Bild und nie,
solange das Fenster im Hintergrund ist — dieselbe Regel wie für den Live-Bereich
([PERFORMANCE.md](PERFORMANCE.md)).

---

## Zurückspielen

```bash
node scripts/replay.js <datei.tdf> [--host 127.0.0.1] [--port 9000] [--speed 8] [--realtime]
```

Sendet die Datei **byteweise identisch** an eine laufende Bridge —
Tabulatoren und Schema-Zeilen inklusive.

| Option | Bedeutung |
|---|---|
| `--host` / `--port` | Ziel; Standard `127.0.0.1:9000` (der Laserforce-Port der Bridge) |
| (nichts) | so schnell wie möglich — Standard |
| `--realtime` | nutzt die `time`-Spalte für echte Abstände |
| `--speed N` | teilt diese Abstände durch N (nur mit `--realtime` sinnvoll) |
| `--quiet` | kein Fortschritt auf der Konsole |

Zum Nachstellen am besten eine **frische** Bridge starten (eigener Arbeitsordner,
eigene Ports) — dann steht am Ende derselbe Zustand da wie in der Halle: Modus,
Spieler, Punkte.

---

## Wie eine Mission erkannt wird

Die Typ-0-, Typ-1- und Typ-2-Zeilen (Kopf, Missionstyp, Teams) kommen **vor**
dem Missionsstart `0100` ([LASERFORCE.md](LASERFORCE.md#zeilentypen-09)). Eine
Datei, die erst bei `0100` beginnt, wäre wertlos — der Spielmodus stünde nicht
drin. Deshalb:

1. Eine **Typ-0- oder Typ-1-Zeile** beginnt eine neue Mission. Eine *zweite*
   Typ-0- bzw. Typ-1-Zeile beginnt immer eine neue; das Paar `0`+`1` eines
   Kopfes bleibt zusammen.
2. Kommt keine davon, beginnt hilfsweise **`0100`** eine Mission.
3. Alles davor gehört in die `vorlauf`-Datei.

Nach `0101` bleibt die Datei noch fünf Sekunden offen, damit eine
nachklappernde Zeile noch hineinfällt; danach wird sie geschlossen und der
Begleitzettel geschrieben.

---

## API

| Methode | Pfad | |
|---|---|---|
| `GET` | `/api/capture/files` | Liste (`name`, `size`, `mtime`, `kind`, `mode`) + `status` |
| `GET` | `/api/capture/file?name=…` | eine Datei herunterladen |
| `GET` | `/api/capture/file?name=…&inline=1` | dieselben Bytes **ohne** `Content-Disposition` — das holt die Leseansicht |
| `GET` | `/api/capture/bundle` | alles als ZIP |
| `POST` | `/api/capture/delete` | `{"name":"…"}`, oder `{"all":true,"password":"…"}` |

`GET /api/status` führt den Mitschnitt zusätzlich unter `capture` mit
(`enabled`, `recording`, `file`, `bytes`, `lines`, `disabledByError`).

Über den WebSocket `/ws` (docs/API.md): die Konsole meldet mit
`{"type":"rawtap","on":true}` an bzw. mit `false` ab, und bekommt daraufhin
`{"type":"raw","lines":[…],"dropped":n,"ts":…}` — ein Rahmen je Bündel, nicht je
Zeile. Ohne Anmeldung sendet der Dienst nichts.
