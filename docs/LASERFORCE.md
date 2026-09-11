# Laserforce — Anbindung, Log-Format & Event-Codes

Alles über die Verbindung zum Laserforce-System und das Format, das über den
TCP-Stream kommt. Dies ist die **einzige** Protokoll-Referenz des Projekts.

- [Zweck](#zweck)
- [Anbinden](#anbinden)
- [Was der Parser liest](#was-der-parser-liest)
- [Zeilentypen 0–9](#zeilentypen-09)
- [Feld-Referenz](#feld-referenz)
- [Typ-2 (Team) im Detail](#typ-2-team-im-detail)
- [Typ-3 (Login nach 0100) im Detail](#typ-3-login-nach-0100-im-detail)
- [Typ-4-Event-Codes: gemeinsame Match-Steuerung](#typ-4-event-codes-gemeinsame-match-steuerung)
- [Typ-4-Event-Codes: Space Marines 5](#typ-4-event-codes-space-marines-5)
- [Typ-4-Event-Codes: Laserball](#typ-4-event-codes-laserball)
- [Typ-4-Event-Codes: 7SM / Nexus](#typ-4-event-codes-7sm-nexus)
- [Spielvarianten](#spielvarianten)
- [Assist-Fenster & Ballbesitz](#assist-fenster--ballbesitz)
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

> **1:1-Port-Hinweis.** Die Auswertung (`src/engine.js`, `processLogLine`) ist
> **1:1 aus dem Originalsystem übernommen** — jede Spaltendeutung, jeder Code,
> jede Heuristik. Neu ist nur die Ausgabe (strukturierte Events statt HTML).
> `src/eventCatalog.js` ist **zusätzliches, rein beschreibendes Nachschlagewerk**
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

Zeilen, die mit `;` beginnen, sind **Schema-Kommentare** (sie nennen die
Spaltennamen der folgenden Zeile ihres Typs) und werden ignoriert. Sonst wird an
Whitespace gesplittet; **Spalte 0 ist der Zeilentyp**.

**Spielernamen** kommen aus der Typ-3-Zeile (Feld nach `player`). Optional
überschreibt eine selbst gepflegte Namensliste (`data/roster.csv`, siehe
[CONFIG.md](CONFIG.md#namensliste-optional)) einzelne Namen/Teams. lf_live
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

## Zeilentypen 0–9

| Typ | Name | Spaltenlayout (Schema) | Vorkommen | lf_live |
|---|---|---|---|---|
| `0` | info / Kopf | `0  file-version  program-version  centre` | 1×, erste Zeile | ⚪ ignoriert (Version nicht ausgewertet) |
| `1` | mission | `1  type  desc  start  [duration]  [penalty]` — `duration` ab v2.001, `penalty` ab v2.003 | 1×, nach Typ 0 | vorletzte Spalte → `duration` |
| `2` | team | `2  index  desc…  colour-enum  colour-desc  [#rgb]` — `#rgb` ab v2.004 | je Team 1×, „Neutral" zuletzt | → `teams[index] = {name, color}` |
| `3` | entity-start | `3  time  id  type  desc  team  level  category  [battlesuit]  [memberId]` — `battlesuit` ab v2.003, `memberId` in späten 2.006 | je Entity 1×, **nach `0100`** | wenn `type == player` und `team != 5` → Spieler anlegen |
| `4` | **event** | `4  time  code  <actor>  <verb…>  <target>` | laufend | siehe Code-Tabellen |
| `5` | score | `5  time  entity  old  delta  new` | begleitet jedes werterelevante Typ-4-Event | ⚪ ignoriert (Score wird selbst gezählt) |
| `6` | entity-end | `6  time  id  type  score` — `type` = Exit-Code (`02` Ende, `04` eliminiert, `01` Kick, `17` Ref-Kick) | je Entity 1× (bei Elimination mitten im Spiel) | ⚪ ignoriert |
| `7` | sm5-stats | `7  id  shotsHit  shotsFired  timesZapped  …  missiledTeam` (24 Felder) | je Entity 1×, **nur SM5** — in Laserball nicht vorhanden | ⚪ ignoriert |
| `8` | — | nicht dokumentiert / nicht beobachtet | — | – |
| `9` | player-state | `9  time  entity  state` — ab v2.005 (SM5); in Laserball ab v2.004 | laufend | → `players[id].status` |
| `3`–`9` | (alle In-Game-Zeilen) | Spalte 1 = Spielzeit in ms | – | → `elapsedTime` |

**Reihenfolge im echten Betrieb:** `0` → `1` → `2` (Teams) → `0100` (Start) →
viele `3` (Logins, sobald Spieler aktiviert werden) → `4`/`5`/`9` (Spielverlauf)
→ `6`/`7` (Endabrechnung) → `0101`. **`0100` leert die Spielerliste** — Logins
kommen im echten Ablauf *danach*. `lf_simulate` hält diese Reihenfolge ein.

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
  nicht dokumentierte Typ-Nummern.
- **Team-Index `5`** wird vom Parser als „kein echtes Team" behandelt (Neutral /
  Nicht-Spieler) und beim Login übersprungen.

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

Der Parser sucht ab dem Token `player` die **Signatur „drei Zahlen in Folge"**
(Team, Level, Category); alle Tokens zwischen `player` und dieser Dreiergruppe
sind der Name. `battlesuit` (ab v2.003) und `memberId` (späte 2.006) werden
aktuell verworfen. Entities mit `team == 5` (Neutral / Nicht-Spieler wie Targets,
Referees) werden **nicht** als Spieler angelegt.

Logins kommen **nach** `0100` — der Start-Event hat die Spielerliste geleert.

---

## Typ-4-Event-Codes: gemeinsame Match-Steuerung

Diese Codes gelten für **alle** Modi (`mode: 'all'`).

| Code | Label | Kategorie | Bedeutung | Status |
|---|---|---|---|---|
| `0100` | Mission Start | match | Beginnt die Mission bei t=0; startet die Spieluhr. Der Parser leert Spielerliste, Ball und Events. | verified |
| `0101` | Mission End | match | Beendet die Mission. In Laserball zusätzlich alle Spieler-Status → 0. Tatsächliche Dauer = dieser Zeitstempel. | verified |
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

## Was lf_live daraus macht

| TDF | → lf_live |
|---|---|
| `0100` | `match_start`; `players`/`ballHolderId`/`events` geleert, Scores → 0, neue `matchId` |
| `0101` | `match_end`; Ball frei |
| `1100` | `pass`; `passesDone/Received++`; Ball→target; Assist-Fenster (10 s) |
| `1109` | `clear`; `clearsDone/Received++`; Ball→target; Assist-Fenster |
| `1101` / `1102` | `goal`; `goals++`; `scores[team]++`; Assist wenn Pass/Clear an Schützen ≤ 10 s zuvor |
| `1103` | `steal`; `stealsDone/Received++`; Ball→actor |
| `1104` | `block` bzw. `reset` (Ziel-Status 2) |
| `110A` | `failed_clear` |
| `1107` | Ball→actor |
| `1106` / `1108` | Ball frei (kein eigenes Event) |
| `1105` | `round_start`-Event (nur Event, keine „pro Runde"-Statistik) |
| `110B` / `110C` | `reset`-Event (explizit; zusätzlich zum aus `1104`+Status abgeleiteten Reset — State unverändert) |
| Zeile 9 | `players[id].status`; `status`-Event |
| Zeile 1 | `duration` |
| Zeile 2 | `teams[index] = {name, color}` |
| Zeile 3 (`player`, `team != 5`) | Spieler angelegt; `player_join`-Event |
| Zeile 5 (Score) | `score`-Event mit `teamId`/`old`/`new`/`delta` — **informativ**, `gameState.scores` bleibt selbst gezählt |
| Zeile 6 (Entity-Ende) | `match_summary`-Event mit `entityId`/`exitCode`/`score` |
| SM5-`02xx`/`03xx` (verifiziert) | eigenes Event (`miss`, `player_hit`, `missile_*` …), `category` aus `eventCatalog` |
| alle übrigen Typ-4-Codes | generisches `lf_event` mit `code`+`category`+`label` (abschaltbar: `LF_EMIT_UNKNOWN_EVENTS=false`) |

Diese zusätzlichen Events sind **rein additiv** (seit v1.1): sie verändern
`gameState` nicht, lösen keinen State-Push aus und ändern kein bestehendes
Event. Der Kern-Parser (`processLogLine`) bleibt Byte-für-Byte identisch für
jeden Code, den er schon vorher behandelt hat.

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
| **Nicht belegte `0xxx`-Codes** | u. a. `0207`, `0208`, `020A+`, `0302`, `0305`, `0307`, `0309+`, `0401`–`0403`, `0406+`, `0501`, `0503`–`0509`, `0511`, `0513+`, `0601+`, `0700`–`08FF`, `0B01`, `0B02`, `0B04+` sind in keiner Quelle beschrieben. | Lücke |
| **`1000`–`10FF` / `12xx+`** | Kein `10xx`- oder `12xx`-Laserball-Code bekannt; nur `11xx` belegt. | Lücke |
| **Zeilentyp `8`** | Nicht dokumentiert, nicht beobachtet. | Lücke |
| **Score-Deltas** | Die `±100 / −20 / +1001 / +500`-Angaben stammen aus der lfstats-Spezifikation, nicht aus lf_live-Zählung. Gegen Zeile 5 der echten Anlage prüfen. | teils unbestätigt |
| **Explizite Resets `110B`/`110C`** | Codes belegt, Bedeutung/Auslöser nicht gegen echte Anlage verifiziert. Werden jetzt als `reset`-Event ausgegeben, fließen aber nicht in `resetsDone`/`resetsReceived` (die kommen weiter aus `1104`+Status). | teilweise |
| **`1105` Round Start** | Wird als `round_start`-Event ausgegeben, aber es gibt weiterhin keine „pro Runde"-Statistik. | offen |
| **Offizieller Score / Endstand** | Zeile 5 → `score`-Event, Zeile 6 → `match_summary`-Event (informativ). `gameState.scores` wird weiterhin selbst gezählt; Zeile 7 bleibt ungenutzt. | bewusst offen |
| **Farb-Enum → RGB** | Fallback-RGB pro `colour-enum` (für v2.003-Feeds ohne `#rgb`) nicht implementiert. | offen |

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

Nicht als Quelle brauchbar: `spookybear0/laserforce.py` (nur die iPlayLaserforce-Web-API,
kein TDF); diverse gleichnamige „TDF"-Projekte (Trusted Data Format, TheDraw-Fonts)
sind unverwandt.

**Konfliktfälle zwischen den Quellen:** keine inhaltlichen Widersprüche gefunden.
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
`Ctrl+C`. `inspect.js` katalogisiert jeden gesehenen Zeilentyp und Typ-4-Code
mit Häufigkeit + Beispielzeile und schreibt `inspect-report.json`. Damit lässt
sich die obige Liste gegen eure Firmware verifizieren — besonders für 7SM/Nexus,
Varianten und die als `unbestätigt` markierten Codes.
