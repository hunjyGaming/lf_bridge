# Roh-Mitschnitt — den Laserforce-Stream aufzeichnen und zurückspielen

Ein **Diagnosewerkzeug für eine Testphase**, kein Dauerbetrieb. Es schneidet den
TCP-Datenstrom der Anlage **byteweise unverändert** mit, eine Datei je Spiel.
Damit lässt sich ein Spiel andernorts exakt nachstellen — genau dafür ist es da.

- [Datenschutz zuerst](#datenschutz-zuerst)
- [Einschalten](#einschalten)
- [Was entsteht](#was-entsteht)
- [Der Begleitzettel](#der-begleitzettel)
- [Grenzen — damit die Platte nicht vollläuft](#grenzen--damit-die-platte-nicht-vollläuft)
- [Dateien aus der Konsole holen](#dateien-aus-der-konsole-holen)
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

## Einschalten

**Standardmäßig aus.** Zwei Wege, beide ohne Neustart wirksam (der `.env`-Weg
erst beim nächsten Start, dafür in der Konsole schreibgeschützt):

| Weg | wo |
|---|---|
| Web-Konsole | *Einstellungen → Roh-Mitschnitt (Diagnose)* — Haken setzen, unten „Änderungen speichern" |
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

*Einstellungen → Roh-Mitschnitt (Diagnose) → Mitschnitte*: Liste mit Name,
Größe, Zeitpunkt und Modus.

- **Herunterladen** je Datei.
- **Alle als ZIP** — in Node eingebaut (`zlib`), keine zusätzliche Abhängigkeit.
  Ab 64 MB Gesamtumfang wird das Paket abgelehnt (es entsteht im Speicher);
  dann einzeln herunterladen.
- **Löschen** einzeln oder alles, jeweils mit Rückfrage. Beim Löschen einer
  `.tdf` geht der zugehörige Begleitzettel mit.

Anmeldung, Token, CORS und Rate-Limit gelten unverändert wie für die
CSV-Endpunkte; das Löschen ist ein schreibender Vorgang mit derselben
CSRF-Absicherung wie jede andere Änderung und wird im Audit-Log vermerkt.

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
| `GET` | `/api/capture/bundle` | alles als ZIP |
| `POST` | `/api/capture/delete` | `{"name":"…"}` oder `{"all":true}` |

`GET /api/status` führt den Mitschnitt zusätzlich unter `capture` mit
(`enabled`, `recording`, `file`, `bytes`, `lines`, `disabledByError`).
