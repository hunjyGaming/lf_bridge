'use strict';

/**
 * gameModes.js — the game-mode registry, the display profiles and the ONE
 * place every column label lives.
 *
 * Maps the mission number of a TDF type-1 line (`1 <type> <desc...> <start> ...`)
 * to a mode descriptor, and describes what a player object of that mode's
 * *family* counts and which columns that mode's *profile* shows.
 *
 * TWO INDEPENDENT AXES — do not mix them up:
 *
 *   FAMILY  = which counters the PROTOCOL can fill at all. Two families exist,
 *             because the Laserforce firmware only ships two type-4 code sets
 *             (docs/LASERFORCE.md):
 *               - `laserball` — the 11xx code set (mission type 28)
 *               - `sm5`       — the 0xxx code set (mission type 5 and every SM5
 *                               variant incl. 7SM/Nexus)
 *
 *   PROFILE = which columns are DISPLAYED and WRITTEN, in which order, under
 *             which label. Three profiles exist: `standard`, `sm5`, `laserball`.
 *
 * Why two axes: "Standard" and "SM5" speak the very same protocol (family
 * `sm5`) but the operator wants different columns for them. Family alone could
 * never express that. A registry entry may therefore name a `profile`; when it
 * does not, the family's default profile applies (`sm5` -> `sm5`,
 * `laserball` -> `laserball`).
 *
 * Unknown mission numbers default to family `sm5` / profile `sm5`: a normal
 * game is counted correctly even when its number is not in the registry.
 *
 * WHERE THE MODES COME FROM (since the JSON rework)
 * -------------------------------------------------
 * The tables below are the BUILT-IN FALLBACK. On load — and again on every
 * `reloadModes()` — the hand-editable JSON files under `modes/` are read on top
 * of them:
 *
 *   modes/<mode>.json          one game mode: key, label, mission NUMBERS,
 *                              family, display profile
 *   modes/profile/<name>.json  one display profile: scoreboard columns, CSV
 *                              columns, sort order
 *
 * A JSON file OVERRIDES a built-in entry of the same key; it never replaces the
 * built-ins as the last line of defence. Anything wrong in a file (bad JSON,
 * missing field, unknown family/profile/metric, a mission number claimed twice)
 * is reported in GERMAN — to stderr and through `modeConfigStatus()` — and that
 * file (or that one entry) is skipped. The bridge always comes up.
 *
 * Nothing in here throws; every input is treated as untrusted stream data.
 */

const fs = require('fs');
const path = require('path');

const FAMILIES = { LASERBALL: 'laserball', SM5: 'sm5' };
const DEFAULT_FAMILY = FAMILIES.SM5;

/**
 * Display profiles. Separate from FAMILIES on purpose — see the file header.
 *
 * `PROFILES` and `PROFILE_LIST` are exported and held by other modules, so a
 * reload MUTATES them in place instead of replacing them. The three built-in
 * profiles always stay first and are never removed; a profile that only a JSON
 * file defines is appended.
 */
const BUILTIN_PROFILES = { STANDARD: 'standard', SM5: 'sm5', LASERBALL: 'laserball' };
const PROFILES = { ...BUILTIN_PROFILES };
const BUILTIN_PROFILE_LIST = [PROFILES.STANDARD, PROFILES.SM5, PROFILES.LASERBALL];
const PROFILE_LIST = BUILTIN_PROFILE_LIST.slice();

/** Profile a family falls back to when a registry entry names none. */
const FAMILY_DEFAULT_PROFILE = {
  [FAMILIES.SM5]: PROFILES.SM5,
  [FAMILIES.LASERBALL]: PROFILES.LASERBALL,
};
const DEFAULT_PROFILE = FAMILY_DEFAULT_PROFILE[DEFAULT_FAMILY];

/**
 * Known mission numbers — the BUILT-IN FALLBACK. Sources: docs/LASERFORCE.md
 * ("mission type": 5 = Space Marines 5, 28 = Laserball Ranked).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HIER WIRD NICHTS MEHR EINGETRAGEN.                                       │
 * │ Modi stehen in den JSON-Dateien unter `modes/` — eine Datei je Modus.    │
 * │ Eine gemessene Modus-Nummer kommt als Zahl in die Liste                  │
 * │ "missionsnummern" der passenden Datei; "Standard" liegt fertig als       │
 * │ `modes/standard.json` mit leerer Liste bereit.                           │
 * │ Schritt für Schritt: docs/GAMEMODES.md -> "Spielmodi in JSON-Dateien".   │
 * │ Diese Tabelle bleibt nur als Rückfallebene stehen, falls die Dateien     │
 * │ fehlen oder kaputt sind.                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const BUILTIN_REGISTRY = {
  5: { number: 5, key: 'sm5', label: 'Space Marines 5', family: FAMILIES.SM5, profile: PROFILES.SM5 },
  28: { number: 28, key: 'laserball_ranked', label: 'Laserball Ranked', family: FAMILIES.LASERBALL, profile: PROFILES.LASERBALL },
};

/**
 * The LIVE registry: built-ins with the JSON files applied on top. Exported and
 * held by other modules (scripts/inspect.js reads it), so `reloadModes()`
 * mutates this very object instead of replacing it.
 */
const REGISTRY = {};

// ---------------------------------------------------------------------------
// counters per family
// ---------------------------------------------------------------------------

/**
 * Laserball counters — UNCHANGED names from the original parser. Every one of
 * them keeps its exact meaning and its exact live-count path in engine.js.
 */
const LASERBALL_FIELDS = [
  'goals', 'assists',
  'stealsDone', 'stealsReceived',
  'blocksDone', 'blocksReceived',
  'resetsDone', 'resetsReceived',
  'clearsDone', 'clearsReceived',
  'passesDone', 'passesReceived',
];

/**
 * SM5 counters, live-counted from the 0xxx event codes (engine C6) and
 * overwritten at match end by the official type-7 block (engine C4).
 *
 * NOTE `shotsFired`: Laserforce does not log a plain "shot" event. The live
 * value is only raised where a hit/miss event proves a shot happened, so it is
 * a LOWER BOUND until the type-7 end block corrects it. The hit RATE derived
 * from it is therefore too HIGH, not too low — see `accuracy` below.
 */
const SM5_FIELDS = [
  'shotsHit', 'shotsFired', 'misses', 'timesHit', 'deactivations', 'timesDeactivated',
  'shotTeam', 'timesHitByTeam', 'targetHits', 'targetDestroys',
  'missileLocks', 'missileHits', 'missileMisses', 'missileDestroys', 'timesMissiled', 'missileTeam',
  'nukesActivated', 'nukesDetonated', 'rapidFires',
  'ammoResupplies', 'ammoReceived', 'livesResupplies', 'livesReceived',
  'teamAmmoResupplies', 'teamLivesResupplies', 'penalties', 'beaconClaims', 'baseAwards',
  'achievements', 'rewards',
];

/**
 * Official type-7 fields that have NO live equivalent: they simply do not exist
 * before the arena ships its end block. They are therefore `null` — never 0 —
 * while a match is running, and blank in the CSV. A 0 here would look like a
 * measurement ("this player had zero lives left"), which would be a lie.
 *
 * Order = the operator's priority: the two he asked for first, then the rest.
 */
const SM5_OFFICIAL_FIELDS = [
  'livesLeft', 'shotsLeft',
  'medicHits', 'ownMedicHits', 'medicNukes',
  'scoutRapid', 'lifeBoost', 'ammoBoost',
  'nukesCancelled', 'ownNukeCancels', 'shot3Hit',
];

/**
 * Derived values the engine computes; not counters, never summed.
 * `accuracy` = shotsHit / shotsFired, `accuracySource` = where it came from.
 */
const DERIVED_FIELDS = ['accuracy', 'accuracySource'];

/** SM5 role from the type-3 `category` column (docs/LASERFORCE.md). */
const ROLES = {
  0: 'N/A',
  1: 'Commander',
  2: 'Heavy Weapons',
  3: 'Scout',
  4: 'Ammo Carrier',
  5: 'Medic',
};

// ---------------------------------------------------------------------------
// THE label table — one place, for scoreboard, stats table and CSV header
// ---------------------------------------------------------------------------

/**
 * Metric groups. A legend over forty metrics is unreadable as one flat list, so
 * every entry in METRICS names exactly ONE group, and the console prints its
 * legend section by section — in THIS order.
 *
 * Shipped through `GET /api/modes` as `metricGroups`, and carried on every
 * `metricInfo()` / `scoreboardColumns()` entry as `group` + `groupLabel`.
 */
const METRIC_GROUPS = [
  { group: 'identity', label: 'Spiel und Spieler', help: 'Wer hat wann in welchem Modus gespielt.' },
  { group: 'result', label: 'Ergebnis', help: 'Punkte und Ausgang des Matches.' },
  { group: 'attack', label: 'Angriff', help: 'Was dieser Spieler ausgeteilt hat.' },
  { group: 'defense', label: 'Verteidigung', help: 'Was dieser Spieler einstecken musste oder abgewehrt hat.' },
  { group: 'possession', label: 'Ballbesitz', help: 'Nur Laserball: was mit dem Ball geschehen ist.' },
  { group: 'targets', label: 'Ziele in der Arena', help: 'Feste Ziele und Basen — keine Spieler.' },
  { group: 'missiles', label: 'Raketen', help: 'Alles rund um die Rakete.' },
  { group: 'equipment', label: 'Ausrüstung und Spezialfähigkeiten', help: 'Munition, Leben, Nuke, Dauerfeuer.' },
  { group: 'misc', label: 'Sonstiges', help: 'Strafen, Erfolge, Belohnungen.' },
  { group: 'totals', label: 'Gesamtwertung', help: 'Summen und Schnitte über mehrere Matches.' },
  { group: 'provenance', label: 'Herkunft der Zahlen', help: 'Woher ein Wert stammt und wie belastbar er ist.' },
];
/** group key -> German section heading. */
const GROUP_LABEL = {};
for (const g of METRIC_GROUPS) GROUP_LABEL[g.group] = g.label;
/** Where a metric lands when it names no group at all. Never happens on purpose. */
const DEFAULT_GROUP = 'misc';

/**
 * Every column lf_live can show, keyed by the PLAYER-OBJECT field name.
 *
 *   label  — the WRITTEN-OUT German name. This is the normal case in every table
 *            header. It must stand on its own, without context and without any
 *            lasertag knowledge.
 *   short  — emergency narrow form. Kept for very tight places, no longer
 *            preferred.
 *   help   — one German sentence (two at most) saying WHAT the number means and
 *            HOW it comes about. Used as a tooltip AND in the console legend.
 *            It never just repeats the label.
 *   group  — which legend section the metric belongs to (METRIC_GROUPS)
 *   format — `int` | `text` | `percent` — how a consumer should render it
 *   csv    — CSV spelling, when it differs from snake(key). NEVER change one:
 *            the operator already has files with these column names.
 *
 * The web console used to keep its own `TOTALS_LABEL` map. This table replaces
 * it: `metricLabels()` is served through `GET /api/modes` and is keyed by BOTH
 * spellings (camelCase field name AND snake_case CSV column), so a consumer can
 * look up whatever it happens to hold.
 */
const METRICS = {
  // ---- identity -----------------------------------------------------------
  matchId: { label: 'Match-Kennung', short: 'Match', group: 'identity', help: 'Kennung, unter der dieses eine Match in allen Dateien abgelegt ist. Sie steht auch im Dateinamen.', format: 'text' },
  date: { label: 'Datum', short: 'Datum', group: 'identity', help: 'Tag, an dem das Match gestartet wurde.', format: 'text' },
  modeKey: { label: 'Modus-Kurzname', short: 'Kurzname', group: 'identity', help: 'Gleichbleibender Kurzname des Spielmodus für Dateien und Auswertungen. Er ändert sich nie, auch wenn die Anlage den Anzeigenamen wechselt.', format: 'text' },
  modeLabel: { label: 'Spielmodus', short: 'Modus', group: 'identity', help: 'Name des Spielmodus, so wie die Anlage ihn zu Missionsbeginn mitschickt.', format: 'text' },
  modeNumber: { label: 'Modus-Nummer', short: 'Modus-Nr.', group: 'identity', help: 'Nummer, unter der die Anlage den Spielmodus meldet. Leer, wenn die Anlage keine geschickt hat.', format: 'text' },
  family: { label: 'Protokollfamilie', short: 'Familie', group: 'identity', help: 'Welchen Satz Zahlen die Anlage in diesem Modus überhaupt liefert: laserball (Tore, Pässe) oder sm5 (Schüsse, Treffer).', format: 'text' },
  profile: { label: 'Anzeigeprofil', short: 'Profil', group: 'identity', help: 'Welcher Spaltensatz für dieses Match angezeigt und geschrieben wird: standard, sm5 oder laserball.', format: 'text' },
  playerId: { label: 'Spieler-Kennung', short: 'Kennung', group: 'identity', help: 'Kennung, unter der die Anlage diesen Spieler führt.', format: 'text' },
  name: { label: 'Spielername', short: 'Spieler', group: 'identity', help: 'Name aus dem Datenstrom der Anlage — oder aus der eigenen Namensliste, wenn dort einer hinterlegt ist.', format: 'text' },
  teamId: { label: 'Team-Nummer', short: 'Team-Nr.', group: 'identity', help: 'Nummer, unter der die Anlage das Team führt.', format: 'text' },
  team: { label: 'Teamname', short: 'Team', group: 'identity', help: 'Name des Teams, in dem dieser Spieler gespielt hat.', format: 'text' },
  roleLabel: { csv: 'role', label: 'Rolle', short: 'Rolle', group: 'identity', help: 'Rolle, mit der sich der Spieler an der Anlage angemeldet hat: Commander, Heavy Weapons, Scout, Ammo Carrier oder Medic. In Laserball gibt es keine Rollen, dort bleibt die Spalte leer.', format: 'text' },
  level: { label: 'Spielerlevel', short: 'Level', group: 'identity', help: 'Erfahrungsstufe, die die Anlage bei der Anmeldung des Spielers mitschickt. Leer, wenn die Anlage keine meldet.', format: 'int' },
  battlesuit: { label: 'Weste', short: 'Weste', group: 'identity', help: 'Kennung der Weste, die dieser Spieler getragen hat, sofern die Anlage sie mitschickt.', format: 'text' },

  // ---- result -------------------------------------------------------------
  score: { label: 'Punkte', short: 'Punkte', group: 'result', help: 'Punktestand dieses Spielers, wie ihn die Anlage meldet. Meldet die Anlage keine Spielerpunkte, bleibt der Wert auf 0.', format: 'int' },
  teamScore: { label: 'Punkte eigenes Team', short: 'Team-Pkt.', group: 'result', help: 'Endstand des Teams, in dem dieser Spieler gespielt hat.', format: 'int' },
  oppScore: { label: 'Punkte bestes Gegnerteam', short: 'Gegner-Pkt.', group: 'result', help: 'Endstand des stärksten gegnerischen Teams. Daraus wird Sieg oder Niederlage bestimmt.', format: 'int' },
  result: { label: 'Spielausgang', short: 'Ausgang', group: 'result', help: 'Sieg (win), Niederlage (loss) oder Unentschieden (draw) — ermittelt aus den Punkten des eigenen Teams gegen das beste Gegnerteam.', format: 'text' },
  durationS: { label: 'Spieldauer (Sekunden)', short: 'Dauer', group: 'result', help: 'Wie lange dieses Match tatsächlich gelaufen ist, in Sekunden.', format: 'int' },

  // ---- SM5: shooting ------------------------------------------------------
  shotsFired: { label: 'Abgegebene Schüsse', short: 'Schüsse', group: 'attack', help: 'Wie oft dieser Spieler geschossen hat. Während des Spiels nur eine Untergrenze, weil die Anlage einen Schuss ohne Wirkung nicht meldet; mit der Endabrechnung liefert sie die amtliche Zahl nach.', format: 'int' },
  shotsHit: { label: 'Erzielte Treffer', short: 'Treffer', group: 'attack', help: 'Schüsse dieses Spielers, die einen Gegner oder ein Ziel in der Arena getroffen haben.', format: 'int' },
  accuracy: { label: 'Trefferquote', short: 'Quote', group: 'attack', help: 'Anteil der Schüsse, die getroffen haben. Während des Spiels liegt der Wert systematisch zu hoch, weil ein Schuss ohne Wirkung kein Ereignis erzeugt und deshalb bei den abgegebenen Schüssen fehlt; nach der Endabrechnung der Anlage ist die Quote amtlich.', format: 'percent' },
  misses: { label: 'Fehlschüsse', short: 'Fehlschüsse', group: 'attack', help: 'Schüsse, die die Anlage ausdrücklich als Fehlschuss gemeldet hat. Nicht gemeldete Fehlschüsse fehlen hier.', format: 'int' },
  deactivations: { label: 'Gegner abgeschossen', short: 'Abschüsse', group: 'attack', help: 'Wie oft dieser Spieler einen Gegner abgeschossen und damit vorübergehend aus dem Spiel genommen hat.', format: 'int' },
  shotTeam: { label: 'Eigene Mitspieler getroffen', short: 'Eigenbeschuss', group: 'attack', help: 'Wie oft dieser Spieler auf einen Mitspieler des eigenen Teams geschossen und ihn getroffen hat.', format: 'int' },
  medicHits: { label: 'Gegnerische Medics getroffen', short: 'Medics', group: 'attack', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Treffer auf Medics des gegnerischen Teams. Die Bedeutung ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  ownMedicHits: { label: 'Eigene Medics getroffen', short: 'Eigene Medics', group: 'attack', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Treffer auf Medics des eigenen Teams. Die Bedeutung ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  shot3Hit: { label: 'Dreifach-Treffer (unbestätigt)', short: 'Dreifach', group: 'attack', help: 'Amtlicher Endwert der Anlage aus dem Feld shot3_hit, erst nach dem Spielende vorhanden. Was genau gezählt wird, ist nicht belegt — die Zahl wird unverändert durchgereicht.', format: 'int' },

  // ---- SM5: what the player took ------------------------------------------
  timesDeactivated: { label: 'Selbst abgeschossen worden', short: 'Ausfälle', group: 'defense', help: 'Wie oft dieser Spieler von einem Gegner abgeschossen wurde und warten musste, bis er wieder mitspielen durfte.', format: 'int' },
  timesHit: { label: 'Selbst getroffen worden', short: 'Getroffen', group: 'defense', help: 'Wie oft ein gegnerischer Schuss diesen Spieler getroffen hat — auch Treffer, die ihn noch nicht abgeschossen haben.', format: 'int' },
  timesHitByTeam: { label: 'Vom eigenen Team getroffen worden', short: 'Von Team getroffen', group: 'defense', help: 'Wie oft ein Mitspieler des eigenen Teams diesen Spieler getroffen hat.', format: 'int' },
  nukesCancelled: { label: 'Gegnerische Nukes abgewehrt', short: 'Nukes abgewehrt', group: 'defense', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Nukes des Gegners, die dieser Spieler verhindert hat. Die Bedeutung ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  ownNukeCancels: { label: 'Nukes des eigenen Teams abgewehrt', short: 'Eigene abgewehrt', group: 'defense', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Nukes aus dem eigenen Team, die dieser Spieler verhindert hat. Die Bedeutung ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },

  // ---- SM5: non-player targets -------------------------------------------
  targetHits: { label: 'Ziele getroffen', short: 'Ziele getroffen', group: 'targets', help: 'Treffer auf ein festes Ziel in der Arena — keinen Spieler. Drei Treffer zerstören ein solches Ziel.', format: 'int' },
  targetDestroys: { label: 'Ziele zerstört', short: 'Ziele zerstört', group: 'targets', help: 'Wie oft dieser Spieler ein festes Ziel in der Arena zerstört hat.', format: 'int' },
  beaconClaims: { label: 'Beacons erobert', short: 'Beacons', group: 'targets', help: 'Wie oft dieser Spieler ein Beacon endgültig für sich entschieden hat. Ein Beacon ist ein festes Ziel in der Arena, um das beide Teams kämpfen.', format: 'int' },
  baseAwards: { label: 'Basen zugesprochen', short: 'Basen', group: 'targets', help: 'Ziele, die diesem Spieler bei einem vorzeitigen Spielende von der Anlage automatisch gutgeschrieben wurden.', format: 'int' },

  // ---- SM5: missiles ------------------------------------------------------
  missileLocks: { label: 'Raketen aufgeschaltet', short: 'Aufgeschaltet', group: 'missiles', help: 'Wie oft dieser Spieler eine Rakete auf ein Ziel aufgeschaltet hat — der Schritt unmittelbar vor dem Abschuss.', format: 'int' },
  missileHits: { label: 'Gegner mit Rakete getroffen', short: 'Raketentreffer', group: 'missiles', help: 'Wie oft eine Rakete dieses Spielers einen Gegner getroffen hat.', format: 'int' },
  missileMisses: { label: 'Raketen daneben', short: 'Raketen daneben', group: 'missiles', help: 'Raketen dieses Spielers, die kein Ziel erwischt haben.', format: 'int' },
  missileDestroys: { label: 'Ziele mit Rakete zerstört', short: 'Ziele per Rakete', group: 'missiles', help: 'Feste Ziele in der Arena, die dieser Spieler mit einer Rakete zerstört hat.', format: 'int' },
  timesMissiled: { label: 'Selbst von Rakete getroffen worden', short: 'Rakete kassiert', group: 'missiles', help: 'Wie oft dieser Spieler von einer gegnerischen Rakete getroffen wurde.', format: 'int' },
  missileTeam: { label: 'Rakete auf eigenes Team', short: 'Rakete auf Team', group: 'missiles', help: 'Wie oft eine Rakete dieses Spielers einen Mitspieler des eigenen Teams getroffen hat.', format: 'int' },

  // ---- SM5: specials and resupply ----------------------------------------
  nukesActivated: { label: 'Nukes gestartet', short: 'Nukes gestartet', group: 'equipment', help: 'Wie oft dieser Spieler die Spezialfähigkeit Nuke ausgelöst hat. Nur der Commander hat sie.', format: 'int' },
  nukesDetonated: { label: 'Nukes gezündet', short: 'Nukes gezündet', group: 'equipment', help: 'Gestartete Nukes, die auch tatsächlich hochgegangen sind. Eine gestartete Nuke kann vorher noch abgewehrt werden.', format: 'int' },
  rapidFires: { label: 'Dauerfeuer eingesetzt', short: 'Dauerfeuer', group: 'equipment', help: 'Wie oft dieser Spieler sein Dauerfeuer ausgelöst hat. Nur der Scout hat diese Fähigkeit.', format: 'int' },
  ammoResupplies: { label: 'Munition ausgegeben', short: 'Munition geben', group: 'equipment', help: 'Wie oft dieser Spieler einen einzelnen Mitspieler mit Munition versorgt hat.', format: 'int' },
  ammoReceived: { label: 'Munition erhalten', short: 'Munition bekommen', group: 'equipment', help: 'Wie oft dieser Spieler von einem Mitspieler Munition bekommen hat.', format: 'int' },
  livesResupplies: { label: 'Leben ausgegeben', short: 'Leben geben', group: 'equipment', help: 'Wie oft dieser Spieler einem einzelnen Mitspieler ein Leben gegeben hat. Das kann nur der Medic.', format: 'int' },
  livesReceived: { label: 'Leben erhalten', short: 'Leben bekommen', group: 'equipment', help: 'Wie oft dieser Spieler von einem Mitspieler ein Leben bekommen hat.', format: 'int' },
  teamAmmoResupplies: { label: 'Munition für das ganze Team', short: 'Team-Munition', group: 'equipment', help: 'Wie oft dieser Spieler die Team-Munitionsausgabe ausgelöst hat — die Spezialfähigkeit des Ammo Carriers, die alle Mitspieler auf einmal versorgt.', format: 'int' },
  teamLivesResupplies: { label: 'Leben für das ganze Team', short: 'Team-Leben', group: 'equipment', help: 'Wie oft dieser Spieler die Team-Lebensausgabe ausgelöst hat — die Spezialfähigkeit des Medics, die alle Mitspieler auf einmal versorgt.', format: 'int' },
  livesLeft: { label: 'Leben übrig', short: 'Leben übrig', group: 'equipment', help: 'Leben, die diesem Spieler am Schluss geblieben sind. Die Anlage meldet den Wert erst mit der Endabrechnung — vorher bleibt die Zelle leer und steht nicht auf 0.', format: 'int' },
  shotsLeft: { label: 'Munition übrig', short: 'Munition übrig', group: 'equipment', help: 'Schuss Munition, die diesem Spieler am Schluss geblieben sind. Die Anlage meldet den Wert erst mit der Endabrechnung — vorher bleibt die Zelle leer und steht nicht auf 0.', format: 'int' },
  medicNukes: { label: 'Nukes gegen Medics', short: 'Medic-Nukes', group: 'equipment', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Nukes, die einen Medic betroffen haben. Die Bedeutung ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  scoutRapid: { label: 'Dauerfeuer des Scouts', short: 'Scout-Dauerfeuer', group: 'equipment', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: Dauerfeuer-Einsätze des Scouts. Wie er sich von „Dauerfeuer eingesetzt“ unterscheidet, ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  lifeBoost: { label: 'Leben-Boosts erhalten', short: 'Leben-Boosts', group: 'equipment', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: erhaltene Leben-Boosts. Wie er sich von „Leben erhalten“ unterscheidet, ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },
  ammoBoost: { label: 'Munitions-Boosts erhalten', short: 'Munitions-Boosts', group: 'equipment', help: 'Amtlicher Endwert der Anlage, erst nach dem Spielende vorhanden: erhaltene Munitions-Boosts. Wie er sich von „Munition erhalten“ unterscheidet, ist aus der Protokollbeschreibung erschlossen und an einer echten Anlage unbestätigt.', format: 'int' },

  // ---- SM5: misc ----------------------------------------------------------
  penalties: { label: 'Strafen', short: 'Strafen', group: 'misc', help: 'Strafen, die die Aufsicht während des Matches gegen diesen Spieler verhängt hat.', format: 'int' },
  achievements: { label: 'Erfolge', short: 'Erfolge', group: 'misc', help: 'Auszeichnungen, die die Anlage diesem Spieler während des Matches zuerkannt hat.', format: 'int' },
  rewards: { label: 'Belohnungen', short: 'Belohnungen', group: 'misc', help: 'Belohnungen des Standorts, die die Anlage vergeben hat — zum Beispiel ein Freispiel.', format: 'int' },

  // ---- Laserball ----------------------------------------------------------
  goals: { label: 'Tore', short: 'Tore', group: 'attack', help: 'Bälle, die dieser Spieler im gegnerischen Tor versenkt hat.', format: 'int' },
  assists: { label: 'Vorlagen', short: 'Vorlagen', group: 'attack', help: 'Pass oder Befreiungspass dieses Spielers, nach dem der Empfänger innerhalb von zehn Sekunden ein Tor erzielt hat.', format: 'int' },
  stealsDone: { label: 'Ball abgenommen', short: 'Ball abgenommen', group: 'possession', help: 'Wie oft dieser Spieler einem Gegner den Ball abgenommen hat.', format: 'int' },
  stealsReceived: { label: 'Ball verloren', short: 'Ball verloren', group: 'possession', help: 'Wie oft ein Gegner diesem Spieler den Ball abgenommen hat.', format: 'int' },
  blocksDone: { label: 'Gegner geblockt', short: 'Geblockt', group: 'defense', help: 'Wie oft dieser Spieler einen noch aktiven Gegner abgeschossen und damit gestoppt hat.', format: 'int' },
  blocksReceived: { label: 'Selbst geblockt worden', short: 'Geblockt worden', group: 'defense', help: 'Wie oft ein Gegner diesen Spieler im aktiven Zustand gestoppt hat.', format: 'int' },
  resetsDone: { label: 'Gegner zurückgesetzt', short: 'Zurückgesetzt', group: 'defense', help: 'Wie oft dieser Spieler einen bereits ausgeschalteten Gegner noch einmal getroffen und dessen Wartezeit dadurch neu gestartet hat.', format: 'int' },
  resetsReceived: { label: 'Selbst zurückgesetzt worden', short: 'Zurückgesetzt worden', group: 'defense', help: 'Wie oft ein Gegner diesen Spieler im ausgeschalteten Zustand noch einmal getroffen und seine Wartezeit neu gestartet hat.', format: 'int' },
  clearsDone: { label: 'Befreiungspässe gespielt', short: 'Befreiungspässe', group: 'possession', help: 'Pässe, mit denen dieser Spieler den Ball aus der eigenen Gefahrenzone herausgespielt hat (im Spiel „Clear“ genannt).', format: 'int' },
  clearsReceived: { label: 'Befreiungspässe erhalten', short: 'Befreiung erhalten', group: 'possession', help: 'Wie oft dieser Spieler den Ball aus einem Befreiungspass eines Mitspielers bekommen hat.', format: 'int' },
  passesDone: { label: 'Pässe gespielt', short: 'Pässe', group: 'possession', help: 'Wie oft dieser Spieler den Ball an einen Mitspieler abgegeben hat.', format: 'int' },
  passesReceived: { label: 'Pässe erhalten', short: 'Pässe erhalten', group: 'possession', help: 'Wie oft dieser Spieler den Ball von einem Mitspieler bekommen hat.', format: 'int' },

  // ---- totals -------------------------------------------------------------
  matches: { label: 'Gespielte Matches', short: 'Matches', group: 'totals', help: 'Anzahl der Matches, die in diese Gesamtwertung eingeflossen sind.', format: 'int' },
  wins: { label: 'Siege', short: 'Siege', group: 'totals', help: 'Matches, die das Team dieses Spielers gewonnen hat.', format: 'int' },
  losses: { label: 'Niederlagen', short: 'Niederlagen', group: 'totals', help: 'Matches, die das Team dieses Spielers verloren hat.', format: 'int' },
  draws: { label: 'Unentschieden', short: 'Unentschieden', group: 'totals', help: 'Matches, die mit Gleichstand geendet haben.', format: 'int' },
  goalsPerMatch: { label: 'Tore je Match', short: 'Tore je Match', group: 'totals', help: 'Alle Tore dieses Spielers geteilt durch die Anzahl seiner gewerteten Matches.', format: 'int' },
  scorePerMatch: { label: 'Punkte je Match', short: 'Punkte je Match', group: 'totals', help: 'Alle Punkte dieses Spielers geteilt durch die Anzahl seiner gewerteten Matches.', format: 'int' },
  firstPlayed: { label: 'Erstes Match', short: 'Erstes Match', group: 'totals', help: 'Zeitpunkt, zu dem dieser Spieler diesen Modus zum ersten Mal gespielt hat.', format: 'text' },
  lastPlayed: { label: 'Letztes Match', short: 'Letztes Match', group: 'totals', help: 'Zeitpunkt, zu dem dieser Spieler diesen Modus zuletzt gespielt hat.', format: 'text' },
  totalDurationS: { label: 'Gesamtspielzeit (Sekunden)', short: 'Spielzeit', group: 'totals', help: 'Aufsummierte Spielzeit aller gewerteten Matches, in Sekunden.', format: 'int' },

  // ---- provenance ---------------------------------------------------------
  statsSource: { label: 'Herkunft der Zähler', short: 'Zähler-Herkunft', group: 'provenance', help: 'live = von lf_live selbst mitgezählt und deshalb eine Untergrenze, tdf7 = amtliche Endzahlen der Anlage.', format: 'text' },
  scoreSource: { label: 'Herkunft der Punkte', short: 'Punkte-Herkunft', group: 'provenance', help: 'internal = von lf_live selbst gezählt, tdf = Punktestände, die die Anlage gemeldet hat.', format: 'text' },
  accuracySource: { label: 'Herkunft der Trefferquote', short: 'Quoten-Herkunft', group: 'provenance', help: 'live = Näherung aus der Eigenzählung und damit zu hoch, tdf7 = aus den amtlichen Endzahlen der Anlage gerechnet.', format: 'text' },
};

// ---------------------------------------------------------------------------
// profiles: scoreboard layout, CSV counter block, sort order
// ---------------------------------------------------------------------------

/** SM5 counters minus the two the profiles pull to the front themselves. */
const SM5_REST = SM5_FIELDS.filter((f) => f !== 'shotsFired' && f !== 'shotsHit');
/** Official fields minus the two the `sm5` profile pulls to the front. */
const OFFICIAL_REST = SM5_OFFICIAL_FIELDS.filter((f) => f !== 'livesLeft' && f !== 'shotsLeft');

/**
 * The three display profiles — the BUILT-IN FALLBACK. The shipped JSON files
 * under `modes/profile/` carry exactly these column sets; edit those, not this.
 *
 *   family     — the family a profile belongs to (which counters can be filled)
 *   scoreboard — live scoreboard columns, in display order
 *   fields     — CSV counter block, in display order: core metrics first, then
 *                the detail counters. Identity / result / provenance columns are
 *                NOT in here — statsWriter frames them around this block.
 *   sort       — totals ranking: the profile's most important metric first
 *
 * `received` on a scoreboard column names the "… suffered" counterpart, which
 * the console shows as a small second number. Unchanged mechanism.
 */
const BUILTIN_PROFILE_DEFS = {
  // Operator: Punkte, Level, abgegebene Schüsse, Trefferquote.
  [PROFILES.STANDARD]: {
    family: FAMILIES.SM5,
    scoreboard: [
      { key: 'score' }, { key: 'level' },
      { key: 'shotsFired' }, { key: 'shotsHit' }, { key: 'accuracy' },
    ],
    fields: ['shotsFired', 'shotsHit', 'accuracy'].concat(SM5_REST),
    sort: ['score', 'shotsHit'],
  },

  // Operator: wie Standard, zusätzlich Rolle, verbleibende Leben, verbleibende
  // Munition. Die bisherigen SM5-Spalten bleiben vollständig erhalten.
  [PROFILES.SM5]: {
    family: FAMILIES.SM5,
    scoreboard: [
      { key: 'score' }, { key: 'level' }, { key: 'roleLabel' },
      { key: 'shotsFired' }, { key: 'shotsHit' }, { key: 'accuracy' },
      { key: 'livesLeft' }, { key: 'shotsLeft' },
      { key: 'deactivations', received: 'timesDeactivated' },
      { key: 'timesHit' },
      { key: 'missileHits', received: 'timesMissiled' },
      { key: 'nukesDetonated' },
      { key: 'ammoResupplies' }, { key: 'livesResupplies' },
      { key: 'penalties' },
    ],
    fields: ['shotsFired', 'shotsHit', 'accuracy', 'livesLeft', 'shotsLeft']
      .concat(SM5_REST).concat(OFFICIAL_REST),
    sort: ['score', 'deactivations'],
  },

  // Laserball. The first seven columns are EXACTLY the ones the web console
  // showed before — do not reorder them. `score` and `level` are appended.
  // Laserball has no shot counter at all: the 11xx code set logs no shots, so
  // there is nothing honest to put in a "Schüsse" column here.
  [PROFILES.LASERBALL]: {
    family: FAMILIES.LASERBALL,
    scoreboard: [
      { key: 'goals' },
      { key: 'assists' },
      { key: 'stealsDone', received: 'stealsReceived' },
      { key: 'blocksDone', received: 'blocksReceived' },
      { key: 'resetsDone', received: 'resetsReceived' },
      { key: 'clearsDone', received: 'clearsReceived' },
      { key: 'passesDone', received: 'passesReceived' },
      { key: 'score' }, { key: 'level' },
    ],
    // identical to the pre-profile Laserball CSV block, character for character
    fields: LASERBALL_FIELDS.slice(),
    sort: ['goals', 'assists'],
  },
};

/** The LIVE profile table: built-ins with `modes/profile/*.json` on top. */
const PROFILE_DEFS = {};

/**
 * German display name of each profile — the text a human reads.
 *
 * It lives HERE, next to the profile definitions, not in the API server: the
 * profile names and their display strings belong together, and every consumer
 * (API, console, legend) must read the same one. Use `profileLabel()`.
 * `anzeigename` in a profile JSON file overrides an entry.
 */
const BUILTIN_PROFILE_LABELS = {
  [PROFILES.STANDARD]: 'Standard',
  [PROFILES.SM5]: 'SM5',
  [PROFILES.LASERBALL]: 'Laserball',
};

/** The LIVE label table. Mutated in place by `reloadModes()`. */
const PROFILE_LABELS = {};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** camelCase -> snake_case (CSV column spelling). */
function snake(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
}

/** Parse an untrusted mission number. Returns null when it is not a number. */
function toModeNumber(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 65535 ? v : null;
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 && n <= 65535 ? n : null;
}

/** Clean an untrusted mission description for display. Returns '' when unusable. */
function cleanDesc(v) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 64);
}

/** Normalize a family string; anything unknown becomes the default family. */
function normFamily(family) {
  const f = String(family == null ? '' : family).trim().toLowerCase();
  return f === FAMILIES.LASERBALL ? FAMILIES.LASERBALL : FAMILIES.SM5;
}

/** Normalize a profile string; anything unknown becomes the default profile. */
function normProfile(profile) {
  const p = String(profile == null ? '' : profile).trim().toLowerCase();
  return PROFILE_LIST.includes(p) ? p : DEFAULT_PROFILE;
}

/**
 * Resolve a FAMILY NAME **or** a PROFILE NAME to a profile.
 *
 * This is what keeps every pre-profile call site working: `scoreboardColumns()`
 * and `csvColumns()` used to take a family, and `'sm5'` / `'laserball'` are
 * valid in both name spaces and mean the same thing there. Only the new name
 * `'standard'` is profile-only.
 */
function resolveProfile(familyOrProfile) {
  const s = String(familyOrProfile == null ? '' : familyOrProfile).trim().toLowerCase();
  if (PROFILE_LIST.includes(s)) return s;
  return FAMILY_DEFAULT_PROFILE[normFamily(s)] || DEFAULT_PROFILE;
}

/** The profile a mode object (or a bare family name) displays under. */
function profileOf(mode) {
  try {
    if (mode && typeof mode === 'object') {
      if (mode.profile) return normProfile(mode.profile);
      return FAMILY_DEFAULT_PROFILE[normFamily(mode.family)] || DEFAULT_PROFILE;
    }
    return resolveProfile(mode);
  } catch (_err) {
    return DEFAULT_PROFILE;
  }
}

/**
 * A copy of `mode` that definitely carries a `profile`.
 *
 * `resolveMode()` deliberately keeps its long-standing six-field shape — it is
 * a pinned public contract. Everything that STORES a mode (engine gameState,
 * stats writer, API) runs it through here first, so `mode.profile` is present
 * everywhere a mode is actually used.
 */
function withProfile(mode) {
  try {
    if (!mode || typeof mode !== 'object') return mode;
    return { ...mode, family: normFamily(mode.family), profile: profileOf(mode) };
  } catch (_err) {
    return mode;
  }
}

/** The profile definition, always a usable object. */
function profileDef(familyOrProfile) {
  return PROFILE_DEFS[resolveProfile(familyOrProfile)] || PROFILE_DEFS[DEFAULT_PROFILE];
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Resolve a mission number (+ optional description from the stream) to a mode.
 *
 * Shape is intentionally unchanged (six fields). Use `withProfile()` — or
 * `profileOf()` — to obtain the display profile.
 *
 * @param {string|number|null} missionType  type-1 column `type`
 * @param {string|null} [missionDesc]       type-1 column `desc` (preferred label)
 * @returns {{number:number|null,key:string,label:string,family:string,known:boolean,source:string}}
 */
function resolveMode(missionType, missionDesc) {
  try {
    const desc = cleanDesc(missionDesc);
    const number = toModeNumber(missionType);

    if (number == null) {
      return {
        number: null,
        key: 'unknown',
        label: desc || 'Unbekannter Modus',
        family: DEFAULT_FAMILY,
        known: false,
        source: 'default',
      };
    }

    const hit = Object.prototype.hasOwnProperty.call(REGISTRY, number) ? REGISTRY[number] : null;
    if (hit) {
      return {
        number,
        key: hit.key,
        label: desc || hit.label,
        family: hit.family,
        known: true,
        source: 'tdf',
      };
    }
    return {
      number,
      key: `mode_${number}`,
      label: desc || `Modus ${number}`,
      family: DEFAULT_FAMILY,
      known: false,
      source: 'tdf',
    };
  } catch (_err) {
    return {
      number: null, key: 'unknown', label: 'Unbekannter Modus',
      family: DEFAULT_FAMILY, known: false, source: 'default',
    };
  }
}

/**
 * Like `resolveMode()`, but the returned object already carries its `profile`.
 * The registry entry's `profile` wins; without one the family default applies.
 */
function resolveModeWithProfile(missionType, missionDesc) {
  const mode = resolveMode(missionType, missionDesc);
  const number = mode.number;
  const hit = number != null && Object.prototype.hasOwnProperty.call(REGISTRY, number)
    ? REGISTRY[number] : null;
  return withProfile(hit && hit.profile ? { ...mode, profile: hit.profile } : mode);
}

/**
 * Coarse family of a type-4 event code. Used for the runtime family correction
 * when a type-1 line is missing or wrong.
 * @returns {'laserball'|'sm5'|'all'}
 */
function familyOf(code) {
  try {
    const c = String(code == null ? '' : code).trim().toUpperCase();
    if (!/^[0-9A-F]{3,4}$/.test(c)) return 'all';
    // shared match control / miss / achievements exist in both families
    if (c === '0100' || c === '0101' || c === '0201' || c.startsWith('09')) return 'all';
    if (c.startsWith('11')) return FAMILIES.LASERBALL;
    if (/^0[23456B]/.test(c)) return FAMILIES.SM5;
    return 'all';
  } catch (_err) {
    return 'all';
  }
}

/** Counter names a player object of this family carries. */
function statFields(family) {
  return normFamily(family) === FAMILIES.LASERBALL ? LASERBALL_FIELDS.slice() : SM5_FIELDS.slice();
}

/** Fresh counter object, every field 0. */
function newPlayerStats(family) {
  const out = {};
  for (const f of statFields(family)) out[f] = 0;
  return out;
}

/**
 * Fresh official-stat object: every type-7-only field `null`.
 *
 * NOT part of `newPlayerStats()` — those are counters that start at 0 and are
 * counted up. These are measurements that do not exist yet, and `null` is the
 * honest placeholder: it lands in the CSV as an EMPTY cell, never as a 0.
 */
function newOfficialStats() {
  const out = {};
  for (const f of SM5_OFFICIAL_FIELDS) out[f] = null;
  return out;
}

/**
 * Player-object field names of a profile's CSV counter block, in output order.
 * @param {string} familyOrProfile family name (back-compat) or profile name
 */
function profileFields(familyOrProfile) {
  return profileDef(familyOrProfile).fields.slice();
}

/**
 * CSV column names (snake_case) of a profile's counter block, in output order.
 * Index-aligned with `profileFields()`.
 *
 * BACK-COMPAT: called with a FAMILY name this still returns that family's
 * column set — `csvColumns('laserball')` is character-identical to what it
 * always returned.
 */
function csvColumns(familyOrProfile) {
  return profileFields(familyOrProfile).map(snake);
}

/**
 * The plain per-FAMILY counter columns — what a family's aggregate files sum.
 * Deliberately NOT profile-aware: a total over a derived rate or over a
 * type-7-only measurement would be meaningless.
 */
function counterColumns(family) {
  return statFields(family).map(snake);
}

/** One METRICS entry as the public, always-complete info object. */
function metricEntry(name, m) {
  const group = GROUP_LABEL[m.group] ? m.group : DEFAULT_GROUP;
  return {
    key: name,
    csv: m.csv || snake(name),
    label: m.label,
    short: m.short,
    help: m.help,
    group,
    groupLabel: GROUP_LABEL[group],
    format: m.format || 'int',
  };
}

/**
 * Label/short/help/group/format for a metric, by camelCase key OR by CSV column.
 * `group` + `groupLabel` are what the console legend sorts its sections by.
 */
function metricInfo(key) {
  const k = String(key == null ? '' : key);
  const direct = Object.prototype.hasOwnProperty.call(METRICS, k) ? METRICS[k] : null;
  if (direct) return metricEntry(k, direct);
  for (const name of Object.keys(METRICS)) {
    const m = METRICS[name];
    if ((m.csv || snake(name)) === k) return metricEntry(name, m);
  }
  return null;
}

/**
 * The legend's section order: [{group,label,help}], in display order.
 * A consumer groups `scoreboardColumns()` / `metricLabels()` by `group` and
 * prints the sections in exactly this sequence.
 */
function metricGroups() {
  return METRIC_GROUPS.map((g) => ({ ...g }));
}

/** German display name of a profile. Anything unknown is returned unchanged. */
function profileLabel(profile) {
  const p = String(profile == null ? '' : profile);
  return Object.prototype.hasOwnProperty.call(PROFILE_LABELS, p) ? PROFILE_LABELS[p] : p;
}

/** Display label for a metric; falls back to a readable version of the key. */
function metricLabel(key) {
  const info = metricInfo(key);
  if (info) return info.label;
  return String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * The whole label table, keyed by BOTH the camelCase field name and the
 * snake_case CSV column, so a consumer can look up whatever it holds.
 * This is what replaces the console's own `TOTALS_LABEL` map — ship it through
 * `GET /api/modes`.
 */
function metricLabels() {
  const out = {};
  for (const name of Object.keys(METRICS)) {
    const info = metricInfo(name);
    out[info.key] = info;
    if (info.csv !== info.key) out[info.csv] = info;
  }
  return out;
}

/**
 * Scoreboard columns for a profile:
 * [{key,label,short,help,group,groupLabel,format,received?}].
 *
 * `group`/`groupLabel` are additive — they let the console build its legend
 * from the very same list it builds the table from.
 *
 * BACK-COMPAT: a family name still works and yields that family's default
 * profile, so every existing `scoreboardColumns(family)` call is unchanged.
 */
function scoreboardColumns(familyOrProfile) {
  const def = profileDef(familyOrProfile);
  return def.scoreboard.map((c) => {
    const info = metricInfo(c.key)
      || { label: metricLabel(c.key), short: metricLabel(c.key), help: '', group: DEFAULT_GROUP, groupLabel: GROUP_LABEL[DEFAULT_GROUP], format: 'int' };
    const col = {
      key: c.key,
      label: info.label,
      short: info.short,
      help: info.help,
      group: info.group,
      groupLabel: info.groupLabel,
      format: info.format,
    };
    if (c.received) col.received = c.received;
    return col;
  });
}

/** Totals ranking for a profile: the most important metric first. */
function profileSort(familyOrProfile) {
  return profileDef(familyOrProfile).sort.slice();
}

/** The three profiles as a list — for `GET /api/modes` and the console. */
function listProfiles() {
  return PROFILE_LIST.map((p) => ({
    profile: p,
    label: profileLabel(p),
    family: PROFILE_DEFS[p].family,
    scoreboard: scoreboardColumns(p),
    csv: csvColumns(p),
    sort: profileSort(p),
  }));
}

/** SM5 role label for a type-3 `category` value. Never throws. */
function roleLabel(category) {
  const n = toModeNumber(category);
  if (n == null) return null;
  return Object.prototype.hasOwnProperty.call(ROLES, n) ? ROLES[n] : null;
}

/** The registry as a list — for `GET /api/modes` and the console. */
function listModes() {
  return Object.keys(REGISTRY)
    .map((k) => {
      const e = REGISTRY[k];
      return { ...e, profile: profileOf(e) };
    })
    .sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------------
// mode files — modes/*.json and modes/profile/*.json
//
// These files are edited BY HAND, on a hall PC, under time pressure. A typo in
// one of them must never take the bridge down: everything below reports in
// German and falls back to the built-in tables above.
// ---------------------------------------------------------------------------

/** Hard limits. The files come off the local disk, but are still read defensively. */
const MODE_FILE_MAX_BYTES = 256 * 1024;   // one file
const MODE_FILE_MAX_COUNT = 200;          // files per directory
const MODE_MAX_NUMBERS = 200;             // mission numbers per mode file
const MODE_MAX_COLUMNS = 200;             // column names per list

/** Field names a file may carry. Anything else is flagged as a probable typo. */
const MODE_FIELDS = ['schluessel', 'anzeigename', 'missionsnummern', 'familie', 'profil'];
const PROFILE_FIELDS = ['profil', 'anzeigename', 'familie', 'scoreboard', 'csv', 'sortierung'];
/** Free-text fields: they exist so a JSON file can carry its own comments. */
const TEXT_FIELDS = ['beschreibung', 'hinweis', 'kommentar'];

/** Result of the last load — served by `modeConfigStatus()`. */
let MODE_STATUS = { dir: '', files: [], modes: [], profiles: [], problems: [], ok: true, loadedAt: null };

/** Where the mode files live. `LF_MODES_DIR` overrides it (tests, packaging). */
// ANGEPASST FÜR DEN LOCATIONSERVER: diese Datei liegt dort unter
// `util/lf-tdf/`, die Modus-Dateien gehören neben `app.js` in den Wurzelordner
// `modes/` — also zwei Ebenen hoch statt einer. Einzige Änderung an dieser
// Datei; `LF_MODES_DIR` sticht sie weiterhin.
function modesDir() {
  const env = process.env.LF_MODES_DIR;
  if (env && String(env).trim()) return path.resolve(String(env).trim());
  return path.join(__dirname, '..', '..', 'modes');
}

/** No prototype pollution through an object key, whatever a file contains. */
function jsonReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

/** One reportable problem. `file` is the path as a human sees it. */
function problem(level, file, message) {
  return { level, file, message };
}

/** Untrusted display text -> printable, bounded. */
function cleanFileText(v, max) {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Untrusted key/name -> a safe lowercase identifier, or '' when unusable. */
function ident(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,39}$/.test(s) ? s : '';
}

/** For an error message: show what the file actually contained, bounded. */
function shown(v) {
  if (v === undefined) return '(fehlt)';
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? '(Liste)' : '(Objekt)';
  if (typeof v === 'string') return `"${cleanFileText(v, 40)}"`;
  return cleanFileText(String(v), 40) || '(leer)';
}

/** True when `name` is a metric of the METRICS table. */
function isMetric(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(METRICS, name);
}

/** Flag fields a file carries that neither the schema nor the comment set knows. */
function checkUnknownFields(obj, allowed, rel, problems) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k) || TEXT_FIELDS.includes(k) || k.startsWith('_')) continue;
    problems.push(problem('warn', rel,
      `Unbekanntes Feld "${cleanFileText(k, 40)}" — Tippfehler? Das Feld wird ignoriert. Bekannt sind: ${allowed.join(', ')} (dazu ${TEXT_FIELDS.join(', ')} als freier Text).`));
  }
}

/**
 * Read and JSON-parse one file. Returns the object, or null with the reason
 * already pushed onto `problems`.
 */
function readModeJson(full, rel, problems) {
  let st;
  try { st = fs.statSync(full); }
  catch (err) {
    problems.push(problem('error', rel, `Die Datei kann nicht gelesen werden (${err && err.code ? err.code : 'unbekannter Fehler'}). Sie wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size === 0) {
    problems.push(problem('error', rel, 'Die Datei ist leer. Sie wird übersprungen; es gelten die eingebauten Vorgaben.'));
    return null;
  }
  if (st.size > MODE_FILE_MAX_BYTES) {
    problems.push(problem('error', rel, `Die Datei ist ${Math.round(st.size / 1024)} KB groß, erlaubt sind höchstens ${MODE_FILE_MAX_BYTES / 1024} KB. Sie wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  let txt;
  try { txt = fs.readFileSync(full, 'utf8'); }
  catch (err) {
    problems.push(problem('error', rel, `Die Datei kann nicht gelesen werden (${err && err.code ? err.code : 'unbekannter Fehler'}). Sie wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  txt = txt.replace(/^\uFEFF/, '');
  if (!txt.trim()) {
    problems.push(problem('error', rel, 'Die Datei enthält nur Leerzeichen. Sie wird übersprungen; es gelten die eingebauten Vorgaben.'));
    return null;
  }
  let obj;
  try { obj = JSON.parse(txt, jsonReviver); }
  catch (err) {
    problems.push(problem('error', rel, `Die Datei ist kein gültiges JSON: ${cleanFileText(err && err.message, 160)}. Häufigste Ursachen: ein Komma zu viel vor der schließenden Klammer, ein fehlendes Anführungszeichen, oder ein Kommentar — JSON kennt keine Kommentare, benutzen Sie dafür das Feld "beschreibung". Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    problems.push(problem('error', rel, 'Die Datei muss ein JSON-Objekt sein, also mit { beginnen und mit } enden. Sie wird übersprungen; es gelten die eingebauten Vorgaben.'));
    return null;
  }
  return obj;
}

/**
 * One column list of a profile file. Entries are either a plain metric name or
 * `{ "kennzahl": …, "gegenstueck": … }`. Returns null only on a HARD error
 * (the field is not a list at all); an unusable single entry is skipped.
 */
function parseColumnList(raw, field, rel, problems) {
  if (!Array.isArray(raw)) {
    problems.push(problem('error', rel, `Das Pflichtfeld "${field}" fehlt oder ist keine Liste (erwartet z. B. ["score", "level"]). Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const out = [];
  for (const item of raw.slice(0, MODE_MAX_COLUMNS)) {
    let key = '';
    let received = '';
    if (typeof item === 'string') {
      key = item.trim();
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      key = typeof item.kennzahl === 'string' ? item.kennzahl.trim() : '';
      received = typeof item.gegenstueck === 'string' ? item.gegenstueck.trim() : '';
    } else {
      problems.push(problem('warn', rel, `Ein Eintrag in "${field}" ist weder ein Name noch ein Objekt mit "kennzahl" — er wird übersprungen.`));
      continue;
    }
    if (!isMetric(key)) {
      problems.push(problem('warn', rel, `Unbekannte Kennzahl "${cleanFileText(key, 40) || '(leer)'}" in "${field}" — diese Spalte wird übersprungen. Die gültigen Kennzahlen stehen in docs/GAMEMODES.md, Abschnitt "Spaltenbeschriftungen".`));
      continue;
    }
    if (received && !isMetric(received)) {
      problems.push(problem('warn', rel, `Unbekannte Kennzahl "${cleanFileText(received, 40)}" als "gegenstueck" von "${key}" — die Spalte bleibt, das Gegenstück entfällt.`));
      received = '';
    }
    const col = { key };
    if (received) col.received = received;
    out.push(col);
  }
  return out;
}

/** One `modes/profile/<name>.json`. Returns null when the file must be skipped. */
function parseProfileFile(obj, rel, problems) {
  checkUnknownFields(obj, PROFILE_FIELDS, rel, problems);

  const name = ident(obj.profil);
  if (!name) {
    problems.push(problem('error', rel, `Pflichtfeld "profil" fehlt oder ist unbrauchbar (gefunden: ${shown(obj.profil)}). Erlaubt sind Kleinbuchstaben, Ziffern und Unterstriche, z. B. "standard". Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const family = ident(obj.familie);
  if (family !== FAMILIES.SM5 && family !== FAMILIES.LASERBALL) {
    problems.push(problem('error', rel, `Unbekannte Protokollfamilie ${shown(obj.familie)} im Feld "familie". Erlaubt sind genau zwei: "${FAMILIES.LASERBALL}" und "${FAMILIES.SM5}". Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const scoreboard = parseColumnList(obj.scoreboard, 'scoreboard', rel, problems);
  if (!scoreboard) return null;
  const csv = parseColumnList(obj.csv, 'csv', rel, problems);
  if (!csv) return null;
  const sort = parseColumnList(obj.sortierung, 'sortierung', rel, problems);
  if (!sort) return null;
  if (!scoreboard.length || !csv.length || !sort.length) {
    problems.push(problem('error', rel, 'Nach dem Prüfen ist "scoreboard", "csv" oder "sortierung" leer — so lässt sich keine Tabelle bauen. Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.'));
    return null;
  }
  const label = cleanFileText(obj.anzeigename, 64);
  if (!label) {
    problems.push(problem('error', rel, `Pflichtfeld "anzeigename" fehlt oder ist leer (gefunden: ${shown(obj.anzeigename)}). Das ist der Text, den ein Mensch liest, z. B. "Laserball". Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  return {
    profile: name,
    label,
    def: { family, scoreboard, fields: csv.map((c) => c.key), sort: sort.map((c) => c.key) },
  };
}

/** One `modes/<mode>.json`. Returns null when the file must be skipped. */
function parseModeFile(obj, rel, problems, knownProfiles) {
  checkUnknownFields(obj, MODE_FIELDS, rel, problems);

  const key = ident(obj.schluessel);
  if (!key) {
    problems.push(problem('error', rel, `Pflichtfeld "schluessel" fehlt oder ist unbrauchbar (gefunden: ${shown(obj.schluessel)}). Das ist der gleichbleibende Kurzname für Dateien und Auswertungen, z. B. "laserball_ranked" — Kleinbuchstaben, Ziffern, Unterstriche. Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const label = cleanFileText(obj.anzeigename, 64);
  if (!label) {
    problems.push(problem('error', rel, `Pflichtfeld "anzeigename" fehlt oder ist leer (gefunden: ${shown(obj.anzeigename)}). Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const family = ident(obj.familie);
  if (family !== FAMILIES.SM5 && family !== FAMILIES.LASERBALL) {
    problems.push(problem('error', rel, `Unbekannte Protokollfamilie ${shown(obj.familie)} im Feld "familie". Erlaubt sind genau zwei: "${FAMILIES.LASERBALL}" (Tore, Pässe) und "${FAMILIES.SM5}" (Schüsse, Treffer). Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  let profile = '';
  if (obj.profil !== undefined && obj.profil !== null && obj.profil !== '') {
    profile = ident(obj.profil);
    if (!profile || !knownProfiles.includes(profile)) {
      problems.push(problem('error', rel, `Unbekanntes Anzeigeprofil ${shown(obj.profil)} im Feld "profil". Bekannt sind zurzeit: ${knownProfiles.join(', ')} — je eine Datei unter modes/profile/. Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
      return null;
    }
  }
  if (!Array.isArray(obj.missionsnummern)) {
    problems.push(problem('error', rel, `Pflichtfeld "missionsnummern" fehlt oder ist keine Liste (gefunden: ${shown(obj.missionsnummern)}). Erwartet wird eine Liste von Zahlen, z. B. [5] oder [5, 17] — oder [], solange die Nummer noch nicht gemessen ist. Die Datei wird übersprungen; es gelten die eingebauten Vorgaben.`));
    return null;
  }
  const numbers = [];
  for (const raw of obj.missionsnummern.slice(0, MODE_MAX_NUMBERS)) {
    const n = toModeNumber(raw);
    if (n == null) {
      problems.push(problem('warn', rel, `${shown(raw)} in "missionsnummern" ist keine gültige Missionsnummer — erlaubt sind ganze Zahlen von 0 bis 65535, ohne Anführungszeichen. Dieser Eintrag wird übersprungen.`));
      continue;
    }
    if (!numbers.includes(n)) numbers.push(n);
  }
  return { key, label, family, profile, numbers };
}

/** Sorted list of the `.json` files of one directory. Never throws. */
function listModeFiles(dir, problems, rel) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (err) {
    if (err && err.code === 'ENOENT') {
      if (rel) problems.push(problem('warn', rel, 'Das Verzeichnis fehlt. Es gelten die eingebauten Vorgaben.'));
      return [];
    }
    problems.push(problem('error', rel || dir, `Das Verzeichnis kann nicht gelesen werden (${err && err.code ? err.code : 'unbekannter Fehler'}). Es gelten die eingebauten Vorgaben.`));
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    if (!n.toLowerCase().endsWith('.json')) continue;
    if (n.startsWith('_') || n.startsWith('.')) continue;   // _vorlage.json and friends
    if (!/^[A-Za-z0-9._-]+$/.test(n)) {
      problems.push(problem('warn', `${rel}${n}`, 'Der Dateiname enthält ungewöhnliche Zeichen. Die Datei wird übersprungen; erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.'));
      continue;
    }
    if (out.length >= MODE_FILE_MAX_COUNT) {
      problems.push(problem('warn', rel || dir, `Mehr als ${MODE_FILE_MAX_COUNT} Dateien — alles darüber wird ignoriert.`));
      break;
    }
    out.push(n);
  }
  return out;
}

/**
 * Print the problems where a hall PC can see them. Never throws.
 *
 * Identical repeats are swallowed: the files are read at require time AND again
 * on every config apply, and the same three lines on every console save would
 * train the operator to ignore them. A CHANGED set is always printed again.
 */
let LAST_REPORT = '';
function reportModeProblems(problems) {
  const sig = problems.map((p) => `${p.level}|${p.file}|${p.message}`).join('\n');
  if (sig === LAST_REPORT) return;
  LAST_REPORT = sig;
  for (const p of problems) {
    const line = `[${new Date().toISOString()}] ${p.level === 'error' ? 'ERROR' : 'WARN'} gamemodes: ${p.file ? `${p.file}: ` : ''}${p.message}\n`;
    try { process.stderr.write(line); } catch (_err) { /* nothing we can do */ }
  }
}

/**
 * Read `modes/` on top of the built-in tables and publish the result.
 *
 * Mutates REGISTRY / PROFILE_DEFS / PROFILE_LABELS / PROFILES / PROFILE_LIST in
 * place — other modules hold references to exactly those objects.
 *
 * @param {{quiet?:boolean}} [opts] `quiet: true` suppresses the stderr report
 * @returns {object} the same object `modeConfigStatus()` returns
 */
function reloadModes(opts) {
  const quiet = !!(opts && opts.quiet);
  const problems = [];
  const dir = modesDir();

  // ---- start from the built-ins -------------------------------------------
  const defs = structuredClone(BUILTIN_PROFILE_DEFS);
  const labels = { ...BUILTIN_PROFILE_LABELS };
  const order = BUILTIN_PROFILE_LIST.slice();
  const registry = structuredClone(BUILTIN_REGISTRY);
  const files = [];
  const loadedModes = [];
  /** number -> file that claimed it, for the duplicate check among JSON files. */
  const claimed = {};

  try {
    // ---- profiles first: a mode file may only name a profile that exists ----
    const pdir = path.join(dir, 'profile');
    for (const name of listModeFiles(pdir, problems, 'modes/profile/')) {
      const rel = `modes/profile/${name}`;
      files.push(rel);
      const obj = readModeJson(path.join(pdir, name), rel, problems);
      if (!obj) continue;
      const parsed = parseProfileFile(obj, rel, problems);
      if (!parsed) continue;
      defs[parsed.profile] = parsed.def;
      labels[parsed.profile] = parsed.label;
      if (!order.includes(parsed.profile)) order.push(parsed.profile);
    }

    // ---- then the modes -----------------------------------------------------
    for (const name of listModeFiles(dir, problems, 'modes/')) {
      const rel = `modes/${name}`;
      files.push(rel);
      const obj = readModeJson(path.join(dir, name), rel, problems);
      if (!obj) continue;
      const parsed = parseModeFile(obj, rel, problems, order);
      if (!parsed) continue;

      const taken = [];
      for (const n of parsed.numbers) {
        if (Object.prototype.hasOwnProperty.call(claimed, n)) {
          problems.push(problem('error', rel, `Die Missionsnummer ${n} ist schon in ${claimed[n]} vergeben. Eine Nummer darf nur zu genau einem Modus gehören. Diese Nummer wird übersprungen, der Rest der Datei gilt — bitte die Nummer in einer der beiden Dateien entfernen.`));
          continue;
        }
        claimed[n] = rel;
        taken.push(n);
        const entry = { number: n, key: parsed.key, label: parsed.label, family: parsed.family };
        if (parsed.profile) entry.profile = parsed.profile;
        registry[n] = entry;
      }
      loadedModes.push({ file: rel, key: parsed.key, label: parsed.label, family: parsed.family, profile: parsed.profile || null, numbers: taken });
    }
  } catch (err) {
    // A bug in the loader must not be worse than a broken file.
    problems.push(problem('error', 'modes/', `Die Modus-Dateien konnten nicht verarbeitet werden (${cleanFileText(err && err.message, 160)}). Es gelten vollständig die eingebauten Vorgaben.`));
  }

  // ---- publish, in place --------------------------------------------------
  for (const k of Object.keys(PROFILE_DEFS)) delete PROFILE_DEFS[k];
  Object.assign(PROFILE_DEFS, defs);
  for (const k of Object.keys(PROFILE_LABELS)) delete PROFILE_LABELS[k];
  Object.assign(PROFILE_LABELS, labels);
  for (const k of Object.keys(REGISTRY)) delete REGISTRY[k];
  Object.assign(REGISTRY, registry);
  for (const k of Object.keys(PROFILES)) delete PROFILES[k];
  Object.assign(PROFILES, BUILTIN_PROFILES);
  for (const p of order) {
    const k = p.toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(PROFILES, k)) PROFILES[k] = p;
  }
  PROFILE_LIST.length = 0;
  PROFILE_LIST.push(...order);

  MODE_STATUS = {
    dir,
    files,
    profiles: order.slice(),
    modes: loadedModes,
    problems,
    ok: !problems.length,
    loadedAt: new Date().toISOString(),
  };
  if (!quiet && problems.length) reportModeProblems(problems);
  return modeConfigStatus();
}

/**
 * What the last `reloadModes()` made of `modes/` — for the log, the status
 * endpoint and the console. `problems[]` is German, plain text, with the file
 * name in `file`.
 */
function modeConfigStatus() {
  return structuredClone(MODE_STATUS);
}

// Read the files once, at require time, before anybody asks anything.
reloadModes();

module.exports = {
  FAMILIES,
  DEFAULT_FAMILY,
  PROFILES,
  PROFILE_LIST,
  DEFAULT_PROFILE,
  FAMILY_DEFAULT_PROFILE,
  REGISTRY,
  ROLES,
  METRICS,
  METRIC_GROUPS,
  PROFILE_LABELS,
  SM5_OFFICIAL_FIELDS,
  DERIVED_FIELDS,
  resolveMode,
  resolveModeWithProfile,
  familyOf,
  statFields,
  newPlayerStats,
  newOfficialStats,
  csvColumns,
  counterColumns,
  profileFields,
  scoreboardColumns,
  profileSort,
  listProfiles,
  profileOf,
  withProfile,
  normProfile,
  resolveProfile,
  metricInfo,
  metricLabel,
  metricLabels,
  metricGroups,
  profileLabel,
  roleLabel,
  listModes,
  snake,
  reloadModes,
  modeConfigStatus,
};
