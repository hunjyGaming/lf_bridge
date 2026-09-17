# Statistiken (CSV)

Nach jedem Match schreibt lf_live die Spielerstatistiken in CSV-Dateien **auf
diesen PC**. Nichts verlässt den Rechner. Ein-/Ausschalten und Einstellungen im
Konsolen-Tab **Statistik**.

Ordner (Standard): `data/stats/` neben dem Programm. Änderbar per `.env`
(`LF_CSV_DIR`) oder in `config.json`.

> Zusätzlich schreibt lf_live eine **lesbare Event-Log-Datei** nach `data/logs/`
> (eine Zeile je Ereignis, zum Mitlesen/Grep). Eigene Doku: [LOGGING.md](LOGGING.md).

- [Getrennt nach Familie — und warum](#getrennt-nach-familie--und-warum)
- [Anzeigeprofil: was in welcher Spalte steht](#anzeigeprofil-was-in-welcher-spalte-steht)
- [Die Dateien](#die-dateien)
- [Spalten: Spieler-Zeilen](#spalten-spieler-zeilen)
- [Leere Zellen sind Absicht](#leere-zellen-sind-absicht)
- [Zeilensortierung](#zeilensortierung)
- [`stats_source`, `score_source` und `accuracy_source`](#stats_source-score_source-und-accuracy_source)
- [Spalten: `totals_<familie>.csv`](#spalten-totals_familiecsv)
- [Spalten: `matches.csv`](#spalten-matchescsv)
- [`player_modes.csv` — wer hat wann welchen Modus gespielt](#player_modescsv--wer-hat-wann-welchen-modus-gespielt)
- [Spalten: `events.csv`](#spalten-eventscsv)
- [Umstieg von einer älteren Version](#umstieg-von-einer-älteren-version)
- [In Excel öffnen](#in-excel-öffnen)
- [Auswertung mit pandas (Beispiel)](#auswertung-mit-pandas-beispiel)
- [Einstellungen (Konsole → Statistik)](#einstellungen-konsole--statistik)
- [API](#api)

---

## Getrennt nach Familie — und warum

lf_live erkennt seit dieser Version den **Spielmodus** und ordnet ihn einer von
zwei **Familien** zu: `laserball` oder `sm5` (ausführlich:
[GAMEMODES.md](GAMEMODES.md)).

Eine Laserball-Zeile zählt Tore, Steals und Pässe. Eine SM5-Zeile zählt Schüsse,
Deaktivierungen und Raketen. **Die beiden Spaltensätze haben keine einzige
gemeinsame Zahl.** Eine gemeinsame Gesamtwertung wäre damit fachlich
bedeutungslos, sobald an einem Tag beide Modi laufen — sie würde Tore und
Schüsse in dieselbe Tabelle zwingen und die jeweils fremden Spalten mit Nullen
füllen.

Deshalb gilt: **jede Sammel- und Gesamtdatei existiert je Familie einmal.**

```
all_players_laserball.csv   all_players_sm5.csv
totals_laserball.csv        totals_sm5.csv
```

Die Dateien, die sich auf **ein** Match beziehen, brauchen das nicht — ein Match
hat genau einen Modus und damit genau eine Familie. Ihr Spaltensatz richtet sich
nach dem **Anzeigeprofil** dieses Matches (siehe
[nächster Abschnitt](#anzeigeprofil-was-in-welcher-spalte-steht)).

Modus-übergreifend sind nur die beiden neuen Index-Dateien `matches.csv` und
`player_modes.csv`: die enthalten bewusst **keine** Zählerspalten, sondern nur
Angaben, die in jedem Modus dasselbe bedeuten.

---

## Anzeigeprofil: was in welcher Spalte steht

Die **Familie** sagt, in welche Datei ein Match kommt. Welche **Spalten** darin
stehen, sagt seit dieser Version das **Anzeigeprofil** — `standard`, `sm5` oder
`laserball`. Warum das getrennt ist, steht in
[GAMEMODES.md](GAMEMODES.md#die-drei-anzeigeprofile); kurz: „Standard" und „SM5"
sind dasselbe Protokoll, sollen aber nicht dieselben Spalten zeigen.

Jede Spieler-Zeile trägt ihr Profil in der Spalte `profile` mit, jede Zeile in
`matches.csv` ebenfalls.

| Datei | Spalten nach |
|---|---|
| `matches/…_players.csv` | dem Profil **dieses** Matches |
| `all_players_<familie>.csv` | dem **Standardprofil der Familie** — siehe Kasten |
| `totals_<familie>.csv` | den reinen Zählern der Familie (unverändert) |

> **Warum die Sammeldatei nicht dem Match folgt.** `all_players_<familie>.csv`
> wird **angehängt**. Ihr Kopf steht ab der ersten geschriebenen Zeile fest, und
> zwei Profile derselben Familie (`standard` und `sm5`) hätten verschiedene
> Köpfe — die Datei würde beim ersten Profilwechsel unlesbar. Sie nimmt deshalb
> immer das Standardprofil der Familie, und das ist zugleich das **breiteste**:
> für `sm5` das Profil `sm5` mit allen amtlichen Feldern. Ein `standard`-Match
> verliert dabei nichts; die Werte stehen einfach in Spalten, die seine eigene
> Match-Datei nicht zeigt.

---

## Die Dateien

```
data/stats/
  all_players_laserball.csv                ← alle Laserball-Spielerzeilen
  all_players_sm5.csv                      ← alle SM5-Spielerzeilen
  totals_laserball.csv                     ← Gesamtwertung Laserball
  totals_sm5.csv                           ← Gesamtwertung SM5
  matches.csv                              ← eine Zeile je Match (Index)
  player_modes.csv                         ← wer hat wann welchen Modus gespielt
  matches/
    2026-09-16_124638_<matchId>_players.csv   ← ein Match, eine Zeile je Spieler
    2026-09-16_124638_<matchId>_events.csv    ← jedes Ereignis dieses Matches
```

| Datei | Wann geschrieben | Zweck |
|---|---|---|
| `matches/…_players.csv` | am Matchende (bei „live mitschreiben" laufend) | eine Datei pro Match, gut zum schnellen Draufschauen |
| `matches/…_events.csv` | am Matchende (wenn „Event-Log" an) | die komplette Zeitleiste eines Matches |
| `all_players_<familie>.csv` | **angehängt** am Matchende | jede Spieler-Zeile aus jedem Match dieser Familie — die Datei für Excel / pandas |
| `totals_<familie>.csv` | neu geschrieben am Matchende | Summe pro Spieler über alle Matches dieser Familie |
| `matches.csv` | **angehängt** am Matchende | eine Zeile je Match: Modus, Dauer, Endstand, Sieger |
| `player_modes.csv` | neu geschrieben am Matchende | je Spieler und Modus: wie oft, seit wann, bis wann |

Es werden nur die Familien-Dateien angelegt, die auch gebraucht werden: wer nur
Laserball spielt, bekommt nie eine `_sm5.csv`.

Ein Match wird am Laserforce-„Mission Ende" (`0101`) fertiggeschrieben. Startet
jemand ein neues Match ohne Ende, wird das vorherige trotzdem aus dem letzten
Stand fertiggeschrieben — es geht nichts verloren.

---

## Spalten: Spieler-Zeilen

Gilt für `matches/…_players.csv` **und** `all_players_<familie>.csv`.

### Die Reihenfolge ist fachlich sortiert, nicht zufällig

Fünf Blöcke, immer in dieser Reihenfolge:

| # | Block | Was drinsteht |
|---|---|---|
| 1 | **Identität** | Welches Match, wann, welcher Modus, wer, welches Team, welche Rolle, welches Level |
| 2 | **Ergebnis** | Punkte und wie das Match ausgegangen ist |
| 3 | **Kernzahlen** | die Leitkennzahlen des Profils |
| 4 | **Detailzähler** | alles Übrige, was das Profil führt |
| 5 | **Herkunft** | woher die Zahlen stammen — immer ganz hinten |

> **CSV-Spaltenname und Bezeichnung sind zweierlei.** Der **CSV-Spaltenname**
> (`shots_fired`, `steals_done` …) ist eine Schnittstelle und ändert sich
> **nie** — vorhandene Excel- und pandas-Auswertungen laufen unverändert weiter.
> Die **Bezeichnung** ist der ausgeschriebene deutsche Text, den Konsole,
> Legende und diese Doku anzeigen. Beide stehen nebeneinander in `METRICS`
> ([GAMEMODES.md](GAMEMODES.md#spaltenbeschriftungen)).

### Block 1 — Identität (in jedem Profil gleich)

| Spalte | Bezeichnung | Bedeutung |
|---|---|---|
| `match_id` | Match-Kennung | interne Match-Kennung (steht auch im Dateinamen) |
| `date` | Datum | Tag des Matchstarts (`YYYY-MM-DD`) |
| `mode_key` | Modus-Kurzname | gleichbleibender Kurzname des Modus, z. B. `sm5`, `laserball_ranked`, `mode_14` |
| `mode_label` | Spielmodus | Anzeigename des Modus (kommt meist aus dem Stream der Anlage) |
| `mode_number` | Modus-Nummer | Nummer aus der Typ-1-Zeile; leer, wenn die Anlage keine geschickt hat. **Der einzige stabile Anker für einen Modus, dessen Nummer nicht in der Registry steht** |
| `family` | Protokollfamilie | `laserball` oder `sm5` — welchen Satz Zahlen die Anlage liefert |
| `profile` | Anzeigeprofil | `standard`, `sm5` oder `laserball`: mit welchem Spaltensatz diese Zeile geschrieben wurde |
| `player_id` | Spieler-Kennung | Kennung, unter der die Anlage den Spieler führt |
| `name` | Spielername | Name aus dem Stream, oder aus der eigenen Namensliste |
| `team_id` | Team-Nummer | Nummer, unter der die Anlage das Team führt |
| `team` | Teamname | Name des Teams |
| `role` | Rolle | Rolle aus der Anmeldung: Commander, Heavy Weapons, Scout, Ammo Carrier, Medic. In Laserball leer |
| `level` | Spielerlevel | Erfahrungsstufe aus der Anmeldung. Leer, wenn die Anlage keine meldet |

### Block 2 — Ergebnis (in jedem Profil gleich)

| Spalte | Bezeichnung | Bedeutung |
|---|---|---|
| `score` | Punkte | Punktestand **dieses Spielers** |
| `team_score` | Punkte eigenes Team | Endstand des eigenen Teams |
| `opp_score` | Punkte bestes Gegnerteam | Endstand des stärksten Gegnerteams |
| `result` | Spielausgang | `win` / `loss` / `draw`, aus `team_score` gegen `opp_score` |
| `duration_s` | Spieldauer (Sekunden) | tatsächlich gespielte Zeit in Sekunden |

### Blöcke 3 + 4 — je Profil

**Profil `laserball` (12 Spalten)**

`goals`, `assists`, `steals_done`, `steals_received`, `blocks_done`,
`blocks_received`, `resets_done`, `resets_received`, `clears_done`,
`clears_received`, `passes_done`, `passes_received`

**Identisch mit dem Zählerblock der bisherigen Version** — Zeichen für Zeichen,
in derselben Reihenfolge. Bestehende Laserball-Auswertungen, die Spalten über
den **Namen** ansprechen, funktionieren unverändert weiter.

**Profil `standard` (31 Spalten)** — Kernzahlen zuerst:

`shots_fired`, `shots_hit`, `accuracy`, dann `misses`, `times_hit`,
`deactivations`, `times_deactivated`, `shot_team`, `times_hit_by_team`,
`target_hits`, `target_destroys`, `missile_locks`, `missile_hits`,
`missile_misses`, `missile_destroys`, `times_missiled`, `missile_team`,
`nukes_activated`, `nukes_detonated`, `rapid_fires`, `ammo_resupplies`,
`ammo_received`, `lives_resupplies`, `lives_received`, `team_ammo_resupplies`,
`team_lives_resupplies`, `penalties`, `beacon_claims`, `base_awards`,
`achievements`, `rewards`

**Profil `sm5` (42 Spalten)** — dieselben, plus die amtlichen Endwerte:

`shots_fired`, `shots_hit`, `accuracy`, **`lives_left`**, **`shots_left`**, dann
die 28 Detailzähler wie oben, und am Ende die neun übrigen amtlichen Felder:
`medic_hits`, `own_medic_hits`, `medic_nukes`, `scout_rapid`, `life_boost`,
`ammo_boost`, `nukes_cancelled`, `own_nuke_cancels`, `shot3_hit`

Was jede einzelne Zahl bedeutet — und unter welcher **ausgeschriebenen
Bezeichnung** sie in Konsole und Legende erscheint —, steht in
[GAMEMODES.md](GAMEMODES.md#zählerfelder-familie-sm5); die amtlichen Felder in
[GAMEMODES.md](GAMEMODES.md#die-amtlichen-typ-7-felder).

Die wichtigsten Paare, damit die Richtung klar ist:

| CSV-Spalte | Bezeichnung | | CSV-Spalte | Bezeichnung |
|---|---|---|---|---|
| `deactivations` | Gegner abgeschossen | ↔ | `times_deactivated` | Selbst abgeschossen worden |
| `shot_team` | Eigene Mitspieler getroffen | ↔ | `times_hit_by_team` | Vom eigenen Team getroffen worden |
| `missile_hits` | Gegner mit Rakete getroffen | ↔ | `times_missiled` | Selbst von Rakete getroffen worden |
| `ammo_resupplies` | Munition ausgegeben | ↔ | `ammo_received` | Munition erhalten |
| `lives_resupplies` | Leben ausgegeben | ↔ | `lives_received` | Leben erhalten |
| `steals_done` | Ball abgenommen | ↔ | `steals_received` | Ball verloren |
| `blocks_done` | Gegner geblockt | ↔ | `blocks_received` | Selbst geblockt worden |
| `resets_done` | Gegner zurückgesetzt | ↔ | `resets_received` | Selbst zurückgesetzt worden |
| `passes_done` | Pässe gespielt | ↔ | `passes_received` | Pässe erhalten |
| `clears_done` | Befreiungspässe gespielt | ↔ | `clears_received` | Befreiungspässe erhalten |

### Block 5 — Herkunft (immer die letzten Spalten)

`stats_source`, `score_source` und — in den Profilen `standard` und `sm5`, die
eine Trefferquote führen — `accuracy_source`.
[Was die Werte heißen](#stats_source-score_source-und-accuracy_source).

---

## Leere Zellen sind Absicht

Manche Werte **existieren noch nicht**, und dann steht dort **nichts** — keine
`0`.

| Spalte | Bezeichnung | Leer, wenn … |
|---|---|---|
| `lives_left` | Leben übrig | das Match noch läuft bzw. die Anlage keinen Typ-7-Endblock geschickt hat |
| `shots_left` | Munition übrig | dasselbe — die Anlage meldet den Rest erst mit der Endabrechnung |
| die neun weiteren amtlichen Felder | siehe [GAMEMODES.md](GAMEMODES.md#die-amtlichen-typ-7-felder) | dasselbe |
| `accuracy` | Trefferquote | der Spieler keinen einzigen Schuss abgegeben hat |
| `level` | Spielerlevel | die Anlage kein Level meldet |
| `mode_number` | Modus-Nummer | keine Typ-1-Zeile ankam |

**Warum das wichtig ist:** eine `0` in einer Statistiktabelle liest sich als
Messwert — „dieser Spieler hatte null Leben übrig", „dieser Spieler hat nie
getroffen". Eine leere Zelle sagt ehrlich: **nicht gemessen**. In `pandas`
werden solche Zellen zu `NaN` und fallen bei `mean()` korrekt heraus, statt den
Schnitt nach unten zu ziehen.

---

## Zeilensortierung

Die Zeilen liegen nicht mehr in der Reihenfolge, in der sich die Spieler
zufällig eingeloggt haben.

| Datei | Sortierung |
|---|---|
| `matches/…_players.csv` und die angehängten Blöcke in `all_players_<familie>.csv` | **nach Team**, innerhalb eines Teams **nach Punkten absteigend**, bei Gleichstand nach Name |
| `totals_laserball.csv` | Tore, dann Vorlagen, dann Name |
| `totals_sm5.csv` | Punkte, dann „Gegner abgeschossen", dann Name |
| `player_modes.csv` | Spielername, dann Familie, dann `mode_key` |
| `matches.csv` | chronologisch (angehängt, nie umsortiert) |

Die Rangfolge einer Gesamtwertung ist die **wichtigste Kennzahl des Profils
zuerst** — sie steht in `src/gameModes.js` neben den Spalten des Profils
(`profileSort()`), nicht irgendwo im Schreiber verstreut.

---

## `stats_source`, `score_source` und `accuracy_source`

Drei Spalten, die sonst niemand versteht — deshalb ausführlich:

### `stats_source` — Bezeichnung: **Herkunft der Zähler**

| Wert | Bedeutung |
|---|---|
| `tdf7` | **Offizielle Zahlen der Anlage.** Am Matchende schickt Laserforce je Spieler einen Endstatistik-Block (TDF-Zeilentyp 7); lf_live hat die eigenen Zählungen damit überschrieben. Das ist der Normalfall für ein vollständig aufgezeichnetes SM5-Match. |
| `live` | **Von lf_live selbst gezählt.** In Laserball immer, weil die Anlage dort gar keinen Endblock schickt. In SM5 dann, wenn kein Endblock ankam — etwa weil die Aufzeichnung mittendrin startete oder das Match abgebrochen wurde. |

**Wichtig bei SM5 mit `live`:** diese **Zählerstände** sind eine
**Untergrenze**, nie zu hoch. Laserforce meldet keinen eigenen „Schuss"-Event,
deshalb kann lf_live `shots_fired` nur dort hochzählen, wo ein Treffer oder ein
Fehlschuss gemeldet wurde.

In Laserball ist `live` dagegen völlig normal und kein Qualitätsmangel — die
zwölf Laserball-Zähler waren schon immer Eigenzählung.

### `accuracy_source` — Bezeichnung: **Herkunft der Trefferquote**

| Wert | Bedeutung |
|---|---|
| `tdf7` | Die Quote ist aus den **amtlichen** `shots_hit` / `shots_fired` der Anlage gerechnet. Belastbar. |
| `live` | Die Quote ist eine **Näherung aus der Eigenzählung — und systematisch zu HOCH.** |

**Die Richtung des Fehlers, damit sie niemand verwechselt:** im Nenner
(`shots_fired`) fehlen die Schüsse, die die Anlage nie gemeldet hat — das sind
ausschließlich **Nicht**-Treffer. Der Zähler (`shots_hit`) ist dagegen
vollständig, denn jeder Treffer erzeugt zwangsläufig ein Ereignis. Vollständiger
Zähler über zu kleinem Nenner ⇒ **zu große Quote**.

> Merksatz: **`shots_fired` ist zu niedrig, `accuracy` ist deshalb zu hoch.**
> Rechenbeispiel: [GAMEMODES.md](GAMEMODES.md#die-trefferquote--und-warum-sie-live-zu-hoch-ist).

Wer ehrlich auswerten will, filtert auf `accuracy_source == "tdf7"`.

### `score_source` — Bezeichnung: **Herkunft der Punkte**

| Wert | Bedeutung |
|---|---|
| `tdf` | **Punkte von der Anlage.** Laserforce hat während des Matches Punktestände gemeldet (TDF-Zeilentyp 5); das sind die offiziellen Werte. |
| `internal` | **Eigenzählung.** Es kam keine einzige Punktezeile an; lf_live hat Laserball-Tore selbst gezählt. Bei SM5 bleibt der Punktestand dann bei 0. |

Da `result` aus `team_score` und `opp_score` abgeleitet wird, sagt
`score_source` indirekt auch, wie belastbar Sieg/Niederlage in dieser Zeile sind.

---

## Spalten: `totals_<familie>.csv`

`player_id`, `name`, `matches`, `wins`, `losses`, `draws`, dann die Summen
**aller** Zählerspalten der Familie, dann `score` und eine Durchschnittsspalte.

**Unverändert gegenüber der Vorversion** — mit Absicht. Eine Gesamtwertung ist
eine **Summe**, und weder eine abgeleitete Quote (`accuracy`) noch ein
Endstandswert (`lives_left`) darf über Matches hinweg aufsummiert werden. Beides
fehlt hier deshalb bewusst; es steht vollständig in
`all_players_<familie>.csv`.

| Datei | Zählerspalten | Letzte zwei Spalten | Sortierung |
|---|---|---|---|
| `totals_laserball.csv` | die 12 Laserball-Spalten | `score` (Punkte), `goals_per_match` (Tore je Match) | Tore, dann Vorlagen |
| `totals_sm5.csv` | die 30 SM5-Spalten | `score` (Punkte), `score_per_match` (Punkte je Match) | Punkte, dann „Gegner abgeschossen" |

Die ersten Spalten heißen `matches` (Gespielte Matches), `wins` (Siege),
`losses` (Niederlagen) und `draws` (Unentschieden).

`score` ist die Summe der Spieler-Punktestände über alle Matches dieser Familie.

Beispiel `totals_laserball.csv`:

```
player_id;name;matches;wins;losses;draws;goals;assists;steals_done;…;passes_received;score;goals_per_match
a1;Mara;2;2;0;0;10;3;3;…;16;5;5
```

---

## Spalten: `matches.csv`

Eine Zeile je fertiggeschriebenem Match — der Index über alles, was aufgezeichnet
wurde. Angehängt, nie neu geschrieben. Enthält **keine** Zählerspalten und gilt
deshalb für beide Familien gemeinsam.

| Spalte | Bedeutung |
|---|---|
| `match_id` | interne Match-ID, verbindet mit den anderen Dateien |
| `date` | Datum des Matchstarts (`YYYY-MM-DD`) |
| `started_at` / `ended_at` | ISO-Zeitstempel von Beginn und Abschluss |
| `duration_s` | tatsächlich gespielte Zeit in Sekunden |
| `mode_key` / `mode_label` / `mode_number` | der Spielmodus |
| `family` | `laserball` oder `sm5` |
| `profile` | **neu** — `standard`, `sm5` oder `laserball`: der Spaltensatz dieses Matches |
| `players` | Anzahl der Spieler-Zeilen dieses Matches |
| `teams` | Anzahl der Teams |
| `scores` | Endstand als Text, z. B. `Rot:5 \| Blau:3` |
| `winner_team` | Name des Siegerteams. **Leer bei Gleichstand** |
| `winner_score` | höchster Teamstand |
| `score_source` | `tdf` oder `internal`, wie oben |
| `events` | Anzahl der aufgezeichneten Ereignisse |

Beispiel:

```
match_id;date;started_at;ended_at;duration_s;mode_key;mode_label;mode_number;family;profile;players;teams;scores;winner_team;winner_score;score_source;events
lb1;2026-09-16;2026-09-16T10:46:38.377Z;2026-09-16T10:46:38.378Z;600;laserball_ranked;Laserball Ranked;28;laserball;laserball;8;2;Rot:5 | Blau:3;Rot;5;tdf;412
```

---

## `player_modes.csv` — wer hat wann welchen Modus gespielt

Die Datei, die genau eine Frage beantwortet: **welcher Spieler hat wann welchen
Spielmodus gespielt?** Sie wird bei jedem Matchende neu geschrieben und enthält
immer den vollständigen Stand.

**Eine Zeile je Kombination aus Spieler und Modus** — nicht je Match. Wer 30-mal
Laserball und 4-mal SM5 gespielt hat, hat dort zwei Zeilen.

| Spalte | Bezeichnung | Bedeutung |
|---|---|---|
| `player_id` | Spieler-Kennung | Kennung, unter der die Anlage den Spieler führt |
| `name` | Spielername | zuletzt gesehener Name des Spielers |
| `mode_key` | Modus-Kurzname | gleichbleibender Kurzname des Modus |
| `mode_label` | Spielmodus | Anzeigename des Modus |
| `family` | Protokollfamilie | `laserball` oder `sm5` |
| `matches` | Gespielte Matches | wie oft dieser Spieler diesen Modus gespielt hat |
| `first_played` | Erstes Match | ISO-Zeitstempel des **ersten** Matches in diesem Modus |
| `last_played` | Letztes Match | ISO-Zeitstempel des **letzten** Matches in diesem Modus |
| `wins` / `losses` / `draws` | Siege / Niederlagen / Unentschieden | Bilanz in diesem Modus |
| `total_duration_s` | Gesamtspielzeit (Sekunden) | aufsummierte Spielzeit in diesem Modus, in Sekunden |

Sortiert nach Spielername, dann Familie, dann `mode_key` — die Zeilen eines
Spielers stehen also immer beieinander.

Beispielinhalt:

```
player_id;name;mode_key;mode_label;family;matches;first_played;last_played;wins;losses;draws;total_duration_s
a1;Mara;laserball_ranked;Laserball Ranked;laserball;1;2026-09-16T10:46:38.377Z;2026-09-16T10:46:38.377Z;1;0;0;600
a1;Mara;sm5;Space Marines 5;sm5;1;2026-09-16T10:46:38.391Z;2026-09-16T10:46:38.391Z;1;0;0;900
```

Damit lässt sich ohne Umwege beantworten:

- *Wer spielt überhaupt SM5?* — nach `family = sm5` filtern.
- *Wer war seit Monaten nicht mehr da?* — `last_played` sortieren.
- *Welcher Modus zieht?* — `matches` je `mode_key` summieren.
- *Wie viel Spielzeit steckt in welchem Modus?* — `total_duration_s` summieren.

Der Stand überlebt Neustarts: lf_live liest die Datei beim Start wieder ein.
Wer sie löscht, verliert die Historie **nicht** endgültig — sie wird beim
nächsten Start aus den `all_players_<familie>.csv` neu aufgebaut.

> Ein Modus, den lf_live nicht kennt, erscheint hier unter `mode_<nummer>` mit
> dem Namen, den die Anlage mitschickt. Wie man ihn einträgt, damit er einen
> sprechenden `mode_key` bekommt, steht in
> [GAMEMODES.md](GAMEMODES.md#eigene-modus-nummern-ermitteln-und-eintragen).
> **`mode_key` sollte sich danach nicht mehr ändern** — sonst zerfällt die
> Historie eines Spielers in zwei Zeilen.

---

## Spalten: `events.csv`

`match_id`, `seq`, `elapsed_s`, `wall_time`, `type`, `code`, `actor_id`, `actor`,
`actor_team`, `target_id`, `target`, `target_team`, `assist`, `detail`, `text`,
**`mode_key`**. `type` ist z. B. `goal`, `pass`, `block`, `steal`, `match_start` —
siehe [API.md](API.md#event-objekt).

- `detail` = der vom Parser gesetzte Roh-Text des Events (`evt.text`).
- `text` = derselbe Vorgang als lesbarer deutscher Satz aus `eventCatalog.phrase()`
  (fällt auf `detail` zurück, wenn der Code nur eine generische Bezeichnung hat).
  Dieselbe Formulierung steht in der Event-Log-Datei — siehe [LOGGING.md](LOGGING.md).
- `mode_key` ist **neu** und steht bewusst **ganz am Ende**. Alle bisherigen
  Spalten behalten damit ihre Position, und Auswertungen, die Spalten über ihren
  Index ansprechen, laufen unverändert weiter.

---

## Umstieg von einer älteren Version

Wer lf_live schon vor der Modus-Erkennung im Einsatz hatte, hat eine
`all_players.csv` und eine `totals.csv` **ohne** Familien-Suffix. Diese Daten
stammen zwangsläufig aus Laserball-Matches.

**Was automatisch passiert:** Beim Start faltet lf_live eine vorhandene
`all_players.csv` in die Laserball-Gesamtwertung ein — aber **genau dann, wenn
diese noch leer ist.** Nach dem ersten fertiggeschriebenen Match sind die
übernommenen Zahlen persistiert, und ab da wird nichts mehr importiert. Das ist
über beliebig viele Neustarts hinweg idempotent: **es wird nichts doppelt
gezählt.** Die alte Datei wird dabei **nie geschrieben, nie umbenannt, nie
gelöscht** — sie wird ausschließlich gelesen und bleibt byte-identisch liegen.

Die Alt-Zeilen erscheinen in `player_modes.csv` unter dem Modus-Schlüssel
`laserball_legacy` / „Laserball (Altbestand)". Sie lassen sich damit sauber von
allem unterscheiden, was nach der Umstellung aufgezeichnet wurde — und es wird
nichts behauptet, was aus den Altdaten nicht hervorgeht, denn eine Modus-Nummer
enthalten sie nicht.

| Datei | Was jetzt gilt |
|---|---|
| `all_players.csv` (ohne Suffix) | wird **nicht mehr geschrieben**, aber weiter gelesen und nicht angetastet. Bleibt als Archiv liegen |
| `totals.csv` (ohne Suffix) | wird **nicht mehr geschrieben**. Bleibt liegen; die Konsole zeigt sie nur noch, solange es keine neue Gesamtwertung gibt |
| `all_players_laserball.csv` | neu, ab jetzt die Laserball-Sammeldatei |
| `totals_laserball.csv` | neu, enthält die eingefalteten Altzahlen plus alles Neue |

**Zu tun ist nichts.** Wer die Altdatei loswerden will, verschiebt sie einfach
weg — aber erst, nachdem mindestens ein Match nach dem Update fertiggeschrieben
wurde, sonst geht die Historie verloren.

---

## In Excel öffnen

- **Trennzeichen**: Standard ist `;` (deutsches Excel). Doppelklick auf die Datei
  öffnet sie direkt richtig. Für `pandas` / andere Tools in der Konsole auf `,`
  stellen (`pd.read_csv(..., sep=';')` geht natürlich auch).
- **Umlaute**: die Dateien haben ein BOM, damit Excel `ä ö ü` korrekt anzeigt.
- **Neue Zeilen** kommen an die `all_players_<familie>.csv` und an `matches.csv`
  unten dran — die Datei einfach offen lassen und neu laden, oder am Turnierende
  einmal öffnen.

## Auswertung mit pandas (Beispiel)

```python
import pandas as pd

lb = pd.read_csv("data/stats/all_players_laserball.csv", sep=";")

# Torschützenliste über alle Laserball-Matches
lb.groupby(["player_id", "name"])["goals"].sum().sort_values(ascending=False)

# Steal-Differenz pro Spieler
lb["steal_diff"] = lb["steals_done"] - lb["steals_received"]
lb.groupby("name")["steal_diff"].sum()

# Siegquote
lb.groupby("name")["result"].value_counts().unstack(fill_value=0)

# --- SM5: nur die Zeilen mit offiziellen Zahlen der Anlage auswerten ---
sm5 = pd.read_csv("data/stats/all_players_sm5.csv", sep=";")

# Die Trefferquote steht fertig in der Spalte `accuracy`. `accuracy_source`
# sagt, ob sie amtlich ist (tdf7) oder eine zu hohe Live-Näherung (live).
amtlich = sm5[sm5["accuracy_source"] == "tdf7"]
amtlich.groupby("name")["accuracy"].mean().sort_values(ascending=False)

# Verbleibende Leben / Munition gibt es nur mit Endblock — leere Zellen sind
# NaN und fallen bei mean() korrekt heraus, ganz ohne fillna(0).
sm5.groupby("role")[["lives_left", "shots_left"]].mean()

# Wer spielt auf welchem Level?
sm5.groupby("name")["level"].max().sort_values(ascending=False)

# --- Wer hat wann welchen Modus gespielt ---
pm = pd.read_csv("data/stats/player_modes.csv", sep=";")
pm.sort_values("last_played", ascending=False)[["name", "mode_label", "matches", "last_played"]]

# --- Matchübersicht: wie viele Matches je Modus ---
m = pd.read_csv("data/stats/matches.csv", sep=";")
m.groupby(["mode_key", "mode_label"]).size().sort_values(ascending=False)
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

**Durch die Modus-Erkennung sind keine neuen Einstellungen dazugekommen.** Die
Familien-Trennung passiert automatisch.

## API

- `GET /api/stats/totals` — Gesamtwertung als JSON. Liefert **eine** Familie:
  die des zuletzt aufgezeichneten Matches, sonst die zuletzt geschriebene
  Gesamtwertung, sonst die alte `totals.csv`. Einen Parameter zur Auswahl gibt es
  derzeit nicht — wer gezielt eine Familie braucht, lädt sie über
  `/api/stats/file?name=totals_sm5.csv`.
- `GET /api/stats/files` — Liste aller CSV-Dateien, auch der neuen
- `GET /api/stats/file?name=<pfad>` — eine Datei herunterladen

Details und Auth: [API.md](API.md).

> **Bekannte Einschränkung der Web-Konsole.** Die Tabelle „Gesamtwertung" im
> Statistik-Tab zeigt fest die **Laserball**-Spalten (Tore, Vorlagen, Steals …).
> Liefert `/api/stats/totals` eine SM5-Gesamtwertung, bleiben diese Spalten leer.
> Die SM5-Zahlen sind vollständig vorhanden — nur eben in
> `totals_sm5.csv`, die im selben Tab unter „Dateien" zum Download steht.
