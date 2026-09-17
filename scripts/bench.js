'use strict';

/**
 * bench.js — Last- und Dauerlaufmessung für den Location Server.
 *
 *   node scripts/bench.js [Optionen]
 *
 * Das Werkzeug startet eine EIGENE Instanz des Dienstes in einem temporären
 * Arbeitsverzeichnis (nichts landet im Projekt), spielt einen realistischen
 * TDF-Strom hinein, hängt simulierte Konsolen an den WebSocket und misst dabei
 * von INNEN, was der Dienst kostet.
 *
 * Zwei Betriebsarten, eine Datei:
 *
 *   node scripts/bench.js …                 Messfahrt (Treiber)
 *   node --require scripts/bench.js …       Sonde im gemessenen Prozess
 *
 * Der Treiber startet den Dienst selbst mit `--expose-gc --require <diese
 * Datei>`; die Sonde erkennt das an `require.main !== module` und macht dann
 * NICHTS außer messen. Sie öffnet einen winzigen TCP-Dienst auf 127.0.0.1
 * (Port aus LF_BENCH_PROBE_PORT) und beantwortet Zeilenbefehle:
 *
 *   sample     -> eine Messzeile (CPU, Heap, Handles, Event-Loop, Schreiblast)
 *   gc         -> erzwungene GC, danach eine Messzeile
 *   loopreset  -> Event-Loop-Histogramm zurücksetzen
 *
 * Gemessen wird:
 *   · CPU-Zeit des Dienstes          process.cpuUsage()
 *   · Heap nach erzwungener GC       global.gc() + process.memoryUsage()
 *   · Handle-Zahl                    process.getActiveResourcesInfo()
 *   · Event-Loop-Verzögerung         perf_hooks.monitorEventLoopDelay()
 *   · Schreiblast auf Platte         fs.{append,write}File{,Sync} umschlossen
 *   · Bytes je Zustands-Push         an den simulierten Konsolen gezählt
 *   · Ereignisdurchsatz              gesendete Zeilen / Laufzeit
 *
 * Keine zusätzliche Abhängigkeit: nur Node-20-Bordmittel und `ws`, das der
 * Dienst ohnehin mitbringt.
 */

const PROBE_ENV = 'LF_BENCH_PROBE_PORT';

// ─────────────────────────────────────────────────────────────────────────────
// Sonde — läuft IM gemessenen Prozess, per `--require` vor src/index.js geladen
// ─────────────────────────────────────────────────────────────────────────────

function installProbe() {
  const port = parseInt(process.env[PROBE_ENV] || '', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;

  const net = require('net');
  const fs = require('fs');
  const { monitorEventLoopDelay } = require('perf_hooks');

  // 10 ms Auflösung: fein genug für einen 200-ms-Tick, grob genug, um selbst
  // nicht ins Gewicht zu fallen.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  // Schreiblast: die vier Wege, auf denen dieses Projekt auf Platte schreibt
  // (statsWriter, eventLog, config). Der Rohmitschnitt (capture.js) benutzt
  // einen WriteStream und ist standardmäßig aus — er wird hier NICHT gezählt.
  const io = { calls: 0, bytes: 0, sync: 0, syncBytes: 0 };
  const len = (d) => {
    try { return Buffer.isBuffer(d) ? d.length : Buffer.byteLength(String(d)); }
    catch { return 0; }
  };
  for (const name of ['appendFileSync', 'writeFileSync', 'appendFile', 'writeFile']) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    const isSync = name.endsWith('Sync');
    fs[name] = function patched(file, data, ...rest) {
      const n = len(data);
      io.calls++; io.bytes += n;
      if (isSync) { io.sync++; io.syncBytes += n; }
      return orig.call(this, file, data, ...rest);
    };
  }

  const ms = (n) => Math.round((Number(n) || 0) / 1e4) / 100; // ns -> ms, 2 Stellen

  const sample = () => {
    const mem = process.memoryUsage();
    const res = process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [];
    const kinds = {};
    for (const r of res) kinds[r] = (kinds[r] || 0) + 1;
    return {
      ts: Date.now(),
      uptimeMs: Math.round(process.uptime() * 1000),
      cpu: process.cpuUsage(),                 // µs seit Prozessstart
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      handles: res.length,
      handleKinds: kinds,
      loop: { mean: ms(loop.mean), max: ms(loop.max), p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), p999: ms(loop.percentile(99.9)) },
      io: { ...io },
      gcAvailable: typeof global.gc === 'function',
    };
  };

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let out;
        if (cmd === 'gc') {
          if (typeof global.gc === 'function') { global.gc(); global.gc(); }
          out = sample();
        } else if (cmd === 'loopreset') {
          loop.reset();
          out = { ok: true };
        } else {
          out = sample();
        }
        try { sock.write(JSON.stringify(out) + '\n'); } catch {}
      }
    });
  });
  server.on('error', () => {});
  server.listen(port, '127.0.0.1');
  server.unref();
}

if (require.main !== module) {
  installProbe();
  module.exports = {};
  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// Treiber
// ─────────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Ereignismischung ------------------------------------------------------
/**
 * Die Mischung ist aus docs/LASERFORCE.md abgeleitet, nicht geraten. Die
 * Gewichte sind Prozent aller Typ-4-Ereignisse einer Mission.
 *
 * Begründung, Code für Code:
 *
 *   `0201` Miss  — die Doku nennt ihn ausdrücklich „Sehr häufig", und er ist
 *     der einzige so markierte Code. Jeder Schuss ins Leere erzeugt ihn, und
 *     ein Spieler trifft die Minderheit seiner Schüsse. 60 % ist die direkte
 *     Folge einer Trefferquote von rund 25–30 % (docs/LASERFORCE.md warnt
 *     ausdrücklich, dass die LIVE-Quote zu hoch ausfällt, weil nicht jeder
 *     Fehlschuss gemeldet wird — real ist der Fehlschussanteil also eher noch
 *     höher als hier angesetzt).
 *   `0205`/`0206` Treffer bzw. Deaktivierung — was von den Treffern übrig
 *     bleibt; Deaktivierungen sind der kleinere Teil, weil ein Spieler mehrere
 *     Trefferpunkte hat.
 *   `0203`/`0204`/`0202` Nicht-Spieler-Ziele — drei Treffer zerstören ein Ziel,
 *     also 0204 ≈ 1/3 von 0203, und es gibt weit weniger Ziele als Spieler.
 *   `03xx` Raketen — jedem Schuss geht ein `0300` Lock voraus; Raketen sind
 *     Sonderwaffen und damit selten.
 *   `04xx` Rapid Fire / Nuke — an Rollen (Scout, Commander) und Sonderpunkte
 *     gebunden, also wenige je Mission und Spieler.
 *   `05xx` Nachschub — Ammo Carrier und Medic, mehrfach je Mission, aber weit
 *     seltener als geschossen wird.
 *   `0600` Strafe, `0900`/`0902` Achievement/Reward — Einzelfälle, „rein
 *     informativ" laut Doku.
 *
 * Laserball analog: `0201` bleibt häufigster Code, darunter der 11xx-Satz mit
 * Pass/Steal/Block als Alltag und dem Tor als seltenem Höhepunkt.
 */
const MIX = {
  sm5: [
    ['0201', 60.0, 'shot'],     // Miss — „Sehr häufig"
    ['0205', 18.0, 'hit'],      // Player Hit
    ['0206', 7.0, 'down'],      // Player Deactivate
    ['0203', 5.0, 'target'],    // Target Hit
    ['0202', 1.5, 'target'],    // Gen Miss
    ['0204', 1.2, 'target'],    // Target Destroy (+Score)
    ['0300', 1.5, 'lock'],      // Missile Lock
    ['0306', 0.8, 'down'],      // Missile Hit Player (+Score)
    ['0304', 0.6, 'hit'],       // Missile Miss vs Player
    ['0500', 0.8, 'supply'],    // Ammo Resupply
    ['0502', 0.8, 'supply'],    // Lives Resupply
    ['0400', 0.5, 'self'],      // Rapid Fire Activate
    ['0900', 0.5, 'self'],      // Achievement
    ['0209', 0.3, 'warbot'],    // Warbot Deactivate
    ['0301', 0.2, 'target'],    // Missile Miss vs Target
    ['0303', 0.2, 'target'],    // Missile Destroy Target (+Score)
    ['0404', 0.25, 'self'],     // Nuke Activate
    ['0405', 0.2, 'nuke'],      // Nuke Detonate (+Score)
    ['0308', 0.15, 'down'],     // Raketen-Eigenbeschuss (+Score)
    ['0510', 0.15, 'self'],     // Team Ammo Resupply
    ['0512', 0.15, 'self'],     // Team Lives Resupply
    ['0902', 0.1, 'self'],      // Reward
    ['0600', 0.05, 'penalty'],  // Penalty
  ],
  laserball: [
    ['0201', 45.0, 'shot'],
    ['1100', 20.0, 'pass'],
    ['1103', 9.0, 'steal'],
    ['1104', 9.0, 'block'],
    ['1109', 8.0, 'pass'],
    ['110A', 4.0, 'self'],
    ['1101', 1.6, 'goal'],
    ['1107', 0.8, 'self'],
    ['1108', 0.8, 'self'],
    ['110C', 0.5, 'block'],
    ['1105', 0.4, 'self'],
    ['1106', 0.4, 'self'],
    ['0900', 0.3, 'self'],
    ['110B', 0.2, 'self'],
  ],
};

/** Codes, die laut Doku eine Typ-5-Score-Zeile nach sich ziehen. */
const SCORING = new Set(['0204', '0205', '0206', '0303', '0306', '0308', '0405', '1101']);
/** Codes, nach denen das Ziel deaktiviert ist (Typ-9-Statuskette 3 → 2 → 0). */
const DEACTIVATES = new Set(['0206', '0306', '0308', '0405', '0500', '0502', '0209', '0600']);

const TYPE1_SCHEMA = ';1/mission\ttype\tdesc\tstart\tduration\tpenalty';
const TYPE2_SCHEMA = ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour';
const TYPE3_SCHEMA = ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmember-id';
const TYPE4_SCHEMA = ';4/event\ttime\ttype\tvaries';
const TYPE5_SCHEMA = ';5/score\ttime\tentity\told\tdelta\tnew';
const TYPE6_SCHEMA = ';6/entity-end\ttime\tid\ttype\tscore';
const TYPE7_SCHEMA = ';7/sm5-stats\tid\tshots-hit\tshots-fired\ttimes-zapped\ttimes-missiled\tmissile-hits'
  + '\tnukes-detonated\tnukes-activated\tnukes-cancelled\tmedic-hits\townmedic-hits\tmedic-nukes'
  + '\tscout-rapid\tlife-boost\tammo-boost\tlives-left\tshots-left\tpenalties\tshot-3-hit'
  + '\town-nuke-cancels\tshot-opponent\tshot-team\tmissiled-opponent\tmissiled-team';
const TYPE9_SCHEMA = ';9/player-state\ttime\tentity\tstate';

const TEAM_COLORS = [
  ['1', 'Red', '#ef4444'], ['4', 'Blue', '#3b82f6'], ['2', 'Green', '#22c55e'],
  ['3', 'Yellow', '#eab308'], ['6', 'Purple', '#a855f7'], ['8', 'Orange', '#f97316'],
];
const TEAM_NAMES = ['Fire', 'Ice', 'Earth', 'Storm', 'Shadow', 'Solar'];

/** Deterministischer Zufall — zwei Läufe sind vergleichbar. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function weightedPicker(mix, rand) {
  const total = mix.reduce((a, m) => a + m[1], 0);
  return () => {
    let r = rand() * total;
    for (const m of mix) { r -= m[1]; if (r <= 0) return m; }
    return mix[mix.length - 1];
  };
}

/**
 * Die Zeilen EINER Mission, als {t, s} sortiert nach Spielzeit.
 * `t === -1` heißt „vor dem Missionsstart", also Kopf-, Missions- und Teamzeilen.
 */
function buildMatch(o, idx, rand) {
  const out = [];
  const add = (t, s) => out.push({ t, s });
  const family = o.mode === 'laserball' ? 'laserball' : 'sm5';
  const modeNumber = family === 'laserball' ? 28 : 5;
  const modeDesc = family === 'laserball' ? 'Laserball Ranked' : 'Space Marines 5';
  const durMs = o.duration * 1000;

  if (idx === 0) add(-1, `0\t2.006\tlf-bench\tBench Arena`);
  add(-1, TYPE1_SCHEMA);
  add(-1, `1\t${modeNumber}\t${modeDesc}\t${stampNow()}\t${durMs}\t0`);
  add(-1, TYPE2_SCHEMA);
  for (let t = 0; t < o.teams; t++) {
    const [enumv, desc, rgb] = TEAM_COLORS[t % TEAM_COLORS.length];
    add(-1, `2\t${t}\t${TEAM_NAMES[t % TEAM_NAMES.length]} Team\t${enumv}\t${desc}\t${rgb}`);
  }
  add(-1, `2\t5\tNeutral\t0\tNone\t#9ca3af`);
  if (idx === 0) {
    add(-1, TYPE3_SCHEMA); add(-1, TYPE4_SCHEMA); add(-1, TYPE5_SCHEMA);
    add(-1, TYPE6_SCHEMA); add(-1, TYPE7_SCHEMA); add(-1, TYPE9_SCHEMA);
  }

  add(0, `4\t0\t0100`);

  // Logins: die Anlage schickt sie NACH 0100, über die ersten Sekunden verteilt.
  //
  // `--roster N` entscheidet, WER spielt, und das trennt zwei Dinge, die sonst
  // in einer Zahl verschwimmen:
  //   roster = 0  jedes Match bringt fremde Spieler. Schlimmster Fall: die
  //               Gesamtwertung (_totals/_playerModes in statsWriter.js) wächst
  //               mit jedem Match, und zwar zu Recht — das ist kein Leck.
  //   roster = N  die Mitglieder einer Halle spielen wieder und wieder. Der
  //               Normalfall. Hier MUSS der Heap flach bleiben; tut er es nicht,
  //               ist es ein echtes Leck.
  const players = [];
  for (let i = 0; i < o.players; i++) {
    const base = o.roster > 0 ? ((idx * o.players + i) % o.roster) : (idx * 1000 + i);
    const id = `${1000000 + base}`;
    const team = String(i % o.teams);
    const role = family === 'laserball' ? 0 : (i % 6);
    players.push({ id, team, role, score: 0 });
    add(Math.round(200 + (i / o.players) * 5000),
      `3\t${Math.round(200 + (i / o.players) * 5000)}\t#${id}\tplayer\tSpieler-${String(i + 1).padStart(3, '0')}\t${team}\t${1 + (i % 12)}\t${role}\tSuit-${String(i + 1).padStart(3, '0')}\tM${id}`);
  }

  // Spielphase
  const pick = weightedPicker(MIX[family], rand);
  const teamScore = new Array(o.teams).fill(0);
  const playStart = 6000;
  const playEnd = durMs;
  const n = Math.max(1, Math.round(o.rate * (playEnd - playStart) / 1000));
  for (let k = 0; k < n; k++) {
    const t = Math.round(playStart + (k / n) * (playEnd - playStart));
    const [code, , shape] = pick();
    const a = players[(rand() * players.length) | 0];
    let target = null;
    if (shape === 'hit' || shape === 'down' || shape === 'block' || shape === 'steal' || shape === 'lock') {
      // Gegner: erster Spieler eines anderen Teams ab einer Zufallsposition
      for (let tries = 0; tries < 8; tries++) {
        const c = players[(rand() * players.length) | 0];
        if (c.team !== a.team) { target = c; break; }
      }
    } else if (shape === 'pass' || shape === 'supply') {
      for (let tries = 0; tries < 8; tries++) {
        const c = players[(rand() * players.length) | 0];
        if (c.team === a.team && c.id !== a.id) { target = c; break; }
      }
    } else if (shape === 'target') {
      target = { id: null, hw: String(100 + ((rand() * 40) | 0)) };
    } else if (shape === 'warbot') {
      target = players[(rand() * players.length) | 0];
    }

    const tgt = target ? (target.hw ? `@${target.hw}` : `#${target.id}`) : '';
    add(t, `4\t${t}\t${code}\t#${a.id}${tgt ? `\thits\t${tgt}` : ''}`);

    if (SCORING.has(code)) {
      // Typ 5 ist die Punkte-Autorität: Teamstand UND Spielerstand.
      const delta = code === '0204' || code === '0303' ? 1001
        : code === '0405' ? 500 : code === '1101' ? 1 : 100;
      const ti = parseInt(a.team, 10) || 0;
      const oldT = teamScore[ti]; teamScore[ti] += delta;
      add(t, `5\t${t}\t${ti}\t${oldT}\t${delta}\t${teamScore[ti]}`);
      const oldP = a.score; a.score += delta;
      add(t, `5\t${t}\t#${a.id}\t${oldP}\t${delta}\t${a.score}`);
    }
    if (DEACTIVATES.has(code) && target && target.id) {
      // Respawn-Kette aus docs/LASERFORCE.md: 3 → 4000 ms → 2 → 4000 ms → 0
      add(t, `9\t${t}\t#${target.id}\t3`);
      if (t + 4000 < playEnd) add(t + 4000, `9\t${t + 4000}\t#${target.id}\t2`);
      if (t + 8000 < playEnd) add(t + 8000, `9\t${t + 8000}\t#${target.id}\t0`);
    }
  }

  // Endabrechnung: je Entity eine Typ-6-Zeile, in SM5 zusätzlich Typ 7,
  // danach erst 0101 (docs/LASERFORCE.md).
  const endT = durMs + 100;
  for (const p of players) add(endT, `6\t${endT}\t#${p.id}\t02\t${p.score}`);
  if (family === 'sm5') {
    for (const p of players) {
      const fired = 200 + ((rand() * 400) | 0);
      const hit = Math.round(fired * (0.2 + rand() * 0.2));
      const f = [hit, fired, (rand() * 30) | 0, (rand() * 5) | 0, (rand() * 6) | 0,
        (rand() * 2) | 0, (rand() * 2) | 0, (rand() * 2) | 0, (rand() * 8) | 0, (rand() * 3) | 0,
        (rand() * 2) | 0, (rand() * 4) | 0, (rand() * 4) | 0, (rand() * 4) | 0, (rand() * 20) | 0,
        (rand() * 100) | 0, (rand() * 2) | 0, (rand() * 10) | 0, (rand() * 2) | 0,
        (rand() * 40) | 0, (rand() * 4) | 0, (rand() * 5) | 0, (rand() * 2) | 0];
      add(endT + 1, `7\t#${p.id}\t${f.join('\t')}`);
    }
  }
  add(endT + 2, `4\t${endT + 2}\t0101`);

  out.sort((a, b) => a.t - b.t);
  return out;
}

function stampNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- Sondenverbindung ------------------------------------------------------
class Probe {
  constructor(port) { this.port = port; this.sock = null; this.pending = []; this.buf = ''; }
  async connect(timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      try {
        this.sock = await new Promise((res, rej) => {
          const s = net.connect(this.port, '127.0.0.1');
          s.once('connect', () => res(s));
          s.once('error', rej);
        });
        break;
      } catch (err) {
        if (Date.now() > end) throw new Error(`Sonde nicht erreichbar: ${err.message}`);
        await sleep(200);
      }
    }
    this.sock.setNoDelay(true);
    this.sock.on('error', () => {});
    this.sock.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        const p = this.pending.shift();
        if (p) { try { p.res(JSON.parse(line)); } catch (e) { p.rej(e); } }
      }
    });
  }
  cmd(c) {
    return new Promise((res, rej) => {
      this.pending.push({ res, rej });
      this.sock.write(c + '\n');
      setTimeout(() => rej(new Error(`Sonde antwortet nicht auf "${c}"`)), 20000).unref?.();
    });
  }
  close() { try { this.sock?.destroy(); } catch {} }
}

// ---- Argumente -------------------------------------------------------------
function usage(msg) {
  if (msg) console.error(`bench: ${msg}\n`);
  console.error(`Aufruf:  node scripts/bench.js [Optionen]

  --players N     Spieler je Match                        (Standard 50)
  --teams N       Teams                                   (Standard 2)
  --mode M        sm5 | laserball                         (Standard sm5)
  --rate N        Ereignisse je Sekunde Spielzeit         (Standard: Spieler x 0.6)
  --duration S    Matchdauer in Sekunden Spielzeit        (Standard 900)
  --matches N     Anzahl Matches hintereinander           (Standard 1)
  --speed N       Zeitraffer: 1 = echt, 45 = 45-fach      (Standard 1)
  --consoles N    simulierte WebSocket-Konsolen           (Standard 2)
  --roster N      feste Mitgliederzahl, aus der die Spieler kommen
                  (Standard 0 = jedes Match fremde Spieler, schlimmster Fall
                  für die Gesamtwertung; N = Stammkundschaft, Normalfall)
  --tick MS       Zustands-Takt des Dienstes (LF_STATE_TICK_MS)
  --no-events     CSV-Ereignisdatei abschalten (LF_CSV_EVENTS=false)
  --no-eventlog   Ereignis-Logdatei abschalten (LF_EVENTLOG_ENABLED=false)
  --env K=V       zusätzliche Umgebungsvariable (mehrfach erlaubt)
  --seed N        Zufallssaat                             (Standard 12345)
  --json DATEI    Messwerte zusätzlich als JSON ablegen
  --keep          Arbeitsverzeichnis nicht löschen
  --quiet         weniger Ausgabe

Beispiele:
  node scripts/bench.js --players 50 --consoles 4 --duration 180
  node scripts/bench.js --matches 60 --duration 900 --speed 45 --consoles 2
`);
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const o = {
    players: 50, teams: 2, mode: 'sm5', rate: 0, duration: 900, matches: 1,
    speed: 1, consoles: 2, roster: 0, tick: null, seed: 12345, json: null,
    keep: false, quiet: false, csvEvents: true, eventLog: true, env: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nextI = () => { const v = parseInt(argv[++i], 10); if (!Number.isFinite(v)) usage(`${a} braucht eine Zahl`); return v; };
    const nextF = () => { const v = parseFloat(argv[++i]); if (!Number.isFinite(v)) usage(`${a} braucht eine Zahl`); return v; };
    if (a === '--help' || a === '-h') usage();
    else if (a === '--players') o.players = nextI();
    else if (a === '--teams') o.teams = nextI();
    else if (a === '--mode') o.mode = String(argv[++i] || '').toLowerCase();
    else if (a === '--rate') o.rate = nextF();
    else if (a === '--duration') o.duration = nextI();
    else if (a === '--matches') o.matches = nextI();
    else if (a === '--speed') o.speed = nextF();
    else if (a === '--consoles') o.consoles = nextI();
    else if (a === '--roster') o.roster = nextI();
    else if (a === '--tick') o.tick = nextI();
    else if (a === '--seed') o.seed = nextI();
    else if (a === '--json') o.json = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--no-events') o.csvEvents = false;
    else if (a === '--no-eventlog') o.eventLog = false;
    else if (a === '--env') { const kv = String(argv[++i] || ''); const j = kv.indexOf('='); if (j < 0) usage('--env braucht K=V'); o.env[kv.slice(0, j)] = kv.slice(j + 1); }
    else usage(`unbekannte Option ${a}`);
  }
  if (!['sm5', 'laserball'].includes(o.mode)) usage('--mode muss sm5 oder laserball sein');
  if (o.players < 1 || o.players > 500) usage('--players muss 1–500 sein');
  if (o.teams < 2 || o.teams > 6) usage('--teams muss 2–6 sein');
  if (o.matches < 1) usage('--matches muss mindestens 1 sein');
  if (o.roster < 0) usage('--roster darf nicht negativ sein');
  if (o.roster > 0 && o.roster < o.players) usage('--roster muss mindestens so groß sein wie --players');
  if (o.speed <= 0) usage('--speed muss größer 0 sein');
  if (!o.rate) o.rate = +(o.players * 0.6).toFixed(2);
  return o;
}

// ---- Hilfen ----------------------------------------------------------------
const MB = (b) => (b / 1048576).toFixed(1);
const pad = (s, w) => String(s).padEnd(w);
const rpad = (s, w) => String(s).padStart(w);

function write(sock, data) {
  return new Promise((resolve, reject) => {
    if (sock.write(data)) return resolve();
    sock.once('drain', resolve);
    sock.once('error', reject);
  });
}

/** Freie lokale Ports finden, damit parallele Läufe sich nicht stören. */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

// ---- Hauptlauf -------------------------------------------------------------
(async () => {
  const o = parseArgs(process.argv.slice(2));
  const rand = rng(o.seed);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-bench-'));
  const [httpPort, tcpPort, probePort] = [await freePort(), await freePort(), await freePort()];
  const TOKEN = 'bench-' + Math.random().toString(36).slice(2, 10);

  const say = (...a) => { if (!o.quiet) console.log(...a); };

  say('');
  say('lf_live — Messfahrt');
  say('─'.repeat(74));
  say(`  Spieler        ${o.players} in ${o.teams} Teams, Modus ${o.mode}`);
  say(`  Mitglieder     ${o.roster > 0 ? `${o.roster} feste Mitglieder (Stammkundschaft)` : 'jedes Match fremde Spieler (schlimmster Fall)'}`);
  say(`  Ereignisrate   ${o.rate}/s Spielzeit  (${(o.rate * o.speed).toFixed(1)}/s echte Zeit bei Tempo ${o.speed}x)`);
  say(`  Matches        ${o.matches} x ${o.duration} s Spielzeit, Zeitraffer ${o.speed}x`);
  say(`  Konsolen       ${o.consoles} WebSocket-Clients`);
  say(`  Arbeitsordner  ${dir}`);
  say('');

  const env = {
    ...process.env,
    LF_HTTP_HOST: '127.0.0.1', LF_HTTP_PORT: String(httpPort),
    LF_TCP_HOST: '127.0.0.1', LF_TCP_PORT: String(tcpPort),
    LF_API_TOKEN: TOKEN, LF_ADMIN_ENABLED: 'false', LF_LOG_LEVEL: 'error',
    LF_CSV_EVENTS: o.csvEvents ? 'true' : 'false',
    LF_EVENTLOG_ENABLED: o.eventLog ? 'true' : 'false',
    [PROBE_ENV]: String(probePort),
    ...o.env,
  };
  if (o.tick) env.LF_STATE_TICK_MS = String(o.tick);

  const svc = spawn(process.execPath, ['--expose-gc', '--require', __filename, path.join(ROOT, 'src', 'index.js')], { cwd: dir, env });
  let svcErr = '';
  svc.stdout.on('data', (d) => { svcErr += d; });
  svc.stderr.on('data', (d) => { svcErr += d; });
  const cleanup = () => {
    try { svc.kill('SIGKILL'); } catch {}
    if (!o.keep) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    else console.log(`\nArbeitsordner behalten: ${dir}`);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const BASE = `http://127.0.0.1:${httpPort}`;
  const AUTH = { Authorization: `Bearer ${TOKEN}` };
  const api = (p) => fetch(BASE + p, { headers: AUTH }).then((r) => r.json());

  // warten, bis der Dienst steht
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() > deadline) { console.error(`bench: Dienst startet nicht.\n${svcErr}`); process.exit(1); }
    await sleep(200);
  }

  const probe = new Probe(probePort);
  await probe.connect();
  const first = await probe.cmd('gc');
  if (!first.gcAvailable) console.error('bench: WARNUNG — global.gc fehlt, Heapwerte sind ungenau');
  say(`Dienst läuft   PID ${svc.pid} · HTTP ${httpPort} · TDF ${tcpPort} · Sonde ${probePort}`);

  // Konsolen anhängen
  const consoles = [];
  for (let i = 0; i < o.consoles; i++) {
    const c = { stateMsgs: 0, stateBytes: 0, eventMsgs: 0, eventBytes: 0, otherBytes: 0 };
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/ws?token=${TOKEN}`);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const n = data.length;
      // Nur der erste Buchstabe des Typs wird gebraucht — kein JSON.parse,
      // damit der Messtreiber selbst nicht zum Engpass wird.
      const head = data.toString('utf8', 0, 24);
      if (head.includes('"state"')) { c.stateMsgs++; c.stateBytes += n; }
      else if (head.includes('"event"')) { c.eventMsgs++; c.eventBytes += n; }
      else c.otherBytes += n;
    });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    consoles.push(c);
  }
  if (o.consoles) say(`Konsolen       ${o.consoles} verbunden`);

  // TDF-Verbindung
  const feed = net.connect(tcpPort, '127.0.0.1');
  feed.setNoDelay(true);
  await new Promise((res, rej) => { feed.once('connect', res); feed.once('error', rej); });
  say('');

  // Leerlauf-Grundwert der Event-Loop: unter Windows liegt die Timer-Auflösung
  // bei ~15,6 ms, das misst sich als Verzögerung, ohne dass etwas blockiert.
  // Ohne diesen Vergleichswert wäre jede Messung unten nicht einzuordnen.
  await probe.cmd('loopreset');
  await sleep(1500);
  const idle = await probe.cmd('sample');
  say(`Leerlauf       Event-Loop ${idle.loop.mean.toFixed(2)} ms Mittel / ${idle.loop.max.toFixed(1)} ms max (Grundrauschen dieses Rechners)`);
  say('');

  await probe.cmd('loopreset');
  const base = await probe.cmd('gc');
  const wall0 = performance.now();
  let linesSent = 0, bytesSent = 0;
  let loopMax = 0;

  const samples = [];
  say(pad('Match', 7) + rpad('Zeilen', 9) + rpad('Heap MB', 10) + rpad('RSS MB', 9)
    + rpad('Handles', 9) + rpad('CPU s', 8) + rpad('Loop max ms', 13) + rpad('Platte MB', 11));
  say('─'.repeat(74));

  for (let m = 0; m < o.matches; m++) {
    const lines = buildMatch(o, m, rand);
    const t0 = performance.now();
    let i = 0;
    // Vorspann (t === -1) sofort
    let pre = '';
    while (i < lines.length && lines[i].t < 0) { pre += lines[i].s + '\r\n'; i++; }
    if (pre) { await write(feed, pre); linesSent += pre.split('\r\n').length - 1; bytesSent += pre.length; }

    while (i < lines.length) {
      const virt = (performance.now() - t0) * o.speed;
      let buf = '';
      let cnt = 0;
      while (i < lines.length && lines[i].t <= virt) { buf += lines[i].s + '\r\n'; i++; cnt++; }
      if (buf) { await write(feed, buf); linesSent += cnt; bytesSent += buf.length; }
      if (i < lines.length) {
        const waitMs = (lines[i].t - (performance.now() - t0) * o.speed) / o.speed;
        if (waitMs > 1) await sleep(Math.min(waitMs, 50));
        else await new Promise((r) => setImmediate(r));
      }
    }

    // Der Dienst rechnet das Match nach dem 0101 synchron ab — kurz warten,
    // damit die CSV-Dateien geschrieben sind, bevor gemessen wird.
    await sleep(Math.max(250, Math.min(1500, 60000 / o.speed)));
    const s = await probe.cmd('gc');
    s.match = m + 1;
    s.linesSent = linesSent;
    samples.push(s);
    loopMax = Math.max(loopMax, s.loop.max);
    // Histogramm je Match zurücksetzen, damit die Spalte zeigt, WELCHES Match
    // geruckelt hat, und nicht nur das Maximum seit dem Start.
    await probe.cmd('loopreset');

    const cpuS = (s.cpu.user + s.cpu.system) / 1e6;
    say(pad(`${m + 1}/${o.matches}`, 7) + rpad(linesSent, 9) + rpad(MB(s.heapUsed), 10)
      + rpad(MB(s.rss), 9) + rpad(s.handles, 9) + rpad(cpuS.toFixed(1), 8)
      + rpad(s.loop.max.toFixed(1), 13) + rpad(MB(s.io.bytes), 11));
  }

  const wallMs = performance.now() - wall0;
  const last = samples[samples.length - 1];
  const status = await api('/api/status').catch(() => null);

  try { feed.end(); } catch {}
  await sleep(200);

  // ---- Auswertung ----------------------------------------------------------
  // WICHTIG: bei Zeitraffer (--speed > 1) ist jede Angabe „je echter Sekunde"
  // ein STRESS-Wert. Die für den Betrieb aussagekräftigen Zahlen sind deshalb
  // auf SPIELZEIT bezogen: was ein Match kostet, geteilt durch seine Dauer.
  const cpuS = (last.cpu.user - base.cpu.user + last.cpu.system - base.cpu.system) / 1e6;
  const cpuPct = (cpuS * 1000 / wallMs) * 100;          // Stress-Wert
  const gameSeconds = o.matches * o.duration;
  const cpuPerMatch = cpuS / o.matches;
  const cpuShare = (cpuPerMatch / o.duration) * 100;    // % eines Kerns im echten Betrieb
  const ioBytes = last.io.bytes - base.io.bytes;
  const ioCalls = last.io.calls - base.io.calls;
  const stateBytes = consoles.reduce((a, c) => a + c.stateBytes, 0);
  const stateMsgs = consoles.reduce((a, c) => a + c.stateMsgs, 0);
  const eventBytes = consoles.reduce((a, c) => a + c.eventBytes, 0);
  const eventMsgs = consoles.reduce((a, c) => a + c.eventMsgs, 0);
  const perState = stateMsgs ? stateBytes / stateMsgs : 0;
  const heapFirst = samples[0].heapUsed;
  const heapLast = last.heapUsed;
  // Steigung der Heapkurve über alle Matches (kleinste Quadrate), Bytes je Match.
  const slope = linreg(samples.map((s, k) => [k, s.heapUsed]));
  const handleSlope = linreg(samples.map((s, k) => [k, s.handles]));
  const realSeconds = wallMs / 1000;

  const result = {
    options: o, wallMs, gameSeconds, linesSent, bytesSent,
    cpuSeconds: +cpuS.toFixed(2), cpuPercentUnderStress: +cpuPct.toFixed(1),
    cpuSecondsPerMatch: +cpuPerMatch.toFixed(3), cpuPercentOfOneCore: +cpuShare.toFixed(2),
    lineThroughputPerSec: +(linesSent / realSeconds).toFixed(1),
    loop: last.loop, loopMax: +loopMax.toFixed(1), loopIdle: idle.loop,
    heap: { firstMatch: heapFirst, lastMatch: heapLast, slopePerMatch: Math.round(slope), curve: samples.map((s) => s.heapUsed) },
    handles: { first: samples[0].handles, last: last.handles, slopePerMatch: +handleSlope.toFixed(3), kinds: last.handleKinds },
    rss: { first: samples[0].rss, last: last.rss },
    io: { bytes: ioBytes, calls: ioCalls, syncCalls: last.io.sync - base.io.sync, syncBytes: last.io.syncBytes - base.io.syncBytes },
    ws: { consoles: o.consoles, stateMsgs, stateBytes, bytesPerState: Math.round(perState), eventMsgs, eventBytes },
    tcpLines: status?.data?.tcp?.lines ?? null,
    samples,
  };
  if (o.json) { try { fs.writeFileSync(path.resolve(process.cwd(), o.json), JSON.stringify(result, null, 2)); say(`\nMesswerte -> ${o.json}`); } catch (e) { console.error(`bench: JSON nicht schreibbar — ${e.message}`); } }

  // ---- Bericht -------------------------------------------------------------
  const line = '═'.repeat(74);
  console.log('');
  console.log(line);
  console.log('  ERGEBNIS');
  console.log(line);
  console.log(`  Gelaufen          ${o.matches} Matches, ${(realSeconds).toFixed(0)} s echte Zeit, Zeitraffer ${o.speed}x`);
  console.log(`  TDF-Zeilen        ${linesSent} gesendet (${MB(bytesSent)} MB), ${result.lineThroughputPerSec}/s echte Zeit`);
  console.log(`  Ereignisse an WS  ${eventMsgs} (${MB(eventBytes)} MB an ${o.consoles} Konsolen)`);
  if (o.speed !== 1) console.log(`  ACHTUNG           Zeitraffer ${o.speed}x: alle „je echter Sekunde"-Werte sind Stress-Werte.`);
  console.log('');
  console.log('  ── Rechenlast ───────────────────────────────────────────────────────');
  console.log(`  CPU je Match      ${cpuPerMatch.toFixed(2)} s  =  ${cpuShare.toFixed(2)} % EINES Kerns im echten Betrieb`);
  console.log(`  CPU gesamt        ${cpuS.toFixed(1)} s über ${realSeconds.toFixed(0)} s Lauf  =  ${cpuPct.toFixed(1)} % eines Kerns unter Zeitraffer`);
  console.log(`  Event-Loop        Mittel ${last.loop.mean.toFixed(2)} ms · 99 % unter ${last.loop.p99.toFixed(1)} ms · Maximum ${loopMax.toFixed(1)} ms`);
  console.log(`                    Leerlauf dieses Rechners: ${idle.loop.mean.toFixed(2)} ms Mittel / ${idle.loop.max.toFixed(1)} ms max`);
  console.log(`                    ${loopVerdict(loopMax, idle.loop.max)}`);
  console.log('');
  console.log('  ── Speicher ─────────────────────────────────────────────────────────');
  console.log(`  Heap (nach GC)    ${MB(heapFirst)} MB nach Match 1  ->  ${MB(heapLast)} MB nach Match ${o.matches}`);
  console.log(`  Trend             ${(slope / 1024).toFixed(1)} KB je Match  ${heapVerdict(slope, o.matches)}`);
  console.log(`  RSS               ${MB(samples[0].rss)} MB -> ${MB(last.rss)} MB`);
  console.log(`  Handles           ${samples[0].handles} -> ${last.handles}  (Trend ${handleSlope.toFixed(2)} je Match)`);
  console.log('');
  console.log('  ── Ausgabe ──────────────────────────────────────────────────────────');
  console.log(`  Zustands-Pushs    ${stateMsgs} Nachrichten, ${Math.round(perState)} Bytes je Push je Konsole`);
  if (o.consoles && gameSeconds > 0) {
    console.log(`                    = ${((stateBytes + eventBytes) / gameSeconds / 1024).toFixed(0)} KB/s an ${o.consoles} Konsolen im echten Betrieb`);
  }
  console.log(`  Schreiblast       ${MB(ioBytes)} MB in ${ioCalls} Schreibvorgängen`);
  console.log(`                    = ${MB(ioBytes / o.matches)} MB je Match, ${(ioBytes / gameSeconds / 1024).toFixed(1)} KB/s im echten Betrieb`);
  console.log(`                    davon synchron (blockiert die Schleife): ${result.io.syncCalls} Aufrufe, ${MB(result.io.syncBytes)} MB`);
  console.log('');
  console.log(line);
  console.log('  EINSCHÄTZUNG');
  console.log(line);
  for (const l of verdict(result)) console.log('  ' + l);
  console.log('');

  probe.close();
  for (const c of consoles) void c;
  process.exit(0);
})().catch((err) => { console.error(`bench: ${err.stack || err.message}`); process.exit(1); });

/** Steigung einer Punktwolke (kleinste Quadrate). */
function linreg(points) {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const [x, y] of points) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const d = n * sxx - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

function loopVerdict(maxMs, idleMax) {
  const over = maxMs - (idleMax || 0);
  if (over < 40) return 'unauffällig — nichts blockiert den Rechner spürbar';
  if (over < 200) return 'erhöht — kurze Aussetzer, für eine Anzeige noch unkritisch';
  return 'ZU HOCH — der Dienst blockiert phasenweise, das stört andere Dienste';
}

function heapVerdict(slopeBytes, matches) {
  if (matches < 5) return '(zu wenige Matches für eine Aussage)';
  if (slopeBytes < 64 * 1024) return '-> stabil, kein Leck erkennbar';
  if (slopeBytes < 512 * 1024) return '-> leichter Anstieg, über Tage beobachten';
  return '-> WÄCHST, das ist ein Leck';
}

/**
 * Die Zusammenfassung, die ein Betreiber ohne Node-Kenntnisse lesen können muss:
 * hält der Server das aus, ja oder nein, und wo ist die Grenze.
 */
function verdict(r) {
  const out = [];
  const o = r.options;
  const cpu = r.cpuPercentOfOneCore;              // % eines Kerns im echten Betrieb
  const perMatchKB = r.heap.slopePerMatch / 1024;
  const perDay = 50;    // Matches je Tag: 12 h Betrieb, ein Match alle 15 min
  const enough = o.matches >= 10;

  out.push(`Betriebsfall: ${o.players} Spieler, ${o.consoles} Konsolen, ${o.rate} Ereignisse/s Spielzeit.`);
  out.push('');

  if (cpu < 15) out.push(`RECHENLAST  ${cpu.toFixed(1)} % eines Kerns während eines laufenden Matches —`);
  else if (cpu < 50) out.push(`RECHENLAST  ${cpu.toFixed(1)} % eines Kerns während eines laufenden Matches —`);
  else out.push(`RECHENLAST  ${cpu.toFixed(1)} % eines Kerns während eines laufenden Matches —`);
  out.push(cpu < 15 ? '            unbedenklich. Zwischen den Matches geht sie gegen null.'
    : cpu < 50 ? '            spürbar, aber tragbar. Zwischen den Matches geht sie gegen null.'
      : '            ZU VIEL für einen geteilten Server.');
  out.push(`            Grenze: bei rund ${Math.round(o.rate * (100 / Math.max(cpu, 0.01)))} Ereignissen/s wäre ein Kern voll —`);
  out.push(`            das entspricht etwa ${Math.round(o.players * (100 / Math.max(cpu, 0.01)))} Spielern bei gleicher Spielweise.`);
  out.push('');

  if (!enough) {
    out.push('SPEICHER    Zu wenige Matches für eine Aussage über Lecks.');
    out.push('            Für den Nachweis:  --matches 60 --duration 900 --speed 45');
  } else if (perMatchKB < 64) {
    out.push(`SPEICHER    Über ${o.matches} Matches stabil (${perMatchKB.toFixed(1)} KB Trend je Match).`);
    out.push(`            Bei ${perDay} Matches am Tag sind das ${(perMatchKB * perDay / 1024).toFixed(1)} MB am Tag — im`);
    out.push('            Rauschen. Dauerbetrieb über Tage ist damit belegt.');
  } else {
    out.push(`SPEICHER    WÄCHST um ${perMatchKB.toFixed(0)} KB je Match. Bei ${perDay} Matches am Tag`);
    out.push(`            sind das ${(perMatchKB * perDay / 1024).toFixed(0)} MB am Tag — nach wenigen Wochen ist der`);
    out.push('            Arbeitsspeicher voll. Das muss behoben werden.');
  }
  out.push('');

  const maxLoop = r.loopMax;
  const over = maxLoop - (r.loopIdle?.max || 0);
  out.push(`REAKTION    Längste Verzögerung ${maxLoop.toFixed(0)} ms (Leerlauf dieses Rechners:`);
  out.push(`            ${(r.loopIdle?.max || 0).toFixed(0)} ms, also ${over.toFixed(0)} ms durch den Dienst selbst).`);
  out.push(over < 40 ? '            Andere Programme auf demselben Rechner merken nichts davon.'
    : over < 200 ? '            Kurze Hänger, meist beim Abrechnen eines Matches. Unkritisch.'
      : '            ZU LANG — in dieser Zeit nimmt der Dienst nichts an.');
  out.push('');

  const kbs = r.io.bytes / r.gameSeconds / 1024;
  out.push(`PLATTE      ${(r.io.bytes / r.options.matches / 1048576).toFixed(1)} MB je Match, ${kbs.toFixed(1)} KB/s während eines Matches.`);
  out.push(`            Bei ${perDay} Matches am Tag rund ${(r.io.bytes / r.options.matches * perDay / 1073741824).toFixed(2)} GB am Tag.`);
  out.push(`            ${r.io.syncCalls} Schreibvorgänge waren synchron (blockieren kurz).`);
  out.push('');

  const bad = cpu >= 50 || (enough && perMatchKB >= 64) || over >= 200;
  out.push(bad
    ? 'FAZIT       So NICHT auf den Location Server. Siehe die markierten Punkte.'
    : 'FAZIT       Der Location Server hält diese Last aus.');
  return out;
}
