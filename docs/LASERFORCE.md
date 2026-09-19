# Laserforce — Anbindung, Log-Format & Event-Codes

Alles über die Verbindung zum Laserforce-System und das Format, das über den
TCP-Stream kommt. Dies ist die **einzige** Protokoll-Referenz des Projekts.

- [Zweck](#zweck)
- [Anbinden](#anbinden)
- [Was der Parser liest](#was-der-parser-liest)
- [Tabulatoren, Leerzeichen und der Spaltenversatz](#tabulatoren-leerzeichen-und-der-spaltenversatz)
- [Zeilentypen 0–9](#zeilentypen-09)
- [Schema-Kommentarzeilen](#schema-kommentarzeilen)
- [Feld-Referenz](#feld-referenz)
- [Typ-1 (Mission) im Detail](#typ-1-mission-im-detail)
- [Typ-2 (Team) im Detail](#typ-2-team-im-detail)
- [Typ-3 (Login nach 0100) im Detail](#typ-3-login-nach-0100-im-detail)
- [Typ-5 (Score) im Detail](#typ-5-score-im-detail)
- [Typ-6 (Entity-Ende) im Detail](#typ-6-entity-ende-im-detail)
- [Typ-7 (SM5-Endblock) im Detail](#typ-7-sm5-endblock-im-detail)
- [Typ-4-Event-Codes: gemeinsame Match-Steuerung](#typ-4-event-codes-gemeinsame-match-steuerung)
- [Typ-4-Event-Codes: Space Marines 5](#typ-4-event-codes-space-marines-5)
- [Typ-4-Event-Codes: Standardmodus (Nummer 7)](#typ-4-event-codes-standardmodus-nummer-7--an-der-eigenen-anlage-gemessen)
- [Typ-4-Event-Codes: Laserball](#typ-4-event-codes-laserball)
- [Typ-4-Event-Codes: 7SM / Nexus](#typ-4-event-codes-7sm--nexus)
- [Spielvarianten](#spielvarianten)
- [Modus-Erkennung](#modus-erkennung)
- [Assist-Fenster & Ballbesitz](#assist-fenster--ballbesitz)
- [Wann ein Match als beendet gilt](#wann-ein-match-als-beendet-gilt)
- [Was lf_live daraus macht](#was-lf_live-daraus-macht)
- [Bekannte Lücken / unbestätigt](#bekannte-lücken--unbestätigt)
- [Quellen](#quellen)
- [Gegen die echte Anlage prüfen](#gegen-die-echte-anlage-prüfen)

---

## Zweck

Diese Datei dokumentiert das TDF-Log-Format ("Tournament Data Format" bzw.
"Tab Delimited File"), das eine Laserforce-Anlage als Stream ausgibt, sowie
**jeden bekannten Typ-4-Event-Code je Spielmodus**. Die maschinenlesbare Fassung
der Code-Tabellen liegt in [`src/eventCatalog.js`](../src/eventCatalog.js)
(`EVENTS`, `describe()`, `phrase()`).

> **Verhältnis zum Originalsystem — Stand heute.** Die Auswertung
> (`src/engine.js`, `processLogLine`) war ursprünglich ein 1:1-Port des
> Originalsystems. Das gilt **nicht mehr pauschal**: der Parser kann inzwischen
> mehr als das Original. Was garantiert unverändert blieb und was bewusst neu
> ist, steht in [Was lf_live daraus macht](#was-lf_live-daraus-macht).
>
> **Unverändert am Laserball-Pfad** — und das ist die Leitplanke des ganzen
> Umbaus: der komplette `11xx`-`switch`, das **10-Sekunden-Assist-Fenster**, die
> Ballbesitz-Führung über `ballHolderId`, die Unterscheidung Reset/Block über den
> Ziel-Status und **alle zwölf bestehenden Laserball-Zählerfelder** unter ihren
> bisherigen Namen. Der Regressionstest `engine.smoke` in `scripts/check.js`
> fährt genau diesen Pfad (Pass → Tor → Assist → Teamscore) und ist grün; die
> Laserball-CSV-Spalten sind nachweislich Zeichen für Zeichen dieselben wie vorher.
>
> **Genau ein** Eingriff in den Laserball-Pfad war nötig: sobald die Anlage
> eigene Punkte per Typ-5-Zeile meldet, zählt lf_live den Teamscore nicht mehr
> selbst mit hoch (siehe [Typ-5 im Detail](#typ-5-score-im-detail)). Tor-Ereignis,
> `goals`-Zähler, Assist-Logik und OBS-Auslöser sind davon nicht berührt.
>
> **Neu gegenüber dem Original** ist alles, was das Original gar nicht kannte:
> die `;`-Schema-Kommentarzeilen, die Modus-Erkennung aus Typ 1, die
> SM5-Live-Zähler aus den `0xxx`-Codes, der Typ-7-Endblock und der Typ-5-Score
> als Autorität.
>
> `src/eventCatalog.js` ist weiterhin **rein beschreibendes Nachschlagewerk**
> und ändert das Parser-Verhalten nicht.

---

## Anbinden

lf_live öffnet einen **TCP-Server** (Standard `0.0.0.0:9000`, über
`LF_TCP_HOST` / `LF_TCP_PORT` änderbar). Laserforce **verbindet sich dorthin**
und schickt seinen Log-/Data-Stream, zeilenweise, durch `\n` getrennt.

1. Im Laserforce-Betriebssystem den Log-/Statistik-Export (TCP-Ausgabe) aktivieren.
2. Als Ziel **IP des Hallen-Rechners : 9000** eintragen. Die IP zeigt die Konsole
   (unter „Einstellungen") und der Startlog; sonst `ipconfig`.
3. Windows-Firewall für `node.exe` im **privaten** Netz freigeben.
4. In der Konsole verschwindet der gelbe Hinweis „Laserforce nicht verbunden",
   und im Log erscheint `Laserforce connected (...)`, bei Log-Level `debug`
   danach `recv N bytes`.

> Diese Verbindung ist **unverschlüsselt und ohne Anmeldung** — so gibt Laserforce
> die Daten aus. Der Rechner gehört in ein vertrauenswürdiges Hallen-Netz. Wenn
> Laserforce nur „lauschen" statt „verbinden" kann, braucht es einen kleinen
> Relay davor — bitte melden.

---

## Was der Parser liest

Zeilen, die mit `;` beginnen, sind **Schema-Kommentare**: sie nennen die
Spaltennamen der folgenden Zeilen ihres Typs. Sie wurden früher verworfen und
werden **jetzt ausgewertet** — siehe [Schema-Kommentarzeilen](#schema-kommentarzeilen).
Alle übrigen Zeilen werden an Whitespace gesplittet; **Spalte 0 ist der
Zeilentyp**.

**Spielernamen** kommen aus der Typ-3-Zeile (Feld nach `player`). Optional
überschreibt eine selbst gepflegte Namensliste (`data/roster.csv`, siehe
[CONFIG.md](CONFIG.md#namensliste)) einzelne Namen/Teams. lf_live
kontaktiert **keine externen Dienste**.

Das Format ist **versioniert** — Zeile 0 nennt die Version (z. B. `2.006`).
Bekannte Versionen: `2.000`–`2.006`. Änderungen sind **additiv** (höhere Version =
Obermenge). Einzelne Spalten kamen erst mit späteren Versionen dazu; im Zweifel
gilt die Schema-Kommentarzeile, nicht die Versionsnummer.

> **Kodierung.** Als Datei ist ein TDF UTF-16 LE (mit BOM), Tab-getrennt,
> `\r\n`-Zeilenende. Über den TCP-Stream kommt es zeilenbasiert an; der Parser
> splittet tolerant an beliebigem Whitespace, deshalb funktioniert Tab **und**
> Space.

---

## Tabulatoren, Leerzeichen und der Spaltenversatz

**TDF ist tabulatorgetrennt.** Der Parser splittet aus historischen Gründen
zusätzlich an beliebigem Whitespace, damit auch ein leerzeichengetrennter Feed
und Testdaten funktionieren. Das klingt harmlos, ist aber der Grund, warum
Spaltenpositionen im TDF zwei verschiedene Zahlen haben können.

Sobald ein Feld selbst ein Leerzeichen enthält — die Missionsbeschreibung, der
Team-Name, der Spielername —, zerfällt es beim Whitespace-Split in mehrere
Tokens und **verschiebt jede Spalte dahinter**:

```
1 ⇥ 5 ⇥ Space Marines 5 ⇥ 20260916120000 ⇥ 900000 ⇥ 0

Tabulator-Spalten:   0:1   1:5   2:"Space Marines 5"   3:start   4:duration   5:penalty
Whitespace-Tokens:   0:1   1:5   2:Space  3:Marines  4:5   5:start  6:duration  7:penalty
```

`duration` liegt auf **Tab-Spalte 4**, aber auf **Whitespace-Token 6**. Ein
Spaltenindex aus einer Schema-Kommentarzeile zählt immer Tabulator-Spalten und
darf deshalb **nie** ungeprüft auf den Whitespace-Split angewendet werden.

So löst die Engine das:

1. Jede Zeile wird zusätzlich an `\t` gesplittet, sofern ein Tabulator drin ist.
   Diese Tab-Spalten sind die **einzige** Darstellung, auf die ein Schema-Index
   direkt angewendet wird.
2. Kommt der Feed **ohne** Tabulatoren, aber es ist ein Schema bekannt, wird der
   Versatz zurückgerechnet: er ist genau `Anzahl Tokens − Anzahl Schema-Spalten`,
   und die überzähligen Tokens gehören zu dem einen Feld, das Leerzeichen
   enthalten darf. Danach passt die Zeile wieder zum Schema.
3. Ist weder ein Tabulator noch ein Schema vorhanden, gilt die feste
   Positionsangabe des jeweiligen Zweigs — also exakt das bisherige Verhalten.

Der ursprüngliche Whitespace-Split bleibt für jeden bestehenden Zweig
unverändert erhalten; die Tab-Spalten sind eine zusätzliche Darstellung, keine
Ablösung. Ein tabulator- und ein leerzeichengetrennter Stream liefern damit
identische Ergebnisse.

> **Bekannte Grenze.** Kommt ein Stream **ohne** Tabulatoren **und ohne**
> Schema-Zeilen, und endet die Missionsbeschreibung auf einer Zahl, kann dieses
> letzte Token verlorengehen — es ist dann nicht mehr von den nachfolgenden
> Zahlenspalten zu unterscheiden. Mit Tabulator oder mit Schema-Zeile korrekt.

---

## Zeilentypen 0–9

| Typ | Name | Spaltenlayout (Schema) | Vorkommen | lf_live |
|---|---|---|---|---|
| `;` | **Schema-Kommentar** | `;<typ>/<name>  spalte  spalte  …` | vor der ersten Zeile ihres Typs | **ausgewertet** → Spaltennamen je Zeilentyp, siehe [unten](#schema-kommentarzeilen) |
| `0` | info / Kopf | `0  file-version  program-version  centre` | 1×, erste Zeile | ⚪ ignoriert (Version nicht ausgewertet) |
| `1` | mission | `1  type  desc  start  [duration]  [penalty]` — `duration` ab v2.001, `penalty` ab v2.003 | 1×, nach Typ 0 | `type` → **Spielmodus**, `desc` → Anzeigename, `duration` → Spieluhr. Details: [Typ-1 im Detail](#typ-1-mission-im-detail) |
| `2` | team | `2  index  desc…  colour-enum  colour-desc  [#rgb]` — `#rgb` ab v2.004 | je Team 1×, „Neutral" zuletzt | → `teams[index] = {name, color}` |
| `3` | entity-start | `3  time  id  type  desc  team  level  category  [battlesuit]  [memberId]` — `battlesuit` ab v2.003, `memberId` in späten 2.006 | je Entity 1×, **nach `0100`** | wenn die Spalte `type` den Wert `player` trägt → Spieler anlegen; `level`/`category`/`battlesuit`/`memberId` werden **jetzt gemerkt**. Zur Spalte statt zum Wort: [Typ-3 im Detail](#typ-3-login-nach-0100-im-detail) |
| `4` | **event** | `4  time  code  <actor>  <verb…>  <target>` | laufend | siehe Code-Tabellen |
| `5` | score | `5  time  entity  old  delta  new` | begleitet jedes werterelevante Typ-4-Event | **Punktestand-Autorität** für alle Modi → `scores` / `players[id].score`, `scoreSource='tdf'`. Meldet die Anlage **keine** Teamzeilen (Standardmodus — gemessen), summiert lf_live `scores` aus den Spielerpunkten und kennzeichnet das mit `teamScoreSource='derived'`. Details: [Typ-5 im Detail](#typ-5-score-im-detail) |
| `6` | entity-end | `6  time  id  type  score` — `type` = Exit-Code, Zuordnung **unbestätigt**, siehe [Exit-Codes](#die-exit-codes-der-typ-6-zeile--unbestätigt) | je Entity 1× (am Ende oder bei Elimination mitten im Spiel) | → `match_summary`-Ereignis (informativ, verändert den Zustand nicht); Exit-Code wird in `exitCodes` festgehalten |
| `7` | sm5-stats | `7  id  <23 benannte Felder>` = 24 Felder + Typ-Spalte | je Entity 1× — **in Laserball nicht vorhanden und, gemessen, auch im Standardmodus (Nummer 7) nicht** | **offizielle Endstatistik** → `players[id].official`, überschreibt die SM5-Live-Zähler, `statsSource='tdf7'`. Details: [Typ-7 im Detail](#typ-7-sm5-endblock-im-detail) |
| `8` | — | nicht dokumentiert / nicht beobachtet | — | – |
| `9` | player-state | `9  time  entity  state` — ab v2.005 (SM5); in Laserball ab v2.004 | laufend | → `players[id].status` |
| `3`–`9` | (alle In-Game-Zeilen) | Spalte 1 = Spielzeit in ms | – | → `elapsedTime`. **Ausnahme Typ 7**: hat keine `time`-Spalte und lässt `elapsedTime` unberührt |

**Reihenfolge im echten Betrieb — an vier echten Mitschnitten gemessen:**
`0` → `1` → `2` (Teams) → `0100` (Start) → viele `3` (Logins, sobald Spieler
aktiviert werden) → `4`/`5`/`9` (Spielverlauf) → **`0101`** → Typ-6-Block.
**`0100` leert die Spielerliste** — Logins kommen im echten Ablauf *danach*.
`lf_simulate` hält diese Reihenfolge ein.

> **KORREKTUR (19.09.2026, vier echte Mitschnitte, Modus 7 „Standard LZ - 2
> Teams").** Hier stand bis dahin, die Reihenfolge sei `6`/`7` → `0101`. Das ist
> **falsch herum**. Gemessen kommt **`0101` zuerst**, und der Typ-6-Block folgt
> unmittelbar danach — in allen vier Mitschnitten, ohne Ausnahme:
>
> | Mitschnitt | `0101` in Zeile | Typ-6-Block | Typ-7 |
> |---|---|---|---|
> | 01:46:50 | 9200 | 9202–9237 (36×) | **0** |
> | 01:59:42 | 9719 | 9721–9766 (46×) | **0** |
> | 02:13:07 | 13916 | 13917–13963 (47×) | **0** |
> | 02:26:46 | 9867 | 9869–9904 (36×) | **0** |
>
> **Einzelne** Typ-6-Zeilen kommen sehr wohl vorher: im Mitschnitt von 02:13:07
> steht eine in Zeile 13696, gut 200 Zeilen vor dem `0101` — ein Spieler, der
> mitten im Spiel ausgeschieden ist (Exit-Code `01`). Nur der **Block** liegt
> hinter dem `0101`.
>
> **Was das für lf_live bedeutet: nichts, und das ist der Punkt.** Die
> Ende-Erkennung fragt nie nach einer Reihenfolge. `0101` gewinnt immer sofort
> (`mission_end`), und der Typ-6/7-Pfad ist nur der Ersatzweg für den Fall, dass
> gar kein `0101` kommt. Dass der Block *danach* liegt, heißt lediglich: im
> Normalbetrieb wird dieser Ersatzweg nie gebraucht. Siehe
> [Wann ein Match als beendet gilt](#wann-ein-match-als-beendet-gilt).

Wo es Typ-7-Zeilen gibt, kommen sie **vor** `0101` — die offiziellen Endzahlen
stünden also fest, bevor das Match als beendet gilt. Im Standardmodus dieser
Anlage gibt es sie aber überhaupt nicht, siehe
[Typ-7 im Detail](#typ-7-sm5-endblock-im-detail).

---

## Schema-Kommentarzeilen

Ein TDF stellt (den meisten) seiner Zeilentypen eine Kommentarzeile voran, die
die Spalten der folgenden Zeilen dieses Typs benennt:

```
;1/mission ⇥ type ⇥ desc ⇥ start ⇥ duration ⇥ penalty
1 ⇥ 28 ⇥ Laserball Ranked ⇥ 20260916120000 ⇥ 900000 ⇥ 0
```

Form: `;<typ>/<name>` als erstes Feld, danach ein Spaltenname je Feld. Das erste
Feld beschreibt dabei **Spalte 0 der Datenzeile**, also die Typ-Spalte selbst —
`duration` steht im Beispiel auf Index 4, und genau dieser Index ist in der
Datenzeile nutzbar.

**Warum das wichtig ist:** die TDF-Versionen 2.000–2.006 unterscheiden sich fast
ausschließlich in den Spalten (`duration` ab 2.001, `penalty` ab 2.003,
`battlesuit` ab 2.003, `#rgb` ab 2.004, `memberId` in späten 2.006). Die
Schema-Zeile ist damit die **zuverlässigste Quelle für Spaltenpositionen** —
zuverlässiger als die Versionsnummer in Zeile 0 und weit zuverlässiger als eine
feste Position. Sie ist außerdem der einzige belastbare Weg, die 23 benannten
Felder des Typ-7-Blocks zuzuordnen.

Wie lf_live sie behandelt:

| | |
|---|---|
| **Früher** | jede `;`-Zeile wurde ersatzlos verworfen |
| **Jetzt** | jede `;`-Zeile wird eingelesen und ihrem Zeilentyp zugeordnet |
| Zuordnung | primär über das `<typ>/<name>`-Präfix des ersten Feldes; nennt es keinen Typ, gilt die Schema-Zeile für den Typ der **nächsten** Nicht-Kommentarzeile |
| Namensvergleich | tolerant: Groß-/Kleinschreibung, `-`, `_` und Leerzeichen sind egal (`shots-hit` = `shotsHit` = `shots hit`) |
| Vorrang | eine Schema-Zeile schlägt **immer** die fest verdrahtete Position |
| Kein Schema | jede Abfrage meldet „unbekannt" und der jeweilige Zweig fällt auf seine bisherige Position zurück — Verhalten wie vorher |
| Fehler | die Schema-Auswertung wirft nie und kann den Parser nicht anhalten |

Ein Spaltenindex aus einer Schema-Zeile zählt **Tabulator-Spalten** — die
Fallstricke dazu stehen unter
[Tabulatoren, Leerzeichen und der Spaltenversatz](#tabulatoren-leerzeichen-und-der-spaltenversatz).

> **Nicht jede Anlage schickt sie.** Ob Ihre Anlage `;`-Zeilen sendet und welche,
> zeigt `scripts/inspect.js` — siehe
> [Gegen die echte Anlage prüfen](#gegen-die-echte-anlage-prüfen).

---

## Feld-Referenz

- **`time`** — Millisekunden seit `0100` (Mission Start). Vor dem Start ggf. 0/negativ.
- **`id` / `actor` / `target` / `entity`**
  - `#xxxxxxx` — **iplId**, weltweit eindeutige Laserforce-Mitglieds-ID.
    Profil: `https://www.iplaylaserforce.com/mission-stats/?t={id-ohne-raute}`
  - `@NNN` — **Hardware-ID** der Weste/des Ziels, nur je Zentrale eindeutig;
    Gäste & Nicht-Spieler.
  - lf_live entfernt `@`/`#` (`cleanId()`) und nutzt den Rest als String-Schlüssel.
- **`category`** (Zeile 3, SM5-Rolle): `0` N/A · `1` Commander · `2` Heavy Weapons ·
  `3` Scout · `4` Ammo Carrier · `5` Medic. In Laserball ist `category` immer `0`.
- **`state`** (Zeile 9): `0` aktiv · `2` „resettable"/verwundbar (lf_live: „in Reset") ·
  `3` deaktiviert/unverwundbar. (SM5-Respawn: `3` → 4000 ms → `2` → 4000 ms → `0`.)
  Der Wert `1` erscheint in Laserball-Quellen als Synonym für „down".
- **`mission type`** (Zeile 1): **`5` = Space Marines 5** · **`28` = Laserball Ranked**.
  Andere Modi (7SM/Nexus, Junior, diverse Varianten) haben eigene, öffentlich
  nicht dokumentierte Typ-Nummern. Wie lf_live damit umgeht und wie man die
  Nummern der eigenen Anlage ermittelt: [GAMEMODES.md](GAMEMODES.md).
- **Neutral ist an dieser Anlage Team-Index `2`, nicht `5`.** Gemessen an vier
  echten Mitschnitten (19.09.2026): die Typ-2-Zeilen lauten
  `2 0 Blaues Team`, `2 1 Rotes Team`, `2 2 Neutral`, und **jede**
  Nicht-Spieler-Entity (`gallery-target`, `generator-target`, `standard-target`,
  `beacon`) trägt Team `2` — 24 von 24 über alle vier Mitschnitte. Ein Index `5`
  kam in keinem einzigen vor.

  > **KORREKTUR.** Hier stand, Team-Index `5` sei „kein echtes Team". Der
  > Parser filterte danach (`teamId !== '5'`) und wurde allein davon gerettet,
  > dass er **zusätzlich** auf die Entity-Art prüft. Der Filter auf `5` steht
  > weiterhin im Code — er schadet nichts und deckt Anlagen ab, die es
  > tatsächlich so halten —, aber **tragend ist er nicht**. Tragend ist die
  > Spalte `type`: nur `player` wird angelegt. Siehe
  > [Typ-3 im Detail](#typ-3-login-nach-0100-im-detail).
  >
  > **Team-Index ist keine Konstante.** Welcher Index „Neutral" bedeutet, sagt
  > die Anlage in ihren eigenen Typ-2-Zeilen. Nichts darf darauf bauen, dass es
  > `2` oder `5` ist.

---

## Typ-1 (Mission) im Detail

`1  <type>  <desc…>  <start>  [duration]  [penalty]`
(`duration` ab v2.001, `penalty` ab v2.003)

Diese eine Zeile liefert drei Dinge: die **Modus-Nummer**, den **Anzeigenamen**
und die **Missionsdauer**. Sie kommt **vor** dem Mission-Start `0100`, und `0100`
setzt weder Modus noch Dauer zurück.

| Spalte | lf_live |
|---|---|
| `type` | Modus-Nummer → Registry → Familie. Schema zuerst, sonst Position 1. |
| `desc` | Anzeigename des Modus, wenn nicht leer. Schema zuerst, sonst die Tokens zwischen `type` und den abschließenden Zahlen. Fremde Daten — nie als HTML ausgeben. |
| `duration` | Spieluhr. Schema zuerst, Position nur als Rückfall. |

### Die Dauer — und warum die alte Lesart falsch war

**Früher** las der Parser schlicht die **vorletzte Spalte** als `duration`. Das
funktionierte, aber nur zufällig: `start`, `duration` und `penalty` stehen alle
numerisch am Zeilenende, und in der getesteten TDF-Version lag `duration`
tatsächlich vorletzt.

Die Lesart bricht in zwei realen Fällen:

- **`penalty` fehlt** (TDF vor v2.003). Dann ist die vorletzte Spalte nicht
  `duration`, sondern `start` — die Startzeit. Die Uhr bekommt einen
  Zeitstempel als Spieldauer.
- **Eine spätere TDF-Version hängt eine Spalte an.** Dann rutscht `duration`
  weiter nach vorn. Dass das passiert, ist keine Theorie: in Typ 2 ist mit der
  `#rgb`-Spalte ab v2.004 genau das bereits geschehen.

**Jetzt gilt:**

1. **Schema zuerst.** Nennt eine `;`-Schema-Kommentarzeile die Spalte
   `duration`, wird genau diese gelesen.
2. **Position nur als Rückfall.** Ohne Schema werden ausschließlich die letzten
   drei Tokens betrachtet — dort liegen `start`, `duration` und `penalty`. Eine
   Zahl mitten in der Missionsbeschreibung kann so nicht mehr fälschlich als
   Dauer durchgehen. Der erste Kandidat, der die Prüfung unten besteht, gewinnt:
   `duration` steht immer vor `penalty`, und `start` (ein Zeitstempel) fällt nie
   in das Plausibilitätsfenster.
3. **Einheiten-Heuristik.** Rohwert unter `10000` → als **Sekunden** gelesen und
   mit 1000 multipliziert. Alles darüber → bereits Millisekunden.
4. **Plausibilitätsprüfung.** Das Ergebnis muss zwischen **60 000 ms** (1 Minute)
   und **7 200 000 ms** (2 Stunden) liegen. Andernfalls wird es verworfen.

Kommt dabei kein Wert heraus, gilt die Dauer als **unbekannt**: die Spieluhr
zählt dann **hoch** statt herunter. Mehr dazu in
[GAMEMODES.md](GAMEMODES.md#die-spieluhr).

---

## Typ-2 (Team) im Detail

`2  <index>  <name…>  <colour-enum>  <colour-desc>  [#rgb]`

Der Team-**Name** sind die Tokens zwischen `index` und den **zwei** Werten
(`colour-enum`, `colour-desc`), die dem `#rgb` vorausgehen. Fehlt `#rgb`
(v2.003 und älter), nimmt der Parser Fallback-Farbe `#9ca3af` und den Namen bis
Spaltenende. Der Parser hat eine reine Schutzgrenze auf `index` 0–31 (verhindert
unbegrenztes Wachsen bei feindlichem Feed); echte Anlagen nutzen 0–7 plus Neutral.

**`colour-enum`-Tabelle:** `0` None · `1` Red · `2` Green · `3` Yellow · `4` Blue ·
`5` Aqua · `6` Purple · `7` White · `8` Orange · `9` Pink · `10` Black · `11` Fire ·
`12` Ice · `13` Earth · `14` Crystal · `15` Rainbow.

Der **Team-Namens-Synchronisierer** (`resolveTeamNames()`, aus dem Original
übernommen) überschreibt den TDF-Teamnamen mit dem häufigsten `dbTeamName` aus
der optionalen Namensliste, falls vorhanden.

---

## Typ-3 (Login nach 0100) im Detail

`3  <time>  <id>  player  <name…>  <team>  <level>  <category>  [battlesuit]  [memberId]`

**Die Entity-Art steht in einer eigenen Spalte** — `type`, laut Schema-Zeile
`;3/entity-start  time  id  type  desc  team  level  category  battlesuit  memberId`
die vierte. Gemessene Werte an dieser Anlage: `player`, `standard-target`,
`gallery-target`, `generator-target`, `beacon`. Der Parser liest sie **dort**
und legt nur `player` als Spieler an.

> **KORREKTUR und Umbau (19.09.2026).** Bis dahin suchte der Parser mit
> `cols.indexOf('player')` das **Wort** `player` irgendwo in der Zeile. Das ging
> gut, solange keine Nicht-Spieler-Entity so **heißt** — die Namen der Ziele
> vergibt aber der Betreiber an der Konsole frei. Eine Punktestation namens
> „player" wäre als Spieler angelegt worden, mit `standard-target` als Kennung.
> Zusätzlich hing das Ganze am Whitespace-Split.
>
> Jetzt gilt: liegt eine Schema-Zeile für Typ 3 vor **und** lässt sich die
> Datenzeile mit ihr zur Deckung bringen (TAB-Spalten, oder das eine Feld mit
> Leerzeichen — der Name — wieder zusammengefaltet), wird die Spalte `type`
> gelesen. Sonst **ändert sich gar nichts**: dann läuft weiterhin genau die alte
> Suche nach dem Wort, Byte für Byte. Der Rückfall ist Absicht — an dieser
> Stelle hängt die gesamte Spielererkennung, und eine Anlage ohne
> Schema-Zeilen darf davon nichts merken.

Ab der Spalte `type` sucht der Parser die **Signatur „drei Zahlen in Folge"**
(Team, Level, Category); alle Tokens dazwischen sind der Name. Zusätzlich
werden Entities mit `team == 5` nicht angelegt — dieser Filter stammt aus der
Fremdquelle, ist an dieser Anlage aber **wirkungslos**, weil Neutral hier
Index `2` ist (siehe oben). Tragend ist allein die Spalte `type`.

**Die `id`-Spalte ist keine Zahl.** Gemessen trägt sie `#` plus acht
alphanumerische Zeichen (`#aA1bB2cC`, `#dD4eE5fF`); Nicht-Spieler-Entities
tragen `@` plus eine kleine Zahl (`@30`, `@91`). Sie darf nirgends numerisch
behandelt, verglichen oder sortiert werden. Die **eigentliche Mitgliedsnummer**
steht in der letzten Spalte `memberId` und sieht ganz anders aus:
`21-101-10001` — siehe
[INTEGRATION.md → Mitglied oder Gast](INTEGRATION.md#mitglied-oder-gast--und-was-offen-bleibt).

`level` und `category` wurden früher verworfen und werden **jetzt gemerkt**:
`category` ist die SM5-Rolle und wird zusätzlich als Klartext (`roleLabel`)
aufgelöst. `battlesuit` (ab v2.003) und `memberId` (späte 2.006) werden
mitgenommen, **sofern eine Schema-Zeile sie benennt** — ohne Schema-Zeile gibt es
für sie keine verlässliche Position, und sie bleiben leer.

Ein Spieler bekommt beim Login außerdem die Zählerfelder seiner Modus-Familie:
die zwölf Laserball-Zähler hat er immer, bei Familie `sm5` zusätzlich die 30
SM5-Zähler. Siehe [GAMEMODES.md](GAMEMODES.md#die-zwei-familien).

Logins kommen **nach** `0100` — der Start-Event hat die Spielerliste geleert.

---

## Typ-5 (Score) im Detail

`5  <time>  <entity>  <old>  <delta>  <new>`

Diese Zeile begleitet jedes punkterelevante Ereignis und enthält den **offiziellen
Punktestand der Anlage**. Sie wurde früher nur als Info-Ereignis durchgereicht;
der Punktestand wurde selbst gezählt. **Jetzt ist sie die Autorität** — für alle
Modi, nicht nur für SM5.

- `entity` kann ein **Team-Index**, eine **Spieler-ID** oder eine
  **Nicht-Spieler-Entity** sein. lf_live unterscheidet in dieser Reihenfolge:
  1. Ist `entity` eine bekannte **Spieler-ID**, landet `new` als
     Spieler-Punktestand. Diese Prüfung steht zuerst, damit die dokumentierte
     Vorrangregel gilt: eine Kennung, die zugleich ein plausibler Team-Index
     wäre, ist der Spieler.
  2. Trägt die Kennung ein **Präfix** (`#` Mitglied, `@` Gastweste oder
     Nicht-Spieler-Entity), ist sie **nie** ein Team — ein Team-Index schreibt
     die Anlage blank (`0`, `1`). Punkte einer Punktestation, eines Generators
     oder eines Beacons gehören also niemandem: sie landen weder bei einem
     Spieler noch bei einem Team. (Vorher wurde aus `@91` das Phantom-Team
     `91`.)
  3. Eine blanke Kennung ist der **Team-Index**.
  Spieler- und Teampunkte werden parallel geführt.
- Gelesen wird die Spalte `new` (Schema zuerst, sonst Position 5), nicht `delta`.
- Ab der ersten Typ-5-Zeile steht `scoreSource` auf `tdf`. `0100` setzt es
  wieder auf `internal` zurück, damit ein Match nicht die Autorität des
  Vormatches erbt.
- Solange `scoreSource` auf `internal` steht, zählt lf_live Laserball-Tore wie
  bisher selbst. Danach nicht mehr — das ist **der einzige** Eingriff in den
  Laserball-Pfad. `goals`, das Tor-Ereignis, das Assist-Fenster und der
  OBS-Auslöser bleiben davon unberührt.
- Das bisherige `score`-Ereignis mit `old`/`delta`/`new` wird zusätzlich weiterhin
  ausgegeben, unverändert.

Gegen einen feindlichen Feed ist ein Team-Punktestand nur für einen plausiblen
Team-Schlüssel (ein- oder zweistellig, maximal 32 verschiedene) zulässig — dieselbe
Schutzgrenze wie bei Typ 2.

### Nicht jede Anlage meldet Teampunkte — `teamScoreSource`

**Gemessen, nicht angenommen.** In vier Mitschnitten des Standardmodus
(19.09.2026, Nummer 7, `| Standard LZ - 2 Teams |`) stehen zusammen **5551
Typ-5-Zeilen — und nicht eine einzige auf einer Team-Kennung.** Die Anlage
rechnet dort ausschließlich je Spieler ab. `gameState.scores` blieb deshalb
leer: die Live-Ansicht zeigte 0:0, und jeder Missionsbericht meldete `draw` ohne
Sieger, obwohl die Einzelpunkte exakt stimmten. In **Laserball** ist es anders —
dort meldet die Anlage Teampunkte, und daran ändert sich nichts.

lf_live summiert die Teampunkte deshalb **genau dann** aus den Spielerpunkten,
wenn die Anlage keine Teamzeile schickt. Wer die Zahl geliefert hat, steht in
`gameState.teamScoreSource`:

| Wert | Heißt | Typischer Fall |
|---|---|---|
| `tdf` | Die **Anlage** hat Teampunkte per Typ-5-Zeile gemeldet. | Laserball |
| `derived` | **Wir** haben sie aus den Spielerpunkten summiert. Unsere Rechnung, nicht die der Anlage. | Standard, SM5 |
| `internal` | Keine verwertbaren Typ-5-Zeilen (bisher) — die alte Eigenzählung greift. | Laserball-Tore, und die ersten Sekunden jedes Matches |

`gameState.scores[teamId]` trägt in **allen drei** Fällen den anzuzeigenden
Wert. **Niemand außerhalb der Engine summiert noch selbst.**

Was in die Summe einfließt, und was ausdrücklich nicht:

- **Ja:** jeder Spieler mit einem Team, das eine Typ-2-Zeile angekündigt hat.
  Negative Punktestände zählen mit — sie sind echt.
- **Nein:** Nicht-Spieler-Entities. Ziele, Generatoren und Beacons stehen gar
  nicht erst in `gameState.players` (der Typ-3-Pfad legt nur Zeilen an, deren
  `type`-Spalte `player` sagt), und ihr Team-Index 2 („Neutral") bekommt so
  auch keine Punkte.
- **Nein:** ein Spieler ohne Team oder in einem Team, das nie angekündigt
  wurde. Teams werden nicht erfunden.
- **Nein:** ein Spieler ohne Punktestand. Das ist eine fehlende Messung, keine 0.

**Die Reihenfolge ist einbahnig:** `internal` → `derived` → `tdf`, nie zurück.
Kommt später doch eine Team-Punktezeile, gewinnt sie sofort und für den Rest
des Matches. Ein `0100` setzt alles zurück, damit ein Match die Antwort nicht
vom Vormatch erbt.

#### Das Zeitfenster am Matchanfang

In den ersten Sekunden gibt es weder Spieler- noch Teampunkte — es ist also
noch gar nicht entschieden, welcher Fall vorliegt. In Laserball schickt die
Anlage die Spielerzeile und die Teamzeile **desselben Tores unter demselben
Zeitstempel**, und nichts garantiert, welche zuerst über die Leitung geht. Ohne
Wartezeit stünde das Kennzeichen kurz auf `derived` und kippte dann auf `tdf` —
genau das Flackern, das die Anzeige nie zeigen darf.

Deshalb wartet die Engine nach der ersten **Spieler**-Punktezeile
`TEAM_SCORE_SETTLE_MS` = **5000 ms Spielzeit**, bevor sie sich aufs Summieren
festlegt. Innerhalb des Fensters bleibt das Kennzeichen auf `internal` und der
Stand bei 0:0 — was ein Match in seinen ersten Sekunden ohnehin ist. Eine
Team-Punktezeile beendet das Fenster sofort mit `tdf`; das Matchende beendet es
ebenfalls, damit auch ein Spiel, das innerhalb des Fensters abbricht, seine
Summe bekommt.

Gemessen wird auf der **Uhr des Streams** (`elapsedTime`), nie auf
`Date.now()`: eine Wiedergabe eines Mitschnitts liefert damit exakt dasselbe
Ergebnis wie das Match live.

---

## Typ-6 (Entity-Ende) im Detail

`6  <time>  <id>  <type>  <score>` — `type` ist der **Exit-Code**.

Eine Typ-6-Zeile sagt: *für diese Entity ist die Mission vorbei.* Das passiert am
regulären Matchende (dann für alle) **und** mitten im Spiel (dann für eine
einzelne, ausgeschiedene oder hinausgeworfene Entity). Der Score dieser Zeile
wird bewusst **nicht** übernommen — Autorität ist Zeile 5.

### Die Exit-Codes der Typ-6-Zeile — unbestätigt

Die Community-Spezifikation (lfstats, siehe [Quellen](#quellen)) ordnet zu:

| Exit-Code | Bedeutung laut Fremdquelle | Status |
|---|---|---|
| `02` | Ende (Mission regulär vorbei) | **unbestätigt** |
| `04` | eliminiert | **unbestätigt** |
| `01` | Kick | **unbestätigt** |
| `17` | Ref-Kick | **unbestätigt** |

Diese Tabelle bleibt hier stehen — sie ist die Fremdquelle und die einzige
Zuordnung, die es überhaupt gibt. Sie ist aber **durch eine Beobachtung an einer
echten Anlage in Frage gestellt** und deshalb durchgehend als `unbestätigt`
geführt.

> **Belegte Abweichung — Beobachtung an einer echten Anlage, 17.09.2026.**
> Der Hallenbetreiber hat das Missionsende an seiner eigenen Laserforce-Anlage
> mitgelesen. Bei einem **regulären Standardspiel** meldet sie
> `Abschluss <id> (Exit 01, Score 0)` — also Exit-Code **`01`**, den die
> Fremdquelle als „Kick" führt, nicht `02` („Ende"). Eine zweite, für Laserball
> genannte Zahl (`1095`) ist nicht eindeutig überliefert — ob Entity-Kennung
> oder Exit-Code, lässt sich aus der Angabe **nicht** ableiten, und hier wird
> nicht geraten. Roh-Mitschnitte stehen aus.
>
> **Konsequenz im Code:** lf_live gattert die Erkennung der Endabrechnung
> **nicht mehr** am Exit-Code (das tat sie bis dahin auf `02` — an dieser Anlage
> hätte sie damit **nie** gegriffen und jedes Match wäre in den
> 120-Sekunden-Watchdog gelaufen). Maßgeblich ist jetzt allein die
> **Vollständigkeit**, siehe
> [Endabrechnung ≠ einzelne Elimination](#endabrechnung--einzelne-elimination).

> **Die Roh-Mitschnitte sind jetzt da — und sie stützen die Fremdquelle
> (19.09.2026, vier Standardspiele).** Gezählt über alle vier:
>
> | Exit-Code | Vorkommen | wo |
> |---|---|---|
> | `02` | 165 | ausnahmslos im Typ-6-Block **hinter** dem `0101` |
> | `01` | 1 | einzeln **mitten im Spiel**, 220 Zeilen vor dem `0101` |
>
> Das ist genau die Zuordnung der Fremdquelle: `02` = reguläres Ende, `01` =
> vorzeitiges Ausscheiden. Die Beobachtung vom 17.09.2026 („reguläres
> Standardspiel meldet `01`") lässt sich an den Mitschnitten **nicht**
> bestätigen; vermutlich wurde dort eine einzelne Ausscheider-Zeile gesehen.
> Die Tabelle oben bleibt trotzdem `unbestätigt`: belegt sind jetzt `01` und
> `02`, nicht `04` und `17`.
>
> **Am Code ändert das nichts, und das ist Absicht.** Die Erkennung wieder an
> `02` zu hängen, hieße sich auf eine Zuordnung zu verlassen, die zwei
> Beobachtungen derselben Anlage widersprüchlich beschreiben. Die
> Vollständigkeitsregel funktioniert ohne sie.
> Der Exit-Code wird nur noch **festgehalten** — er ist der Wert, gegen den die
> Mitschnitte auszuwerten sind, kein Wert, auf den sich eine Entscheidung
> stützen darf.

### Was lf_live mit den Exit-Codes macht

| Feld | Inhalt |
|---|---|
| `match_summary`-Ereignis | wie bisher `entityId`, `exitCode` (Rohtoken), `score` |
| `gameState.exitCodes` | `{ Entity-Kennung: Exit-Code }` für das laufende/zuletzt gelaufene Match |
| `gameState.exitCodesSeen` | die **verschiedenen** Exit-Codes dieses Matches, sortiert — z. B. `["01"]` oder `["01","02","17"]` |
| `match_end`-Ereignis | trägt beide zusätzlich mit, plus `endSource` |

Der Exit-Code wird als **Rohtoken** geführt (`"01"`, nicht `1`): die führende
Null ist Teil der Beobachtung. Fremddaten — auf kurze alphanumerische Tokens
begrenzt, damit sie weder Markup noch ein CSV-Trennzeichen transportieren
können. `0100` (Mission-Start) leert beide Felder, ein Match erbt also nichts
vom vorigen.

---

## Typ-7 (SM5-Endblock) im Detail

`7  <id>  <23 benannte Felder>`

**Die Feldzahl wird gern verwechselt.** Es sind **24 Felder** — `id` plus 23
benannte Statistikfelder — und mit der vorangestellten Typ-Spalte ergeben sich
**25 Tabulator-Spalten**. Die 23 benannten Felder beginnen also erst nach `7`
und `id`, ab Spaltenindex 2.

Typ-7-Zeilen kommen je Entity einmal am Matchende, **vor** `0101`. In Laserball
gibt es sie nicht.

> ### Im Standardmodus (Nummer 7) gibt es **keine** Typ-7-Zeilen
>
> **Gemessen, nicht vermutet.** In vier vollständigen Mitschnitten echter
> Standardspiele vom 19.09.2026 — zusammen 42 870 Zeilen, 141 Spieler, jedes
> Spiel regulär mit `0101` beendet — steht **keine einzige** Typ-7-Zeile. Der
> Endblock, den die Fremdquelle für SM5 beschreibt, kommt in diesem Modus nie.
>
> **Die Folge für den Betrieb:** alles, was ausschließlich aus Typ 7 stammt,
> bleibt im Standardmodus **dauerhaft leer** — das sind
>
> - `livesLeft` (Leben),
> - `shotsLeft` (Munition),
> - die **amtliche** Trefferquote `accuracy` samt `shotsFired`/`shotsHit` aus
>   der Anlagenrechnung.
>
> Was stattdessen angezeigt und geschrieben wird, sind die **Live-Zähler** von
> lf_live aus dem Ereignisstrom. Sie tragen `statsSource: "live"`,
> `accuracySource: "live"` und `accuracyIsEstimate: true`. Eine Korrektur am
> Matchende findet **nicht** statt, weil es nichts gibt, womit korrigiert werden
> könnte.
>
> **Das ist kein Fehler und keine kaputte Anlage.** Leere Felder in einem
> Standardspiel sind der Normalfall. Wer sie für einen Ausfall hält, sucht an
> der falschen Stelle. Dasselbe in Betreibersprache steht in
> [GAMEMODES.md](GAMEMODES.md#warum-im-standardmodus-leben-munition-und-trefferquote-leer-bleiben).
>
> **Warum `shotsFired` dadurch zu niedrig bleibt.** Laserforce meldet keinen
> eigenen Schuss-Event; lf_live kann nur die Schüsse zählen, die als Treffer
> oder Fehlschuss sichtbar werden. In SM5 korrigiert der Typ-7-Block das am
> Ende. Im Standardmodus bleibt es bei der **Untergrenze**.

**Die Zeile hat keine `time`-Spalte** — Spalte 1 ist die Entity-ID, nicht die
Spielzeit. lf_live lässt `elapsedTime` bei Typ-7-Zeilen deshalb bewusst unberührt.

### Feldreihenfolge (Positions-Rückfall)

Diese Reihenfolge stammt aus der lfstats-`TDF_Spec` und wird **nur** verwendet,
wenn die Anlage keine `;`-Schema-Zeile für Typ 7 geschickt hat. **Eine
Schema-Zeile der Anlage hat immer Vorrang vor dieser Liste** — genau dafür ist
die Schema-Auswertung da.

| Spalte | Feld | Spalte | Feld |
|---|---|---|---|
| 0 | (Zeilentyp `7`) | 13 | `scoutRapid` |
| 1 | `id` | 14 | `lifeBoost` |
| 2 | `shotsHit` | 15 | `ammoBoost` |
| 3 | `shotsFired` | 16 | `livesLeft` |
| 4 | `timesZapped` | 17 | `shotsLeft` |
| 5 | `timesMissiled` | 18 | `penalties` |
| 6 | `missileHits` | 19 | `shot3Hit` |
| 7 | `nukesDetonated` | 20 | `ownNukeCancels` |
| 8 | `nukesActivated` | 21 | `shotOpponent` |
| 9 | `nukesCancelled` | 22 | `shotTeam` |
| 10 | `medicHits` | 23 | `missiledOpponent` |
| 11 | `ownMedicHits` | 24 | `missiledTeam` |
| 12 | `medicNukes` | | |

Die Spalten 2 bis 24 sind die 23 benannten Felder; mit `id` ergeben sich die oft
zitierten „24 Felder" und mit der Typ-Spalte 25 Tabulator-Spalten. Schickt eine
Anlage mehr Spalten, sind sie hier nicht benannt und lassen sich ausschließlich
über eine Schema-Zeile zuordnen.

### Was lf_live damit macht

1. Alle Werte landen **roh** unter `players[id].official`. Unbekannte
   Zusatzfelder aus einer Schema-Zeile werden mitgenommen, nichts wird verworfen.
2. Die Felder mit eindeutiger Entsprechung **überschreiben** die SM5-Live-Zähler.
3. `players[id].statsSource` wechselt von `live` auf `tdf7`.
4. Ein `sm5_stats`-Ereignis wird ausgegeben.

Welches Feld welchen Zähler überschreibt und warum die Live-Zahlen davor eine
Untergrenze sind, steht in
[GAMEMODES.md](GAMEMODES.md#warum-die-sm5-live-zahlen-eine-untergrenze-sind).

---

## Typ-4-Event-Codes: gemeinsame Match-Steuerung

Diese Codes gelten für **alle** Modi (`mode: 'all'`).

| Code | Label | Kategorie | Bedeutung | Status |
|---|---|---|---|---|
| `0100` | Mission Start | match | Beginnt die Mission bei t=0; startet die Spieluhr. Der Parser leert Spielerliste, Ball und Events. | verified |
| `0101` | Mission End | match | Beendet die Mission (`endReason: mission_end`). In Laserball zusätzlich alle Spieler-Status → 0. Tatsächliche Dauer = dieser Zeitstempel. **Ob die Anlage es auch beim Beenden von Hand schickt, ist nicht belegt** — siehe [Wann ein Match als beendet gilt](#wann-ein-match-als-beendet-gilt). | verified |
| `0201` | Miss | combat | Schuss/Wurf ins Leere. Sehr häufig, kein Score. Kommt in SM5 **und** Laserball vor. | verified |
| `0900` | Achievement | other | Ingame-Achievement abgeschlossen. Rein informativ. | verified |
| `0902` | Reward | other | Standort-Belohnung (z. B. Freispiel). Rein informativ. TDF ab v2.005. | verified |
| `0901` | Achievement/Reward (Variante) | other | (unbestätigt) Nur in der lfstats-Laserball-Simulation neben `0900`/`0902` in der Ignorier-Liste; genaue Bedeutung unbekannt. | unverified |

---

## Typ-4-Event-Codes: Space Marines 5

Modus-Nummer `5`. **Keine `11xx`-Codes.** Quelle: lfstats `docs/TDF_Spec.md`
(Versionen 2.000–2.006) plus `apps/chomper/src/simulator.ts`. Score-Deltas in
Klammern sind aus der Spezifikation, nicht von lf_live gezählt.

| Code | Label | Kategorie | Bedeutung | Status |
|---|---|---|---|---|
| `0201` | Miss | combat | Fehlschuss, kein Treffer. Kein Score. | verified |
| `0202` | Gen Miss | combat | Fehlschuss auf ein angeschlagenes Nicht-Spieler-Ziel; setzt dessen 3-Treffer-Zähler auf 0. | verified |
| `0203` | Target Hit | combat | Treffer auf Nicht-Spieler-Ziel (`@NNN`); 3 Treffer in Folge zerstören es. | verified |
| `0204` | Target Destroy | score | 3. Treffer zerstört das Ziel. Actor +1001. | verified |
| `0205` | Player Hit | combat | Spieler beschädigt, nicht deaktiviert. Actor ±100, Ziel −20. | verified |
| `0206` | Player Deactivate | combat | Trefferpunkte des Ziels auf 0 → Deaktivierung + Respawn. Score wie `0205`. | verified |
| `0209` | Warbot Deactivate | combat | Warbot deaktiviert einen Spieler: −1 Leben. Kein Score, zählt nicht als `timesZapped`. | verified |
| `0300` | Missile Lock | combat | Actor schaltet auf ein Ziel auf; geht jedem Raketenschuss voraus. | verified |
| `0301` | Missile Miss vs Target | combat | Rakete verfehlt Nicht-Spieler-Ziel; 3-Treffer-Zähler zurück. | verified |
| `0303` | Missile Destroy Target | score | Rakete zerstört Nicht-Spieler-Ziel in einem Schlag. Actor +1001. | verified |
| `0304` | Missile Miss vs Player | combat | Rakete verfehlt einen Spieler. Kein Score. | verified |
| `0306` | Missile Hit Player | combat | Rakete deaktiviert einen Spieler in einem Schlag. Actor ±500, Ziel −100. | verified |
| `0308` | Missile Hit Player (Eigenbeschuss) | combat | Raketen-Eigenbeschuss; Ziel immer Mitspieler. Actor −500, Ziel −100. | verified |
| `0400` | Rapid Fire Activate | special | Scout aktiviert Dauerfeuer (10 SP). Endet implizit bei Ammo-Resupply (`0500`). | verified |
| `0404` | Nuke Activate | special | Commander startet Nuke-Sequenz (20 SP). | verified |
| `0405` | Nuke Detonate | special | Nuke detoniert: Gegnerteam −3 Leben, sofort deaktiviert. Commander +500. | verified |
| `0500` | Ammo Resupply | player | Munition für **einen** Mitspieler (Ammo Carrier oder Notfall-Beacon). Ziel 8 s deaktiviert. Kein Score. | verified |
| `0502` | Lives Resupply | player | Leben für **einen** Mitspieler (Medic oder Notfall-Beacon). Ziel 8 s deaktiviert. Kein Score. | verified |
| `0510` | Team Ammo Resupply | player | Ammo-Carrier-Spezial (15 SP): Munition für alle aktiven Mitspieler, ohne Deaktivierung. | verified |
| `0512` | Team Lives Resupply | player | Medic-Spezial (10 SP): Leben für alle aktiven Mitspieler, ohne Deaktivierung. | verified |
| `0600` | Penalty | player | Schiedsrichter-Strafe. `actor` = bestrafter Spieler; wird deaktiviert. Score-Abzug = `penalty` aus Zeile 1 (meist 0). Erzeugt Zeile 5 + Zeile 9. | verified |
| `0900` | Achievement | other | Rein informativ. | verified |
| `0902` | Reward | other | Rein informativ. Ab v2.005. | verified |
| `0B00` | Beacon Claim | special | Finaler (3.) Treffer auf ein Beacon-Ziel. Sollte in normalem SM5 nicht auftreten (nur bei aktiven Beacons aus anderem Modus). | verified |
| `0B03` | Base Award | score | Bei vorzeitigem Spielende durch Team-Elimination wird ein Ziel automatisch einem Spieler des Siegerteams zugesprochen. +1001. | verified |

`0100` / `0101` siehe [gemeinsame Match-Steuerung](#typ-4-event-codes-gemeinsame-match-steuerung).

---

## Typ-4-Event-Codes: Standardmodus (Nummer 7) — an der eigenen Anlage gemessen

Modus-Nummer `7`, Anzeigename der Anlage `| Standard LZ - 2 Teams |`, Familie
`sm5`. **Einzige Quelle: vier vollständige Roh-Mitschnitte vom 19.09.2026**
(42 870 Zeilen, 141 Spieler, jedes Spiel regulär mit `0101` beendet). Keine
Fremdquelle kennt diese Codes.

> **Die Mitschnitte selbst liegen nicht im Repository und dürfen es nie.** Sie
> enthalten echte Spielernamen und weltweit eindeutige Laserforce-Mitglieds-IDs.
> **Sämtliche Kennungen, Namen und Mitgliedsnummern in dieser Datei, in
> `src/eventCatalog.js` und in `scripts/check.js` sind erfunden** und nur in der
> gemessenen *Form* nachgebildet. Nur die Zahlen — Häufigkeiten, Anteile,
> Zeitabstände — stammen aus den Mitschnitten.

Der komplette SM5-Satz oben gilt hier unverändert mit; die Tabelle listet **nur
das, was zusätzlich vorkommt**. Die Anlage schickt zu jedem Code ein **deutsches
Klartext-Verb** in derselben Zeile mit — daraus, und aus Häufigkeit, Actor/Ziel,
Teamzugehörigkeit, Punktezeilen und Spieler-Zuständen, stammen die Deutungen
unten. Nichts davon ist geraten; wo die Daten nichts hergeben, steht das da.

| Code | Klartext der Anlage | Label | Kategorie | Gesamt | Bedeutung und Beleg | Status |
|---|---|---|---|---|---|---|
| `0208` | `<#A> " phasert " <#B>` | Player Hit (Eigenbeschuss) | combat | **48** | **Eigenbeschuss.** 48 von 48 Vorkommen zwischen Spielern **desselben** Teams, während `0205`/`0206` in denselben Mitschnitten **5333 von 5333** Mal gegnerische Teams betrafen. Actor **−50** (48 von 48 Punktezeilen), Ziel ohne Punktezeile. Deaktiviert in der Regel nicht: nur 11 von 48 Zielen gingen binnen 1,5 s in Zustand ≠ 0 (Vergleich `0205`: 68/142, `0206`: 4688/5191). | **verified** |
| `0402` | `<#A> " aktiviert Unverwundbarkeit"` | Unverwundbarkeit aktiviert | special | **38** | Nur Actor, kein Ziel, **keine** Punktezeile (38/38). 11 verschiedene Akteure über **alle** Login-Level 0–3 → keine rollen- oder levelgebundene Fähigkeit. Bei 8 von 38 steht auf demselben Zeitstempel ein `0E00` „wird zum Held befördert" desselben Spielers — ob der Rang die Fähigkeit auslöst, ist damit **nicht** belegt. | **verified** |
| `0408` | `<#A> " aktiviert Vergeltung"` | Vergeltung aktiviert | special | **31** | Nur Actor, kein Ziel, **keine** Punktezeile (31/31), und nur in **zwei** der vier Mitschnitte. Beide beobachteten Akteure hatten Login-Level 3 — bei **genau zwei** verschiedenen Spielern ist daraus keine Rollenbindung abzuleiten, und sie wird hier auch nicht behauptet. | **verified** |
| `0700` | `"Zustand von " <@Z> " ist kritisch"` | Generator kritisch | special | **13** | **Kein Actor** — das erste Feld hinter dem Code ist Text. Das Ziel war in allen 13 Fällen dieselbe Nicht-Spieler-Entity `@30` (`generator-target`, Name „Generator", Team 2). Keine Punktezeile. | **verified** |
| `0701` | `<#A> " wurde verstrahlt"` | Verstrahlung | combat | **212** | Nur Actor, kein Ziel, **keine** Punktezeile (212/212). **Folgt immer auf `0700`:** kleinster gemessener Abstand zur vorangehenden Generatorwarnung 8025 ms, größter 23 933 ms — und **jede** der 13 Warnungen zog genau **eine** Serie nach sich (13 Serien, je rund 14 s, Wiederholung je Spieler im Median 5,4 s). In 193 von 212 Fällen geht der Spieler binnen 500 ms in Zustand ≠ 0, wird also deaktiviert. | **verified** |
| `0D05` | `<#A> " blastet " <#B>` | Blast (Treffer) | combat | **1** | **Genau ein** Vorkommen. Gleiches Verb wie `0D06`, Ziel im Gegnerteam, Actor +110, Ziel ohne Punktezeile — aber das Ziel ging **nicht** in Zustand ≠ 0. Das legt dasselbe Verhältnis wie `0205`:`0206` nahe (Treffer ohne Deaktivierung). Bei n=1 **nicht belegt**. | **unverified** |
| `0D06` | `<#A> " blastet " <#B>` | Blast (Deaktivierung) | combat | **78** | 78 von 78 gegen **gegnerische** Teams. Actor bekommt eine Punktezeile im selben Bereich wie `0206` (gemessen +60 bis +140), Ziel keine. In **75 von 78** geht das Ziel binnen 1,5 s in Zustand ≠ 0 (Vergleichswert `0206`: 4688/5191) → Deaktivierung. **Mehrere Ziele auf demselben Zeitstempel** (beobachtet bis zu 2) → Mehrfach-/Flächentreffer. | **verified** |
| `0E00` | `<#A> " wird zum " <Rang> " befördert"` | Beförderung | other | **25** | Nur Actor, kein Ziel, **keine** Punktezeile (25/25). Der **Rang steht als eigenes Feld** zwischen den beiden Textteilen; lf_live liest ihn dort heraus (`evt.rank`) — aber nur, wenn die Zeile TAB-getrennt ankam, sonst ist die Feldgrenze nicht bestimmbar. Beobachtete Ränge: Schütze 9×, Held 7×, Unsterblicher 5×, Raketenliebhaber 4×. **Welche Wirkung ein Rang hat, geben die Daten nicht her.** | **verified** |

**Was lf_live daraus macht.** Alle acht bekommen einen eigenen Ereignistyp
(`player_hit`, `player_deactivate`, `invulnerability`, `retaliation`,
`generator_critical`, `irradiated`, `promotion`) statt wie bisher als generisches
`lf_event` durchzulaufen. Sie **verändern keinen Zustand und keinen Zähler** —
genau wie `0400`/`0500` vorher: `_emitAuxEvent()` schreibt nie in `gameState`.

**Bewusst NICHT gemacht:** `0208` und `0D06` fließen **nicht** in `shotsFired`,
`shotsHit` oder `deactivations` ein. Ob die Anlage einen Eigenbeschuss als
Treffer zählt und wie sie einen Blast verbucht, steht in ihrer eigenen
Endabrechnung — und die gibt es in diesem Modus nicht (Typ 7 fehlt). Es gibt
also nichts, woran sich eine solche Zuordnung prüfen ließe, und geraten wird
hier nicht. Ebenso bleibt `0D06` aus der Serien-Erkennung
(„Hinterherlaufen", `CHASE_TAG_CODES` = `0205`/`0206`) heraus: das ist eine
eingeführte fachliche Regel, und 78 Ereignisse gegen 5333 würden sie nur
verwackeln.

### Unbekannte Codes beschriften sich künftig selbst

Die Schema-Zeile für Typ 4 lautet schlicht `;4/event  time  type  varies` — der
Rest der Zeile ist **frei**. Eine echte Anlage füllt ihn mit Entity-Verweisen
und **deutschem Klartext** im Wechsel:

```
4 ⇥ 0000196 ⇥ 0D06 ⇥ #jJ9kK0lL ⇥ " blastet " ⇥ #mM1nN2oO
4 ⇥ 0109912 ⇥ 0E00 ⇥ #gG7hH8iI ⇥ " wird zum " ⇥ Held ⇥ " befördert"
4 ⇥ 0002482 ⇥ 0700 ⇥ "Zustand von " ⇥ @30 ⇥ " ist kritisch"
```

**Jede Halle darf eigene Spielmodi anlegen.** Ein Katalog kann deshalb nie
vollständig sein — die Anlage aber liefert die Bedeutung ihrer eigenen Codes
selbst mit. lf_live nutzt das jetzt: `eventCatalog.streamPhrase()` ersetzt jeden
Verweis mit `#`/`@` durch den aufgelösten Spielernamen (unbekannte bleiben roh
stehen) und nimmt alles andere **wörtlich**. Aus `Event 0F00: A -> B` wird so
„Anna blastet Bert" — **ohne dass irgendetwas geraten wird**, denn die Worte
sind die der Anlage.

Grenzen, bewusst eng gezogen:

- Der Selbsttext greift **nur**, wenn der Katalog den Code nicht kennt. Eine
  dokumentierte Formulierung wird nie überschrieben.
- Der Text ist **Fremdeingabe** von einem unauthentifizierten TCP-Feed: er wird
  von Steuerzeichen befreit, auf eine Zeile normalisiert und auf 160 Zeichen
  gekürzt, bevor er in Log, CSV oder Konsole landet.
- Er beschriftet, er **deutet nicht**: kein Zähler, kein Punktestand, kein
  Zustand hängt daran. Ein neuer Code bleibt fachlich unbekannt — er ist nur
  nicht mehr unlesbar.

---

## Typ-4-Event-Codes: Laserball

Modus-Nummer `28` (`Laserball Ranked`). Eigener `11xx`-Codesatz; Zeilenlayout wie
SM5. Quellen: lfstats `docs/Laserball_TDF_Spec.md` + `apps/chomper/src/laserball/`
(`types.ts` `LB_EVENT`, `simulator.ts`) **und** — unabhängig davon — das originale
`lf_overlay/server.js`. Die **fett** markierten wertet der aktuelle Parser aus.

| Code | Label | Kategorie | Bedeutung | Status |
|---|---|---|---|---|
| `0201` | Miss | combat | Fehlwurf ins Leere. Kein Score, nicht im Replay-Log. | verified |
| **`1100`** | Pass | possession | Ball zu einem Mitspieler. Ball → Ziel, Assist-Fenster (10 s). | verified |
| **`1101`** | Tor | score | Actor erzielt ein Tor; erzeugt genau eine Zeile 5 (`delta = 1`). Assist bei Pass/Clear ≤ 10 s zuvor an den Schützen. | verified |
| **`1102`** | Tor (Variante) | score | (unbestätigt) Zweiter Tor-Code (lfstats-Konstante `GOAL_B`). Beide Quellen behandeln ihn sicherheitshalber wie ein Tor, in Beispieldaten nie beobachtet. | unverified |
| **`1103`** | Steal | possession | Actor nimmt einem Gegner den Ball ab. Ball → Actor. | verified |
| **`1104`** | Block | combat | Actor taggt/blockt einen Spieler. lf_live wertet es als **Reset**, wenn das Ziel Status 2 hat, sonst als **Block**. | verified |
| `1105` | Round Start | match | Beginn einer Ballbesitz-Runde. Parser: als `round_start`-Event ausgegeben, keine Rundenstatistik. | verified |
| **`1106`** | Round End | match | Ende einer Runde; Ball wird frei. | verified |
| **`1107`** | Get Ball | possession | Actor bekommt bei Rundenstart den Ball. Ball → Actor. | verified |
| **`1108`** | Ball Timeout | possession | Ball zu lange gehalten; Ballbesitz endet, Ball frei. | verified |
| **`1109`** | Clear | possession | Defensiver Clear/Pass. Ball → Ziel, Assist-Fenster. | verified |
| **`110A`** | Failed Clear | possession | Clear-Versuch fehlgeschlagen. | verified |
| `110B` | Target Reset (self) | combat | Actor hat sein eigenes Ziel resettet. Parser: als `reset`-Event ausgegeben; kein `resetsDone`-Zähler. | verified |
| `110C` | Target Reset (player) | combat | Ziel-Spieler wurde resettet. Parser: als `reset`-Event ausgegeben; kein Zähler. | verified |
| `0900` / `0901` / `0902` | Achievement | other | Informativ; nicht interpretiert, nicht gespeichert. `0901` unbestätigt. | verified / unverified |

`0100` / `0101` siehe [gemeinsame Match-Steuerung](#typ-4-event-codes-gemeinsame-match-steuerung).
`actor`/`target` werden aus Tokens mit führendem `@`/`#` gelesen.

---

## Typ-4-Event-Codes: 7SM / Nexus

**Keine belastbare Quelle gefunden.** Weder lfstats noch das originale `lf_overlay`
noch andere öffentliche TDF-Parser dokumentieren einen eigenen Event-Codesatz für
7SM (Nexus). Anhaltspunkte:

- 7SM/Nexus läuft auf derselben Laserforce-Firmware wie SM5 und ist regelmechanisch
  eine SM5-Abwandlung → **sehr wahrscheinlich derselbe `0xxx`-Codesatz wie SM5**,
  evtl. mit zusätzlichen modus-spezifischen Codes.
- Die Modus-Nummer in Zeile 1 (`type`) ist **unbekannt** (nicht `5`, nicht `28`).

Bis eine echte 7SM-Aufzeichnung vorliegt: **als SM5 behandeln** und jede
Abweichung mit `scripts/inspect.js` katalogisieren. Alle 7SM-spezifischen Codes
gelten als `unbestätigt`.

Genau so verhält sich lf_live: eine unbekannte Modus-Nummer läuft als Familie
`sm5` — siehe [Modus-Erkennung](#modus-erkennung) und [GAMEMODES.md](GAMEMODES.md).

---

## Spielvarianten

Laserforce kennt zahlreiche SM5-Varianten (Attack & Defend, Zombies, VIP,
Kill Confirmed, Zone Control / Domination, Highlander, 2v2, Junior, …). Öffentlich
liegt **keine** Aufschlüsselung eigener Event-Codes je Variante vor.

| Variante | Annahme | Status |
|---|---|---|
| Attack & Defend, Highlander, 2v2, Junior u. a. reine Regelvarianten | Nutzen den **SM5-Codesatz** unverändert; Unterschiede stecken in Regeln/Dauer/Scoring, nicht im Log-Format. | unbestätigt |
| Zombies | Vermutlich SM5-Codesatz + evtl. modus-spezifische Codes für „Infektion". Kein Code bekannt. | unbestätigt |
| VIP | Vermutlich SM5-Codesatz; ein „VIP down"-Marker könnte über einen der `0xxx`-Codes oder Zeile 6 laufen. Kein Code bekannt. | unbestätigt |
| Kill Confirmed / Zone Control / Domination | Vermutlich SM5-Codesatz + Zonen-/Bestätigungs-Codes. `0B00`/`0B03` (Beacon/Base) könnten hier regulär auftreten. Nicht verifiziert. | unbestätigt |
| Laserball-Varianten | Nutzen den `11xx`-Codesatz (Modus `28`). | verified |

**Kurz:** die meisten Varianten teilen sich den SM5-Codesatz. `eventCatalog.js`
bildet daher nur `sm5` / `laserball` / `all` ab; Varianten werden auf `sm5`
gemappt. Modus-spezifische Sonder-Codes sind eine offene Lücke (siehe unten).

---

## Modus-Erkennung

Aus Protokollsicht kurz zusammengefasst — die ausführliche Betriebsanleitung
steht in [GAMEMODES.md](GAMEMODES.md).

| Merkmal | Aussagekraft |
|---|---|
| **`type` in der Typ-1-Zeile** | Das Primärmerkmal. `5` = SM5, `28` = Laserball Ranked, alles andere unbekannt. Liegt ab der ersten Zeile der Mission vor. |
| **`11xx`-Codes** | Beweisen Laserball. lf_live stellt die Familie zur Laufzeit darauf um, falls die Typ-1-Zeile etwas anderes sagte oder fehlte. |
| **`02xx`–`06xx`, `0Bxx`** | Sprechen für SM5. Sie stellen die Familie ebenfalls um — aber **nie**, wenn die Modus-Nummer `28` ist. |
| **`0100`, `0101`, `0201`, `09xx`** | Kommen in **beiden** Familien vor und taugen nicht zur Unterscheidung. `0201` insbesondere ist in Laserball der Fehlwurf. |
| **Fehlende Typ-7-Zeilen** | *Sekundärmerkmal.* Fehlen in einer Mission Typ-7-Zeilen völlig, **spricht das gegen SM5** — SM5 schickt am Matchende je Spieler eine, Laserball gar keine. Die Einschränkung: das steht erst **am Matchende** fest und taugt deshalb nicht zur Erkennung während des Spiels, sondern nur zur nachträglichen Auswertung einer Aufzeichnung. Genau dafür weist `scripts/inspect.js` die Typ-7-Zahl je Modus aus. |

---

## Assist-Fenster & Ballbesitz

- **Assist-Fenster (Laserball):** 10 000 ms. Ein Tor (`1101`/`1102`) zählt einen
  Assist für den letzten Passer/Clearer, wenn dessen `1100`/`1109` an den Schützen
  ≤ 10 s zurückliegt. Nach `1101`/`1102`/`1103` wird die Pass-Historie geleert.
- **Ballbesitz (Laserball):** ein einzelner `ballHolderId` wird geführt. Gewinn bei
  `1107` (Actor), `1100`/`1109` (Ziel), `1103` (Actor). Verlust (Ball frei) bei
  `1101`, `1102`, `1106`, `1108`. Bei `0101` wird der Ball ebenfalls frei.
- **Reset vs. Block (`1104`):** hängt vom `status` des Ziels ab — Status 2 → Reset,
  sonst Block. Der Status kommt aus Zeile 9.

Objekt-Formen: [API.md](API.md).

---

## Wann ein Match als beendet gilt

**Das `0101` ist nicht verlässlich.** Beendet der Spielleiter die Mission an der
Anlage von Hand, ist bisher nicht belegt, dass überhaupt eines kommt — die
Dokumentation behauptet es, gemessen wurde es nie. lf_live verlässt sich deshalb
nicht darauf: ein Match kann auf **vier** Wegen enden, und jeder trägt seine
Begründung mit.

| `endReason` | Auslöser | Schwellwert |
|---|---|---|
| `mission_end` | Typ-4-Code `0101` von der Anlage. Gewinnt immer. | sofort |
| `watchdog` | **keine einzige Zeile** mehr von der Anlage — oder die erkannte Endabrechnung (Typ 6/7) ist verstrichen, ohne dass ein `0101` kam | `matchEnd.watchdogSeconds` (120 s) bzw. `matchEnd.endBlockSeconds` (10 s) |
| `stream_lost` | die TCP-Verbindung ist mitten im Match weg und kommt nicht zurück | `matchEnd.streamLostSeconds` (30 s) |
| `next_match` | ein `0100` kam, während das vorige Match noch lief | sofort |
| `shutdown` | der Dienst wurde beendet, während ein Match lief | sofort |

Der Zustand führt dazu `gameState.endReason` (einer der Werte oben oder `null`)
und `gameState.endedAt` (Zeitstempel in ms oder `null`). **`null` heißt: es läuft
eines oder es lief noch keines** — nur dann darf eine Anzeige die Uhr
weiterzählen lassen. Dieselben zwei Felder stehen unter `match` in
`GET /api/status`, und das `match_end`-Ereignis trägt `reason`.

### `endSource` — wodurch das Ende erschlossen wurde

`endReason` sagt, **warum** ein Match als beendet gilt. Das reicht nicht: der
Wert `watchdog` steht für **zwei völlig verschiedene Beobachtungen** — „die
Endabrechnung wurde erkannt und die Frist lief ab" und „von der Anlage kam gar
keine Zeile mehr". Für die Auswertung der Mitschnitte ist genau dieser
Unterschied der interessante. Deshalb führt der Zustand zusätzlich
`gameState.endSource`, und das `match_end`-Ereignis trägt ihn mit:

| `endSource` | `endReason` | Bedeutung |
|---|---|---|
| `0101` | `mission_end` | die Anlage hat den Mission-End-Code selbst geschickt |
| `summary_type6` | `watchdog` | **alle** Entities hatten eine Typ-6-Zeile gemeldet; kein `0101` kam nach |
| `summary_type7` | `watchdog` | ein SM5-Typ-7-Endblock kam; kein `0101` kam nach |
| `silence` | `watchdog` | keine einzige Zeile mehr — der eigentliche Watchdog |
| `stream_lost` | `stream_lost` | die TCP-Verbindung kam nicht zurück |
| `next_match` | `next_match` | ein `0100` beendete das vorige Match |
| `shutdown` | `shutdown` | der Dienst wurde beendet |

`endReason` ist unverändert und bleibt der Vertrag, auf den bestehende
Konsumenten bauen. `endSource` ist **rein additiv**: eine Diagnose, kein
Steuerwert.

Alle drei Fristen sind in der Konsole und per `.env` einstellbar, **`0` schaltet
den jeweiligen Weg ab** ([CONFIG.md](CONFIG.md)) — für den Fall, dass eine Anlage
sich anders verhält als hier beschrieben.

### Endabrechnung ≠ einzelne Elimination

Die Reihenfolge am Matchende ist — gemessen an vier echten Mitschnitten —
**`0101` zuerst, danach der Typ-6-Block**; Typ 7 kommt im Standardmodus gar
nicht (Belege oben in
[Reihenfolge im echten Betrieb](#zeilentypen-09)). Die Endabrechnung ist damit
**nicht** das erste Signal, sondern der **Ersatzweg** für den Fall, dass kein
`0101` kommt. Eine **einzelne** Typ-6-Zeile bedeutet ohnehin nur, dass *eine*
Entity ausgeschieden ist, und das passiert mitten im Spiel — belegt: im
Mitschnitt von 02:13:07 steht eine solche Zeile gut 200 Zeilen vor dem `0101`.
Sie darf das Match **auf keinen Fall** beenden. Unterschieden wird deshalb so:

- **Typ 7** kommt ausschließlich am Matchende (und nur in SM5). Eine einzige
  Zeile genügt als Signal.
- **Typ 6** zählt über die **Vollständigkeit**, und über nichts anderes:

  > Eine Endabrechnung liegt vor, wenn **jede** Entity dieses Matches eine
  > Typ-6-Zeile gemeldet hat — **gleich welchen Exit-Code sie trug**.

  Der Exit-Code ist als Prüfstein ausgeschieden: bis dahin verlangte die Regel
  `02` („Ende"), und an einer echten Anlage endet ein reguläres Standardspiel
  mit `01` (→ [Die Exit-Codes der Typ-6-Zeile](#die-exit-codes-der-typ-6-zeile--unbestätigt)).
  Dort hätte die Erkennung nie gegriffen. Der Code wird jetzt nur noch
  **festgehalten**.

  **Warum die Vollständigkeit trotzdem nicht schwächer ist.** Eine Entity meldet
  genau **einmal**. Wer mitten im Spiel ausscheidet, meldet *dann*; die übrigen
  melden am Ende. Zählt man jede Meldung in dieselbe Menge, ist
  „Meldungen ≥ Entities" arithmetisch exakt dieselbe Bedingung, die der Code
  vorher als „Exit-02-Meldungen ≥ Entities − vorher Ausgeschiedene" schrieb —
  nur ohne den Exit-Code-Filter davor. Die vorher Ausgeschiedenen werden also
  weiterhin abgezogen; sie stehen jetzt als „hat bereits gemeldet" statt als
  „fällt weg" in der Rechnung. Ein einzelner Kick mitten im Spiel ist nach wie
  vor **eine** Meldung von N und beendet nichts. So deckt die Regel auch
  Laserball ab, wo es keine Typ-7-Zeilen gibt.

  **Die Mindestzahl von zwei Entities ist entfallen.** Für jedes Match mit zwei
  oder mehr Entities war sie ohnehin die schwächere der beiden Bedingungen — die
  Vollständigkeit verlangt dort mehr. Für ein Match mit **einer** Entity (selten,
  aber möglich) machte sie die Regel dagegen wirkungslos: die Endabrechnung war
  dort nie erkennbar und jedes solche Match lief in den Watchdog. Und bei genau
  einer Entity fallen die beiden Lesarten ihrer Typ-6-Zeile zusammen — ob
  hinausgeworfen oder regulär beendet, es ist niemand mehr da, der spielt.
- Das Erkennen **beendet nichts**, es setzt nur eine Frist von
  `matchEnd.endBlockSeconds`. Kommt das `0101` — es folgt im echten Betrieb
  Millisekunden später —, gewinnt es und die Begründung ist `mission_end`.
- Kommt danach noch ein Spiel-Ereignis (Typ 4) oder eine Punktezeile (Typ 5),
  war es doch keine Endabrechnung: die Frist wird wieder verworfen. **Das ist
  der eigentliche Schutz** — eine zu früh erkannte Endabrechnung wird durch
  weiterlaufendes Spiel von selbst wieder aufgehoben.

Ein zu spät beendetes Match ist ärgerlich, ein fälschlich mitten im Spiel
beendetes wäre schlimmer — im Zweifel läuft es weiter und der Watchdog fängt es.

Die fünf Fälle, die `scripts/check.js` (`engine.matchEnd`) dauerhaft festnagelt:
ein einzelner Kick mitten im Spiel beendet **nichts**; mehrere Ausgeschiedene
nacheinander beenden **nichts**, solange noch jemand aktiv ist; melden am Ende
alle Verbliebenen, wird die Endabrechnung erkannt und die Frist läuft; ein
danach eintreffendes `0101` gewinnt mit `mission_end`; ein danach eintreffendes
Spielereignis verwirft die Frist. Dazu die Beobachtung des Betreibers
(alle melden `01`) und ein Fall mit gemischten Exit-Codes in derselben
Endabrechnung.

---

## Was lf_live daraus macht

### Zeilentypen

| TDF | → lf_live |
|---|---|
| `;`-Schema-Kommentar | Spaltennamen je Zeilentyp; **alle** Spalten unten werden darüber aufgelöst, Positionen nur als Rückfall |
| Zeile 0 | ⚪ ignoriert (Version nicht ausgewertet) |
| Zeile 1 (Mission) | `mode` (Nummer, Familie, Anzeigename) + `missionDesc`; `duration` und `durationKnown`; `mode_change`-Event |
| Zeile 2 | `teams[index] = {name, color}` |
| Zeile 3 (Spalte `type` = `player`) | Spieler angelegt; `player_join`-Event; zusätzlich `level`, `category`, `roleLabel`, `battlesuit`, `memberId` und die Zählerfelder der Familie |
| Zeile 5 (Score) | **autoritativer Punktestand** → `scores[team]` bzw. `players[id].score`, `scoreSource='tdf'`; zusätzlich weiterhin das `score`-Event mit `teamId`/`old`/`new`/`delta`. Schickt die Anlage keine Teamzeile, wird `scores[team]` aus den Spielerpunkten **summiert** — `teamScoreSource` sagt, wer gerechnet hat |
| Zeile 6 (Entity-Ende) | `match_summary`-Event mit `entityId`/`exitCode`/`score` (informativ, kein Zustandswechsel); der Exit-Code wird in `exitCodes`/`exitCodesSeen` festgehalten; zählt zusätzlich zur [Erkennung der Endabrechnung](#endabrechnung--einzelne-elimination) — **nie allein** |
| Zeile 7 (SM5-Endblock) | `players[id].official` (Rohwerte), überschreibt die SM5-Live-Zähler, `statsSource='tdf7'`, `sm5_stats`-Event; setzt die Frist der [Endabrechnung](#endabrechnung--einzelne-elimination) |
| Zeile 9 | `players[id].status`; `status`-Event |

### Typ-4-Codes: Laserball (`11xx`) — unverändert

| TDF | → lf_live |
|---|---|
| `0100` | `match_start`; `players`/`ballHolderId`/`events` geleert, Scores → 0, neue `matchId`, `scoreSource` und `teamScoreSource` → `internal`. **`mode` und `duration` bleiben stehen** (Typ 1 kam davor) |
| `0101` | `match_end` mit `reason: mission_end`; Ball frei; `endReason`/`endedAt` gesetzt |
| `1100` | `pass`; `passesDone/Received++`; Ball→target; Assist-Fenster (10 s) |
| `1109` | `clear`; `clearsDone/Received++`; Ball→target; Assist-Fenster |
| `1101` / `1102` | `goal`; `goals++`; Assist wenn Pass/Clear an Schützen ≤ 10 s zuvor. `scores[team]++` **nur solange `scoreSource === 'internal'`** |
| `1103` | `steal`; `stealsDone/Received++`; Ball→actor |
| `1104` | `block` bzw. `reset` (Ziel-Status 2) |
| `110A` | `failed_clear` |
| `1107` | Ball→actor |
| `1106` / `1108` | Ball frei (kein eigenes Event) |
| `1105` | `round_start`-Event (nur Event, keine „pro Runde"-Statistik) |
| `110B` / `110C` | `reset`-Event (explizit; zusätzlich zum aus `1104`+Status abgeleiteten Reset — State unverändert) |

### Typ-4-Codes: SM5 (`0xxx`) — neu gezählt

Diese Zählung läuft **nur**, solange die Modus-Familie `sm5` ist, und ist vom
`11xx`-Zweig strikt getrennt.

| TDF | → lf_live (Zähler) |
|---|---|
| `0201` / `0202` | Actor: `misses`, `shotsFired` |
| `0203` | Actor: `targetHits`, `shotsHit`, `shotsFired` |
| `0204` | Actor: `targetDestroys`, `shotsHit`, `shotsFired` |
| `0205` | Gegner: Actor `shotsHit`+`shotsFired`, Ziel `timesHit` · eigenes Team: Actor `shotTeam`+`shotsFired`, Ziel `timesHitByTeam` |
| `0206` | wie `0205`, zusätzlich Actor `deactivations`, Ziel `timesDeactivated` |
| `0209` | Ziel: `timesDeactivated` (Warbot — kein Actor-Credit) |
| `0300` | Actor: `missileLocks` |
| `0301` / `0304` | Actor: `missileMisses` |
| `0303` | Actor: `missileDestroys` |
| `0306` | Actor: `missileHits` · Ziel: `timesMissiled` |
| `0308` | Actor: `missileTeam` · Ziel: `timesMissiled` |
| `0400` | Actor: `rapidFires` |
| `0404` / `0405` | Actor: `nukesActivated` / `nukesDetonated` |
| `0500` | Actor: `ammoResupplies` · Ziel: `ammoReceived` |
| `0502` | Actor: `livesResupplies` · Ziel: `livesReceived` |
| `0510` / `0512` | Actor: `teamAmmoResupplies` / `teamLivesResupplies` |
| `0600` | Actor: `penalties` |
| `0B00` / `0B03` | Actor: `beaconClaims` / `baseAwards` |
| `0900` / `0901` | Actor: `achievements` |
| `0902` | Actor: `rewards` |

**`shotsFired` wird nur dort erhöht, wo die Tabelle es sagt** — Laserforce meldet
keinen eigenen „Schuss"-Event. Die Live-Zahl ist damit eine **Untergrenze**; der
Typ-7-Endblock korrigiert sie am Matchende. Ausführlich:
[GAMEMODES.md](GAMEMODES.md#warum-die-sm5-live-zahlen-eine-untergrenze-sind).

### Beschreibende Events

| TDF | → lf_live |
|---|---|
| SM5-`02xx`/`03xx`/`04xx`/`05xx`/`06xx`/`0Bxx`/`09xx` | eigenes Event (`miss`, `player_hit`, `missile_*`, `nuke_*`, `resupply`, `penalty` …), `category` aus `eventCatalog` |
| alle übrigen Typ-4-Codes | generisches `lf_event` mit `code`+`category`+`label` (abschaltbar: `LF_EMIT_UNKNOWN_EVENTS=false`) |

Diese beschreibenden Events sind **rein additiv** (seit v1.1): sie verändern
`gameState` nicht, lösen keinen State-Push aus und ändern kein bestehendes
Event. Für jeden Code, den der Kern-Parser schon vorher behandelt hat, ist sein
Verhalten unverändert — die neuen Zählungen laufen in einem getrennten Zweig.

`describe(code)` / `phrase(evt)` aus [`src/eventCatalog.js`](../src/eventCatalog.js)
liefern Label, Modus, Kategorie und einen deutschen Klartext-Satz zu **jedem**
Code (auch unbekannten) — ohne je zu werfen. Sie sind rein additiv und für
Anzeigen/Overlays gedacht.

---

## Bekannte Lücken / unbestätigt

Es ist **erwartet**, dass diese Liste Lücken hat. Alles hier ist entweder nicht
öffentlich dokumentiert oder nur schwach belegt.

| Thema | Was fehlt / unklar | Status |
|---|---|---|
| **7SM / Nexus** | Kein eigener Codesatz und keine Modus-Nummer bekannt. Annahme: = SM5. | unbestätigt |
| **SM5-Varianten** (Zombies, VIP, Kill Confirmed, Zone Control, Domination …) | Mögliche modus-spezifische Sonder-Codes (Infektion, VIP-down, Zonen-Capture) sind nirgends dokumentiert. | unbestätigt |
| **`1102` (Tor-Variante)** | Als Konstante `GOAL_B` in lfstats, aber in keiner Beispieldatei beobachtet. | unbestätigt |
| **`0901`** | Erscheint nur in einer Ignorier-Liste neben `0900`/`0902`; Bedeutung unbekannt. | unbestätigt |
| **Nicht belegte `0xxx`-Codes** | u. a. `0207`, `020A+`, `0302`, `0305`, `0307`, `0309+`, `0401`, `0403`, `0406`, `0407`, `0409+`, `0501`, `0503`–`0509`, `0511`, `0513+`, `0601+`, `0702`–`08FF`, `0B01`, `0B02`, `0B04+`, `0D00`–`0D04`, `0D07+`, `0E01+` sind in keiner Quelle beschrieben. `0208`, `0402`, `0408`, `0700`, `0701`, `0D05`, `0D06` und `0E00` sind seit dem 19.09.2026 **an der eigenen Anlage gemessen** — siehe [Standardmodus (Nummer 7)](#typ-4-event-codes-standardmodus-nummer-7--an-der-eigenen-anlage-gemessen). | Lücke |
| **`1000`–`10FF` / `12xx+`** | Kein `10xx`- oder `12xx`-Laserball-Code bekannt; nur `11xx` belegt. | Lücke |
| **Zeilentyp `8`** | Nicht dokumentiert, nicht beobachtet. | Lücke |
| **Score-Deltas** | Die `±100 / −20 / +1001 / +500`-Angaben stammen aus der lfstats-Spezifikation, nicht aus lf_live-Zählung. Gegen Zeile 5 der echten Anlage prüfen. | teils unbestätigt |
| **Explizite Resets `110B`/`110C`** | Codes belegt, Bedeutung/Auslöser nicht gegen echte Anlage verifiziert. Werden jetzt als `reset`-Event ausgegeben, fließen aber nicht in `resetsDone`/`resetsReceived` (die kommen weiter aus `1104`+Status). | teilweise |
| **`1105` Round Start** | Wird als `round_start`-Event ausgegeben, aber es gibt weiterhin keine „pro Runde"-Statistik. | offen |
| **Modus-Nummern außer `5`, `7` und `28`** | `7` ist seit dem 19.09.2026 an der eigenen Anlage gemessen (Standard, „| Standard LZ - 2 Teams |", Familie `sm5`) und steht in `modes/standard.json`. Sonst ist keine weitere Nummer belegt. 7SM/Nexus und sämtliche SM5- und Laserball-Varianten haben unbekannte Nummern und müssen an der eigenen Anlage ermittelt werden ([GAMEMODES.md](GAMEMODES.md#eigene-modus-nummern-ermitteln-und-eintragen)). | Lücke |
| **Typ-7-Feldreihenfolge** | Die 23 Feldnamen stammen aus der lfstats-`TDF_Spec` und sind nicht gegen eine echte Anlage geprüft. Eine `;`-Schema-Zeile der Anlage hat Vorrang und macht die Frage gegenstandslos. | teils unbestätigt |
| **Zuordnung Typ-7 → Live-Zähler** | Welches Typ-7-Feld welchen SM5-Live-Zähler überschreibt, ist aus den Feldnamen erschlossen (`shotOpponent` → `deactivations`, `timesZapped` → `timesDeactivated`, `missiledOpponent` → `missileHits`). Nicht verifiziert. | unbestätigt |
| **`shotsFired` live** | Laserforce meldet keinen Schuss-Event. Die Live-Zahl ist systematisch zu niedrig, bis der Typ-7-Block sie korrigiert. Für Laserball und für SM5-Zähler ohne Typ-7-Pendant bleibt es dabei. | bekannte Grenze |
| **Beschreibung endet auf einer Zahl** | Ohne Tabulatoren **und** ohne Schema-Zeile kann das letzte Token einer auf eine Zahl endenden Missionsbeschreibung verlorengehen. Mit Tabulator oder Schema-Zeile korrekt. | bekannte Grenze |
| **Offizieller Score / Endstand** | Zeile 5 ist jetzt die Autorität für `gameState.scores` und `players[id].score`, Zeile 7 die Autorität für die SM5-Endstatistik. Nicht übernommen wird weiterhin der Score aus Zeile 6 (bleibt rein informativ). | weitgehend geschlossen |
| **Farb-Enum → RGB** | Fallback-RGB pro `colour-enum` (für v2.003-Feeds ohne `#rgb`) nicht implementiert. | offen |
| **`0101` beim Beenden von Hand** | Ob die Anlage den Mission-End-Code auch dann schickt, wenn der Spielleiter die Mission an der Konsole abbricht, ist **nicht gemessen**. Deshalb die vier Beendigungswege in [Wann ein Match als beendet gilt](#wann-ein-match-als-beendet-gilt) — sie greifen unabhängig davon. Gegen einen Mitschnitt (`scripts/inspect.js`) prüfen. | unbestätigt |
| **Typ-6-Exit-Codes** | Die Zuordnung `02` Ende · `04` eliminiert · `01` Kick · `17` Ref-Kick stammt aus der Community-Spezifikation. Die Mitschnitte vom 19.09.2026 **stützen** sie für `01` und `02` (165× `02` im Endblock hinter dem `0101`, 1× `01` mitten im Spiel) und widersprechen damit der Beobachtung vom 17.09.2026; `04` und `17` bleiben unbelegt. Die Fremdtabelle bleibt stehen, gilt aber durchgehend als unbestätigt. lf_live entscheidet nichts mehr am Exit-Code, sondern hält ihn in `exitCodes`/`exitCodesSeen` fest. → [Typ-6 im Detail](#die-exit-codes-der-typ-6-zeile--unbestätigt) | **unbestätigt** |
| **Zweite Zahl der Beobachtung (`1095`, Laserball)** | Der Betreiber nannte für Laserball eine Zahl `1095`. Ob Entity-Kennung oder Exit-Code, ist aus der Angabe **nicht** ableitbar. Hier wird nicht geraten; die Mitschnitte müssen es zeigen. | offen |
| **Typ-6 am Matchende** | Dass am regulären Ende **jede** verbliebene Entity eine Typ-6-Zeile schickt, stammt aus der Spezifikation, nicht aus einer Messung der eigenen Anlage. Die Vollständigkeitsregel steht und fällt damit. Trifft es nicht zu, wird die Endabrechnung nicht erkannt und der Watchdog beendet das Match später — nie früher. | unbestätigt |
| **`exitCodes` bleibt im Standardmodus leer** | Folge der gemessenen Reihenfolge: der Typ-6-Block kommt **hinter** dem `0101` und läuft damit in ein bereits beendetes Match. `_noteEntityEnd()` steigt dort aus, `exitCodes`/`exitCodesSeen` bleiben leer. Die Zeilen selbst werden weiterhin als `match_summary`-Ereignis ausgegeben. Beide Felder sind **rein diagnostisch** und entscheiden nichts — deshalb bleibt es so. | **gemessen** |
| **Teamstand im Standardmodus** | **Gemessen: die Anlage schickt in Modus 7 keine einzige Typ-5-Zeile auf eine TEAM-Kennung** — alle 5551 Punktezeilen der vier Mitschnitte nennen einen Spieler. Die Spielerpunkte stimmen dagegen exakt (141 von 141 Spielern deckungsgleich mit der letzten Typ-5-Zeile ihrer Kennung). lf_live **summiert den Teamstand deshalb selbst** aus den Spielerpunkten und kennzeichnet ihn mit `teamScoreSource: 'derived'` → [Typ-5 im Detail](#nicht-jede-anlage-meldet-teampunkte--teamscoresource). Damit stimmen Live-Ansicht, Sieger und `draw` wieder. **Dass die Anlage intern genauso rechnet, bleibt unbelegt** — es ist unsere Summe, überall als solche markiert, und eine später doch eintreffende Teamzeile gewinnt. | **gelöst, Herkunft gekennzeichnet** |
| **`0D05` (Blast ohne Deaktivierung)** | **Ein einziges** Vorkommen in vier Mitschnitten. Die Deutung als nicht-deaktivierender Gegenpart zu `0D06` ist plausibel (gleiches Verb, Gegnerteam, Ziel bleibt in Zustand 0), bei n=1 aber nicht belegt. | unbestätigt |
| **Wirkung der Ränge (`0E00`)** | Dass ein Spieler zum „Held", „Schütze", „Unsterblicher" oder „Raketenliebhaber" befördert wird, ist belegt. **Was der Rang bewirkt, nicht.** Einziger Anhaltspunkt: 4 der 7 Held-Beförderungen liegen auf demselben Zeitstempel wie ein `0402` (Unverwundbarkeit) desselben Spielers — 3 nicht. Zu wenig. | unbestätigt |
| **`0208`/`0D06` in den Live-Zählern** | Eigenbeschuss und Blast fließen bewusst **nicht** in `shotsFired`/`shotsHit`/`deactivations` ein. Wie die Anlage sie selbst verbucht, stünde in ihrer Endabrechnung — die es in diesem Modus nicht gibt (kein Typ 7). Damit fehlt jeder Prüfstein, und geraten wird nicht. | bewusst offen |
| **Kein Typ 7 im Standardmodus** | **Gemessen und damit geklärt, aber mit dauerhafter Folge:** in vier vollständigen Standardspielen steht keine einzige Typ-7-Zeile. Leben, Munition und die amtliche Trefferquote bleiben dort für immer leer; angezeigt werden die Live-Zähler mit `statsSource: "live"`. → [Typ-7 im Detail](#typ-7-sm5-endblock-im-detail) | **gemessen** |
| **Melden alle Entities gleichzeitig?** | Ob die Typ-6-Zeilen der Endabrechnung wirklich in einem Block kommen (und nicht über Sekunden verteilt), ist nicht gemessen. Relevant nur für die Länge der Frist `matchEnd.endBlockSeconds`. | unbestätigt |

---

## Quellen

| Quelle | URL | Autorität |
|---|---|---|
| **lfstats — TDF-Spezifikation (SM5)** | `https://github.com/zmaniacz/lfstats/blob/main/docs/TDF_Spec.md` | **Haupt-Quelle.** Community-reverse-engineert, nicht offiziell von Laserforce. Aber: sehr detailliert (Versionen 2.000–2.006, alle Zeilentypen, alle Codes, Score-Deltas), aktiv gepflegt (2026), und Grundlage der öffentlichen SM5-Turnier-Statistikseite. |
| **lfstats — Laserball-TDF-Spezifikation** | `https://github.com/zmaniacz/lfstats/blob/main/docs/Laserball_TDF_Spec.md` | Delta zu oben. Selbst ein Port einer europäischen Referenz-Implementierung (`process_logs.php`), die dort als „authoritative spec" bezeichnet wird. |
| **lfstats — Parser & Simulator** | `https://github.com/zmaniacz/lfstats/tree/main/apps/chomper/src` (`parser.ts`, `simulator.ts`, `laserball/types.ts`, `laserball/simulator.ts`) | Ausführbarer Beleg der obigen Specs. `laserball/types.ts` enthält die `LB_EVENT`-Konstantentabelle. |
| **lfstats — Penalty-Definitionen** | `https://github.com/zmaniacz/lfstats/blob/main/docs/SM5-penalty-definitions.md` | Kontext zu `0600`. |
| **Original `lf_overlay/server.js`** | lokal: `C:\Users\menze\Desktop\lf_overlay\server.js` (von Dritten übergeben) | **Unabhängige Zweitquelle.** Bestätigt den Laserball-`11xx`-Satz sowie `0100`/`0101`/`0201`/`0900` exakt (deckungsgleiche `switch`-Fälle und Kommentare). Enthält keine SM5-`0xxx`-Auswertung. |
| lfstats — Doku-Index & Chomper-Design | `https://github.com/zmaniacz/lfstats/blob/main/docs/README.md`, `.../docs/chomper-design.md` | Einordnung, Verweis auf `process_logs.php` als Laserball-Referenz. |
| **Beobachtung an einer echten Anlage, 17.09.2026** | mündliche Angabe des Hallenbetreibers, mitgelesen an der eigenen Laserforce-Anlage: Standardspiel → `Abschluss <id> (Exit 01, Score 0)`; für Laserball zusätzlich eine nicht eindeutig überlieferte Zahl `1095`. | **Erstmessung an der Zielanlage.** Schlägt für den Exit-Code die Fremdquelle — sie beschreibt *diese* Firmware. Aber: mündlich, ohne Mitschnitt, ein einziger Fall, und die zweite Zahl ist mehrdeutig. Deshalb ist der Befund als *belegte Abweichung* geführt und **keine** der Zuordnungen gilt als bestätigt. Mitschnitte angekündigt. |
| **Der Stream der eigenen Anlage** | `scripts/inspect.js` → `inspect-report.json` | **Die einzige Quelle, die eure Firmware wirklich beschreibt.** Modus-Nummern außer `5`/`28`, das tatsächliche Vorhandensein von `;`-Schema-Zeilen und die reale Feldzahl in Typ 7 lassen sich nur so belegen. Alles in dieser Datei, was nicht aus einer Aufzeichnung stammt, ist Fremdquelle. |

Nicht als Quelle brauchbar: `spookybear0/laserforce.py` (nur die iPlayLaserforce-Web-API,
kein TDF); diverse gleichnamige „TDF"-Projekte (Trusted Data Format, TheDraw-Fonts)
sind unverwandt.

**Konfliktfälle zwischen den Quellen:** **einer** — und er ist wichtig. Die
lfstats-Spezifikation führt den Typ-6-Exit-Code `02` als „Ende" und `01` als
„Kick"; die [Beobachtung an der echten Anlage (17.09.2026)](#die-exit-codes-der-typ-6-zeile--unbestätigt)
zeigt ein regulär beendetes Standardspiel mit `01`. Aufgelöst ist der Konflikt
**nicht** — beide Angaben stehen nebeneinander, beide gelten als unbestätigt,
und lf_live stützt seit dem Befund keine Entscheidung mehr auf diese Spalte.
Sonst keine inhaltlichen Widersprüche gefunden:
lfstats und `server.js` benennen dieselben `11xx`-Codes und behandeln `1104`
identisch (Reset vs. Block über den Ziel-Status). Wo `server.js` schweigt (der
gesamte SM5-`0xxx`-Bereich), ist lfstats die einzige Quelle — entsprechend als
`verified` geführt, weil dort feldgenau spezifiziert, aber ohne zweite
Bestätigung.

---

## Gegen die echte Anlage prüfen

```bash
node scripts/inspect.js 9100        # bare TCP server, interpretiert nichts
```

Den Laserforce-Export **temporär** auf `<PC>:9100` stellen, ein Match spielen,
`Ctrl+C`. `inspect.js` katalogisiert und schreibt zusätzlich
`inspect-report.json` ins aktuelle Verzeichnis:

| Abschnitt | Wofür |
|---|---|
| **LINE TYPES** | jeder gesehene Zeilentyp mit Häufigkeit und Beispielzeile |
| **TYPE-4 EVENT CODES** | jeder Event-Code mit Häufigkeit und der Form seiner ID-Tokens (`@` Hardware / `#` iplId) |
| **SCHEMA-KOMMENTARE** | jede `;`-Zeile mit ihren Spaltennamen **und deren Index**. Damit lässt sich prüfen, ob eure Firmware Schema-Zeilen schickt und wo `duration` in Typ 1 bzw. die 23 Felder in Typ 7 wirklich liegen. Schickt sie keine, sagt der Abschnitt das ausdrücklich |
| **TYP-7-ZEILEN** | tatsächliche Spaltenzahl der SM5-Endstatistik, im Vergleich zu den erwarteten 24 Feldern + Typ-Spalte |
| **SPIELMODI** | jede Typ-1-Zeile nach Modus-Nummer, mit Beschreibung, Dauer-Quelle, Zeilentypen, Typ-7-Zahl, allen Event-Codes dieses Modus und der Rohzeile |
| **WAS JETZT ZU TUN IST** | die zu meldenden Zeilen für Modi, die lf_live nicht kennt |

Damit lässt sich die obige Liste gegen eure Firmware verifizieren — besonders
für 7SM/Nexus, Varianten und die als `unbestätigt` markierten Codes.

**Was an den nächsten Mitschnitten konkret zu klären ist** (offen seit der
[Beobachtung vom 17.09.2026](#die-exit-codes-der-typ-6-zeile--unbestätigt)):

1. Welchen Exit-Code trägt eine Typ-6-Zeile am **regulären** Missionsende — je
   Modus? Bestätigt sich `01` im Standardspiel, und was steht in Laserball?
2. Welchen Exit-Code trägt eine Typ-6-Zeile bei einer **Elimination mitten im
   Spiel**? Unterscheiden sich die beiden Fälle an dieser Anlage überhaupt?
3. Was ist die Zahl `1095` aus der Beobachtung — Entity-Kennung oder Exit-Code?
4. Meldet am Ende wirklich **jede** Entity eine Typ-6-Zeile, und kommen sie als
   ein Block? Davon hängt die Erkennung der Endabrechnung ab.
5. Kommt nach der Endabrechnung überhaupt ein `0101`?

Im Betrieb beantworten dieselben Fragen auch die Felder `exitCodes`,
`exitCodesSeen` und `endSource` des beendeten Matches, ohne Mitschnitt.

Das Werkzeug meldet außerdem, wenn die Schema-Spalte `duration` und die alte
Heuristik „vorletzte Spalte" **verschiedene** Werte liefern — genau der Fall, der
unter [Typ-1 im Detail](#typ-1-mission-im-detail) beschrieben ist.

Die Schritt-für-Schritt-Anleitung, wie man daraus eine neue Modus-Nummer
einträgt, steht in
[GAMEMODES.md](GAMEMODES.md#eigene-modus-nummern-ermitteln-und-eintragen).
