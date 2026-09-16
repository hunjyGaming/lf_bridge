'use strict';

/**
 * Laserforce feed inspector.
 *
 *   node scripts/inspect.js [port]        (default 9100)
 *
 * A bare TCP server that does NOT interpret anything — it just catalogs what it
 * sees. Point the Laserforce log export at this port temporarily, play one or
 * more matches, then Ctrl+C. It prints a summary and writes inspect-report.json.
 *
 * Beyond the plain line-type / event-code census it now answers the question
 * "welcher Spielmodus nutzt welche Codes?":
 *
 *   - every type-1 (mission) line is cataloged by mode number (cols[1]),
 *     with description, raw line, detected duration and its column index;
 *   - every ';' schema comment is collected per line type — those name the
 *     columns of the following line and are the only reliable way to pin down
 *     e.g. `duration` in type 1 or the 24 fields of type 7;
 *   - every type-4 code is attributed to the mission that was running at the
 *     time (the last type-1 line before it);
 *   - type-7 lines get their own section (field count + sample);
 *   - if src/gameModes.js exists it is loaded via try/catch and each seen mode
 *     number is flagged known/unknown. The file is optional — no hard dependency.
 *
 * Use it to verify docs/LASERFORCE.md against your actual hardware.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2] || '9100', 10);

// ── hard caps: this is an unauthenticated TCP feed, nothing may grow forever ──
const CAP = {
  lineTypes: 64,
  type4Codes: 1000,
  modes: 128,
  codesPerMode: 300,
  sessions: 200,
  schemaTypes: 64,
  schemaColumns: 128,
  samplesPerMode: 3,
  type7Samples: 3,
  type7FieldCounts: 32,
  unknownShapes: 50,
  descsPerMode: 8,
  lineTypesPerMode: 24,
  sampleChars: 500,
  buffer: 1 << 20, // 1 MiB without a newline => drop, do not accumulate
};

const report = {
  startedAt: new Date().toISOString(),
  port,
  lineTypes: {},    // "4" -> { count, sample }
  type4Codes: {},   // "1101" -> { count, sample, idTokens }
  schemaComments: {},   // "1" -> { count, columns, raw, assignedBy }
  orphanSchemaComments: [],
  missions: {},     // "28" -> { ...mission catalog... }
  missionSessions: [],
  codesByMode: {},  // "28" -> { "1100": { count, sample } }
  type7: { count: 0, fieldCounts: {}, samples: [], expectedFields: 24, byMode: {} },
  registry: { available: false, source: 'src/gameModes.js', error: null, modeCount: 0, shape: null },
  tabSeparated: null,
  warnings: [],
  unknownShapes: [],
  totalLines: 0,
  totalComments: 0,
};

// ───────────────────────────── helpers ─────────────────────────────

function clip(s) {
  s = String(s == null ? '' : s);
  return s.length > CAP.sampleChars ? `${s.slice(0, CAP.sampleChars)}…` : s;
}

/** printable-safe rendering for the console (tabs become visible separators) */
function show(s, max) {
  let out = String(s == null ? '' : s).replace(/\t/g, ' | ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·');
  if (max && out.length > max) out = `${out.slice(0, max)}…`;
  return out;
}

function warn(msg) {
  if (report.warnings.length < 50 && !report.warnings.includes(msg)) report.warnings.push(msg);
}

/** true when the map may take a new key */
function room(map, cap) {
  return Object.keys(map).length < cap;
}

function note(map, key, line, cap) {
  if (!map[key]) {
    if (!room(map, cap)) return null;
    map[key] = { count: 0, sample: clip(line) };
  }
  map[key].count++;
  return map[key];
}

/**
 * TDF is tab separated, but descriptions contain spaces — so a whitespace split
 * (what src/engine.js does) and a tab split can disagree. We keep both.
 */
function splitCols(line) {
  const ws = line.split(/\s+/).filter(Boolean);
  if (line.indexOf('\t') === -1) return { cols: ws, ws, tabbed: false };
  const tab = line.split('\t').map((c) => c.trim()).filter((c) => c !== '');
  return { cols: tab.length ? tab : ws, ws, tabbed: true };
}

function isNum(v) {
  return v != null && v !== '' && !isNaN(v) && isFinite(Number(v));
}

function msToClock(ms) {
  const total = Math.round(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function durationHint(value) {
  if (!isNum(value)) return '';
  const n = Number(value);
  if (n >= 10000) return `≈ ${msToClock(n)} min (als Millisekunden gelesen)`;
  if (n > 0) return `≈ ${msToClock(n * 1000)} min (falls Sekunden)`;
  return '';
}

// ────────────────────── optionale Modus-Registry ───────────────────

/**
 * src/gameModes.js is being written by someone else and its shape is not fixed.
 * Load it defensively and try a handful of plausible shapes; any failure just
 * degrades to "Registry nicht verfügbar".
 */
const registry = (() => {
  let mod;
  try {
    mod = require(path.join(__dirname, '..', 'src', 'gameModes.js'));
  } catch (err) {
    report.registry.error = err && err.code === 'MODULE_NOT_FOUND'
      ? 'nicht vorhanden'
      : `nicht ladbar: ${err && err.message}`;
    return null;
  }
  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    report.registry.error = 'unerwarteter Export';
    return null;
  }

  let table = null;   // Map: "5" -> { name, key, family }
  let shape = null;

  // ── 1. the documented API of src/gameModes.js ──
  // listModes() -> [{ number, key, label, family }]
  // resolveMode(missionType, missionDesc) -> { number, key, label, family, known, source }
  // NB: resolveMode().label echoes the TDF description, so the canonical
  //     registry name comes from listModes(); resolveMode() supplies `known`.
  if (typeof mod.listModes === 'function') {
    try {
      const list = mod.listModes();
      if (Array.isArray(list) && list.length) {
        table = new Map();
        for (const e of list) {
          if (!e || !isNum(e.number)) continue;
          table.set(String(Number(e.number)), {
            name: typeof e.label === 'string' ? e.label : `Modus ${e.number}`,
            key: typeof e.key === 'string' ? e.key : null,
            family: typeof e.family === 'string' ? e.family : null,
          });
        }
        if (table.size) shape = 'listModes()';
        else table = null;
      }
    } catch (err) {
      warn(`src/gameModes.js: listModes() warf ${err && err.message}`);
      table = null;
    }
  }

  const resolveFn = typeof mod.resolveMode === 'function' ? { n: 'resolveMode', f: mod.resolveMode } : null;

  // ── 2. tolerant fallback for other shapes ──
  const fnNames = ['getGameMode', 'getMode', 'lookupMode', 'modeFor', 'byType', 'resolve', 'get'];
  const fn = resolveFn
    || fnNames.map((n) => (typeof mod[n] === 'function' ? { n, f: mod[n] } : null)).find(Boolean)
    || null;

  if (!table) {
    const containerNames = ['REGISTRY', 'GAME_MODES', 'gameModes', 'MODES', 'modes', 'byType', 'byNumber', 'registry', 'ALL', 'default'];
    const candidates = containerNames.map((n) => (mod[n] ? { n, v: mod[n] } : null)).filter(Boolean);
    candidates.push({ n: '(module)', v: mod });
    for (const c of candidates) {
      const built = buildTable(c.v);
      if (built && built.size) { table = built; shape = `Tabelle via ${c.n}`; break; }
    }
  }

  function buildTable(v) {
    try {
      const map = new Map();
      if (v instanceof Map) {
        for (const [k, val] of v) if (isNum(k)) map.set(String(Number(k)), entryOf(val, k));
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (!item || typeof item !== 'object') continue;
          const k = [item.type, item.id, item.mode, item.number, item.code, item.modeNumber].find(isNum);
          if (k != null) map.set(String(Number(k)), entryOf(item, k));
        }
      } else if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          if (!isNum(k)) continue;
          map.set(String(Number(k)), entryOf(v[k], k));
        }
      }
      return map;
    } catch { return null; }
  }

  function entryOf(val, k) {
    if (typeof val === 'string') return { name: val, key: null, family: null };
    if (val && typeof val === 'object') {
      const n = [val.name, val.label, val.title, val.desc, val.description].find((x) => typeof x === 'string');
      return {
        name: n || `Modus ${k}`,
        key: typeof val.key === 'string' ? val.key : null,
        family: typeof val.family === 'string' ? val.family : null,
      };
    }
    return { name: `Modus ${k}`, key: null, family: null };
  }

  if (!table && !fn) {
    report.registry.error = 'geladen, aber keine erkennbare Modus-Tabelle';
    return null;
  }

  report.registry.available = true;
  report.registry.error = null;
  report.registry.modeCount = table ? table.size : 0;
  report.registry.shape = [shape, fn ? `${fn.n}()` : null].filter(Boolean).join(' + ') || 'unbekannt';
  if (table) {
    report.registry.knownModes = Object.fromEntries([...table].map(([k, v]) => [k, v.name]));
  }

  return {
    /** @param {string} num mode number  @param {string} desc mission description */
    lookup(num, desc) {
      const key = String(Number(num));
      const hit = table && table.has(key) ? table.get(key) : null;

      // resolveMode() is authoritative for known/unknown
      if (resolveFn) {
        try {
          const r = resolveFn.f.call(mod, Number(num), desc == null ? '' : String(desc));
          if (r && typeof r === 'object' && typeof r.known === 'boolean') {
            return {
              known: r.known,
              // r.label echoes the TDF description — prefer the registry's own name
              name: (hit && hit.name) || (r.known && typeof r.label === 'string' ? r.label : null),
              key: (hit && hit.key) || (typeof r.key === 'string' ? r.key : null),
              family: (hit && hit.family) || (typeof r.family === 'string' ? r.family : null),
            };
          }
        } catch { /* fall through */ }
      }

      if (hit) return { known: true, name: hit.name, key: hit.key, family: hit.family };

      if (fn && fn !== resolveFn) {
        for (const arg of [Number(num), String(num)]) {
          try {
            const r = fn.f.call(mod, arg);
            if (r && (typeof r === 'string' || typeof r === 'object')) {
              const e = entryOf(r, num);
              return { known: true, name: e.name, key: e.key, family: e.family };
            }
          } catch { /* ignore */ }
        }
      }
      return { known: false, name: null, key: null, family: null };
    },
  };
})();

// ─────────────────────────── parsing state ──────────────────────────

let currentMode = null;         // mode number of the last type-1 line
let currentSession = null;      // entry in report.missionSessions
let pendingSchema = null;       // ';' line whose type we could not read yet

const UNASSIGNED = '(vor der ersten Typ-1-Zeile)';

function modeKey() {
  return currentMode == null ? UNASSIGNED : currentMode;
}

function handleComment(raw) {
  report.totalComments++;
  // e.g.  ";1/mission	type	desc	start	duration	penalty"
  //   or  ";0/info,file-version,program-version,centre"
  const body = raw.replace(/^;+\s*/, '');
  if (!body) return;
  const parts = body.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  const cols = (parts.length > 1 ? parts : body.split(/\s+/).filter(Boolean)).slice(0, CAP.schemaColumns);
  if (!cols.length) return;

  const m = /^(\d+)\s*\/\s*(.*)$/.exec(cols[0]);
  const entry = {
    count: 1,
    raw: clip(raw),
    columns: cols.slice(),
    assignedBy: null,
    name: null,
  };

  if (m) {
    entry.name = m[2] || null;
    entry.columns = [`${m[1]}/${m[2] || ''}`].concat(cols.slice(1));
    entry.assignedBy = 'header';
    storeSchema(m[1], entry);
    pendingSchema = null;
    return;
  }
  // no "N/name" prefix — belongs to the next data line of its type
  pendingSchema = entry;
}

function storeSchema(type, entry) {
  const key = String(type);
  const prev = report.schemaComments[key];
  if (prev) { prev.count++; return; }
  if (!room(report.schemaComments, CAP.schemaTypes)) {
    if (report.orphanSchemaComments.length < CAP.schemaTypes) report.orphanSchemaComments.push(entry.raw);
    return;
  }
  report.schemaComments[key] = entry;
}

/** index of a column whose name matches `re`, or -1 */
function schemaIndex(type, re) {
  const s = report.schemaComments[String(type)];
  if (!s) return -1;
  return s.columns.findIndex((c) => re.test(String(c)));
}

function handleMission(line, parsed) {
  const { cols, ws, tabbed } = parsed;
  const mode = cols[1] != null ? String(cols[1]).slice(0, 16) : '(fehlt)';

  // description: tab layout gives it directly, otherwise strip trailing numbers
  let desc;
  if (tabbed) {
    desc = cols[2] || '';
  } else {
    const rest = ws.slice(2);
    while (rest.length > 1 && isNum(rest[rest.length - 1])) rest.pop();
    desc = rest.join(' ');
  }
  desc = clip(desc);

  // duration, two independent readings
  const heuristicIdx = ws.length - 2;
  const heuristicVal = ws[heuristicIdx];
  const schemaIdx = schemaIndex('1', /duration|dauer/i);
  const schemaVal = schemaIdx >= 0 ? cols[schemaIdx] : undefined;

  const duration = {
    value: isNum(schemaVal) ? Number(schemaVal) : (isNum(heuristicVal) ? Number(heuristicVal) : null),
    source: isNum(schemaVal) ? 'schema' : (isNum(heuristicVal) ? 'heuristik' : 'nicht erkannt'),
    columnIndex: isNum(schemaVal) ? schemaIdx : (isNum(heuristicVal) ? heuristicIdx : null),
    columnIndexBasis: isNum(schemaVal) ? 'Tabulator-Spalten (Schema-Kommentar)' : 'Leerzeichen-Tokens (wie src/engine.js)',
    schemaValue: schemaVal == null ? null : String(schemaVal),
    schemaColumnIndex: schemaIdx >= 0 ? schemaIdx : null,
    heuristicValue: heuristicVal == null ? null : String(heuristicVal),
    heuristicColumnIndex: heuristicIdx >= 0 ? heuristicIdx : null,
    agrees: schemaIdx < 0 ? null : String(schemaVal) === String(heuristicVal),
  };
  if (duration.agrees === false) {
    warn(`Typ-1: Schema-Spalte "duration" (Index ${schemaIdx}) und die Heuristik "vorletzte Spalte" liefern verschiedene Werte (${schemaVal} vs. ${heuristicVal}) — src/engine.js liest hier evtl. falsch.`);
  }

  let m = report.missions[mode];
  if (!m) {
    if (!room(report.missions, CAP.modes)) {
      currentMode = mode;
      currentSession = null;
      return;
    }
    const reg = registry ? safeLookup(mode, desc) : { known: false, name: null, key: null, family: null };
    m = report.missions[mode] = {
      mode,
      count: 0,
      descriptions: [],
      samples: [],
      duration,
      columnCount: cols.length,
      tabSeparated: tabbed,
      firstSeenAt: new Date().toISOString(),
      known: registry ? reg.known : null,
      registryName: reg.name,
      registryKey: reg.key || null,
      family: reg.family || null,
      lineTypeCounts: {},
      type7Lines: 0,
    };
  }
  m.count++;
  if (desc && m.descriptions.length < CAP.descsPerMode && !m.descriptions.includes(desc)) m.descriptions.push(desc);
  if (m.samples.length < CAP.samplesPerMode) m.samples.push(clip(line));
  if (m.duration.value == null && duration.value != null) m.duration = duration;

  currentMode = mode;
  if (report.missionSessions.length < CAP.sessions) {
    currentSession = {
      index: report.missionSessions.length,
      mode,
      description: desc,
      line: clip(line),
      seenAt: new Date().toISOString(),
      lines: 0,
      distinctCodes: 0,
    };
    report.missionSessions.push(currentSession);
  } else {
    currentSession = null;
  }
  if (!report.codesByMode[mode] && room(report.codesByMode, CAP.modes)) report.codesByMode[mode] = {};
}

function safeLookup(mode, desc) {
  try { return registry.lookup(mode, desc); } catch { return { known: false, name: null, key: null, family: null }; }
}

function countPerMode(type) {
  // a type-1 line opens the NEXT mission — never count it towards the previous one
  if (String(type) === '1') return;
  const m = report.missions[modeKey()];
  if (!m) return;
  const t = String(type);
  if (m.lineTypeCounts[t] == null) {
    if (!room(m.lineTypeCounts, CAP.lineTypesPerMode)) return;
    m.lineTypeCounts[t] = 0;
  }
  m.lineTypeCounts[t]++;
}

function handleType4(line, cols) {
  const code = cols[2] || '(none)';
  const key = String(code).slice(0, 24);

  let e = report.type4Codes[key];
  if (!e) {
    if (!room(report.type4Codes, CAP.type4Codes)) return;
    e = report.type4Codes[key] = { count: 0, sample: clip(line), cols: cols.length, idTokens: new Set() };
  }
  e.count++;
  // shape of the id tokens after the code (@hardware vs #ipl) → actor/target insight
  for (const c of cols.slice(3)) {
    if (e.idTokens.size > 8) break;
    if (c.startsWith('@')) e.idTokens.add('@');
    else if (c.startsWith('#')) e.idTokens.add('#');
  }

  // attribute the code to the mission that was running
  const mk = modeKey();
  let bucket = report.codesByMode[mk];
  if (!bucket) {
    if (!room(report.codesByMode, CAP.modes)) return;
    bucket = report.codesByMode[mk] = {};
  }
  let b = bucket[key];
  if (!b) {
    if (!room(bucket, CAP.codesPerMode)) return;
    b = bucket[key] = { count: 0, sample: clip(line) };
    if (currentSession) currentSession.distinctCodes++;
  }
  b.count++;
}

function handleType7(line, cols) {
  const t7 = report.type7;
  t7.count++;
  const n = String(cols.length);
  if (t7.fieldCounts[n] != null || room(t7.fieldCounts, CAP.type7FieldCounts)) {
    t7.fieldCounts[n] = (t7.fieldCounts[n] || 0) + 1;
  }
  if (t7.samples.length < CAP.type7Samples) {
    t7.samples.push({ mode: modeKey(), fields: cols.length, line: clip(line) });
  }
  const mk = modeKey();
  if (t7.byMode[mk] != null || room(t7.byMode, CAP.modes)) t7.byMode[mk] = (t7.byMode[mk] || 0) + 1;
  const m = report.missions[mk];
  if (m) m.type7Lines++;
}

function processLine(raw) {
  const line = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!line) return;

  if (line.startsWith(';')) { handleComment(line); return; }

  report.totalLines++;
  const parsed = splitCols(line);
  const { cols, ws, tabbed } = parsed;
  const type = cols[0];
  if (report.tabSeparated === null) report.tabSeparated = tabbed;
  else if (report.tabSeparated !== tabbed) {
    report.tabSeparated = 'gemischt';
    warn('Feed enthält Zeilen mit UND ohne Tabulatoren — Spaltenpositionen sind nicht überall gleich zu ermitteln.');
  }

  // a schema comment without "N/name" prefix belongs to this line's type
  if (pendingSchema) {
    pendingSchema.assignedBy = 'folgende Zeile';
    storeSchema(type, pendingSchema);
    pendingSchema = null;
  }

  note(report.lineTypes, String(type).slice(0, 16), line, CAP.lineTypes);
  if (!/^[0-9]$/.test(String(type))) {
    if (report.unknownShapes.length < CAP.unknownShapes) {
      report.unknownShapes.push({ type: String(type).slice(0, 16), cols: cols.length, sample: clip(line) });
    }
  }
  countPerMode(type);
  if (currentSession) currentSession.lines++;

  if (type === '1') handleMission(line, parsed);
  else if (type === '4') handleType4(line, cols);
  else if (type === '7') handleType7(line, cols);
  void ws;
}

// ─────────────────────────── TCP server ────────────────────────────

const server = net.createServer((sock) => {
  console.log(`[inspect] Laserforce connected: ${sock.remoteAddress}:${sock.remotePort}`);
  let buf = '';
  sock.on('data', (d) => {
    try {
      buf += d.toString('utf8');
      if (buf.length > CAP.buffer) {
        warn(`Eine Zeile war länger als ${CAP.buffer} Bytes und wurde verworfen.`);
        buf = buf.slice(-1024);
      }
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const raw of lines) {
        try { processLine(raw); } catch (err) { warn(`Zeile nicht verarbeitbar: ${err && err.message}`); }
      }
    } catch (err) {
      warn(`Datenblock nicht verarbeitbar: ${err && err.message}`);
    }
  });
  sock.on('error', (err) => console.log(`[inspect] socket error: ${err.message}`));
  sock.on('close', () => { console.log('[inspect] Laserforce disconnected'); dump(); });
});

// keep the report file fresh even if the process is killed hard
setInterval(() => { try { writeReport(); } catch {} }, 10000).unref();

server.on('error', (err) => { console.error(`[inspect] cannot listen on ${port}: ${err.message}`); process.exit(1); });
server.listen(port, '0.0.0.0', () => {
  console.log(`[inspect] listening on 0.0.0.0:${port}`);
  console.log('[inspect] point the Laserforce export here, play a match, then Ctrl+C\n');
});

// ──────────────────────────── reporting ────────────────────────────

function writeReport() {
  const out = {
    ...report,
    finishedAt: new Date().toISOString(),
    type4Codes: Object.fromEntries(Object.entries(report.type4Codes)
      .map(([k, v]) => [k, { count: v.count, sample: v.sample, idTokens: [...v.idTokens] }])),
    schemaCommentsSeen: Object.keys(report.schemaComments).length > 0,
  };
  const file = path.resolve(process.cwd(), 'inspect-report.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return file;
}

function modeTitle(mode) {
  const m = report.missions[mode];
  if (!m) return `Modus ${mode}`;
  const desc = m.descriptions[0] ? `„${m.descriptions[0]}"` : '(ohne Beschreibung)';
  return `Modus ${mode}  ${desc}`;
}

let lastDumpAt = -1; // report.totalLines + totalComments at the last dump

/**
 * Prints the summary. Both 'close' and Ctrl+C call this, so a disconnect
 * followed by Ctrl+C would print twice — suppressed here unless new data
 * arrived in between (Laserforce may disconnect and reconnect between
 * matches, and that second match must still be reported).
 */
function dump() {
  const fingerprint = report.totalLines + report.totalComments;
  if (fingerprint === lastDumpAt) return;
  lastDumpAt = fingerprint;
  const line = '─'.repeat(72);
  const dline = '═'.repeat(72);

  console.log(`\n${line}\nLINE TYPES  (total lines: ${report.totalLines})\n${line}`);
  for (const [t, v] of Object.entries(report.lineTypes).sort()) {
    console.log(`  type ${t.padEnd(3)}  ${String(v.count).padStart(6)}×   e.g.  ${show(v.sample, 90)}`);
  }

  console.log(`\n${line}\nTYPE-4 EVENT CODES\n${line}`);
  const rows = Object.entries(report.type4Codes).sort((a, b) => b[1].count - a[1].count);
  for (const [code, v] of rows) {
    const tt = [...v.idTokens].join(' ') || '–';
    console.log(`  ${code.padEnd(6)} ${String(v.count).padStart(6)}×   id-tokens: ${tt}`);
    console.log(`         e.g.  ${show(v.sample, 100)}`);
  }

  console.log(`\n${line}\nSCHEMA-KOMMENTARE (';'-Zeilen, ${report.totalComments} gesehen)\n${line}`);
  const schemaKeys = Object.keys(report.schemaComments).sort();
  if (!schemaKeys.length) {
    console.log('  KEINE. Die Anlage sendet keine \';\'-Schemazeilen.');
    console.log('  → Spaltennamen sind damit NICHT gesichert. Die Dauer in Typ 1 wird über');
    console.log('    die Heuristik "vorletzte Spalte" gelesen, die 24 Felder in Typ 7 lassen');
    console.log('    sich nur über die lfstats-Spezifikation zuordnen.');
  } else {
    for (const t of schemaKeys) {
      const s = report.schemaComments[t];
      console.log(`  Typ ${t}  (${s.columns.length} Spalten, ${s.count}×, zugeordnet über: ${s.assignedBy})`);
      console.log(`     ${s.columns.map((c, i) => `${i}:${c}`).join('  ')}`);
    }
    if (report.orphanSchemaComments.length) {
      console.log(`  + ${report.orphanSchemaComments.length} nicht zuordenbare Kommentarzeile(n).`);
    }
  }

  console.log(`\n${line}\nTYP-7-ZEILEN (SM5-Endstatistik)\n${line}`);
  if (!report.type7.count) {
    console.log('  Keine Typ-7-Zeile gesehen (in Laserball normal — dort gibt es keine).');
  } else {
    const fc = Object.entries(report.type7.fieldCounts)
      .map(([n, c]) => `${n} Tokens (= ${Number(n) - 1} Felder) ×${c}`).join(', ');
    console.log(`  ${report.type7.count} Zeile(n). Spaltenzahl: ${fc}`);
    console.log(`  Erwartet laut lfstats-Spezifikation: ${report.type7.expectedFields} Felder (+ Typ-Spalte = ${report.type7.expectedFields + 1} Tokens).`);
    for (const s of report.type7.samples) {
      console.log(`  Beispiel (Modus ${s.mode}, ${s.fields} Tokens):`);
      console.log(`     ${show(s.line, 160)}`);
    }
    const sIdx = Object.keys(report.schemaComments).includes('7');
    console.log(`  Feldreihenfolge über Schema-Kommentar prüfbar: ${sIdx ? 'JA (siehe Typ 7 oben)' : 'NEIN — kein ;-Schema für Typ 7 empfangen'}`);
  }

  // ───── Hauptteil: Missionen / Spielmodi, in DEUTSCH, für den Hallenbetrieb ─────
  const modeKeys = Object.keys(report.missions);
  console.log(`\n${dline}\n SPIELMODI IN DIESER AUFZEICHNUNG\n${dline}`);

  if (registry) {
    console.log(` Modus-Registry src/gameModes.js: geladen (${report.registry.shape}, ${report.registry.modeCount} Einträge).`);
  } else {
    console.log(` Modus-Registry src/gameModes.js: ${report.registry.error}.`);
    console.log(' → "bekannt/unbekannt" kann diesmal nicht geprüft werden.');
  }

  if (!modeKeys.length) {
    console.log('\n Es wurde KEINE Typ-1-Zeile empfangen — kein Spielmodus erkennbar.');
    console.log(' Der Export muss vom Missionsstart an mitlaufen (Typ 1 kommt ganz am Anfang).');
  }

  const unknownModes = [];
  for (const mode of modeKeys.sort((a, b) => (Number(a) || 0) - (Number(b) || 0))) {
    const m = report.missions[mode];
    const codes = report.codesByMode[mode] || {};
    const codeRows = Object.entries(codes).sort((a, b) => b[1].count - a[1].count);
    let flag;
    if (m.known === true) {
      flag = `BEKANNT — lf_live nennt ihn „${m.registryName || '(ohne Namen)'}"`;
      if (m.registryKey || m.family) flag += ` [key: ${m.registryKey || '–'}, Familie: ${m.family || '–'}]`;
    }
    else if (m.known === false) { flag = 'UNBEKANNT — lf_live kennt diesen Modus NICHT'; unknownModes.push(mode); }
    else flag = 'ungeprüft (keine Registry geladen)';

    console.log(`\n ${modeTitle(mode)}`);
    console.log(`   Status       : ${flag}`);
    console.log(`   Missionen    : ${m.count}×${m.descriptions.length > 1 ? `  Beschreibungen: ${m.descriptions.map((d) => `„${d}"`).join(', ')}` : ''}`);
    const d = m.duration;
    if (d && d.value != null) {
      console.log(`   Dauer        : ${d.value}  ${durationHint(d.value)}`);
      console.log(`                  Quelle: ${d.source}, Spalte ${d.columnIndex} der ${d.columnIndexBasis}`);
      if (d.agrees === false) {
        console.log(`   ACHTUNG      : Schema sagt Spalte ${d.schemaColumnIndex} = ${d.schemaValue}, Heuristik (vorletztes Token) sagt ${d.heuristicValue}.`);
      }
    } else {
      console.log('   Dauer        : nicht erkannt (keine numerische Spalte an erwarteter Stelle)');
    }
    console.log(`   Zeilentypen  : ${Object.entries(m.lineTypeCounts).sort().map(([t, c]) => `${t}:${c}`).join('  ') || '–'}`);
    console.log(`   Typ-7-Zeilen : ${m.type7Lines}${m.type7Lines ? '' : '  (keine — spricht für Laserball o. ä.)'}`);
    if (codeRows.length) {
      console.log(`   Event-Codes  : ${codeRows.length} verschiedene`);
      for (const [code, v] of codeRows) {
        console.log(`      ${code.padEnd(6)} ${String(v.count).padStart(5)}×   ${show(v.sample, 90)}`);
      }
    } else {
      console.log('   Event-Codes  : keine Typ-4-Zeilen in dieser Mission');
    }
    console.log('   Rohzeile     :');
    for (const s of m.samples) console.log(`      ${show(s, 160)}`);
  }

  const stray = report.codesByMode[UNASSIGNED];
  if (stray && Object.keys(stray).length) {
    const n = Object.keys(stray).length;
    console.log(`\n Hinweis: ${n} Event-Code(s) kamen VOR der ersten Typ-1-Zeile und konnten`);
    console.log(' keinem Modus zugeordnet werden (Aufzeichnung lief erst mitten im Spiel an).');
  }

  console.log(`\n${dline}\n WAS JETZT ZU TUN IST\n${dline}`);
  if (!registry) {
    console.log(' Ohne src/gameModes.js lässt sich nicht sagen, welche Modi lf_live kennt.');
    console.log(' Bitte den Report inspect-report.json weitergeben.');
  } else if (!unknownModes.length && modeKeys.length) {
    console.log(' Alle aufgezeichneten Spielmodi sind lf_live bereits bekannt. Nichts zu tun.');
  } else if (unknownModes.length) {
    console.log(` ${unknownModes.length} Spielmodus/-modi ist/sind lf_live UNBEKANNT.`);
    console.log(' Bitte JEWEILS die folgende Zeile melden (genau so, mit Modus-Nummer und Namen),');
    console.log(' damit der Modus in lf_live eingetragen werden kann:\n');
    for (const mode of unknownModes) {
      const m = report.missions[mode];
      console.log(`   Modus ${mode}  →  ${m.descriptions[0] || '(ohne Beschreibung)'}`);
      console.log(`   Rohzeile: ${show(m.samples[0] || '', 200)}`);
      const codes = Object.keys(report.codesByMode[mode] || {}).sort();
      console.log(`   Codes:    ${codes.join(' ') || '–'}`);
      console.log('');
    }
    console.log(' Dazu bitte inspect-report.json mitschicken — dort stehen alle Details.');
  }

  if (report.warnings.length) {
    console.log(`\n${line}\nWARNUNGEN\n${line}`);
    for (const w of report.warnings) console.log(`  ! ${w}`);
  }

  let file;
  try { file = writeReport(); } catch (err) { console.log(`\n[inspect] Report konnte nicht geschrieben werden: ${err && err.message}`); }
  if (file) console.log(`\nwritten: ${file}`);
}

process.on('SIGINT', () => { dump(); process.exit(0); });
process.on('SIGTERM', () => { dump(); process.exit(0); });
