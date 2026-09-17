# Spielmodi — Erkennung, Zählung, Eintragen

Diese Datei beantwortet **eine** Frage: woher weiß lf_live, welcher Spielmodus
gerade läuft, und was zählt es in welchem Modus?

Die Protokollgrundlage (Zeilentypen, Event-Codes, Modus-Nummern) steht in
[LASERFORCE.md](LASERFORCE.md). Hier geht es nur darum, was lf_live daraus macht.

- [Kurzfassung](#kurzfassung)
- [Die zwei Familien](#die-zwei-familien)
- [Die drei Anzeigeprofile](#die-drei-anzeigeprofile)
- [Wie der Modus erkannt wird](#wie-der-modus-erkannt-wird)
- [Das `mode`-Objekt](#das-mode-objekt)
- [Die Registry](#die-registry)
- [„Standard" eintragen — die eine Zeile](#standard-eintragen--die-eine-zeile)
- [Unbekannter Modus — warum das trotzdem funktioniert](#unbekannter-modus--warum-das-trotzdem-funktioniert)
- [Laufzeit-Selbstkorrektur (`inferred`)](#laufzeit-selbstkorrektur-inferred)
- [Zählerfelder: Familie `laserball`](#zählerfelder-familie-laserball)
- [Zählerfelder: Familie `sm5`](#zählerfelder-familie-sm5)
- [Die Trefferquote — und warum sie live zu hoch ist](#die-trefferquote--und-warum-sie-live-zu-hoch-ist)
- [Die amtlichen Typ-7-Felder](#die-amtlichen-typ-7-felder)
- [Spaltenbeschriftungen](#spaltenbeschriftungen)
- [Warum die SM5-Live-Zahlen eine Untergrenze sind](#warum-die-sm5-live-zahlen-eine-untergrenze-sind)
- [Punktestand: woher kommt er?](#punktestand-woher-kommt-er)
- [Die Spieluhr](#die-spieluhr)
- [Wo die Zahlen landen](#wo-die-zahlen-landen)
- [Eigene Modus-Nummern ermitteln und eintragen](#eigene-modus-nummern-ermitteln-und-eintragen)
- [Bekannte Lücken / unbestätigt](#bekannte-lücken--unbestätigt)

---

## Kurzfassung

1. Die Anlage schickt ganz am Anfang einer Mission eine **Typ-1-Zeile**. Deren
   zweite Spalte ist die **Modus-Nummer**.
2. lf_live schlägt diese Nummer in einer kleinen **Registry** nach
   ([`src/gameModes.js`](../src/gameModes.js)). Belegt sind bisher nur `5`
   (Space Marines 5) und `28` (Laserball Ranked).
3. Jeder Modus gehört zu einer von **zwei Familien** — `sm5` oder `laserball`.
   Die Familie entscheidet, welche Zähler ein Spieler hat.
4. Jeder Modus hat außerdem ein **Anzeigeprofil** — `standard`, `sm5` oder
   `laserball`. Das Profil entscheidet, welche **Spalten** angezeigt und
   geschrieben werden. Familie und Profil sind **zwei verschiedene Dinge**.
5. Eine **unbekannte** Nummer läuft als Familie `sm5` mit Profil `sm5`. Das
   Spiel wird trotzdem korrekt gezählt; niemand muss vorher etwas eintragen.
6. Widersprechen die Event-Codes der Typ-1-Zeile, **korrigiert sich lf_live
   während des laufenden Matches selbst** (`source: 'inferred'`).

---

## Die zwei Familien

Die Laserforce-Firmware liefert nur **zwei** Sätze von Typ-4-Event-Codes
(siehe [LASERFORCE.md](LASERFORCE.md#typ-4-event-codes-space-marines-5)):

| Familie | Codesatz | Wer gehört dazu |
|---|---|---|
| `laserball` | `11xx` | Laserball (Modus `28`) und seine Varianten |
| `sm5` | `0xxx` | Space Marines 5 (Modus `5`), alle SM5-Varianten, 7SM/Nexus — und alles, dessen Nummer wir nicht kennen |

Die Familie ist **nicht** kosmetisch. Sie steuert:

- welche Zählerfelder ein Spielerobjekt bekommt,
- welcher Zählzweig in der Engine überhaupt läuft,
- in welche Sammel- und Summendatei ein Match abgelegt wird
  (`all_players_<familie>.csv`, `totals_<familie>.csv`).

Was die Familie **nicht mehr** steuert: welche Spalten man zu sehen bekommt.
Das macht seit dieser Version das Anzeigeprofil.

---

## Die drei Anzeigeprofile

**Warum überhaupt getrennt?** „Standard" und „SM5" sprechen dasselbe Protokoll.
Beide sind Familie `sm5`, beide füllen dieselben 30 Zähler — aber der
Hallenbetreiber will für sie **unterschiedliche Spalten** sehen. Mit der Familie
allein ließe sich das nicht ausdrücken. Deshalb gibt es zwei unabhängige Achsen:

| Achse | Beantwortet die Frage | Werte |
|---|---|---|
| **Familie** | Welche Zähler kann das **Protokoll** überhaupt füllen? | `sm5`, `laserball` |
| **Profil** | Welche Spalten werden **angezeigt und geschrieben**, in welcher Reihenfolge, mit welcher Beschriftung? | `standard`, `sm5`, `laserball` |

Jeder Registry-Eintrag darf ein `profile` nennen. Fehlt es, gilt das
**Standardprofil der Familie**:

| Familie | Profil ohne ausdrücklichen Eintrag |
|---|---|
| `sm5` | `sm5` |
| `laserball` | `laserball` |

### Was jedes Profil zeigt

| Profil | Anzeigename | Scoreboard-Spalten (in dieser Reihenfolge) |
|---|---|---|
| `standard` | Standard | Punkte · Spielerlevel · Abgegebene Schüsse · Erzielte Treffer · Trefferquote |
| `sm5` | SM5 | Punkte · Spielerlevel · Rolle · Abgegebene Schüsse · Erzielte Treffer · Trefferquote · Leben übrig · Munition übrig · Gegner abgeschossen · Selbst getroffen worden · Gegner mit Rakete getroffen · Nukes gezündet · Munition ausgegeben · Leben ausgegeben · Strafen |
| `laserball` | Laserball | Tore · Vorlagen · Ball abgenommen · Gegner geblockt · Gegner zurückgesetzt · Befreiungspässe gespielt · Pässe gespielt · Punkte · Spielerlevel |

Die **Anzeigenamen der Profile** stehen in `src/gameModes.js`, Tabelle
`PROFILE_LABELS`, und werden über `profileLabel()` abgerufen — die API erfindet
keine eigenen mehr.

Die ersten **sieben** Laserball-Spalten stehen in derselben Reihenfolge da, wo
sie immer standen — nur ausgeschrieben statt abgekürzt (aus „Steals" wurde „Ball
abgenommen", aus „Clears" wurde „Befreiungspässe gespielt"). Die
**CSV-Spaltennamen sind unverändert**; geändert hat sich allein der Anzeigetext.
`Punkte` und `Spielerlevel` kommen hinten dazu. Laserball hat
**keinen Schusszähler** — der `11xx`-Codesatz protokolliert keine Schüsse, also
gibt es in Laserball auch nichts Ehrliches, was in einer Spalte „Schüsse"
stehen könnte.

Die CSV-Spaltensätze je Profil stehen in [STATS.md](STATS.md#spalten-spieler-zeilen).

### Wo das im Code steht

Alles in [`src/gameModes.js`](../src/gameModes.js), Konstante `PROFILE_DEFS` —
Scoreboard-Spalten, CSV-Block und Sortierkennzahl eines Profils stehen dort
nebeneinander in **einem** Objekt.

| Funktion | Liefert |
|---|---|
| `scoreboardColumns(profil)` | Scoreboard-Spalten mit Bezeichnung, Erklärtext, Gruppe und Format |
| `csvColumns(profil)` | CSV-Zählerblock (snake_case) |
| `profileFields(profil)` | dieselben Spalten als Feldnamen des Spielerobjekts |
| `profileSort(profil)` | die wichtigste Kennzahl des Profils zuerst |
| `counterColumns(familie)` | die **reinen** Zähler einer Familie — das, was Gesamtwertungen summieren dürfen |
| `profileLabel(profil)` | den deutschen Anzeigenamen des Profils |
| `listProfiles()` | alle drei Profile am Stück, für die API — je Profil auch `label` |

> **Abwärtskompatibel.** `scoreboardColumns()` und `csvColumns()` nehmen weiterhin
> einen **Familiennamen** entgegen: `'sm5'` und `'laserball'` sind in beiden
> Namensräumen gültig und bedeuten dort dasselbe. Nur `'standard'` gibt es
> ausschließlich als Profil. `csvColumns('laserball')` ist **exakt** der
> bisherige Laserball-Spaltensatz — vorhandene Laserball-CSVs bleiben
> spaltenkompatibel.

---

## Wie der Modus erkannt wird

Drei Stufen, in dieser Reihenfolge:

**Stufe 1 — Typ-1-Zeile.** `1  type  desc…  start  [duration]  [penalty]`

```
1 ⇥ 28 ⇥ Laserball Ranked ⇥ 20260916120000 ⇥ 900000 ⇥ 0
     ▲    ▲
     │    └── desc  → wird als Anzeigename verwendet, wenn nicht leer
     └─────── type  → die Modus-Nummer
```

Die Spalte `type` wird **per Schema-Kommentarzeile** gelesen, wenn die Anlage
eine schickt, sonst über die feste Position 1. Dasselbe gilt für `desc`. Details
zu den `;`-Schema-Zeilen: [LASERFORCE.md](LASERFORCE.md#zeilentypen-09).

> **Achtung:** Die Typ-1-Zeile kommt **vor** dem Mission-Start `0100`. Der
> Start-Event setzt Modus und Dauer deshalb bewusst **nicht** zurück. Wer den
> Export erst mitten im Spiel anschaltet, sieht nie eine Typ-1-Zeile und landet
> bei Stufe 3.

**Stufe 2 — Registry.** Die Nummer wird nachgeschlagen. Treffer → bekannter
Modus (`known: true`). Kein Treffer → unbekannter Modus, Familie `sm5`
(`known: false`), aber die Nummer selbst wird trotzdem geführt.

**Stufe 3 — Laufzeit-Selbstkorrektur.** Sieht die Engine Event-Codes, die nicht
zur gesetzten Familie passen, stellt sie die Familie um. Siehe
[unten](#laufzeit-selbstkorrektur-inferred).

---

## Das `mode`-Objekt

Steht im Zustands-Snapshot unter `gameState.mode` und wird über
`GET /api/status` und `GET /api/modes` ausgeliefert ([API.md](API.md)).

| Feld | Typ | Bedeutung |
|---|---|---|
| `number` | Zahl oder `null` | Modus-Nummer aus der Typ-1-Zeile. `null` = keine Typ-1-Zeile gesehen. |
| `key` | Text | Stabiler Kurzname für CSV und API: `sm5`, `laserball_ranked`, sonst `mode_<nummer>`, ohne Nummer `unknown`. |
| `label` | Text | Anzeigename. **Bevorzugt die Beschreibung aus dem Stream**, sonst der Registry-Name, sonst `Modus <nummer>`. |
| `family` | `sm5` \| `laserball` | Protokollfamilie. Steuert die Zähler und die Ablagedatei. |
| `profile` | `standard` \| `sm5` \| `laserball` | **Neu, additiv.** Anzeigeprofil: steuert Scoreboard-, Tabellen- und CSV-Spalten. Fehlt in der Registry ein Profil, steht hier das Standardprofil der Familie. |
| `known` | `true` / `false` | `false` = Nummer steht nicht in der Registry. |
| `source` | `tdf` \| `inferred` \| `default` | Woher die Angabe stammt — siehe Tabelle unten. |

| `source` | Heißt |
|---|---|
| `tdf` | Aus der Typ-1-Zeile der Anlage gelesen. Der Normalfall. |
| `inferred` | Die Familie wurde **während des Matches** anhand der Event-Codes korrigiert. Die Typ-1-Zeile fehlte oder passte nicht. |
| `default` | Noch keine Typ-1-Zeile gesehen (Programmstart). Familie `sm5`, `known: false`. |

> **Wo `profile` angehängt wird.** `resolveMode()` behält seine seit jeher
> sechsfeldrige Form — sie ist ein festgenagelter öffentlicher Vertrag. Das
> Profil hängt `withProfile()` an, und jede Stelle, die einen Modus tatsächlich
> **speichert** (Engine-Zustand, Statistik-Schreiber, API), läuft darüber. Wer
> beides in einem Schritt will, nimmt `resolveModeWithProfile()`.

> `label` und die Missionsbeschreibung **kommen aus dem Stream**. Sie werden auf
> 64 Zeichen gekürzt und von Steuerzeichen befreit, sind aber trotzdem fremde
> Daten — in Anzeigen nie als HTML einsetzen, genau wie Team- und Spielernamen.

---

## Die Registry

[`src/gameModes.js`](../src/gameModes.js), Konstante `REGISTRY`. Stand heute:

| Nummer | `key` | `label` | Familie | Profil | Status |
|---|---|---|---|---|---|
| `5` | `sm5` | Space Marines 5 | `sm5` | `sm5` | verified |
| `28` | `laserball_ranked` | Laserball Ranked | `laserball` | `laserball` | verified |

Das ist die **gesamte** öffentlich belegte Modus-Nummerierung. Alles andere —
„Standard", 7SM/Nexus, Junior, Zombies, VIP, Attack & Defend, Zone Control,
sämtliche Laserball-Varianten — hat Nummern, die nirgends dokumentiert sind. Sie
zu ermitteln ist Sache des Hallenbetreibers, siehe
[unten](#eigene-modus-nummern-ermitteln-und-eintragen).

---

## „Standard" eintragen — die eine Zeile

Der Modus **„Standard"** hat ein fertiges Anzeigeprofil (`standard`), aber
**seine Modus-Nummer ist unbekannt.** Sie wird an der Anlage gemessen; hier wird
sie **nicht geraten**, weil ein falscher Registry-Eintrag schlechter ist als gar
keiner (ein unbekannter Modus läuft ohnehin sauber als Familie `sm5`).

**Die Stelle:** [`src/gameModes.js`](../src/gameModes.js), Konstante `REGISTRY`.
Direkt darüber steht ein Kommentarkasten mit genau dieser Zeile. Sobald die
Nummer per [`scripts/inspect.js`](../scripts/inspect.js) gemessen ist
([Anleitung unten](#eigene-modus-nummern-ermitteln-und-eintragen)), wird `<NR>`
ersetzt und die Zeile in `REGISTRY` eingefügt:

```js
const REGISTRY = {
  5:  { number: 5,  key: 'sm5',              label: 'Space Marines 5',  family: FAMILIES.SM5,       profile: PROFILES.SM5 },
  28: { number: 28, key: 'laserball_ranked', label: 'Laserball Ranked', family: FAMILIES.LASERBALL, profile: PROFILES.LASERBALL },

  // ▼ hier, sobald die Nummer gemessen ist — <NR> ersetzen, sonst nichts ändern:
  <NR>: { number: <NR>, key: 'standard', label: 'Standard', family: FAMILIES.SM5, profile: PROFILES.STANDARD },
};
```

Mehr ist nicht zu tun: Familie `sm5` (dasselbe Protokoll wie SM5), Profil
`standard` (die schlanke Spaltenauswahl). Danach lf_live neu starten.

---

## Unbekannter Modus — warum das trotzdem funktioniert

Eine Nummer, die nicht in der Registry steht, bekommt:

```
number: 14,  key: 'mode_14',  label: <Beschreibung aus dem Stream> oder 'Modus 14',
family: 'sm5',  profile: 'sm5',  known: false,  source: 'tdf'
```

Die Familie ist **absichtlich** `sm5`. Begründung: alle SM5-Varianten und
7SM/Nexus teilen sich laut Protokolldoku denselben `0xxx`-Codesatz; Laserball
ist mit `11xx` die Ausnahme, und Laserball hat mit `28` eine bekannte Nummer.
Die wahrscheinlichste Familie für eine unbekannte Nummer ist also `sm5`.

**Praktisch bedeutet das:** ein ganz normales Spiel in einem Modus, den lf_live
nicht kennt, wird trotzdem vollständig gezählt. Der Betreiber muss vorher
**nichts** eintragen. In der Konsole steht dann der Name aus dem Stream mit dem
Zusatz, dass der Modus unbekannt ist — mehr nicht.

Und wenn die Familie doch falsch geraten war, greift Stufe 3.

---

## Laufzeit-Selbstkorrektur (`inferred`)

Die Engine beobachtet mit, welchem Codesatz die eintreffenden Typ-4-Codes
angehören:

| Code | Zugeordnet zu |
|---|---|
| `11xx` | `laserball` |
| `02xx`, `03xx`, `04xx`, `05xx`, `06xx`, `0Bxx` | `sm5` |
| `0100`, `0101`, `0201`, `09xx` | beide (`all`) — lösen **nie** eine Korrektur aus |

Passt ein Code nicht zur gesetzten Familie, wird die Familie umgestellt,
`source` auf `inferred` gesetzt und ein `mode_change`-Event ausgelöst.

**Das Anzeigeprofil zieht mit.** Wird die Familie korrigiert, springt das Profil
auf das Standardprofil der **neuen** Familie — ein in der Registry eingetragenes
Profil gehörte zu der Familie, die sich gerade als falsch herausgestellt hat.

Regeln:

- Die Korrektur greift **höchstens einmal pro Match**. Sie wird bei jeder
  Typ-1-Zeile und bei jedem `0100` neu scharfgestellt.
- **Modus `28` wird nie zu `sm5` degradiert.** Ein ausdrücklich als Laserball
  gemeldetes Match bleibt Laserball, auch wenn ein `0xxx`-Code auftaucht —
  `0201` (Fehlwurf) kommt in Laserball regulär vor.
- `0201` und die `09xx`-Achievements zählen als „beide" und können deshalb
  keine Fehlkorrektur auslösen.

Das ist der Rettungsanker für kaputte oder fehlende Typ-1-Zeilen: ein
Laserball-Match, das ohne Typ-1-Zeile anläuft, startet als Familie `sm5` und
schaltet beim ersten `11xx`-Code selbständig um.

> **Nebeneffekt, den man kennen sollte.** Spieler, die sich **vor** der
> Korrektur einloggen, haben beide Zählersätze auf ihrem Objekt: die 12
> Laserball-Zähler (die sind immer da) und zusätzlich die 30 SM5-Zähler auf 0.
> Es geht dabei nichts verloren und nichts wird doppelt gezählt — der jeweils
> unpassende Satz bleibt einfach auf 0.

---

## Zählerfelder: Familie `laserball`

Unverändert gegenüber dem bisherigen Verhalten — gleiche Namen, gleiche
Bedeutung, gleiche Zählweise.

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `goals` | `goals` | Tore | Bälle, die dieser Spieler im gegnerischen Tor versenkt hat | `1101` / `1102` |
| `assists` | `assists` | Vorlagen | Pass oder Befreiungspass, nach dem der Empfänger binnen 10 s ein Tor erzielt hat | `1100` / `1109` + `1101` |
| `passesDone` | `passes_done` | Pässe gespielt | Ball an einen Mitspieler abgegeben | `1100` (Actor) |
| `passesReceived` | `passes_received` | Pässe erhalten | Ball von einem Mitspieler bekommen | `1100` (Ziel) |
| `clearsDone` | `clears_done` | Befreiungspässe gespielt | Ball aus der eigenen Gefahrenzone herausgespielt (im Spiel „Clear") | `1109` (Actor) |
| `clearsReceived` | `clears_received` | Befreiungspässe erhalten | Ball aus dem Befreiungspass eines Mitspielers bekommen | `1109` (Ziel) |
| `stealsDone` | `steals_done` | Ball abgenommen | Einem Gegner den Ball abgenommen | `1103` (Actor) |
| `stealsReceived` | `steals_received` | Ball verloren | Ein Gegner hat diesem Spieler den Ball abgenommen | `1103` (Ziel) |
| `blocksDone` | `blocks_done` | Gegner geblockt | Einen noch aktiven Gegner abgeschossen und damit gestoppt | `1104`, Ziel-Status ≠ 2 |
| `blocksReceived` | `blocks_received` | Selbst geblockt worden | Ein Gegner hat diesen Spieler im aktiven Zustand gestoppt | `1104` (Ziel) |
| `resetsDone` | `resets_done` | Gegner zurückgesetzt | Einen bereits ausgeschalteten Gegner erneut getroffen, seine Wartezeit läuft neu | `1104`, Ziel-Status = 2 |
| `resetsReceived` | `resets_received` | Selbst zurückgesetzt worden | Im ausgeschalteten Zustand erneut getroffen worden, Wartezeit läuft neu | `1104` (Ziel) |

Der Unterschied zwischen Block und Reset hängt allein am `status` des Ziels aus
der Typ-9-Zeile. Die expliziten Reset-Codes `110B` / `110C` erzeugen ein
sichtbares Ereignis, aber **keinen** Zählerstand — das war vorher so und bleibt so.

---

## Zählerfelder: Familie `sm5`

Neu. Live gezählt aus den `0xxx`-Codes; am Matchende vom offiziellen
Typ-7-Endblock korrigiert (siehe [nächster Abschnitt](#warum-die-sm5-live-zahlen-eine-untergrenze-sind)).

### Schießen

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `shotsFired` | `shots_fired` | Abgegebene Schüsse | Wie oft der Spieler geschossen hat. Live eine **Untergrenze** — siehe unten | `0201` `0202` `0203` `0204` `0205` `0206` |
| `shotsHit` | `shots_hit` | Erzielte Treffer | Schüsse, die einen Gegner oder ein Ziel getroffen haben | `0203` `0204` `0205` `0206` (nur gegen Gegner) |
| `accuracy` | `accuracy` | Trefferquote | **Abgeleitet:** `shotsHit / shotsFired`. Live eine Näherung und systematisch **zu hoch** — siehe [eigener Abschnitt](#die-trefferquote--und-warum-sie-live-zu-hoch-ist) | berechnet |
| `misses` | `misses` | Fehlschüsse | Schüsse, die die Anlage ausdrücklich als Fehlschuss gemeldet hat | `0201` `0202` |
| `deactivations` | `deactivations` | Gegner abgeschossen | Wie oft der Spieler einen Gegner **ausgeteilt** aus dem Spiel genommen hat | `0206` gegen Gegner |
| `timesDeactivated` | `times_deactivated` | Selbst abgeschossen worden | Das Gegenstück: wie oft der Spieler selbst ausfiel | `0206` (Ziel), `0209` (Warbot) |
| `timesHit` | `times_hit` | Selbst getroffen worden | Gegnerische Treffer, auch solche ohne Ausfall | `0205` / `0206` (Ziel) |
| `shotTeam` | `shot_team` | Eigene Mitspieler getroffen | Eigenbeschuss, **ausgeteilt** | `0205` / `0206`, gleiches Team |
| `timesHitByTeam` | `times_hit_by_team` | Vom eigenen Team getroffen worden | Eigenbeschuss, **erhalten** | `0205` / `0206` (Ziel), gleiches Team |

> **Ausgeteilt gegen erhalten.** Bei jedem Paar sagt schon die Bezeichnung, in
> welche Richtung es geht: „Gegner abgeschossen" gegen „Selbst abgeschossen
> worden", „Eigene Mitspieler getroffen" gegen „Vom eigenen Team getroffen
> worden", „Ball abgenommen" gegen „Ball verloren". Wer nur eine Spalte sieht,
> weiß trotzdem, was sie zählt.

### Nicht-Spieler-Ziele

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `targetHits` | `target_hits` | Ziele getroffen | Treffer auf ein festes Ziel in der Arena; 3 Treffer zerstören es | `0203` |
| `targetDestroys` | `target_destroys` | Ziele zerstört | Festes Ziel in der Arena zerstört | `0204` |
| `beaconClaims` | `beacon_claims` | Beacons erobert | Ein Beacon endgültig für sich entschieden | `0B00` |
| `baseAwards` | `base_awards` | Basen zugesprochen | Bei vorzeitigem Spielende automatisch gutgeschriebenes Ziel | `0B03` |

### Raketen

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `missileLocks` | `missile_locks` | Raketen aufgeschaltet | Der Schritt unmittelbar vor dem Abschuss | `0300` |
| `missileHits` | `missile_hits` | Gegner mit Rakete getroffen | Eigene Rakete hat einen Gegner erwischt | `0306` |
| `missileMisses` | `missile_misses` | Raketen daneben | Eigene Rakete ohne Ziel | `0301` `0304` |
| `missileDestroys` | `missile_destroys` | Ziele mit Rakete zerstört | Festes Ziel in der Arena per Rakete zerstört | `0303` |
| `timesMissiled` | `times_missiled` | Selbst von Rakete getroffen worden | Das Gegenstück: gegnerische Rakete hat getroffen | `0306` / `0308` (Ziel) |
| `missileTeam` | `missile_team` | Rakete auf eigenes Team | Eigene Rakete hat einen Mitspieler getroffen | `0308` |

### Spezialfähigkeiten und Versorgung

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `nukesActivated` | `nukes_activated` | Nukes gestartet | Nuke ausgelöst; nur der Commander hat sie | `0404` |
| `nukesDetonated` | `nukes_detonated` | Nukes gezündet | Davon tatsächlich hochgegangen — abwehrbar | `0405` |
| `rapidFires` | `rapid_fires` | Dauerfeuer eingesetzt | Dauerfeuer ausgelöst; nur der Scout hat es | `0400` |
| `ammoResupplies` | `ammo_resupplies` | Munition ausgegeben | Einen einzelnen Mitspieler versorgt | `0500` (Actor) |
| `ammoReceived` | `ammo_received` | Munition erhalten | Das Gegenstück: selbst versorgt worden | `0500` (Ziel) |
| `livesResupplies` | `lives_resupplies` | Leben ausgegeben | Einem einzelnen Mitspieler ein Leben gegeben (Medic) | `0502` (Actor) |
| `livesReceived` | `lives_received` | Leben erhalten | Das Gegenstück: selbst ein Leben bekommen | `0502` (Ziel) |
| `teamAmmoResupplies` | `team_ammo_resupplies` | Munition für das ganze Team | Spezialfähigkeit des Ammo Carriers, versorgt alle auf einmal | `0510` |
| `teamLivesResupplies` | `team_lives_resupplies` | Leben für das ganze Team | Spezialfähigkeit des Medics, versorgt alle auf einmal | `0512` |

### Sonstiges

| Feld | CSV-Spalte | Bezeichnung | Was die Zahl bedeutet | Auslöser |
|---|---|---|---|---|
| `penalties` | `penalties` | Strafen | Strafen der Aufsicht gegen diesen Spieler | `0600` |
| `achievements` | `achievements` | Erfolge | Auszeichnungen, die die Anlage im Spiel zuerkennt | `0900` `0901` |
| `rewards` | `rewards` | Belohnungen | Belohnungen des Standorts, z. B. ein Freispiel | `0902` |

### Rolle, Level, Weste

Unabhängig von der Familie merkt sich lf_live jetzt zusätzlich aus der
Typ-3-Zeile: `level`, `category` und den aufgelösten `roleLabel`, dazu
`battlesuit` und `memberId`, sofern die Anlage sie schickt.

| `category` | `roleLabel` |
|---|---|
| `0` | N/A |
| `1` | Commander |
| `2` | Heavy Weapons |
| `3` | Scout |
| `4` | Ammo Carrier |
| `5` | Medic |

In Laserball ist `category` immer `0`.

`level` und `roleLabel` sind **keine** Familiensache: beide stehen in jedem
Modus im Zustand, in jedem Profil im Scoreboard (Rolle nur im Profil `sm5`, weil
sie in Laserball leer bliebe) und in jeder Spieler-CSV-Zeile.

---

## Die Trefferquote — und warum sie live zu hoch ist

`accuracy` = `shotsHit / shotsFired`. Die Zahl wird nirgends gezählt, sondern
von der Engine bei jedem Zustandswechsel neu berechnet.

### Die Richtung des Fehlers

Die **Live**-Quote ist **systematisch zu hoch**, nicht zu niedrig. Der Grund
steckt in der Zusammensetzung von Zähler und Nenner:

- Der **Nenner** `shotsFired` steigt nur bei Ereignissen, die beweisen, dass ein
  Schuss stattgefunden hat: `0201` `0202` `0203` `0204` `0205` `0206`. Ein
  Schuss, den die Anlage **gar nicht** meldet, fehlt darin.
- Der **Zähler** `shotsHit` steigt bei `0203` `0204` `0205` `0206`. Jeder
  Treffer **erzeugt** zwangsläufig eines dieser Ereignisse — im Zähler fehlt
  also nichts.

Ein vollständiger Zähler über einem zu kleinen Nenner ergibt einen **zu großen**
Quotienten. Beispiel: ein Spieler schießt 100-mal, trifft 30-mal, und 40
Fehlschüsse werden von der Anlage nicht protokolliert. Live steht dann 30/60 =
**50 %** statt der tatsächlichen 30/100 = **30 %**.

> **Korrektur einer früheren Fassung dieser Doku.** Hier stand, die Quote falle
> „zu niedrig" aus. Das war falsch herum. Richtig ist: **`shotsFired` ist zu
> niedrig — und genau deshalb ist die daraus gebildete Quote zu hoch.** Die
> Untergrenzen-Aussage gilt für den Zähler `shotsFired`, nicht für das Verhältnis.

### Wie lf_live damit umgeht

Die Näherung wird geliefert, aber **als Näherung gekennzeichnet**, damit keine
Oberfläche sie als Messwert ausgibt:

| Feld | Während des Matches | Nach dem Typ-7-Endblock |
|---|---|---|
| `accuracy` | Näherung aus der Eigenzählung | neu berechnet aus den **amtlichen** `shotsHit`/`shotsFired` |
| `accuracyIsEstimate` | `true` | `false` |
| `accuracySource` | `live` | `tdf7` |

`accuracyIsEstimate` ist genau dafür da, dass die Oberfläche die Näherung
sichtbar machen kann (Sternchen, Tilde, ausgegrauter Wert — was auch immer).

Zwei Sonderfälle, bewusst so:

- **`shotsFired = 0` ⇒ `accuracy = null`**, nicht `0`. Wer nie geschossen hat,
  hat keine messbare Quote; eine `0` läse sich wie „hat nie getroffen".
- In **Laserball** gibt es die Felder gar nicht — dort wird kein Schuss gezählt.

In der CSV stehen **zwei getrennte Spalten**: `accuracy` (die Quote) und
`accuracy_source` (ihre Herkunft, `live` oder `tdf7`).

---

## Die amtlichen Typ-7-Felder

Der Typ-7-Endblock liefert je Spieler **alle 23** amtlichen Felder. Sie liegen
roh unter `players[id].official`. Elf davon haben **keine** Entsprechung unter
den Live-Zählern — es gibt sie schlicht erst, wenn das Match vorbei ist. Diese
elf werden zusätzlich direkt auf das Spielerobjekt gehoben:

| Feld | CSV-Spalte | Bezeichnung | Bedeutung | Belegt? |
|---|---|---|---|---|
| `livesLeft` | `lives_left` | Leben übrig | Leben, die dem Spieler am Schluss geblieben sind | aus dem Namen klar |
| `shotsLeft` | `shots_left` | Munition übrig | Schuss Munition, die dem Spieler am Schluss geblieben sind | aus dem Namen klar |
| `medicHits` | `medic_hits` | Gegnerische Medics getroffen | Treffer auf Medics des gegnerischen Teams | **unbestätigt** |
| `ownMedicHits` | `own_medic_hits` | Eigene Medics getroffen | Treffer auf Medics des eigenen Teams | **unbestätigt** |
| `medicNukes` | `medic_nukes` | Nukes gegen Medics | Nukes, die einen Medic betroffen haben | **unbestätigt** |
| `scoutRapid` | `scout_rapid` | Dauerfeuer des Scouts | Dauerfeuer-Einsätze des Scouts; Abgrenzung zu `rapidFires` unklar | **unbestätigt** |
| `lifeBoost` | `life_boost` | Leben-Boosts erhalten | Erhaltene Leben-Boosts; Abgrenzung zu `livesReceived` unklar | **unbestätigt** |
| `ammoBoost` | `ammo_boost` | Munitions-Boosts erhalten | Erhaltene Munitions-Boosts; Abgrenzung zu `ammoReceived` unklar | **unbestätigt** |
| `nukesCancelled` | `nukes_cancelled` | Gegnerische Nukes abgewehrt | Verhinderte Nukes des Gegners | **unbestätigt** |
| `ownNukeCancels` | `own_nuke_cancels` | Nukes des eigenen Teams abgewehrt | Verhinderte Nukes aus dem eigenen Team | **unbestätigt** |
| `shot3Hit` | `shot3_hit` | Dreifach-Treffer (unbestätigt) | **Nicht belegt.** Was gezählt wird, sagt der Feldname nicht; die Zahl wird unverändert durchgereicht | **unbestätigt** |

Die Spalte „Belegt?" ist der Grund, warum die **Erklärtexte** dieser neun Felder
in der Konsole ausdrücklich sagen, dass ihre Bedeutung aus der
Protokollbeschreibung erschlossen und an einer echten Anlage nicht geprüft ist.
Bei `shot3Hit` steht die Unsicherheit sogar in der Bezeichnung selbst, weil der
Feldname allein gar keine Bedeutung hergibt — geraten wird hier nicht.

`livesLeft` und `shotsLeft` stehen im Scoreboard des Profils `sm5`; alle elf
stehen in der CSV des Profils `sm5`.

> **Vor dem Matchende sind diese Felder `null` — und in der CSV eine LEERE
> Zelle, keine `0`.** Das ist Absicht. Eine `0` in einer Statistiktabelle liest
> sich als Messwert („dieser Spieler hatte null Leben übrig"); leer heißt
> ehrlich „noch nicht gemessen". Dasselbe gilt für `accuracy`, solange niemand
> geschossen hat, und für `level`, wenn die Anlage keines meldet.
>
> Die Feldbedeutungen stammen aus der lfstats-Spezifikation und sind **nicht**
> gegen eine echte Anlage geprüft — siehe
> [Bekannte Lücken](#bekannte-lücken--unbestätigt).

---

## Spaltenbeschriftungen

**Alle** Beschriftungen für Scoreboard, Statistiktabelle, Legende und CSV-Kopf
stehen an **einer** Stelle: Konstante `METRICS` in
[`src/gameModes.js`](../src/gameModes.js). Je Kennzahl:

| Teil | Wofür |
|---|---|
| `label` | die **ausgeschriebene Bezeichnung**. Sie ist der Normalfall in jedem Tabellenkopf und muss ohne Vorwissen verständlich sein |
| `short` | Notreserve für sehr enge Stellen. Wird **nicht** mehr bevorzugt |
| `help` | ein bis zwei deutsche Sätze: **was die Zahl bedeutet und wie sie entsteht**. Wird als Tooltip **und** in der Legende angezeigt |
| `group` | in welchen Abschnitt der Legende die Kennzahl gehört (siehe unten) |
| `format` | `int` · `text` · `percent` — wie der Wert darzustellen ist |
| `csv` | die CSV-Schreibweise, wo sie von `snake(key)` abweicht (`roleLabel` → `role`) |

> **Die CSV-Spaltennamen ändern sich nie.** Sie sind eine Schnittstelle: der
> Betreiber hat bereits Dateien und Auswertungen damit. Geändert wurden
> ausschließlich die **Anzeigetexte** (`label`, `short`, `help`).

### Die Gruppen — damit die Legende keine Liste aus vierzig Zeilen wird

Jede Kennzahl nennt genau **eine** Gruppe. Die Konsole druckt ihre Legende
abschnittsweise, in genau dieser Reihenfolge (Konstante `METRIC_GROUPS`):

| Gruppe | Überschrift | Was darin steht |
|---|---|---|
| `identity` | Spiel und Spieler | Wer hat wann in welchem Modus gespielt |
| `result` | Ergebnis | Punkte und Ausgang des Matches |
| `attack` | Angriff | Was der Spieler **ausgeteilt** hat — inklusive Tore und Vorlagen |
| `defense` | Verteidigung | Was er **einstecken** musste oder abgewehrt hat |
| `possession` | Ballbesitz | Nur Laserball: Pässe, Befreiungspässe, abgenommene und verlorene Bälle |
| `targets` | Ziele in der Arena | Feste Ziele, Beacons, Basen — keine Spieler |
| `missiles` | Raketen | Alles rund um die Rakete |
| `equipment` | Ausrüstung und Spezialfähigkeiten | Munition, Leben, Nuke, Dauerfeuer, Restbestände |
| `misc` | Sonstiges | Strafen, Erfolge, Belohnungen |
| `totals` | Gesamtwertung | Summen und Schnitte über mehrere Matches |
| `provenance` | Herkunft der Zahlen | Woher ein Wert stammt und wie belastbar er ist |

Abrufbar über:

| Funktion | Liefert |
|---|---|
| `metricLabels()` | die ganze Tabelle, **doppelt verschlüsselt**: unter dem camelCase-Feldnamen *und* unter der snake_case-CSV-Spalte |
| `metricInfo(key)` | einen Eintrag samt `group` und `groupLabel`, egal in welcher der beiden Schreibweisen gefragt wird |
| `metricLabel(key)` | nur die Bezeichnung |
| `metricGroups()` | die Abschnitte der Legende in Anzeigereihenfolge: `[{group,label,help}]` |

`scoreboardColumns()` setzt Bezeichnung, Erklärtext, Gruppe und Format bereits
in seine Spaltenobjekte ein — ein Consumer braucht dafür nichts nachzuschlagen.

### Wie die Legende in die Oberfläche kommt

`GET /api/modes` liefert alles, was eine Legende braucht, ohne dass die Konsole
eine eigene Texttabelle führt:

- `metrics` — die ganze `METRICS`-Tabelle je Eintrag mit `label`, `short`,
  `help`, `group`, `groupLabel`, `format`, `csv`
- `metricGroups` — die Abschnitte in Anzeigereihenfolge
- `scoreboard[<profil>]` — die Spalten des Profils, jede schon mit `group`

Die Konsole gruppiert die Spalten des **laufenden** Profils nach `group`, druckt
die Abschnitte in der Reihenfolge von `metricGroups` und je Kennzahl `label` und
`help`. Details: [API.md](API.md#get-apimodes).

---

## Warum die SM5-Live-Zahlen eine Untergrenze sind

**Laserforce meldet keinen eigenen „Schuss"-Event.** Es gibt im Protokoll keine
Zeile, die sagt „Spieler X hat abgedrückt". Es gibt nur Zeilen für das
*Ergebnis*: Treffer, Fehlschuss, Zerstörung.

lf_live erhöht `shotsFired` deshalb nur dort, wo ein Ereignis beweist, dass ein
Schuss stattgefunden hat. Alles, was die Anlage nicht als Ereignis meldet —
etwa Schüsse gegen ein bereits deaktiviertes Ziel oder ins Leere, die die Anlage
nicht als `0201` protokolliert — fehlt in der Live-Zahl.

**Konsequenz, und hier muss man genau hinsehen:**

| Größe | Richtung des Fehlers |
|---|---|
| `shotsFired` (der **Zähler**stand) | **zu niedrig** — es fehlen Schüsse, die nie gemeldet wurden |
| `accuracy` (die **Quote** daraus) | **zu hoch** — der Nenner ist zu klein, der Zähler vollständig |

Das ist kein Widerspruch, sondern dieselbe Ursache aus zwei Blickwinkeln: was im
Nenner fehlt, sind ausschließlich **Nicht**-Treffer. Ausführlich mit Rechenbeispiel:
[Die Trefferquote](#die-trefferquote--und-warum-sie-live-zu-hoch-ist).

Für alle übrigen SM5-Live-Zähler gilt abgeschwächt dasselbe wie für
`shotsFired`: sie sind Untergrenzen.

### Der Typ-7-Endblock korrigiert das

Am Ende eines SM5-Matches — **vor** dem Mission-Ende `0101` — schickt die Anlage
je Spieler eine **Typ-7-Zeile** mit der offiziellen Endstatistik. lf_live liest
sie und:

1. legt die **kompletten Rohwerte** der Anlage unter `players[id].official` ab,
2. **überschreibt** die passenden Live-Zähler mit den offiziellen Werten,
3. hebt die elf Felder **ohne** Live-Pendant direkt auf das Spielerobjekt
   ([Tabelle oben](#die-amtlichen-typ-7-felder)) — vorher stehen sie auf `null`,
4. setzt `players[id].statsSource` von `live` auf **`tdf7`**, berechnet
   `accuracy` aus den amtlichen Zahlen neu und setzt `accuracyIsEstimate` auf
   `false`,
5. löst ein `sm5_stats`-Ereignis aus.

Überschrieben werden:

| Typ-7-Feld | überschreibt |
|---|---|
| `shotsHit` | `shotsHit` |
| `shotsFired` | `shotsFired` |
| `timesZapped` | `timesDeactivated` |
| `timesMissiled` | `timesMissiled` |
| `missileHits`, danach `missiledOpponent` | `missileHits` |
| `nukesDetonated` | `nukesDetonated` |
| `nukesActivated` | `nukesActivated` |
| `penalties` | `penalties` |
| `shotOpponent` | `deactivations` |
| `shotTeam` | `shotTeam` |
| `missiledTeam` | `missileTeam` |

Alle übrigen Live-Zähler (`misses`, `targetHits`, `missileLocks`,
`ammoResupplies`, `achievements` …) haben **keine** Entsprechung im Typ-7-Block
und bleiben die Live-Zahlen — also weiterhin Untergrenzen.

Umgekehrt haben elf **amtliche** Felder kein Live-Pendant — `livesLeft`,
`shotsLeft` und der Medic-/Boost-/Nuke-Abwehr-Block. Sie existieren erst ab
diesem Moment und sind vorher leer: [Die amtlichen Typ-7-Felder](#die-amtlichen-typ-7-felder).

> **Das ist der Grund, warum sich Zahlen am Spielende ändern können.** Wenn auf
> dem Scoreboard während des Matches 240 Schüsse stehen und nach dem Abpfiff
> plötzlich 317, ist nichts kaputt: die Anlage hat ihre offizielle Zahl
> nachgeliefert. `statsSource` zeigt an, welcher Stand gerade gilt —
> `live` = Eigenzählung (Untergrenze), `tdf7` = offizielle Zahlen der Anlage.

Weil der Typ-7-Block **vor** `0101` kommt, sieht auch die CSV-Ablage die
offiziellen Zahlen und nicht die Live-Untergrenze.

In **Laserball gibt es keine Typ-7-Zeilen.** Die 12 Laserball-Zähler sind reine
Eigenzählung aus den `11xx`-Events und waren das schon immer.

---

## Punktestand: woher kommt er?

Der Punktestand kommt **von der Anlage**, nicht von lf_live. Die Anlage schickt
zu jedem punkterelevanten Ereignis eine **Typ-5-Zeile**:

```
5  time  entity  old  delta  new
```

`entity` ist entweder ein Team-Index oder eine Spieler-ID. lf_live unterscheidet
das anhand der bekannten Spielerliste: ist es eine bekannte Spieler-ID, landet
der Wert in `players[id].score`, sonst als Team-Punktestand in
`gameState.scores`. Beides wird parallel geführt.

Die **Eigenzählung ist nur noch Rückfall.** Solange keine Typ-5-Zeile eingetroffen
ist, zählt lf_live Laserball-Tore wie bisher selbst hoch. Sobald die erste
Typ-5-Zeile ankommt, hört die Eigenzählung auf, den Punktestand zu verändern —
das Tor-Ereignis und der `goals`-Zähler bleiben davon völlig unberührt.

### `scoreSource`

| Wert | Heißt |
|---|---|
| `internal` | Noch keine Typ-5-Zeile in diesem Match. Der Punktestand ist die Eigenzählung. |
| `tdf` | Die Anlage hat Punkte gemeldet. Der Punktestand ist der offizielle. |

`scoreSource` wird bei jedem Mission-Start `0100` auf `internal` zurückgesetzt,
damit ein Match nicht die Autorität des Vormatches erbt. Das Feld steht im
Snapshot und in `GET /api/status`.

---

## Die Spieluhr

| `durationKnown` | Was passiert |
|---|---|
| `true` | Die Anlage hat eine Missionsdauer gemeldet. Die Uhr zählt **herunter**. `remainingMs` ist die Restzeit in Millisekunden. |
| `false` | Keine verwertbare Dauer. Die Uhr zählt **hoch** ab 0 („Laufzeit" statt „Restzeit"). `remainingMs` ist `null`. |

`remainingMs` wird von der Engine berechnet und im Snapshot mitgeliefert.
**Niemand außerhalb der Engine rechnet noch selbst `duration - elapsedTime`** —
sonst entsteht bei unbekannter Dauer ein sinnloser oder negativer Wert.

Wie die Dauer gelesen wird:

1. **Schema zuerst.** Nennt eine `;`-Schema-Kommentarzeile die Spalte `duration`,
   wird genau die gelesen.
2. **Position nur als Rückfall.** Ohne Schema werden ausschließlich die **letzten
   drei** Tokens der Typ-1-Zeile betrachtet — dort liegen `start`, `duration`
   und `penalty`. Der erste Kandidat, der die Plausibilitätsprüfung besteht,
   gewinnt, weil `duration` immer vor `penalty` steht und `start` (ein
   Zeitstempel) nie in das Plausibilitätsfenster fällt.
3. **Einheiten-Heuristik.** Ein Rohwert unter `10000` wird als **Sekunden**
   gelesen und mit 1000 multipliziert, alles darüber als Millisekunden.
4. **Plausibilitätsfenster 60 000 – 7 200 000 ms** (1 Minute bis 2 Stunden).
   Was außerhalb liegt, wird verworfen → `durationKnown: false`.

> **Die alte Dauer-Erkennung war fehlerhaft.** Sie las schlicht die *vorletzte
> Spalte*. Das ging nur gut, weil `start`, `duration` und `penalty` zufällig alle
> numerisch am Zeilenende stehen. Fehlt die `penalty`-Spalte (TDF vor 2.003),
> las sie die **Startzeit** statt der Dauer; hängt eine spätere TDF-Version eine
> weitere Spalte an, geht es genauso schief. Genau das ist in Typ 2 mit der
> `#rgb`-Spalte bereits passiert. Details:
> [LASERFORCE.md](LASERFORCE.md#typ-1-mission-im-detail).

---

## Wo die Zahlen landen

Der erkannte Modus wirkt sich an drei Stellen aus.

### CSV-Ablage — getrennt je Familie

Weil eine Laserball-Zeile Tore und eine SM5-Zeile Schüsse zählt, gibt es keine
gemeinsame Gesamtwertung. Jede Sammel- und Summendatei existiert je Familie
einmal:

| Datei | Inhalt |
|---|---|
| `all_players_laserball.csv` / `all_players_sm5.csv` | jede Spieler-Zeile dieser Familie |
| `totals_laserball.csv` / `totals_sm5.csv` | Gesamtwertung dieser Familie |
| `matches.csv` | eine Zeile je Match mit `mode_key`, `mode_label`, `mode_number`, `family` |
| `player_modes.csv` | je Spieler und Modus: Anzahl, `first_played`, `last_played`, Bilanz, Spielzeit |

Jede Spieler-Zeile trägt vorne `mode_key`, `mode_label`, `mode_number`,
`family` und `profile`, ganz hinten `stats_source` (`live` oder `tdf7`),
`score_source` (`internal` oder `tdf`) und — wo es eine Quote gibt —
`accuracy_source`. Die Laserball-Zählerspalten sind zeichengleich mit denen der
Vorversion. Vollständige Spaltenlisten, die Spalten- und Zeilensortierung und
der Migrationshinweis für Altdaten: [STATS.md](STATS.md).

> **Welches Profil eine Datei hat.** Die Datei zu **einem** Match nimmt die
> Spalten **ihres** Profils. Die anhängende Sammeldatei
> `all_players_<familie>.csv` kann das nicht: ihr Kopf steht ab der ersten Zeile
> fest, und zwei Profile derselben Familie (`standard` und `sm5`) hätten
> verschiedene Köpfe. Sie nimmt deshalb immer das **Standardprofil der Familie**
> — das ist zugleich das breiteste. Die Spalte `profile` in jeder Zeile sagt,
> mit welchem Profil das Match gespielt wurde.

### API

`GET /api/status` liefert unter `match` zusätzlich `mode`, `durationKnown`,
`remainingMs` und `scoreSource`; `GET /api/state` dieselben Felder im Snapshot.
Der Endpunkt `GET /api/modes` gibt die Registry (jeder Eintrag jetzt mit
`profile`), den aktuell erkannten Modus — dessen `mode.profile` — und die
Scoreboard-Spalten zurück. Details: [API.md](API.md#get-apimodes).

### Web-Konsole

Im Kopf steht ein Modus-Chip mit `mode.label` und einem dezenten Hinweis, wenn
der Modus unbekannt ist oder die Familie zur Laufzeit korrigiert wurde. Die
Spalten der Spielertabelle kommen aus `/api/modes` statt aus einer fest
verdrahteten Liste, und die Uhr zeigt bei `durationKnown: false` „Laufzeit"
statt „Restzeit" und zählt hoch.

---

## Eigene Modus-Nummern ermitteln und eintragen

Belegt sind nur `5` und `28`. Welche Nummern **Ihre** Anlage für 7SM/Nexus,
Junior, Zombies oder Ihre Laserball-Varianten verwendet, lässt sich nur an der
echten Anlage messen. Das Werkzeug dafür ist
[`scripts/inspect.js`](../scripts/inspect.js).

### Schritt 1 — Inspektor starten

```bash
node scripts/inspect.js 9100
```

Das ist ein blanker TCP-Server auf Port 9100, der **nichts interpretiert** —
er katalogisiert nur, was er sieht. Er läuft **neben** lf_live; der eigentliche
Betrieb muss dafür nicht abgeschaltet werden, nur der Export umgestellt.

### Schritt 2 — Export umstellen

Im Laserforce-Betriebssystem das Ziel des Log-Exports **vorübergehend** auf
`<IP-des-Hallen-PCs>:9100` stellen (statt `:9000`). Nach dem Test wieder
zurückstellen — sonst läuft lf_live leer.

### Schritt 3 — Je ein Match pro Modus spielen

Wichtig: **der Export muss vom Missionsstart an mitlaufen.** Die Typ-1-Zeile mit
der Modus-Nummer kommt ganz am Anfang. Wer mittendrin anschaltet, bekommt die
Nummer nicht. Für jeden Modus, der eingetragen werden soll, ein Match — auch ein
sehr kurzes reicht, solange Typ-1 und ein paar Events dabei sind.

### Schritt 4 — Beenden

`Ctrl+C` drücken (oder den Export trennen). Der Inspektor gibt eine **deutsche
Zusammenfassung** auf der Konsole aus und schreibt `inspect-report.json` in das
Verzeichnis, aus dem er gestartet wurde. Die JSON-Datei wird außerdem alle
10 Sekunden aktualisiert, geht also auch bei einem harten Abbruch nicht verloren.

> Kleinigkeit: Trennt sich die Anlage und man drückt danach noch `Ctrl+C`, wird
> die Zusammenfassung zweimal ausgegeben. Beide Ausgaben sind identisch.

### Schritt 5 — Den Abschnitt „SPIELMODI IN DIESER AUFZEICHNUNG" lesen

Pro gesehenem Modus stehen dort:

| Zeile | Was sie sagt |
|---|---|
| `Modus <n> „<Beschreibung>"` | Die Modus-Nummer und der Name, den die Anlage mitschickt |
| `Status` | `BEKANNT` samt `key` und Familie aus der Registry, oder `UNBEKANNT — lf_live kennt diesen Modus NICHT` |
| `Missionen` | Wie oft dieser Modus in der Aufzeichnung vorkam |
| `Dauer` | Der erkannte Dauer-Wert, aus welcher Quelle (Schema oder Heuristik) und aus welcher Spalte |
| `Zeilentypen` | Welche Zeilentypen in diesem Modus vorkamen, mit Häufigkeit |
| `Typ-7-Zeilen` | Anzahl. **`0` ist ein starker Hinweis auf Laserball** — SM5 schickt immer welche |
| `Event-Codes` | Jeder Typ-4-Code dieses Modus mit Häufigkeit und Beispielzeile. `11xx` ⇒ Laserball, `0xxx` ⇒ SM5 |
| `Rohzeile` | Die Typ-1-Zeile im Original |

Zusätzlich listet der Abschnitt **SCHEMA-KOMMENTARE** alle `;`-Zeilen mit ihren
Spaltennamen und Positionen, und der Abschnitt **TYP-7-ZEILEN** die tatsächliche
Feldzahl der Endstatistik.

### Schritt 6 — Den Abschnitt „WAS JETZT ZU TUN IST" lesen

Der Inspektor lädt dazu die Registry aus `src/gameModes.js` und gleicht jede
gesehene Nummer dagegen ab. Sind alle bekannt, steht dort schlicht „Alle
aufgezeichneten Spielmodi sind lf_live bereits bekannt. Nichts zu tun." Sonst
nennt er für jeden unbekannten Modus genau die Zeile, die zu melden ist:

```
 1 Spielmodus/-modi ist/sind lf_live UNBEKANNT.

   Modus 14  →  Space Marines 7 Nexus
   Rohzeile: 1 | 14 | Space Marines 7 Nexus | 20260916120000 | 900000 | 0
   Codes:    0100 0101 0205
```

> Die Konsolenausgabe stellt Tabulatoren als ` | ` dar, damit man die
> Spaltengrenzen sieht. Die Rohzeile in `inspect-report.json` ist das Original.
>
> Lässt sich `src/gameModes.js` einmal nicht laden, sagt der Inspektor das
> ausdrücklich und stuft jeden Modus als `ungeprüft` ein. Nummern,
> Beschreibungen, Codes und Rohzeilen stimmen dann trotzdem — man vergleicht sie
> von Hand mit der [Registry-Tabelle oben](#die-registry).

### Schritt 7 — Den Modus eintragen

In [`src/gameModes.js`](../src/gameModes.js), Konstante `REGISTRY`, eine Zeile
ergänzen:

```js
const REGISTRY = {
  5:  { number: 5,  key: 'sm5',              label: 'Space Marines 5',  family: FAMILIES.SM5,       profile: PROFILES.SM5 },
  28: { number: 28, key: 'laserball_ranked', label: 'Laserball Ranked', family: FAMILIES.LASERBALL, profile: PROFILES.LASERBALL },
  14: { number: 14, key: 'sm7_nexus',        label: '7SM Nexus',        family: FAMILIES.SM5 },
};
```

Regeln für den Eintrag:

- **`number`** — die Nummer aus der Typ-1-Zeile, als Zahl.
- **`key`** — stabiler Kurzname in Kleinbuchstaben mit Unterstrichen. Er landet
  in CSV-Dateien und in der API; einmal vergeben, sollte er sich nicht mehr
  ändern, sonst passen alte und neue Auswertungen nicht zusammen.
- **`label`** — Anzeigename. Wird von der Beschreibung aus dem Stream
  überschrieben, sofern die Anlage eine schickt.
- **`family`** — `FAMILIES.LASERBALL` **nur**, wenn im Inspektor `11xx`-Codes
  aufgetaucht sind. In allen anderen Fällen `FAMILIES.SM5`.
- **`profile`** — **optional.** Weglassen heißt: Standardprofil der Familie
  (`sm5` → `sm5`, `laserball` → `laserball`). Nur angeben, wenn der Modus
  bewusst einen **anderen** Spaltensatz zeigen soll als seine Familie —
  `PROFILES.STANDARD` ist genau dafür da (siehe
  [„Standard" eintragen](#standard-eintragen--die-eine-zeile)).

Danach lf_live neu starten. Ohne Eintrag funktioniert der Modus trotzdem — er
heißt dann nur `mode_14` statt `sm7_nexus` und ist als unbekannt markiert.

> Wer sich bei der Familie unsicher ist, trägt sie **nicht** ein: ein fehlender
> Eintrag landet bei `sm5` und wird bei `11xx`-Codes zur Laufzeit automatisch
> korrigiert. Ein **falscher** Eintrag auf `laserball` wird dagegen nie zu `sm5`
> zurückkorrigiert, wenn die Nummer `28` ist — und ein falscher Eintrag ist
> schlechter als gar keiner.

---

## Bekannte Lücken / unbestätigt

Im Stil der übrigen Doku: hier steht ehrlich, was **nicht** belegt ist.

| Thema | Was fehlt / unklar | Status |
|---|---|---|
| **Modus-Nummern insgesamt** | Belegt sind ausschließlich `5` (SM5) und `28` (Laserball Ranked). Alle anderen Nummern sind unbekannt und müssen an der Anlage ermittelt werden. | verified (nur diese zwei) |
| **7SM / Nexus** | Modus-Nummer unbekannt. Codesatz nicht belegt; Annahme: `0xxx` wie SM5, weil dieselbe Firmware. | unbestätigt |
| **SM5-Varianten** (Zombies, VIP, Kill Confirmed, Zone Control, Attack & Defend, Junior, Highlander, 2v2 …) | Weder Nummern noch eventuelle Sonder-Codes bekannt. Annahme: `0xxx` wie SM5. | unbestätigt |
| **Laserball-Varianten** | Nummern unbekannt. Codesatz `11xx` gilt als gesichert. | teils unbestätigt |
| **Familien-Voreinstellung `sm5`** | Die Annahme „alles Unbekannte ist SM5" stützt sich auf die Protokolldoku, nicht auf eine Messung an einer 7SM-Anlage. Die Laufzeit-Korrektur fängt den Fehlerfall ab, aber erst ab dem ersten widersprechenden Code. | unbestätigt |
| **Typ-7-Feldreihenfolge** | Die 23 benannten Felder stammen aus der lfstats-Spezifikation. Schickt die Anlage eine `;`-Schema-Zeile für Typ 7, gewinnt diese — ohne Schema-Zeile ist die Zuordnung eine Annahme. | teils unbestätigt |
| **Typ-7-Zuordnung auf Live-Zähler** | Welches Typ-7-Feld welchem Live-Zähler entspricht, ist aus den Feldnamen erschlossen. `missileHits` vs. `missiledOpponent` sind beide plausibel; lf_live lässt `missiledOpponent` gewinnen. Nicht gegen eine echte Anlage geprüft. | unbestätigt |
| **SM5-Live-Zähler ohne Typ-7-Pendant** | `misses`, `targetHits`, `targetDestroys`, `missileLocks`, `missileMisses`, `missileDestroys`, `rapidFires`, alle Resupply-Zähler, `beaconClaims`, `baseAwards`, `achievements`, `rewards`, `timesHit`, `timesHitByTeam` bleiben Untergrenzen — die Anlage liefert dafür keine offizielle Endzahl. | bekannte Grenze |
| **`shotsFired` live** | Laserforce meldet keinen Schuss-Event. Die Live-Zahl ist systematisch zu niedrig. | bekannte Grenze |
| **Trefferquote live** | Weil nur der Nenner unvollständig ist, fällt die Live-Quote systematisch **zu hoch** aus. Sie ist deshalb als Näherung gekennzeichnet (`accuracyIsEstimate`) und wird nach dem Typ-7-Block amtlich. Wie groß der Fehler an einer echten Anlage ist, ist **nicht** gemessen. | bekannte Grenze |
| **Modus-Nummer „Standard"** | Nicht belegt. Wird an der Anlage gemessen; das Anzeigeprofil `standard` steht bereit, die Registry-Zeile fehlt bewusst. | offen |
| **Bedeutung der elf amtlichen Typ-7-Felder** | `livesLeft` und `shotsLeft` sind aus den Namen klar. Für `medicHits`, `ownMedicHits`, `medicNukes`, `scoutRapid`, `lifeBoost`, `ammoBoost`, `nukesCancelled`, `ownNukeCancels`, `shot3Hit` ist die Bedeutung aus der lfstats-Spezifikation erschlossen und nicht gegen eine Anlage geprüft. Die Zahlen werden roh durchgereicht. | unbestätigt |
| **Anzeigeprofil in der Web-Konsole** | `GET /api/modes` liefert die Scoreboard-Spalten heute unter den beiden **Familien**-Schlüsseln. Für ein Profil `standard` müsste der Endpunkt zusätzlich nach Profil ausliefern; solange keine Modus-Nummer auf `standard` zeigt, fällt das nicht an. | offen |
| **Gesamtwertung in der Web-Konsole** | Die Tabelle „Gesamtwertung" im Statistik-Tab zeigt fest die Laserball-Spalten. Bei einer SM5-Gesamtwertung bleiben sie leer; die Zahlen stehen vollständig in `totals_sm5.csv`, die im selben Tab zum Download bereitsteht. Auch `GET /api/stats/totals` hat keinen Familien-Parameter. | offen |
| **Keine Typ-1-Zeile** | Sendet eine Anlage gar keine Typ-1-Zeile, bleibt der Modus dauerhaft `unknown`. Eine Möglichkeit, die Familie von Hand zu erzwingen, gibt es bewusst (noch) nicht. | bewusst offen |
| **Beschreibung endet auf einer Zahl** | Kommt ein Stream **ohne** Tabulatoren **und ohne** Schema-Zeilen, und endet die Missionsbeschreibung auf einer Zahl, kann dieses letzte Token verlorengehen. Mit Tabulator oder mit Schema-Zeile korrekt. | bekannte Grenze |

---

Protokollseite dazu: [LASERFORCE.md](LASERFORCE.md).
Zustandsfelder und Endpunkte: [API.md](API.md).
CSV-Ablage: [STATS.md](STATS.md).
