# Laserforce — Anbindung, Log-Format & Event-Codes

Alles über die Verbindung zum Laserforce-System und das Format, das über den
TCP-Stream kommt.

- [Anbinden](#anbinden)
- [Was der Parser liest](#was-der-parser-liest)
- [Zeilentypen](#zeilentypen)
- [Typ-4-Codes: Laserball](#typ-4-codes-laserball)
- [Typ-4-Codes: Space Marines 5](#typ-4-codes-space-marines-5)
- [Was lf_live daraus macht](#was-lf_live-daraus-macht)
- [Bekannte Lücken / Ausbaupunkte](#bekannte-lücken--ausbaupunkte)
- [Gegen die echte Anlage prüfen](#gegen-die-echte-anlage-prüfen)

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

Zeilen, die mit `;` beginnen, sind Kommentare und werden ignoriert. Sonst wird an
Whitespace gesplittet; **Spalte 0 ist der Zeilentyp**.

Die Auswertung (`src/engine.js`, `processLogLine`) ist **1:1 aus dem
Originalsystem übernommen** — jede Spaltendeutung, jeder Code, jede Heuristik.
Neu ist nur die Ausgabe (strukturierte Events statt HTML).

**Spielernamen** kommen aus der Typ-3-Zeile (Feld nach `player`). Optional
überschreibt eine selbst gepflegte Namensliste (`data/roster.csv`, siehe
[CONFIG.md](CONFIG.md#namensliste-optional)) einzelne Namen/Teams. lf_live
kontaktiert **keine externen Dienste**.

Das Format ist **versioniert** — Zeile 0 nennt die Version (z. B. `2.006`),
einzelne Spalten kamen erst mit späteren Versionen dazu.

---

## Zeilentypen

| Typ | Name | Spaltenlayout | lf_live |
|---|---|---|---|
| `0` | info / Kopf | `0  file-version  program-version  centre` | ⚪ ignoriert |
| `1` | mission | `1  type  desc  start  [duration]  [penalty]` — `duration` ab v2.001, `penalty` ab v2.003 | vorletzte Spalte → `duration` |
| `2` | team | `2  index  desc…  colour-enum  colour-desc  [#rgb]` — Name = Tokens zwischen `index` und den **zwei** Werten vor `#rgb` | → `teams[index] = {name, color}` |
| `3` | entity-start | `3  time  id  type  desc  team  level  category  [battlesuit]  [memberId]` | wenn `type == player` und `team != 5` → Spieler anlegen |
| `4` | **event** | `4  time  code  actor  <verb>  target` | siehe Code-Tabellen |
| `5` | score | `5  time  entity  old  delta  new` | ⚪ ignoriert (Score wird selbst gezählt) |
| `6` | entity-end | `6  time  id  type  score` (Endstand pro Spieler) | ⚪ ignoriert |
| `7` | (nur SM5) | in Laserball nicht enthalten | – |
| `9` | player-state | `9  time  entity  state` (ab v2.005) | → `players[id].status` |
| `3/4/5/6/9` | (alle) | Spalte 1 = Spielzeit in ms | → `elapsedTime` |

### Felder

- **`time`** — Millisekunden seit `0100` (Mission Start). Vor dem Start ggf. 0/negativ.
- **`id` / `actor` / `target` / `entity`**
  - `#xxxxxxx` — **iplId**, weltweit eindeutige Laserforce-Mitglieds-ID
  - `@NNN` — **Hardware-ID** der Weste, nur je Zentrale eindeutig; Gäste & Nicht-Spieler
  - lf_live entfernt `@`/`#` (`cleanId()`) und nutzt den Rest als String-Schlüssel.
- **`category`** (Zeile 3, SM5-Rolle): `0` N/A · `1` Commander · `2` Heavy · `3` Scout · `4` Ammo Carrier · `5` Medic
- **`state`** (Zeile 9): `0` aktiv · `1`/`2` down/resettable (lf_live: `2` = „in Reset") · `3` deaktiviert
- **`mission type`** (Zeile 1): `5` = Space Marines 5 · **`28` = Laserball Ranked**

---

## Typ-4-Codes: Laserball

Der Code ist die 3. Spalte. lf_live wertet die **fett** markierten aus.

| Code | Name | Bedeutung | lf_live |
|---|---|---|---|
| **`0100`** | Mission Start | Spielbeginn bei t=0 | `match_start` + State-Reset |
| **`0101`** | Mission End | Spielende; Status aller Spieler → 0 | `match_end` |
| `0201` | Miss | Schuss ins Leere; sehr häufig | ⚪ ignoriert |
| **`1100`** | Pass | Ball zum Mitspieler | `pass`, Ball→target, Assist-Fenster |
| `1105` | Round Start | Ballbesitz-Runde beginnt | ❌ noch nicht |
| **`1106`** | Round End | Runde endet | Ball frei |
| **`1107`** | Get Ball | Actor bekommt Ball bei Rundenstart | Ball→actor |
| **`1108`** | Ball Timeout | Ball zu lange gehalten | Ball frei |
| **`1101`** | Goal | Actor trifft (erzeugt zusätzlich eine Zeile 5) | `goal`, `goals++`, Score++, Assist |
| **`1102`** | Goal (alt.) | wie Tor; in Samples nicht beobachtet | wie `1101` |
| **`1103`** | Steal | Actor nimmt Gegner den Ball ab | `steal`, Ball→actor |
| **`1104`** | Block | Actor blockt/tagged einen Spieler | `block` — **oder `reset`, wenn Ziel-Status = 2** |
| **`1109`** | Clear | Defensiver Clear/Pass | `clear`, Ball→target, Assist-Fenster |
| **`110A`** | Failed Clear | Clear fehlgeschlagen | `failed_clear` |
| `110B` | Target Reset (self) | Actor hat sein Ziel resettet | ❌ noch nicht |
| `110C` | Target Reset (player) | Ziel-Spieler wurde resettet | ❌ noch nicht |
| `0900`/`0901`/`0902` | Achievement | rein informativ | ⚪ ignoriert |

`actor`/`target` werden aus Tokens mit führendem `@`/`#` gelesen.

**Reihenfolge im echten Betrieb:** `1` → `2` (Teams) → `0100` (Start) → viele
`3` (Logins, sobald Spieler aktiviert werden) → `4`/`9` (Spielverlauf) → `0101`.
**`0100` leert die Spielerliste** — Logins kommen im echten Ablauf *danach*.
`lf_simulate` hält diese Reihenfolge ein.

---

## Typ-4-Codes: Space Marines 5

Nur falls die Anlage im normalen SM5-Modus statt Laserball läuft — dann **keine**
`11xx`-Codes. lf_live ist auf Laserball ausgelegt; dieser Modus wird aktuell
nur teilweise sinnvoll ausgewertet (`0100`/`0101` + `9`).

| Code | Name | Bedeutung |
|---|---|---|
| `0100` / `0101` | Mission Start / End | – |
| `0201` | Miss | Schuss ins Leere |
| `0202` | Gen Miss | verfehlt; 3-Treffer-Zähler zurück |
| `0203` | Target Hit | Nicht-Spieler-Ziel getroffen (3 Treffer nötig) |
| `0204` | Target Destroy | 3. Treffer zerstört Ziel; +1001 |
| `0205` | Player Hit | Spieler beschädigt; ±100 actor, −20 target |
| `0206` | Player Deactivate | Spieler auf 0 HP; ±100 actor, −20 target |
| `0209` | Warbot Deactivate | Warbot deaktiviert Spieler (−1 Leben) |
| `0300` | Missile Lock | Commander/Heavy schaltet auf |
| `0301` | Missile Miss vs Target | verfehlt Nicht-Spieler-Ziel |
| `0303` | Missile Destroy Target | zerstört Ziel in einem Schlag; +1001 |
| `0304` | Missile Miss vs Player | verfehlt Spieler |
| `0306` | Missile Hit Player | deaktiviert Spieler; ±500 actor, −100 target |
| `0308` | Missile Hit (friendly) | Eigenbeschuss; −500 actor, −100 target |
| `0400` | Rapid Fire Activate | Scout aktiviert Dauerfeuer |
| `0404` / `0405` | Nuke Activate / Detonate | Countdown / Zündung (Gegner −3 Leben) |
| `0500` / `0502` | Ammo / Lives Resupply | einzelner Mitspieler |
| `0510` / `0512` | Team Ammo / Lives Resupply | Ammo Carrier / Medic Spezial |
| `0600` | Penalty | Schiedsrichter-Strafe |
| `0900` / `0902` | Achievement / Reward | informativ |
| `0B00` | Beacon Claim | Beacon-Ziel zerstört; +1001 |
| `0B03` | Base Award | automatische Zielvergabe bei Elimination |

---

## Was lf_live daraus macht

| TDF | → lf_live |
|---|---|
| `0100` | `match_start`; `players`/`ballHolderId`/`events` geleert, Scores → 0, neue `matchId` |
| `0101` | `match_end`; Ball frei |
| `1100` | `pass`; `passesDone/Received++`; Ball→target; Assist-Fenster (10 s) |
| `1109` | `clear`; `clearsDone/Received++`; Ball→target; Assist-Fenster |
| `1101`/`1102` | `goal`; `goals++`; `scores[team]++`; Assist wenn Pass/Clear an Schützen ≤ 10 s zuvor |
| `1103` | `steal`; `stealsDone/Received++`; Ball→actor |
| `1104` | `block` bzw. `reset` (Ziel-Status 2) |
| `110A` | `failed_clear` |
| `1107` | Ball→actor |
| `1106`/`1108` | Ball frei |
| Zeile 9 | `players[id].status`; `status`-Event |
| Zeile 1 | `duration` |
| Zeile 2 | `teams[index] = {name, color}` |
| Zeile 3 (`player`) | Spieler angelegt |

Event-Objekt und State-Objekt: [API.md](API.md).

---

## Bekannte Lücken / Ausbaupunkte

Quelle für die Code-Bedeutungen: öffentliche TDF-Spezifikation des
[lfstats](https://github.com/zmaniacz/lfstats)-Projekts (community-reverse-engineert,
nicht offiziell — einzelne Codes „in Samples nicht beobachtet"). **Gegen die
echte Anlage prüfen.**

| Thema | Was fehlt | Wo ansetzen |
|---|---|---|
| Offizieller Score | Zeile 5 wird ignoriert; Score selbst gezählt | `engine.js` — `if (type === '5')`; `entity` = Team- oder Spieler-ID |
| Endstand | Zeile 6 wird ignoriert | daraus einen `final`-Snapshot bei `match_end` |
| Explizite Resets | `110B`/`110C` nicht behandelt (Reset aus `1104`+Status abgeleitet) | mit `inspect` klären, dann `case '110B'/'110C'` |
| Ballbesitz-Runden | `1105` nicht behandelt | Rundenzähler in `gameState` für „pro Runde"-Statistiken |
| Format-Version | Zeile 0 ignoriert; `duration` per `cols.length-2` stimmt erst ab v2.003 | Zeile 0 → `gameState.tdfVersion`, Indizes danach |
| Rollen | `category` (Zeile 3) verworfen | `players[id].category` speichern |
| iplId vs Hardware-ID | `#`/`@` gleich behandelt | `players[id].idType` mitführen |

---

## Gegen die echte Anlage prüfen

```bash
node scripts/inspect.js 9100        # bare TCP server, interpretiert nichts
```

Den Laserforce-Export **temporär** auf `<PC>:9100` stellen, ein Match spielen,
`Ctrl+C`. `inspect.js` katalogisiert jeden gesehenen Zeilentyp und Typ-4-Code
mit Häufigkeit + Beispielzeile und schreibt `inspect-report.json`. Damit lässt
sich die obige Liste gegen eure Firmware verifizieren.
