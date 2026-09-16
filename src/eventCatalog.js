'use strict';

/**
 * eventCatalog.js — maps LaserForce TDF type-4 event codes to human-readable info.
 *
 * Sources (see docs/LASERFORCE.md "Quellen" for URLs and how authoritative each is):
 *   - zmaniacz/lfstats — docs/TDF_Spec.md (SM5, format versions 2.000-2.006) and
 *     docs/Laserball_TDF_Spec.md, plus the parser/simulator in apps/chomper/src/
 *     (parser.ts, simulator.ts, laserball/types.ts, laserball/simulator.ts).
 *     Community reverse-engineering, but it is the de-facto reference: it powers the
 *     public SM5 tournament stats site and its Laserball half is itself a port of a
 *     European reference implementation (process_logs.php).
 *   - The original lf_overlay server.js (an independent third-party implementation)
 *     corroborates the Laserball 11xx set and 0100/0101/0201/09xx.
 *
 * HARD RULE: no invented codes. Everything here is traceable to one of the sources
 * above. Anything uncertain, inferred, or conflicting is marked status:'unverified'
 * and explained in the `desc`. Gaps are expected and are listed in the doc.
 *
 * Labels and `desc` are German on purpose — they are shown to hall operators.
 *
 * `mode`    : 'all' | 'sm5' | 'laserball' | '7sm'  (variants reuse 'sm5', see doc)
 * `category`: 'match' | 'score' | 'possession' | 'combat' | 'player' | 'special' | 'other'
 * `status`  : 'verified' | 'unverified'
 */

const categories = ['match', 'score', 'possession', 'combat', 'player', 'special', 'other'];

const EVENTS = {
  // ---------------------------------------------------------------------------
  // Shared match-control (every game mode)
  // ---------------------------------------------------------------------------
  '0100': {
    code: '0100', label: 'Mission Start', mode: 'all', category: 'match', status: 'verified',
    desc: 'Beginnt die Mission bei t=0. Startet die Spieluhr; leert im Parser die Spielerliste (Logins folgen danach).',
  },
  '0101': {
    code: '0101', label: 'Mission End', mode: 'all', category: 'match', status: 'verified',
    desc: 'Beendet die Mission. Setzt in Laserball zusätzlich alle Spieler-Status auf 0. Tatsächliche Dauer = dieser Zeitstempel.',
  },

  // ---------------------------------------------------------------------------
  // Shot / combat events — Space Marines 5
  // ---------------------------------------------------------------------------
  '0201': {
    code: '0201', label: 'Miss', mode: 'all', category: 'combat', status: 'verified',
    desc: 'Schuss ins Leere (kein Treffer). Sehr häufig, kein Score. Kommt in SM5 und Laserball vor.',
  },
  '0202': {
    code: '0202', label: 'Gen Miss', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Fehlschuss auf ein bereits angeschlagenes Nicht-Spieler-Ziel; setzt dessen 3-Treffer-Zähler auf 0. Kein Score.',
  },
  '0203': {
    code: '0203', label: 'Target Hit', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Treffer auf ein Nicht-Spieler-Ziel (@NNN). Drei aufeinanderfolgende Treffer zerstören es. Kein Score beim Einzeltreffer.',
  },
  '0204': {
    code: '0204', label: 'Target Destroy', mode: 'sm5', category: 'score', status: 'verified',
    desc: 'Dritter Treffer zerstört das Ziel. +1001 Punkte für den Actor.',
  },
  '0205': {
    code: '0205', label: 'Player Hit', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Spieler getroffen, aber nicht deaktiviert. Actor +100 (Gegner) / -100 (eigenes Team); Ziel immer -20.',
  },
  '0206': {
    code: '0206', label: 'Player Deactivate', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Treffer setzt die Trefferpunkte des Ziels auf 0 -> Deaktivierung + Respawn-Zyklus. Score wie 0205.',
  },
  '0209': {
    code: '0209', label: 'Warbot Deactivate', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Ein Warbot (Nicht-Spieler) deaktiviert einen Spieler: -1 Leben, Standard-Respawn. Zählt nicht als timesZapped. Kein Score.',
  },

  // ---------------------------------------------------------------------------
  // Missile events — Space Marines 5 (Commander / Heavy)
  // ---------------------------------------------------------------------------
  '0300': {
    code: '0300', label: 'Missile Lock', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Actor schaltet auf ein Ziel auf (Spieler oder Nicht-Spieler). Geht jedem Raketenschuss voraus. Kein Score.',
  },
  '0301': {
    code: '0301', label: 'Missile Miss vs Target', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Rakete verfehlt ein Nicht-Spieler-Ziel; setzt dessen 3-Treffer-Zähler zurück. Kein Score.',
  },
  '0303': {
    code: '0303', label: 'Missile Destroy Target', mode: 'sm5', category: 'score', status: 'verified',
    desc: 'Rakete zerstört ein Nicht-Spieler-Ziel in einem Schlag. +1001 Punkte für den Actor.',
  },
  '0304': {
    code: '0304', label: 'Missile Miss vs Player', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Rakete verfehlt einen Spieler. Kein Score.',
  },
  '0306': {
    code: '0306', label: 'Missile Hit Player', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Rakete deaktiviert einen Spieler in einem Schlag. Actor +500 (Gegner) / -500 (eigenes Team); Ziel -100.',
  },
  '0308': {
    code: '0308', label: 'Missile Hit Player (Eigenbeschuss)', mode: 'sm5', category: 'combat', status: 'verified',
    desc: 'Raketen-Eigenbeschuss: Ziel ist immer ein Mitspieler. Actor -500; Ziel -100.',
  },

  // ---------------------------------------------------------------------------
  // Special abilities — Space Marines 5
  // ---------------------------------------------------------------------------
  '0400': {
    code: '0400', label: 'Rapid Fire Activate', mode: 'sm5', category: 'special', status: 'verified',
    desc: 'Scout aktiviert Dauerfeuer (10 SP). Kein explizites Ende-Event; endet, wenn ein Ammo Carrier den Scout auffüllt (0500).',
  },
  '0404': {
    code: '0404', label: 'Nuke Activate', mode: 'sm5', category: 'special', status: 'verified',
    desc: 'Commander startet die Nuke-Sequenz (20 SP). Detonation (0405) folgt, sofern der Commander nicht vorher in Status 3 geht.',
  },
  '0405': {
    code: '0405', label: 'Nuke Detonate', mode: 'sm5', category: 'special', status: 'verified',
    desc: 'Nuke detoniert: gegnerisches Team -3 Leben und sofort deaktiviert. Fester Bonus +500 für den Commander.',
  },

  // ---------------------------------------------------------------------------
  // Resupply / referee — Space Marines 5
  // ---------------------------------------------------------------------------
  '0500': {
    code: '0500', label: 'Ammo Resupply', mode: 'sm5', category: 'player', status: 'verified',
    desc: 'Munition für einen einzelnen Mitspieler auffüllen (Ammo Carrier, oder Notfall-Beacon). Ziel wird 8 s deaktiviert. Kein Score.',
  },
  '0502': {
    code: '0502', label: 'Lives Resupply', mode: 'sm5', category: 'player', status: 'verified',
    desc: 'Leben für einen einzelnen Mitspieler auffüllen (Medic, oder Notfall-Beacon). Ziel wird 8 s deaktiviert. Kein Score.',
  },
  '0510': {
    code: '0510', label: 'Team Ammo Resupply', mode: 'sm5', category: 'player', status: 'verified',
    desc: 'Ammo-Carrier-Spezial (15 SP): füllt Munition aller aktiven Mitspieler gleichzeitig, ohne sie zu deaktivieren.',
  },
  '0512': {
    code: '0512', label: 'Team Lives Resupply', mode: 'sm5', category: 'player', status: 'verified',
    desc: 'Medic-Spezial (10 SP): füllt Leben aller aktiven Mitspieler gleichzeitig, ohne sie zu deaktivieren.',
  },
  '0600': {
    code: '0600', label: 'Penalty', mode: 'sm5', category: 'player', status: 'verified',
    desc: 'Schiedsrichter-Strafe. Der Actor ist der bestrafte Spieler; er wird deaktiviert. Score-Abzug = Feld penalty aus Zeile 1 (meist 0). Erzeugt zusätzlich Zeile 5 und Zeile 9.',
  },

  // ---------------------------------------------------------------------------
  // Achievements / rewards — shared (informativ)
  // ---------------------------------------------------------------------------
  '0900': {
    code: '0900', label: 'Achievement', mode: 'all', category: 'other', status: 'verified',
    desc: 'Spieler hat ein Ingame-Achievement abgeschlossen. Rein informativ, kein Score. Kommt in SM5 und Laserball vor.',
  },
  '0901': {
    code: '0901', label: 'Achievement/Reward (Variante)', mode: 'all', category: 'other', status: 'unverified',
    desc: '(unbestätigt) Taucht in der lfstats-Laserball-Simulation nur in der Ignorier-Liste neben 0900/0902 auf; genaue Bedeutung nicht dokumentiert. Rein informativ.',
  },
  '0902': {
    code: '0902', label: 'Reward', mode: 'all', category: 'other', status: 'verified',
    desc: 'Spieler hat eine Standort-Belohnung erhalten (z. B. Freispiel). Rein informativ, kein Score. TDF-Version 2.005+.',
  },

  // ---------------------------------------------------------------------------
  // Beacon / base — Space Marines 5
  // ---------------------------------------------------------------------------
  '0B00': {
    code: '0B00', label: 'Beacon Claim', mode: 'sm5', category: 'special', status: 'verified',
    desc: 'Actor landet den finalen (3.) Treffer auf einem Beacon-Ziel und beansprucht es. Sollte in einem normalen SM5-Spiel nicht auftreten (nur bei aktiven Beacons aus einem anderen Modus).',
  },
  '0B03': {
    code: '0B03', label: 'Base Award', mode: 'sm5', category: 'score', status: 'verified',
    desc: 'Ein Nicht-Spieler-Ziel wird bei vorzeitigem Spielende durch Team-Elimination automatisch einem Spieler des Siegerteams zugesprochen. +1001 Punkte.',
  },

  // ---------------------------------------------------------------------------
  // Laserball type-4 codes (11xx). Layout wie SM5: 4 <time> <code> <actor> <verb> <target>
  // ---------------------------------------------------------------------------
  '1100': {
    code: '1100', label: 'Pass', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Ball zu einem Mitspieler gespielt. Ball -> Ziel. Öffnet das Assist-Fenster (10 s).',
  },
  '1101': {
    code: '1101', label: 'Tor', mode: 'laserball', category: 'score', status: 'verified',
    desc: 'Actor erzielt ein Tor. Erzeugt genau eine Zeile 5 (delta = 1). Assist, wenn <= 10 s zuvor ein Pass/Clear an den Schützen ging.',
  },
  '1102': {
    code: '1102', label: 'Tor (Variante)', mode: 'laserball', category: 'score', status: 'unverified',
    desc: '(unbestätigt) Zweiter Tor-Code (lfstats-Konstante GOAL_B). Beide Quellen behandeln ihn sicherheitshalber wie ein Tor, in Beispieldaten aber nie beobachtet.',
  },
  '1103': {
    code: '1103', label: 'Steal', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Actor nimmt einem Gegner den Ball ab. Ball -> Actor.',
  },
  '1104': {
    code: '1104', label: 'Block', mode: 'laserball', category: 'combat', status: 'verified',
    desc: 'Actor taggt/blockt einen Spieler. Der Parser wertet es als Reset, wenn das Ziel gerade Status 2 hat, sonst als Block.',
  },
  '1105': {
    code: '1105', label: 'Round Start', mode: 'laserball', category: 'match', status: 'verified',
    desc: 'Beginn einer Ballbesitz-Runde.',
  },
  '1106': {
    code: '1106', label: 'Round End', mode: 'laserball', category: 'match', status: 'verified',
    desc: 'Ende einer Runde. Ball wird frei; Ballbesitz-Tracking zurücksetzen.',
  },
  '1107': {
    code: '1107', label: 'Get Ball', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Actor erhält bei Rundenstart den Ball. Ball -> Actor.',
  },
  '1108': {
    code: '1108', label: 'Ball Timeout', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Ball zu lange gehalten; Ballbesitz endet. Ball wird frei.',
  },
  '1109': {
    code: '1109', label: 'Clear', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Defensiver Clear/Pass. Ball -> Ziel. Öffnet das Assist-Fenster.',
  },
  '110A': {
    code: '110A', label: 'Failed Clear', mode: 'laserball', category: 'possession', status: 'verified',
    desc: 'Ein Clear-Versuch, der fehlgeschlagen ist.',
  },
  '110B': {
    code: '110B', label: 'Target Reset (self)', mode: 'laserball', category: 'combat', status: 'verified',
    desc: 'Actor hat sein eigenes Ziel resettet. Wird als reset-Event ausgegeben; fließt nicht in die resetsDone-Statistik (die kommt aus 1104 + Ziel-Status).',
  },
  '110C': {
    code: '110C', label: 'Target Reset (player)', mode: 'laserball', category: 'combat', status: 'verified',
    desc: 'Ziel-Spieler wurde resettet. Wird als reset-Event ausgegeben; fließt nicht in die reset-Statistik.',
  },
};

/**
 * Look up a code. Never throws. Unknown codes get a generic descriptor.
 * @param {string} code
 * @returns {{code:string,label:string,mode:string,category:string,status:string,desc?:string}}
 */
function describe(code) {
  const key = code == null ? '' : String(code).trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(EVENTS, key)) return EVENTS[key];
  return {
    code: key || '(leer)',
    label: `Event ${key || '?'}`,
    mode: '?',
    category: 'other',
    status: 'unknown',
  };
}

/** Pick the first non-empty string from a list. */
function firstStr(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Build "3:2" style score text from evt.scores ({teamId:n}) or evt.score (string). */
function scoreText(evt) {
  if (evt == null) return null;
  if (typeof evt.score === 'string' && evt.score.trim()) return evt.score.trim();
  const s = evt.scores;
  if (s && typeof s === 'object') {
    const vals = Object.keys(s)
      .sort()
      .map((k) => s[k])
      .filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (vals.length >= 2) return vals.join(':');
  }
  return null;
}

/**
 * Turn a parsed event into a readable German sentence. Best effort — always falls
 * back to the catalog label (or a generic string) and never throws.
 *
 * Accepts a loose shape, e.g.:
 *   { code, actorName|actor, targetName|target, teamName, teamId, scores|score }
 *
 * @param {object} evt
 * @returns {string}
 */
function phrase(evt) {
  try {
    const e = evt || {};
    const info = describe(e.code);
    const actor = firstStr(e.actorName, e.actor, e.actorId);
    const target = firstStr(e.targetName, e.target, e.targetId);
    const team = firstStr(e.teamName, e.actorTeamName)
      || (e.teamId != null ? `Team ${e.teamId}` : null)
      || (e.actorTeamId != null ? `Team ${e.actorTeamId}` : null);
    const sc = scoreText(e);
    const A = actor || 'Spieler';
    const T = target || 'Ziel';

    switch (info.code) {
      case '0100': return 'Mission gestartet';
      case '0101': return sc ? `Mission beendet (${sc})` : 'Mission beendet';

      // Laserball
      case '1100': return target ? `${A} spielt zu ${T}` : `${A} passt`;
      case '1109': return target ? `${A} klärt zu ${T}` : `${A} klärt`;
      case '110A': return `${A} vergibt den Clear`;
      case '1103': return target ? `${A} erobert den Ball von ${T}` : `${A} erobert den Ball`;
      case '1104': return target ? `${A} blockt ${T}` : `${A} blockt`;
      case '1101':
      case '1102': {
        if (team && sc) return `Tor für ${team} (${sc})`;
        if (team) return `Tor für ${team}`;
        return `Tor von ${A}`;
      }
      case '1105': return 'Runde gestartet';
      case '1106': return 'Runde beendet';
      case '1107': return `${A} erhält den Ball`;
      case '1108': return 'Ballbesitz-Timeout';
      case '110B': return `${A} resettet das eigene Ziel`;
      case '110C': return target ? `${A} resettet ${T}` : `${A} resettet ein Ziel`;

      // SM5
      case '0201': return `${A} verfehlt`;
      case '0202': return `${A} verfehlt ${T}`;
      case '0203': return `${A} trifft ${T}`;
      case '0204': return `${A} zerstört ${T}`;
      case '0205': return target ? `${A} trifft ${T}` : `${A} trifft`;
      case '0206': return target ? `${A} deaktiviert ${T}` : `${A} deaktiviert einen Spieler`;
      case '0209': return `Warbot deaktiviert ${T}`;
      case '0300': return target ? `${A} schaltet auf ${T} auf` : `${A} schaltet auf`;
      case '0301':
      case '0304': return `${A} verfehlt ${T} mit einer Rakete`;
      case '0303': return `${A} zerstört ${T} mit einer Rakete`;
      case '0306': return target ? `${A} trifft ${T} mit einer Rakete` : `${A} feuert eine Rakete`;
      case '0308': return target ? `${A} trifft ${T} mit einer Rakete (Eigenbeschuss)` : `${A} feuert eine Rakete (Eigenbeschuss)`;
      case '0400': return `${A} aktiviert Dauerfeuer`;
      case '0404': return `${A} aktiviert die Nuke`;
      case '0405': return `${A} zündet die Nuke`;
      case '0500': return target ? `${A} versorgt ${T} mit Munition` : `${A} versorgt mit Munition`;
      case '0502': return target ? `${A} versorgt ${T} mit Leben` : `${A} versorgt mit Leben`;
      case '0510': return `${A} versorgt das Team mit Munition`;
      case '0512': return `${A} versorgt das Team mit Leben`;
      case '0600': return `Strafe gegen ${A}`;
      case '0900': return `${A} schaltet ein Achievement frei`;
      case '0901': return `${A} erhält eine Auszeichnung`;
      case '0902': return `${A} erhält eine Belohnung`;
      case '0B00': return target ? `${A} beansprucht ${T}` : `${A} beansprucht einen Beacon`;
      case '0B03': return target ? `${T} wird ${A} zugesprochen` : `${A} erhält ein Ziel zugesprochen`;

      default: {
        const label = info.label || `Event ${info.code}`;
        if (actor && target) return `${label}: ${A} -> ${T}`;
        if (actor) return `${label}: ${A}`;
        return label;
      }
    }
  } catch (_err) {
    // phrase() must never throw
    try {
      return describe((evt || {}).code).label;
    } catch (_e2) {
      return 'Event';
    }
  }
}

/**
 * phrase(), but fall back to a supplied `evt.text` whenever phrase() could only
 * produce the generic catalog label (i.e. it does not really "know" the code).
 * Used by the event-log file and the events CSV so an unknown/edge code still
 * shows the engine's own plain-text description instead of "Event 0F00".
 *
 * @param {object} evt
 * @returns {string}
 */
function readable(evt) {
  const e = evt || {};
  let p = '';
  try { p = phrase(e); } catch (_err) { p = ''; }
  let generic = '';
  try { generic = describe(e.code).label; } catch (_err) { generic = ''; }
  const isGeneric = !!p && !!generic && (p === generic || p.startsWith(`${generic}:`));
  if (p && !isGeneric) return p;
  if (typeof e.text === 'string' && e.text.trim()) return e.text.trim();
  if (p && p.trim()) return p;
  if (e.type) return String(e.type);
  return `Event ${e.code || '?'}`;
}

module.exports = { EVENTS, describe, phrase, readable, categories };
