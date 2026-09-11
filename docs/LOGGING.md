# Event-Log-Datei

Neben den [CSV-Statistiken](STATS.md) schreibt lf_live eine **lesbare,
append-only Textdatei** mit einer Zeile pro Ereignis — zum Mitlesen während
des Matches (`tail -f`), schnellen `grep`, oder als Beleg hinterher. Sie ist
**nicht** zum maschinellen Parsen gedacht (dafür sind die CSV und die JSON-API);
sie ergänzt sie nur. Nichts verlässt den Rechner.

Standardmäßig **an**. Ordner: `data/logs/` neben dem Programm.

---

## Zeilenformat

```
2026-09-10 21:14:03  +07:12.900  [mtvqikv5]  score       Tor für Team Rot (3:2)
└ Wanduhr ────────┘  └ Spielzeit┘  └ Match ─┘  └ Kategorie┘  └ Klartext-Satz ────┘
```

| Spalte | Inhalt |
|---|---|
| Wanduhr | lokale Zeit `YYYY-MM-DD HH:MM:SS` |
| Spielzeit | `+MM:SS.mmm` seit Mission-Start (aus `evt.elapsedMs`) |
| Match | kurze `matchId` in eckigen Klammern |
| Kategorie | `match` · `score` · `possession` · `combat` · `player` · `special` · `other` — auf feste Breite aufgefüllt |
| Klartext | der deutsche Satz aus `eventCatalog.phrase(evt)`; fällt zurück auf `evt.text`, dann `evt.type`, dann `Event <code>` |

Spalten sind mit zwei Leerzeichen getrennt und stabil breit, damit `grep`/`awk`
funktionieren.

**Match-Kopf/-Fuß:** Bei jedem Match-Start steht eine Kopfzeile
(`──── Match <id> · <n> Spieler · <Zeit> ────`), bei Match-Ende eine Fußzeile
mit Endstand.

---

## Rotation (`LF_EVENTLOG_ROTATE` / `eventLog.rotate`)

| Wert | Datei | Wechsel |
|---|---|---|
| `daily` *(Standard)* | `data/logs/events-YYYY-MM-DD.log` | pro Kalendertag |
| `match` | `data/logs/events-<matchId>.log` | neue Datei bei jedem `match_start` |
| `none` | `data/logs/events.log` | nie (eine Datei) |

Der Dateiname-Präfix (`events`) ist über `eventLog.filenamePrefix` änderbar.

---

## Einstellungen

| `.env` | `config.json` | Standard | |
|---|---|---|---|
| `LF_EVENTLOG_ENABLED` | `eventLog.enabled` | `true` | Datei schreiben an/aus |
| `LF_EVENTLOG_DIR` | `eventLog.dir` | `data/logs` | Zielordner (relativ zum Programm) |
| `LF_EVENTLOG_ROTATE` | `eventLog.rotate` | `daily` | `daily` \| `match` \| `none` |
| — | `eventLog.filenamePrefix` | `events` | Dateiname-Präfix |

Änderungen an `eventLog.*` über die Konsole wirken **erst nach einem Neustart**
des Dienstes.

Der Ordner wird beim ersten Schreiben angelegt (Rechte `0700`, soweit das OS das
beachtet). Schreibfehler werden abgefangen und **einmalig** als `warn` ins
Konsolen-Log gemeldet — sie stören den Betrieb nie.

---

## Welche Ereignisse

Jedes Event, das die Engine ausgibt (siehe [API.md](API.md#event-objekt)),
landet als eine Zeile — inkl. der zusätzlich ausgegebenen, früher ignorierten
Codes (`round_start`, `score`, `reset`, `match_summary`, `lf_event`; siehe
[LASERFORCE.md](LASERFORCE.md#was-lf_live-daraus-macht)). Mit
`LF_EMIT_UNKNOWN_EVENTS=false` entfällt nur das generische `lf_event` für
komplett unbekannte Typ-4-Codes.

`GET /api/status` zeigt unter `eventLog` den aktuellen Zustand und Dateipfad.
`GET /api/logs/events` listet die geschriebenen Dateien,
`GET /api/logs/events/file?name=<name>` gibt eine davon als Text aus
(siehe [API.md](API.md)).
