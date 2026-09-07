# Statistiken (CSV)

Nach jedem Match schreibt lf_live die Spielerstatistiken in CSV-Dateien **auf
diesen PC**. Nichts verlässt den Rechner. Ein-/Ausschalten und Einstellungen im
Konsolen-Tab **Statistik**.

Ordner (Standard): `data/stats/` neben dem Programm. Änderbar per `.env`
(`LF_CSV_DIR`) oder in `config.json`.

---

## Die Dateien

```
data/stats/
  all_players.csv                          ← DIE Datei für Auswertungen
  totals.csv                               ← Gesamtwertung pro Spieler
  matches/
    2026-09-06_192541_<matchId>_players.csv   ← ein Match, eine Zeile je Spieler
    2026-09-06_192541_<matchId>_events.csv    ← jedes Ereignis dieses Matches
```

| Datei | Wann geschrieben | Zweck |
|---|---|---|
| `matches/…_players.csv` | am Matchende | eine Datei pro Match, gut zum schnellen Draufschauen |
| `matches/…_events.csv` | am Matchende (wenn „Event-Log" an) | die komplette Zeitleiste eines Matches |
| `all_players.csv` | **angehängt** am Matchende | jede Spieler-Zeile aus **jedem** Match — hier lädst du alles in Excel / pandas |
| `totals.csv` | neu geschrieben am Matchende | Summe pro Spieler über alle Matches |

Ein Match wird am Laserforce-„Mission Ende" (`0101`) fertiggeschrieben. Startet
jemand ein neues Match ohne Ende, wird das vorherige trotzdem aus dem letzten
Stand fertiggeschrieben — es geht nichts verloren.

---

## Spalten: `players` / `all_players.csv`

| Spalte | Bedeutung |
|---|---|
| `match_id` | interne Match-ID (auch im Dateinamen) |
| `date` | Datum des Matchstarts (`YYYY-MM-DD`) |
| `player_id` | Laserforce-ID des Spielers |
| `name` | Name (aus dem Stream, oder aus deiner Namensliste) |
| `team_id` | Team-Nummer aus Laserforce |
| `team` | Teamname |
| `team_score` / `opp_score` | Endstand des eigenen Teams / bestes Gegnerteam |
| `result` | `win` / `loss` / `draw` |
| `goals`, `assists` | Tore, Vorlagen |
| `steals_done` / `steals_received` | Steals gemacht / kassiert |
| `blocks_done` / `blocks_received` | Blocks gemacht / kassiert |
| `resets_done` / `resets_received` | Resets gemacht / kassiert |
| `clears_done` / `clears_received` | Clears gemacht / kassiert |
| `passes_done` / `passes_received` | Pässe gespielt / empfangen |
| `duration_s` | Spieldauer in Sekunden |

## Spalten: `totals.csv`

`player_id`, `name`, `matches`, `wins`, `losses`, `draws`, dann die Summen von
`goals` … `passes_received`, plus `goals_per_match` (Ø). Sortiert nach Toren.

## Spalten: `events.csv`

`match_id`, `seq`, `elapsed_s`, `wall_time`, `type`, `code`, `actor_id`, `actor`,
`actor_team`, `target_id`, `target`, `target_team`, `assist`, `detail`.
`type` ist z. B. `goal`, `pass`, `block`, `steal`, `match_start` — siehe
[API.md](API.md#event-objekt).

---

## In Excel öffnen

- **Trennzeichen**: Standard ist `;` (deutsches Excel). Doppelklick auf die Datei
  öffnet sie direkt richtig. Für `pandas` / andere Tools in der Konsole auf `,`
  stellen (`pd.read_csv(..., sep=';')` geht natürlich auch).
- **Umlaute**: die Dateien haben ein BOM, damit Excel `ä ö ü` korrekt anzeigt.
- **Neue Zeilen** kommen ans `all_players.csv` unten dran — die Datei einfach
  offen lassen und neu laden, oder am Turnierende einmal öffnen.

## Auswertung mit pandas (Beispiel)

```python
import pandas as pd
df = pd.read_csv("data/stats/all_players.csv", sep=";")

# Torschützenliste über alle Matches
df.groupby(["player_id", "name"])["goals"].sum().sort_values(ascending=False)

# Steal-Differenz pro Spieler
df["steal_diff"] = df["steals_done"] - df["steals_received"]
df.groupby("name")["steal_diff"].sum()

# Siegquote
df.groupby("name")["result"].value_counts().unstack(fill_value=0)
```

---

## Einstellungen (Konsole → Statistik)

| Einstellung | |
|---|---|
| **Statistiken als CSV speichern** | An/Aus |
| **Trennzeichen** | `;` (Excel DE) · `,` · Tab |
| **Event-Log** | zusätzlich die `_events.csv` pro Match schreiben |
| **live mitschreiben** | die `_players.csv` des laufenden Matches alle ~1,5 s aktualisieren (statt nur am Ende) |

`.env`: `LF_CSV_ENABLED`, `LF_CSV_DIR`, `LF_CSV_DELIMITER`, `LF_CSV_BOM`, `LF_CSV_EVENTS`, `LF_CSV_LIVE`.

## API

- `GET /api/stats/totals` — Gesamtwertung als JSON
- `GET /api/stats/files` — Liste aller CSV-Dateien
- `GET /api/stats/file?name=<pfad>` — eine Datei herunterladen
