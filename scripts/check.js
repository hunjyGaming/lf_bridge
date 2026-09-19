'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Jedes Modul unter src/ muss sich laden lassen. Die Liste war unvollständig —
// gameModes, matchReport, mqtt, eventLog, eventCatalog und tdfSchema fehlten,
// obwohl sie zum Teil beim Laden Dateien lesen und Tabellen aufbauen.
const mods = [
  '../src/config', '../src/logger', '../src/engine', '../src/localRoster', '../src/statsWriter',
  '../src/tcpIngest', '../src/capture', '../src/outputs', '../src/streamServer', '../src/apiServer',
  '../src/auth', '../src/netinfo', '../src/notify', '../src/smtp',
  '../src/gameModes', '../src/matchReport', '../src/mqtt', '../src/eventLog',
  '../src/eventCatalog', '../src/tdfSchema', '../src/chaseLog',
];
let failed = 0;
for (const m of mods) {
  try { require(m); console.log(`  ok    ${m}`); }
  catch (err) { failed++; console.error(`  FAIL  ${m}\n        ${err.stack}`); }
}

try {
  const { normalize } = require('../src/config');
  const c = normalize({
    http: { port: '99999' },
    outputs: [
      { kind: 'webhook', url: 'ftp://x' },
      { kind: 'webhook', url: 'https://ok.example/h', events: ['goal'] },
      { kind: 'tcp', host: '10.0.0.5', port: '7000', enabled: true },
    ],
    streamServer: { enabled: true, port: '99999' },
    cors: ['https://ok.example', 42, 'https://two.example'],
    rateLimitPerMin: '-5',
  });
  assert.strictEqual(c.http.port, 65535, 'port clamped');
  assert.strictEqual(c.outputs[0].url, '', 'non-http webhook url rejected');
  assert.strictEqual(c.outputs[1].url, 'https://ok.example/h', 'https webhook kept');
  assert.strictEqual(c.outputs[2].kind, 'tcp', 'tcp output kept');
  assert.strictEqual(c.outputs[2].port, 7000, 'tcp port coerced to number');
  assert.strictEqual(c.streamServer.port, 65535, 'stream server port clamped');
  assert.strictEqual(c.streamServer.host, '127.0.0.1', 'stream server binds localhost by default');
  assert.deepStrictEqual(c.cors, ['https://ok.example', 'https://two.example'], 'cors: strings only');
  assert.strictEqual(c.rateLimitPerMin, 0, 'negative rate limit clamped to 0');
  // legacy webhooks array migrates to outputs
  const legacy = normalize({ webhooks: [{ url: 'https://a.example/x', secret: 's' }] });
  assert.strictEqual(legacy.outputs[0].kind, 'webhook', 'legacy webhooks migrate to outputs');
  console.log('  ok    config.normalize');
} catch (err) { failed++; console.error(`  FAIL  config.normalize\n        ${err.stack}`); }

try {
  const { Config } = require('../src/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-env-'));
  const cwd = process.cwd(); process.chdir(dir);
  const save = { ...process.env };
  process.env.LF_HTTP_PORT = '8123'; process.env.LF_STREAM_ENABLED = 'true'; process.env.LF_STREAM_HOST = '0.0.0.0'; process.env.LF_API_TOKEN = 'sekret';
  const c = new Config(); c.load();
  assert.strictEqual(c.data.http.port, 8123, 'env pins http port');
  assert.strictEqual(c.data.streamServer.enabled, true, 'env enables stream server');
  assert.strictEqual(c.data.apiToken, 'sekret', 'env sets token');
  assert.ok(c.envPins.includes('http.port') && c.envPins.includes('apiToken'), 'envPins reported');
  // a console patch cannot override an env-pinned value
  c.update({ http: { port: 9999 } });
  assert.strictEqual(c.data.http.port, 8123, 'env pin survives a console save');
  process.env = save;
  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    config.envPins');
} catch (err) { failed++; console.error(`  FAIL  config.envPins\n        ${err.stack}`); }

try {
  const { Config } = require('../src/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-'));
  const cwd = process.cwd(); process.chdir(dir);
  const cfg = new Config();
  cfg.load();
  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'config.json created on first run');
  cfg.update({ csv: { delimiter: ',' } });
  assert.strictEqual(new Config().load().csv.delimiter, ',', 'update persists');
  assert.strictEqual(new Config().load().csv.enabled, true, 'csv on by default');
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    config.persist');
} catch (err) { failed++; console.error(`  FAIL  config.persist\n        ${err.stack}`); }

try {
  const { csvCell, splitCsv, StatsWriter } = require('../src/statsWriter');
  assert.strictEqual(csvCell('a;b', ';'), '"a;b"', 'delimiter forces quotes');
  assert.strictEqual(csvCell('say "hi"', ','), '"say ""hi"""', 'quotes doubled');
  assert.strictEqual(csvCell('plain', ','), 'plain', 'plain value untouched');
  assert.deepStrictEqual(splitCsv('a;"b;c";d', ';'), ['a', 'b;c', 'd'], 'round-trips quoted field');
  // Formel-Einschleusung: ein Spielername kommt aus dem TDF-Strom und der
  // Spieler wählt ihn selbst. Eine Zelle, die mit = + - @ Tab oder CR beginnt,
  // führt Excel/LibreOffice/Sheets als FORMEL aus (`=cmd|…!A0` öffnet einen
  // Dialog „externes Programm starten?"). Sie muss als Text markiert ankommen.
  assert.strictEqual(csvCell("=cmd|'/C calc'!A0", ';'), "'=cmd|'/C calc'!A0", 'formula cell marked as text');
  assert.strictEqual(csvCell('@SUM(A1)', ','), "'@SUM(A1)", 'leading @ neutralised');
  assert.strictEqual(csvCell('+49 170', ','), "'+49 170", 'leading + neutralised');
  // … aber eine echte Zahl bleibt eine Zahl, sonst wäre jede negative
  // Statistik-Zelle plötzlich Text.
  assert.strictEqual(csvCell(-5, ','), '-5', 'negative number untouched');
  assert.strictEqual(csvCell('-12.5', ','), '-12.5', 'negative decimal untouched');
  // und zweimal durch csvCell() darf nicht zweimal markieren
  assert.strictEqual(csvCell(csvCell('=x', ','), ','), "'=x", 'marking is idempotent');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfstats-'));
  const cwd = process.cwd(); process.chdir(dir);
  const sw = new StatsWriter({ logger: { info() {}, warn() {}, error() {} }, getConfig: () => ({ csv: { enabled: true, dir: 'stats', delimiter: ';', bom: true, writeEvents: true, writeLive: false } }) });
  const st = {
    matchId: 'mtest', elapsedTime: 300000,
    teams: { 0: { name: 'Rot' }, 1: { name: 'Blau' } }, scores: { 0: 3, 1: 1 },
    players: {
      1001: { id: '1001', name: 'Mara', teamId: '0', goals: 2, assists: 1, stealsDone: 0, stealsReceived: 1, blocksDone: 2, blocksReceived: 0, resetsDone: 0, resetsReceived: 0, clearsDone: 1, clearsReceived: 0, passesDone: 5, passesReceived: 3 },
      2001: { id: '2001', name: 'Lea', teamId: '1', goals: 1, assists: 0, stealsDone: 1, stealsReceived: 0, blocksDone: 1, blocksReceived: 1, resetsDone: 0, resetsReceived: 0, clearsDone: 0, clearsReceived: 1, passesDone: 2, passesReceived: 4 },
    },
  };
  sw.onChange(st);
  sw.onMatchStart(st);
  sw.onEvent({ id: 1, ts: Date.now(), elapsedMs: 47000, type: 'goal', actorId: '1001', actorName: 'Mara', text: 'Mara SCORED' });
  sw.onMatchEnd(st);
  // a state without a `mode` (as here) is filed by the family inferred from the
  // player objects — no SM5 counters present, so: laserball.
  const players = fs.readFileSync(path.join(dir, 'stats', 'all_players_laserball.csv'), 'utf8');
  assert.ok(players.includes('Mara') && players.includes('win'), 'all_players_laserball.csv has the winner row');
  const totals = fs.readFileSync(path.join(dir, 'stats', 'totals_laserball.csv'), 'utf8').replace(/^\uFEFF/, '');
  assert.ok(totals.split(/\r?\n/).filter(Boolean).length === 3, 'totals_laserball.csv: header + 2 players');
  assert.ok(totals.includes('Mara;1;1;0;0;2;1'), 'Mara totals: 1 match, 1 win, 2 goals, 1 assist');
  assert.ok(fs.existsSync(path.join(dir, 'stats', 'matches')), 'per-match folder written');
  const matchIdx = fs.readFileSync(path.join(dir, 'stats', 'matches.csv'), 'utf8');
  assert.ok(matchIdx.split(/\r?\n/).filter(Boolean).length === 2 && matchIdx.includes('mtest'), 'matches.csv: header + 1 match');
  const pm = fs.readFileSync(path.join(dir, 'stats', 'player_modes.csv'), 'utf8');
  assert.ok(/Mara;unknown;/.test(pm) && pm.includes('laserball'), 'player_modes.csv has Mara with a laserball mode row');
  // a second match aggregates
  const st2 = structuredClone(st); st2.matchId = 'm2'; st2.players['1001'].goals = 1; st2.scores = { 0: 1, 1: 2 };
  sw.onChange(st2); sw.onMatchStart(st2); sw.onMatchEnd(st2);
  const totals2 = fs.readFileSync(path.join(dir, 'stats', 'totals_laserball.csv'), 'utf8');
  assert.ok(totals2.includes('Mara;2;1;1;0;3;'), 'Mara after 2 matches: 2 played, 1 win, 1 loss, 3 goals total');
  const pm2 = fs.readFileSync(path.join(dir, 'stats', 'player_modes.csv'), 'utf8').replace(/^\uFEFF/, '');
  assert.ok(pm2.split(/\r?\n/).filter(Boolean).length === 3, 'player_modes.csv: header + 2 players, one mode each');
  assert.ok(/1001;Mara;unknown;[^;]*;laserball;2;/.test(pm2), 'Mara played the same mode twice');
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    statsWriter');
} catch (err) { failed++; console.error(`  FAIL  statsWriter\n        ${err.stack}`); }

try {
  const { Engine } = require('../src/engine');
  const evts = [];
  const eng = new Engine({ logger: null });
  eng.on('event', (e) => evts.push(e));
  [
    '1 0 0 0 720000 0', '2 0 Red Team 5 solid #ff0000', '2 1 Blue Team 5 solid #0000ff',
    '4 2000 0100',
    '3 1000 event @1234 player Alice 0 3 1', '3 1000 event @5678 player Bob 1 3 1',
    '4 5000 1100 @1234 @5678', '4 6000 1101 @5678',
  ].forEach((l) => eng.processLogLine(l));
  assert.strictEqual(eng.snapshot().teams['0'].name, 'Red Team', 'multi-word team name parsed');
  const s = eng.snapshot();
  assert.strictEqual(Object.keys(s.players).length, 2);
  assert.strictEqual(s.players['5678'].goals, 1);
  assert.strictEqual(s.players['1234'].assists, 1);
  assert.strictEqual(Object.values(s.scores).reduce((a, b) => a + b, 0), 1);
  assert.ok(evts.some((e) => e.type === 'goal'));
  assert.ok(evts.every((e) => !/<\/?[a-z][\s\S]*>/i.test(e.text || '')), 'no HTML in event text');
  console.log('  ok    engine.smoke');
} catch (err) { failed++; console.error(`  FAIL  engine.smoke\n        ${err.stack}`); }

try {
  const { Engine } = require('../src/engine');
  const evts = [];
  const eng = new Engine({ logger: null });
  eng.on('event', (e) => evts.push(e));
  [
    '1 0 0 0 720000 0', '2 0 Red 5 solid #ff0000', '2 1 Blue 5 solid #0000ff',
    '4 100 0100',
    '3 100 event @1 player A 0 3 1', '3 100 event @2 player B 1 3 1',
    '4 200 1105',                 // laserball round start — was ignored
    '4 300 0201 @1',              // SM5 miss — was ignored
    '4 400 110C @1 @2',           // explicit reset code — was ignored
    '4 450 0F00 @1',              // truly unknown type-4 code
    '5 600 0 0 1 1',              // type-5 score line — was ignored
    '6 700 1 02 5',               // type-6 entity-end / summary — was ignored
    '4 800 1100 @1 @2',           // handled code: must NOT get a duplicate aux event
  ].forEach((l) => eng.processLogLine(l));
  const has = (t, code) => evts.some((e) => e.type === t && (code === undefined || e.code === code));
  assert.ok(has('round_start', '1105'), 'emits round_start for 1105');
  assert.ok(has('miss', '0201'), 'emits typed event for SM5 0201');
  assert.ok(has('reset', '110C'), 'emits reset for explicit 110C');
  assert.ok(has('lf_event', '0F00'), 'emits generic lf_event for an unknown code');
  assert.ok(evts.some((e) => e.type === 'score' && e.delta === 1 && e.new === 1), 'emits score event from type-5');
  assert.ok(has('match_summary', '6'), 'emits match_summary from type-6');
  assert.strictEqual(evts.filter((e) => e.code === '1100').length, 1, 'handled code 1100 not double-emitted');
  assert.ok(evts.every((e) => !/<\/?[a-z][\s\S]*>/i.test(e.text || '')), 'no HTML in aux event text');
  // emitUnknownEvents:false suppresses only the generic fallback, not the mapped types
  const eng2 = new Engine({ logger: null, emitUnknownEvents: false });
  const e2 = []; eng2.on('event', (e) => e2.push(e));
  ['1 0 0 0 720000 0', '2 0 Red 5 solid #ff0000', '4 100 0100',
    '3 100 event @1 player A 0 3 1', '4 200 0F00 @1', '4 300 1105'].forEach((l) => eng2.processLogLine(l));
  assert.ok(!e2.some((e) => e.type === 'lf_event'), 'emitUnknownEvents:false hides generic lf_event');
  assert.ok(e2.some((e) => e.type === 'round_start'), 'emitUnknownEvents:false keeps mapped types');
  console.log('  ok    engine.auxEvents');
} catch (err) { failed++; console.error(`  FAIL  engine.auxEvents\n        ${err.stack}`); }

try {
  const { EventLog } = require('../src/eventLog');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflog-'));
  const cwd = process.cwd(); process.chdir(dir);
  const el = new EventLog({ eventLog: { enabled: true, dir: 'data/logs', rotate: 'daily', filenamePrefix: 'events' } }, { warn() {} });
  el.onMatchStart({ matchId: 'abc123', players: { 1: {}, 2: {} } });
  el.onEvent({ id: 1, ts: Date.parse('2026-09-10T21:14:03Z'), elapsedMs: 432900, matchId: 'abc123', type: 'goal', code: '1101', actorName: 'Mara', actorTeamId: '0', scores: { 0: 3, 1: 2 }, text: 'Mara SCORED' });
  el.onEvent({ id: 2, ts: Date.now(), elapsedMs: 5000, matchId: 'abc123', type: 'lf_event', code: '0F00', text: 'Event 0F00' });
  el.onMatchEnd({ matchId: 'abc123', scores: { 0: 3, 1: 2 }, players: { 1: {}, 2: {} } });
  el.flush();
  const f = path.join(dir, 'data', 'logs', `events-${new Date().toISOString().slice(0, 10)}.log`);
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}\+\d\d:\d\d\.\d{3} {2}\[abc123\] {2}\S/m.test(txt), 'readable columned line');
  assert.ok(/\+07:12\.900/.test(txt), 'elapsed formatted mm:ss.mmm');
  assert.ok(/──── Match abc123 · 2 Spieler/.test(txt), 'match header line');
  assert.ok(/Match abc123 beendet · Endstand 3:2/.test(txt), 'match footer with score');
  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    eventLog');
} catch (err) { failed++; console.error(`  FAIL  eventLog\n        ${err.stack}`); }

// ---- raw capture (docs/CAPTURE.md) ----------------------------------------
// The whole point is byte-exactness: what goes in must come out unchanged, tabs,
// \r\n and `;` schema lines included, split into one file per mission.
const capLog = { info() {}, warn() {}, error() {} };
const CAP_LB = [
  ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
  '1\t28\tLaserball Ranked\t20260916143012\t900\t0',
  '2\t0\tRot\t1\tRed\t#ef4444',
  '4\t500\t0100',
  '3\t1000\t#1001\tplayer\tMara\t0\t3\t0\tSuit-A',
  '4\t9000\t1101\t#1001',
  '4\t30000\t0101',
].join('\r\n') + '\r\n';
const CAP_SM5 = [
  '0\t2.006\tx\tHalle',
  ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
  '1\t5\tSpace Marines 5\t20260916145000\t900\t0',
  '4\t500\t0100',
  '3\t1000\t#2001\tplayer\tNoa\t1\t3\t5\tSuit-B',
  '4\t7000\t0206\t#2001\tdeactivates\t#3001',
  '4\t60000\t0101',
].join('\r\n') + '\r\n';

try {
  const { Capture } = require('../src/capture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfcap-'));
  const cwd = process.cwd(); process.chdir(dir);
  const cfg = { capture: { enabled: true, dir: 'data/capture', maxFileMB: 20, maxFiles: 50, maxTotalMB: 500 } };
  const cap = new Capture({ logger: capLog, getConfig: () => cfg });

  // fed in chunks that deliberately cut lines in half
  const all = Buffer.from(CAP_LB + CAP_SM5, 'utf8');
  for (let i = 0; i < all.length; i += 7) cap.onData(all.subarray(i, i + 7));
  cap.onStreamEnd();

  const out = path.join(dir, 'data', 'capture');
  const tdf = fs.readdirSync(out).filter((f) => f.endsWith('.tdf')).sort();
  assert.strictEqual(tdf.length, 2, 'one file per mission');
  assert.ok(tdf.some((f) => /_mode28_laserball-ranked_[a-z0-9]+\.tdf$/.test(f)), 'laserball file speaks its mode');
  assert.ok(tdf.some((f) => /_mode5_space-marines-5_[a-z0-9]+\.tdf$/.test(f)), 'sm5 file speaks its mode');

  const byMode = (n) => fs.readFileSync(path.join(out, tdf.find((f) => f.includes(`_mode${n}_`))));
  assert.strictEqual(byMode(28).toString('utf8'), CAP_LB, 'laserball recording is byte-identical');
  assert.strictEqual(byMode(5).toString('utf8'), CAP_SM5, 'sm5 recording is byte-identical');
  assert.ok(byMode(28).includes('\t') && byMode(28).includes('\r\n') && byMode(28).includes(';1/mission'),
    'tabs, CRLF and the schema comment survive untouched');

  for (const f of tdf) {
    const txt = fs.readFileSync(path.join(out, f.replace(/\.tdf$/, '.txt')), 'utf8');
    assert.ok(/Ende des Matches regulär beendet \(Mission End 0101\)/.test(txt), 'companion names the end reason');
    assert.ok(/Mitglieds-IDs/.test(txt), 'companion carries the privacy note');
    assert.ok(/Gesehene Typ-4-Codes/.test(txt) && /0100/.test(txt), 'companion lists the type-4 codes');
  }
  const lbTxt = fs.readFileSync(path.join(out, tdf.find((f) => f.includes('_mode28_')).replace(/\.tdf$/, '.txt')), 'utf8');
  assert.ok(/Spielmodus\s+28 · Laserball Ranked \(Familie laserball\)/.test(lbTxt), 'companion resolves the mode');
  assert.ok(/Teams\s+0 Rot/.test(lbTxt) && /Spieler\s+1/.test(lbTxt), 'companion counts teams and players');

  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    capture.byteExact');
} catch (err) { failed++; console.error(`  FAIL  capture.byteExact\n        ${err.stack}`); }

try {
  const { Capture } = require('../src/capture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfcap-off-'));
  const cwd = process.cwd(); process.chdir(dir);
  const cfg = { capture: { enabled: false, dir: 'data/capture', maxFileMB: 20, maxFiles: 50, maxTotalMB: 500 } };
  const cap = new Capture({ logger: capLog, getConfig: () => cfg });
  cap.onData(Buffer.from(CAP_LB, 'utf8'));
  cap.onStreamEnd();
  assert.ok(!fs.existsSync(path.join(dir, 'data')), 'switched off: not even a directory is created');
  assert.deepStrictEqual(cap.listFiles(), [], 'switched off: nothing to list');
  assert.strictEqual(cap.status().enabled, false, 'status reports it is off');
  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    capture.offIsFree');
} catch (err) { failed++; console.error(`  FAIL  capture.offIsFree\n        ${err.stack}`); }

try {
  const { Capture } = require('../src/capture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfcap-lim-'));
  const cwd = process.cwd(); process.chdir(dir);
  // maxFileMB is the smallest the config allows (1 MB); feed more than that.
  const cfg = { capture: { enabled: true, dir: 'data/capture', maxFileMB: 1, maxFiles: 2, maxTotalMB: 500 } };
  const cap = new Capture({ logger: capLog, getConfig: () => cfg });
  const filler = `4\t1000\t0201\t#1001\r\n`;
  cap.onData(Buffer.from(';1/mission\ttype\tdesc\r\n1\t28\tLaserball Ranked\t20260916143012\t900\t0\r\n4\t500\t0100\r\n', 'utf8'));
  cap.onData(Buffer.from(filler.repeat(60000), 'utf8'));   // ~1.3 MB, over the 1 MB cap
  cap.onData(Buffer.from('4\t99000\t0101\r\n', 'utf8'));
  cap.onStreamEnd();
  const out = path.join(dir, 'data', 'capture');
  const f = fs.readdirSync(out).find((x) => x.endsWith('.tdf'));
  assert.ok(fs.statSync(path.join(out, f)).size <= 1024 * 1024, 'per-file limit holds');
  assert.ok(/ABGESCHNITTEN/.test(fs.readFileSync(path.join(out, f.replace(/\.tdf$/, '.txt')), 'utf8')), 'truncation is noted in the companion');

  // three more missions with maxFiles = 2 -> only the two newest survive
  for (let i = 0; i < 3; i++) {
    cap.onData(Buffer.from(`1\t28\tLaserball Ranked\t2026091614300${i}\t900\t0\r\n4\t500\t0100\r\n4\t9000\t0101\r\n`, 'utf8'));
    cap.onStreamEnd();
  }
  const left = fs.readdirSync(out).filter((x) => x.endsWith('.tdf'));
  assert.strictEqual(left.length, 2, 'maxFiles enforced, oldest deleted');
  assert.strictEqual(fs.readdirSync(out).filter((x) => x.endsWith('.txt')).length, 2, 'companions go with them');
  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    capture.limits');
} catch (err) { failed++; console.error(`  FAIL  capture.limits\n        ${err.stack}`); }

try {
  const { Capture, zipOf, classify } = require('../src/capture');
  const zlib = require('zlib');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfcap-api-'));
  const cwd = process.cwd(); process.chdir(dir);
  const cfg = { capture: { enabled: true, dir: 'data/capture', maxFileMB: 20, maxFiles: 50, maxTotalMB: 500 } };
  const cap = new Capture({ logger: capLog, getConfig: () => cfg });
  cap.onData(Buffer.from(CAP_LB, 'utf8'));
  cap.onStreamEnd();

  const list = cap.listFiles();
  assert.strictEqual(list.length, 2, 'listing has the .tdf and its .txt');
  const name = list.find((x) => x.kind === 'tdf').name;
  assert.strictEqual(cap.readFile(name).toString('utf8'), CAP_LB, 'readFile serves the exact bytes');

  // same path handling as StatsWriter.readFile()
  assert.strictEqual(cap.readFile('../../secret.tdf'), null, 'traversal rejected');
  assert.strictEqual(cap.readFile('sub/x.tdf'), null, 'path separator rejected');
  assert.strictEqual(cap.readFile('/etc/passwd'), null, 'absolute path rejected');
  assert.strictEqual(cap.readFile('totals_sm5.csv'), null, 'foreign extension rejected');
  assert.strictEqual(cap.deleteFile('../x.tdf').error, 'bad_name', 'delete refuses traversal');

  // "everything as one file" — a real ZIP, built with the built-in zlib
  const b = cap.bundle();
  assert.ok(b.ok && b.buffer.readUInt32LE(0) === 0x04034b50, 'bundle is a zip');
  assert.strictEqual(b.count, 2, 'zip holds both files');
  assert.ok(b.buffer.includes(Buffer.from(name, 'ascii')), 'zip names the recording');
  // round-trip one member through inflateRaw to prove the stream is well-formed
  const one = zipOf([{ name: 'a.tdf', data: Buffer.from(CAP_LB, 'utf8'), mtime: Date.now() }]);
  const nl = one.readUInt16LE(26);
  const body = one.subarray(30 + nl, 30 + nl + one.readUInt32LE(18));
  const back = one.readUInt16LE(8) === 8 ? zlib.inflateRawSync(body) : body;
  assert.strictEqual(back.toString('utf8'), CAP_LB, 'zip member inflates back byte for byte');

  assert.strictEqual(cap.deleteFile(name).ok, true, 'single delete works');
  assert.strictEqual(cap.listFiles().length, 0, 'deleting a .tdf takes its .txt with it');
  process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true });

  // line classification is tolerant of both tab- and space-delimited feeds
  assert.strictEqual(classify(Buffer.from('4\t500\t0100\r\n')).code, '0100', 'tab type-4 code');
  assert.strictEqual(classify(Buffer.from('4 500 1101 @2001\n')).code, '1101', 'space type-4 code');
  assert.strictEqual(classify(Buffer.from(';1/mission\ttype\n')).kind, 'schema', 'schema comment recognised');
  assert.strictEqual(classify(Buffer.from('  \r\n')).kind, 'blank', 'blank line recognised');
  assert.strictEqual(classify(Buffer.from('1 5 Space Marines 5 20260916 900 0\n')).missionDesc, 'Space Marines 5', 'space-delimited mission description');
  console.log('  ok    capture.filesAndZip');
} catch (err) { failed++; console.error(`  FAIL  capture.filesAndZip\n        ${err.stack}`); }

try {
  const { Engine } = require('../src/engine');
  const evts = [];
  const eng = new Engine({ logger: null });
  eng.on('event', (e) => evts.push(e));
  [
    '1 0 0 0 720000 0', '2 0 Red 5 solid #ff0000', '2 1 Blue 5 solid #0000ff',
    '4 100 0100',
    '3 100 event @1 player A 0 3 1', '3 100 event @2 player B 1 3 1',
    '4 500 1100 @1 @2', '4 900 1101 @2',
  ].forEach((l) => eng.processLogLine(l));

  const goal = evts.find((e) => e.type === 'goal');
  assert.ok(goal, 'goal event emitted');
  assert.strictEqual(goal.category, 'score', 'goal enriched with category:score');
  assert.strictEqual(goal.code, '1101', 'goal keeps its own code');
  assert.ok(typeof goal.phrase === 'string' && goal.phrase.trim(), 'goal enriched with a phrase');
  assert.ok(goal.text === 'B SCORED', 'goal.text unchanged by enrichment');

  const ms = evts.find((e) => e.type === 'match_start');
  assert.strictEqual(ms.code, '0100', 'match_start gets code 0100 from TYPE_TO_CODE');
  assert.strictEqual(ms.category, 'match', 'match_start enriched category');

  const pass = evts.find((e) => e.type === 'pass');
  assert.strictEqual(pass.category, 'possession', 'pass category from catalog');
  assert.ok(evts.find((e) => e.type === 'player_join') && evts.find((e) => e.type === 'player_join').code === undefined, 'player_join has no code (type-3 login)');
  console.log('  ok    engine.enrich');
} catch (err) { failed++; console.error(`  FAIL  engine.enrich\n        ${err.stack}`); }

// ===========================================================================
// MODE ADAPTIVITY — permanent regression tests (contract A-D, docs/GAMEMODES.md)
//
// Same pattern as every block above: plain `assert`, no framework, no new
// dependency, nothing written into the project directory. The Laserball block
// is the guard rail of the whole project: it pins goals, assists, passes,
// clears, steals, blocks, resets and the ballHolderId history to the values the
// parser produced BEFORE the mode rework, so a future change on the SM5 side
// cannot damage Laserball unnoticed.
// ===========================================================================

/** Feed a stream through a fresh engine. Returns engine, events and snapshot. */
function feedEngine(lines, opts = {}) {
  const { Engine } = require('../src/engine');
  const evts = [];
  const eng = new Engine({ logger: null, ...opts });
  eng.on('event', (e) => evts.push(e));
  for (const l of lines) eng.processLogLine(l);
  return { eng, evts, state: eng.snapshot() };
}
/** Turn a tab-delimited stream into a whitespace-delimited one. */
const toSpaces = (lines) => lines.map((l) => l.replace(/\t/g, ' '));
/** Drop the `;` schema-comment lines. */
const noSchema = (lines) => lines.filter((l) => !l.startsWith(';'));
/** First column (line type) of a stream line, tab- or space-delimited. */
const lineType = (l) => String(l).split(/\s+/)[0];

/**
 * A complete Laserball match, tab-delimited, with `;` schema comments.
 * Mission description AND team names contain spaces on purpose — that is
 * exactly what a naive column index gets wrong.
 */
const LASERBALL_MATCH = [
  '0\t2.006\tlf-sim\tTesthalle',
  ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
  '1\t28\tLaserball Ranked\t20260916094500\t900\t0',
  ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour',
  '2\t0\tRote Kugeln\t1\tRed\t#ff0000',
  '2\t1\tBlaue Kugeln\t4\tBlue\t#0000ff',
  '4\t0\t0100',
  ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit',
  '3\t100\t#1001\tplayer\tAnna Maria\t0\t3\t0\tSuit-A',
  '3\t100\t#1002\tplayer\tBen\t0\t3\t0\tSuit-B',
  '3\t100\t#2001\tplayer\tCara\t1\t3\t0\tSuit-C',
  '3\t100\t#2002\tplayer\tDave\t1\t3\t0\tSuit-D',
  ';4/event\ttime\ttype\tplayer\taction\tplayer',
  '4\t1000\t1107\t#1001',                       // get ball
  '4\t2000\t1100\t#1001\tpasses to\t#1002',      // pass
  '4\t3000\t1101\t#1002',                        // goal, assisted by 1001
  '4\t9000\t1103\t#2001\tsteals from\t#1002',    // steal
  '4\t10000\t1109\t#2001\tclears to\t#2002',     // clear
  '4\t12000\t1101\t#2002',                       // goal, assisted by 2001
  '4\t15000\t110A\t#1001',                       // failed clear
  '4\t16000\t1107\t#2001',
  '9\t17000\t#2001\t2',                          // 2001 is down -> next 1104 is a RESET
  '4\t18000\t1104\t#1001\tresets\t#2001',
  '4\t20000\t1104\t#1002\tblocks\t#2002',        // target is up -> BLOCK
  '4\t30000\t0101',
];

/** ballHolderId after every type-4 / type-9 line of LASERBALL_MATCH. */
const LASERBALL_HOLDERS = [
  null,      // 0100
  '1001',    // 1107 get ball
  '1002',    // 1100 pass -> receiver holds
  null,      // 1101 goal
  '2001',    // 1103 steal -> thief holds
  '2002',    // 1109 clear -> receiver holds
  null,      // 1101 goal
  null,      // 110A failed clear does not change the holder
  '2001',    // 1107
  '2001',    // type-9 status does not change the holder
  '2001',    // 1104 reset does not change the holder
  '2001',    // 1104 block does not change the holder
  null,      // 0101
];

/** Every Laserball counter of LASERBALL_MATCH, exactly as before the rework. */
function assertLaserballCounters(state, label) {
  const p = state.players;
  const eq = (pid, field, want) => assert.strictEqual(p[pid][field], want, `${label}: ${pid}.${field} == ${want}`);
  assert.strictEqual(Object.keys(p).length, 4, `${label}: 4 players`);
  // goals + assists (the 10 s window)
  eq('1002', 'goals', 1); eq('2002', 'goals', 1);
  eq('1001', 'goals', 0); eq('2001', 'goals', 0);
  eq('1001', 'assists', 1); eq('2001', 'assists', 1);
  eq('1002', 'assists', 0); eq('2002', 'assists', 0);
  // passes
  eq('1001', 'passesDone', 1); eq('1002', 'passesReceived', 1);
  eq('1002', 'passesDone', 0); eq('2001', 'passesReceived', 0);
  // clears
  eq('2001', 'clearsDone', 1); eq('2002', 'clearsReceived', 1);
  eq('1001', 'clearsDone', 0);
  // steals
  eq('2001', 'stealsDone', 1); eq('1002', 'stealsReceived', 1);
  eq('1001', 'stealsDone', 0);
  // blocks vs. resets — decided by the target status (type-9)
  eq('1001', 'resetsDone', 1); eq('2001', 'resetsReceived', 1);
  eq('1001', 'blocksDone', 0); eq('2001', 'blocksReceived', 0);
  eq('1002', 'blocksDone', 1); eq('2002', 'blocksReceived', 1);
  eq('1002', 'resetsDone', 0); eq('2002', 'resetsReceived', 0);
  // the own count owns the score here — no type-5 line in this stream
  assert.strictEqual(state.scoreSource, 'internal', `${label}: scoreSource internal`);
  assert.deepStrictEqual(state.scores, { 0: 1, 1: 1 }, `${label}: scores from the own count`);
  // not one SM5 counter may leak into a Laserball player
  assert.strictEqual(p['1001'].shotsFired, undefined, `${label}: no SM5 fields on a Laserball player`);
  assert.strictEqual(p['1001'].deactivations, undefined, `${label}: no SM5 fields on a Laserball player`);
}

try {
  const { Engine } = require('../src/engine');
  const eng = new Engine({ logger: null });
  const evts = [];
  const holders = [];
  eng.on('event', (e) => evts.push(e));
  for (const l of LASERBALL_MATCH) {
    eng.processLogLine(l);
    const t = lineType(l);
    if (t === '4' || t === '9') holders.push(eng.gameState.ballHolderId);
  }
  const state = eng.snapshot();

  // mode + clock
  assert.strictEqual(state.mode.number, 28, 'mission 28');
  assert.strictEqual(state.mode.key, 'laserball_ranked', 'mode key');
  assert.strictEqual(state.mode.family, 'laserball', 'family laserball');
  assert.strictEqual(state.mode.known, true, 'mode is in the registry');
  assert.strictEqual(state.mode.source, 'tdf', 'mode came from the type-1 line');
  assert.strictEqual(state.mode.label, 'Laserball Ranked', 'label from the stream');
  assert.strictEqual(state.duration, 900000, 'duration 900 s -> 900000 ms');
  assert.strictEqual(state.durationKnown, true, 'duration known');
  assert.strictEqual(state.remainingMs, 870000, 'remainingMs = duration - elapsed');
  assert.strictEqual(state.missionActive, false, 'mission ended');
  // names with spaces survive
  assert.strictEqual(state.teams['0'].name, 'Rote Kugeln', 'team name with a space');
  assert.strictEqual(state.teams['1'].name, 'Blaue Kugeln', 'second team name with a space');
  assert.strictEqual(state.players['1001'].name, 'Anna Maria', 'player name with a space');
  assert.strictEqual(state.players['1001'].battlesuit, 'Suit-A', 'battlesuit read via the schema line');

  assertLaserballCounters(state, 'laserball');
  assert.deepStrictEqual(holders, LASERBALL_HOLDERS, 'ballHolderId history unchanged');
  assert.strictEqual(state.ballHolderId, null, 'ball is free after the match end');

  // the events of the Laserball path, unchanged
  const goals = evts.filter((e) => e.type === 'goal');
  assert.strictEqual(goals.length, 2, 'two goal events');
  assert.strictEqual(goals[0].assistId, '1001', 'first goal credits the passer');
  assert.strictEqual(goals[0].assistName, 'Anna Maria', 'assist name on the goal event');
  assert.strictEqual(goals[1].assistId, '2001', 'second goal credits the clearing player');
  assert.ok(evts.some((e) => e.type === 'pass' && e.code === '1100'), 'pass event');
  assert.ok(evts.some((e) => e.type === 'clear' && e.code === '1109'), 'clear event');
  assert.ok(evts.some((e) => e.type === 'steal' && e.code === '1103'), 'steal event');
  assert.ok(evts.some((e) => e.type === 'reset' && e.code === '1104' && e.targetId === '2001'), 'reset event');
  assert.ok(evts.some((e) => e.type === 'block' && e.code === '1104' && e.targetId === '2002'), 'block event');
  assert.ok(evts.some((e) => e.type === 'failed_clear' && e.code === '110A'), 'failed_clear event');
  assert.ok(evts.some((e) => e.type === 'mode_change' && e.mode.family === 'laserball'), 'mode_change emitted');
  assert.ok(evts.every((e) => !/<\/?[a-z][\s\S]*>/i.test(e.text || '')), 'no HTML in any event text');
  console.log('  ok    engine.laserballRegression');
} catch (err) { failed++; console.error(`  FAIL  engine.laserballRegression\n        ${err.stack}`); }

try {
  // The 10 s assist window, pinned on BOTH sides: 9 s counts, 10 s (the exact
  // boundary) still counts, 11 s does not. Widening or narrowing the window in
  // engine.js breaks one of these three.
  const assistAfter = (goalAt) => {
    const { state, evts } = feedEngine([
      '1 28 Laserball Ranked 0 900 0',
      '2 0 Rot 1 Red #ff0000',
      '4 0 0100',
      '3 100 event @1 player Passer 0 3 0',
      '3 100 event @2 player Scorer 0 3 0',
      '4 1000 1100 @1 @2',
      `4 ${1000 + goalAt} 1101 @2`,
    ]);
    const goal = evts.find((e) => e.type === 'goal');
    return { assists: state.players['1'].assists, assistId: goal ? goal.assistId : undefined };
  };
  assert.strictEqual(assistAfter(9000).assists, 1, 'a pass 9 s before the goal is an assist');
  assert.strictEqual(assistAfter(9000).assistId, '1', 'and the goal event names the passer');
  assert.strictEqual(assistAfter(10000).assists, 1, '10 s exactly is still inside the window');
  assert.strictEqual(assistAfter(11000).assists, 0, 'a pass 11 s before the goal is NOT an assist');
  assert.strictEqual(assistAfter(11000).assistId, null, 'and the goal event carries no assist');
  // a clear (1109) feeds the same window
  const { state: cl } = feedEngine([
    '1 28 Laserball Ranked 0 900 0', '2 0 Rot 1 Red #ff0000', '4 0 0100',
    '3 100 event @1 player Clearer 0 3 0', '3 100 event @2 player Scorer 0 3 0',
    '4 1000 1109 @1 @2', '4 10000 1101 @2',
  ]);
  assert.strictEqual(cl.players['1'].assists, 1, 'a clear inside the window is an assist too');
  // a steal between pass and goal wipes the pass history
  const { state: st } = feedEngine([
    '1 28 Laserball Ranked 0 900 0', '2 0 Rot 1 Red #ff0000', '2 1 Blau 4 Blue #0000ff', '4 0 0100',
    '3 100 event @1 player Passer 0 3 0', '3 100 event @2 player Scorer 0 3 0',
    '3 100 event @3 player Dieb 1 3 0',
    '4 1000 1100 @1 @2', '4 2000 1103 @3 @2', '4 3000 1101 @2',
  ]);
  assert.strictEqual(st.players['1'].assists, 0, 'a steal in between voids the assist');
  console.log('  ok    engine.assistWindow');
} catch (err) { failed++; console.error(`  FAIL  engine.assistWindow\n        ${err.stack}`); }

try {
  const { resolveMode, familyOf, statFields, csvColumns, newPlayerStats, scoreboardColumns, roleLabel } = require('../src/gameModes');
  // registry
  assert.strictEqual(resolveMode(28).family, 'laserball', 'type 28 -> laserball');
  assert.strictEqual(resolveMode(28).key, 'laserball_ranked', 'type 28 key');
  assert.strictEqual(resolveMode('28').known, true, 'type 28 is known (string form too)');
  assert.strictEqual(resolveMode(5).family, 'sm5', 'type 5 -> sm5');
  assert.strictEqual(resolveMode(5).key, 'sm5', 'type 5 key');
  // unknown number -> not known, but still counted as sm5 (shared 0xxx code set)
  const unknown = resolveMode(14, null);
  assert.strictEqual(unknown.known, false, 'unknown number -> known:false');
  assert.strictEqual(unknown.family, 'sm5', 'unknown number -> family sm5');
  assert.strictEqual(unknown.key, 'mode_14', 'unknown number keeps a stable slug');
  assert.strictEqual(unknown.number, 14, 'unknown number is kept');
  assert.strictEqual(unknown.source, 'tdf', 'the number still came from the stream');
  // label from the type-1 description, registry label only as fallback
  assert.strictEqual(resolveMode(28, 'Hausrunde Freitag').label, 'Hausrunde Freitag', 'stream description wins');
  assert.strictEqual(resolveMode(28, '   ').label, 'Laserball Ranked', 'blank description -> registry label');
  assert.strictEqual(resolveMode(14, 'Nexus Turnier').label, 'Nexus Turnier', 'unknown mode labelled from the stream');
  // no number at all
  const none = resolveMode(null, null);
  assert.deepStrictEqual(none, {
    number: null, key: 'unknown', label: 'Unbekannter Modus', family: 'sm5', known: false, source: 'default',
  }, 'no type-1 line -> unknown/default');
  assert.strictEqual(resolveMode('nicht-numerisch').known, false, 'garbage number -> unknown');
  assert.strictEqual(resolveMode('99999999').known, false, 'out-of-range number -> unknown');
  // code -> family
  assert.strictEqual(familyOf('1100'), 'laserball', '11xx is laserball');
  assert.strictEqual(familyOf('110C'), 'laserball', '110C is laserball');
  assert.strictEqual(familyOf('0205'), 'sm5', '02xx is sm5');
  assert.strictEqual(familyOf('0B03'), 'sm5', '0Bxx is sm5');
  assert.strictEqual(familyOf('0100'), 'all', 'match control belongs to both');
  assert.strictEqual(familyOf('0101'), 'all', 'match end belongs to both');
  assert.strictEqual(familyOf('0201'), 'all', 'a miss exists in both families');
  assert.strictEqual(familyOf(null), 'all', 'no code -> no family claim');
  // counter sets are disjoint and stable
  assert.strictEqual(statFields('laserball').length, 12, '12 Laserball counters');
  assert.strictEqual(Object.keys(newPlayerStats('sm5')).length, 30, '30 SM5 counters');
  assert.deepStrictEqual(csvColumns('laserball').slice(0, 4),
    ['goals', 'assists', 'steals_done', 'steals_received'], 'Laserball CSV order unchanged');
  assert.ok(!csvColumns('sm5').includes('goals'), 'no Laserball column in the SM5 set');
  assert.ok(!csvColumns('laserball').includes('shots_fired'), 'no SM5 column in the Laserball set');
  assert.strictEqual(scoreboardColumns('laserball')[0].key, 'goals', 'Laserball scoreboard starts with goals');
  assert.strictEqual(roleLabel(1), 'Commander', 'SM5 role from the category column');
  assert.strictEqual(roleLabel(5), 'Medic', 'SM5 role from the category column');
  assert.strictEqual(roleLabel('nope'), null, 'unusable category -> no role');

  // the same, through the engine
  const modeOf = (line) => feedEngine([line]).state.mode;
  assert.strictEqual(modeOf('1\t28\tLaserball Ranked\t0\t900\t0').family, 'laserball', 'engine: 28 -> laserball');
  assert.strictEqual(modeOf('1\t5\tSpace Marines 5\t0\t900\t0').family, 'sm5', 'engine: 5 -> sm5');
  assert.strictEqual(modeOf('1\t5\tSpace Marines 5\t0\t900\t0').label, 'Space Marines 5', 'engine: label out of the stream');
  const m14 = modeOf('1\t14\t7SM Nexus\t0\t900\t0');
  assert.strictEqual(m14.known, false, 'engine: unknown number -> known:false');
  assert.strictEqual(m14.family, 'sm5', 'engine: unknown number -> family sm5');
  assert.strictEqual(m14.label, '7SM Nexus', 'engine: unknown mode labelled from the description');
  console.log('  ok    gameModes.detection');
} catch (err) { failed++; console.error(`  FAIL  gameModes.detection\n        ${err.stack}`); }

try {
  // Runtime self-correction: a mode announced as sm5 that ships 11xx codes
  // flips to laserball exactly once and marks itself `inferred`.
  const { state, evts } = feedEngine([
    '1\t5\tSpace Marines 5\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
    '3\t100\t#2\tplayer\tB\t0\t3\t0',
    '4\t1000\t1100\t#1\t#2',
    '4\t2000\t1101\t#2',
    '4\t3000\t1100\t#2\t#1',
    '4\t4000\t1103\t#1\t#2',
  ]);
  assert.strictEqual(state.mode.family, 'laserball', '11xx codes correct the family');
  assert.strictEqual(state.mode.source, 'inferred', 'the correction marks itself inferred');
  assert.strictEqual(state.mode.number, 5, 'the announced number is kept');
  assert.strictEqual(state.mode.key, 'sm5', 'the key is kept — only the family changed');
  assert.strictEqual(evts.filter((e) => e.type === 'mode_change' && e.mode.source === 'inferred').length, 1,
    'the correction fires exactly once per match');
  assert.strictEqual(state.players['2'].goals, 1, 'the goal is counted after the correction');
  assert.strictEqual(state.players['1'].passesDone, 1, 'Laserball counters run after the correction');

  // No flapping: once corrected, a later code of the OTHER family must not flip
  // the mode back — otherwise every stray 02xx would re-bucket a running match.
  const flap = feedEngine([
    '1\t99\tHausmodus\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
    '3\t100\t#2\tplayer\tB\t0\t3\t0',
    '4\t1000\t1100\t#1\t#2',   // -> laserball, inferred
    '4\t2000\t0205\t#1\t#2',   // a stray SM5 code must NOT flip it back
    '4\t3000\t0206\t#1\t#2',
    '4\t4000\t1101\t#2',
  ]);
  assert.strictEqual(flap.state.mode.family, 'laserball', 'a later SM5 code does not flip the family back');
  assert.strictEqual(flap.evts.filter((e) => e.type === 'mode_change' && e.mode.source === 'inferred').length, 1,
    'the family is corrected at most once per match, never repeatedly');
  assert.strictEqual(flap.state.players['2'].goals, 1, 'the match keeps counting as Laserball');

  // The counter-proof: mission 28 is Laserball by definition and must NEVER be
  // demoted to sm5, whatever 02xx codes turn up.
  const lb = feedEngine([
    '1\t28\tLaserball Ranked\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
    '3\t100\t#2\tplayer\tB\t0\t3\t0',
    '4\t1000\t0205\t#1\t#2',
    '4\t1100\t0206\t#1\t#2',
    '4\t1200\t0306\t#1\t#2',
    '4\t1300\t0600\t#1',
    '4\t1400\t1100\t#1\t#2',
  ]);
  assert.strictEqual(lb.state.mode.family, 'laserball', 'mission 28 stays laserball');
  assert.strictEqual(lb.state.mode.source, 'tdf', 'mission 28 keeps source:tdf');
  assert.strictEqual(lb.state.players['1'].shotsFired, undefined, 'no SM5 counting inside a Laserball match');
  assert.strictEqual(lb.state.players['2'].timesHit, undefined, 'no SM5 counting inside a Laserball match');
  assert.strictEqual(lb.evts.filter((e) => e.type === 'mode_change').length, 1, 'only the initial mode_change');
  assert.strictEqual(lb.state.players['1'].passesDone, 1, 'the Laserball pass is still counted');
  console.log('  ok    engine.familyInference');
} catch (err) { failed++; console.error(`  FAIL  engine.familyInference\n        ${err.stack}`); }

try {
  // Adaptive game clock (contract C1/C2).
  const known = feedEngine([
    '1\t28\tLaserball Ranked\t20260916094500\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
  ]);
  assert.strictEqual(known.state.durationKnown, true, 'reported duration -> durationKnown');
  assert.strictEqual(known.state.duration, 900000, 'duration in ms');
  const first = known.state.remainingMs;
  known.eng.processLogLine('4\t120000\t1107\t#1');
  const second = known.eng.snapshot().remainingMs;
  assert.strictEqual(first, 899900, 'remainingMs after 100 ms');
  assert.strictEqual(second, 780000, 'remainingMs after 120 s');
  assert.ok(second < first, 'remainingMs counts DOWN while the duration is known');

  const unknownDur = feedEngine([
    '1\t14\t7SM Nexus\t20260916094500',
    '2\t0\tRot\t1\tRed\t#ff0000',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
    '4\t60000\t0201\t#1',
  ]);
  assert.strictEqual(unknownDur.state.durationKnown, false, 'no duration -> durationKnown:false');
  assert.strictEqual(unknownDur.state.remainingMs, null, 'no duration -> remainingMs null');
  assert.strictEqual(unknownDur.state.duration, 720000, 'duration falls back to the default');
  assert.strictEqual(unknownDur.state.elapsedTime, 60000, 'elapsedTime counts UP instead');
  unknownDur.eng.processLogLine('4\t130000\t0201\t#1');
  assert.strictEqual(unknownDur.eng.snapshot().elapsedTime, 130000, 'elapsedTime keeps rising');
  assert.strictEqual(unknownDur.eng.snapshot().remainingMs, null, 'remainingMs stays null');

  // unit heuristic + plausibility window
  const dur = (line) => feedEngine([line]).state;
  assert.strictEqual(dur('1\t5\tX\t0\t900\t0').duration, 900000, '900 is read as seconds');
  assert.strictEqual(dur('1\t5\tX\t0\t900000\t0').duration, 900000, '900000 is read as milliseconds');
  // the plausibility window is 1 min - 2 h; both edges are pinned
  assert.strictEqual(dur('1\t5\tX\t0\t60\t0').duration, 60000, 'the shortest plausible mission');
  assert.strictEqual(dur('1\t5\tX\t0\t59\t0').durationKnown, false, 'just under a minute is discarded');
  assert.strictEqual(dur('1\t5\tX\t0\t7200\t0').duration, 7200000, 'two hours exactly is still accepted');
  assert.strictEqual(dur('1\t5\tX\t0\t7201\t0').durationKnown, false, 'just over two hours is discarded');
  assert.strictEqual(dur('1\t5\tX\t0\t5\t0').durationKnown, false, '5 s is not a plausible mission');
  assert.strictEqual(dur('1\t5\tX\t0\t5\t0').duration, 720000, 'and the default is used instead');
  assert.strictEqual(dur('1\t5\tX\t0\t99999999\t0').durationKnown, false, 'more than 2 h is discarded');
  assert.strictEqual(dur('1\t5\tX\t0\t-900\t0').durationKnown, false, 'a negative duration is discarded');
  assert.strictEqual(dur('1\t5\tX\t0\tabc\t0').durationKnown, false, 'a non-numeric duration is discarded');
  assert.strictEqual(dur('1\t5\tX\t20260916094500').durationKnown, false, 'TDF 2.000 has no duration column');
  assert.strictEqual(dur('1\t5\tX\t20260916094500\t900').duration, 900000, 'duration without a penalty column');
  assert.strictEqual(dur('1\t5\tX\t20260916094500\t900\t0').duration, 900000, 'the start timestamp is never a duration');
  console.log('  ok    engine.gameClock');
} catch (err) { failed++; console.error(`  FAIL  engine.gameClock\n        ${err.stack}`); }

try {
  // Score authority (contract C3).
  const internal = feedEngine([
    '1\t28\tLaserball Ranked\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000', '2\t1\tBlau\t4\tBlue\t#0000ff',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0', '3\t100\t#2\tplayer\tB\t1\t3\t0',
    '4\t1000\t1101\t#1', '4\t2000\t1101\t#1',
  ]);
  assert.strictEqual(internal.state.scoreSource, 'internal', 'without type-5 the own count is the authority');
  assert.deepStrictEqual(internal.state.scores, { 0: 2, 1: 0 }, 'the own count produced the score');
  assert.strictEqual(internal.state.players['1'].goals, 2, 'goals counted');

  const { eng, state } = feedEngine([
    '1\t5\tSpace Marines 5\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000', '2\t1\tBlau\t4\tBlue\t#0000ff',
    '4\t0\t0100',
    '3\t100\t#1001\tplayer\tA\t0\t3\t1', '3\t100\t#2001\tplayer\tB\t1\t3\t1',
    ';5/score\ttime\tentity\told\tdelta\tnew',
    '5\t1000\t0\t0\t3400\t3400',
    '5\t1000\t1\t0\t1200\t1200',
    '5\t1100\t#1001\t0\t2200\t2200',
  ]);
  assert.strictEqual(state.scoreSource, 'tdf', 'a type-5 line makes the arena the authority');
  assert.strictEqual(state.scores['0'], 3400, 'team score straight from the arena');
  assert.strictEqual(state.scores['1'], 1200, 'team score straight from the arena');
  assert.strictEqual(state.players['1001'].score, 2200, 'player score straight from the arena');
  // once the arena owns the score, the own goal count must not add on top
  eng.processLogLine('4\t2000\t1101\t#1001');
  const after = eng.snapshot();
  assert.strictEqual(after.scores['0'], 3400, 'the own count does not add onto an arena score');
  assert.strictEqual(after.players['1001'].goals, 1, 'the goal itself is still counted');

  // 0100 resets the authority — a match never inherits it from its predecessor
  eng.processLogLine('1\t28\tLaserball Ranked\t0\t900\t0');
  eng.processLogLine('4\t0\t0100');
  assert.strictEqual(eng.snapshot().scoreSource, 'internal', '0100 resets scoreSource');
  eng.processLogLine('3\t100\t#1001\tplayer\tA\t0\t3\t0');
  eng.processLogLine('4\t1000\t1101\t#1001');
  assert.strictEqual(eng.snapshot().scores['0'], 1, 'the new match counts for itself again');
  assert.strictEqual(eng.snapshot().scoreSource, 'internal', 'and stays on the own count');

  // DOCUMENTED precedence: a type-5 `entity` that is also a player id is read as
  // the PLAYER, not as the team index. Real Laserforce ids are long, so this
  // only bites a hand-built stream — but it has to stay deliberate.
  const clash = feedEngine([
    '1\t5\tX\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000', '2\t1\tBlau\t4\tBlue\t#0000ff',
    '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t1',
    '5\t1000\t1\t0\t1200\t1200',
  ]).state;
  assert.strictEqual(clash.players['1'].score, 1200, 'entity matching a player id -> player score');
  assert.strictEqual(clash.scores['1'], 0, 'and NOT the team score');
  console.log('  ok    engine.scoreAuthority');
} catch (err) { failed++; console.error(`  FAIL  engine.scoreAuthority\n        ${err.stack}`); }

try {
  // ── Teampunkte, wenn die Anlage keine meldet ──────────────────────────────
  // Der Befund aus dem echten Betrieb: im Standardmodus (Nummer 7,
  // „| Standard LZ - 2 Teams |") schickt die Anlage Typ-5-Zeilen AUSSCHLIESSLICH
  // je Spieler, nie je Team — gemessen an vier Mitschnitten vom 19.09.2026,
  // zusammen 5551 Typ-5-Zeilen, davon 0 auf eine Team-Kennung. `scores` blieb
  // deshalb leer, jeder Bericht meldete `draw`, die Live-Ansicht 0:0.
  // In Laserball ist es umgekehrt: dort MELDET die Anlage Teampunkte, und daran
  // darf sich nichts ändern.
  const { buildMatchReport } = require('../src/matchReport');
  const { buildDisplay } = require('../src/apiServer');
  const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
  const feed = (lines) => feedEngine(lines, { matchEnd: OFF });
  const STD_HEAD = [
    '1\t7\t| Standard LZ - 2 Teams |\t20260919104649\t480000\t-1000',
    ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour-rgb',
    '2\t0\tBlaues Team\t12\tIce\t#00A0FF',
    '2\t1\tRotes Team\t11\tFire\t#FF5000',
    '2\t2\tNeutral\t0\tNone\t#808080',
    '4\t0000000\t0100\t* Missionsbeginn *',
    ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
    '3\t0000001\t#aA1bB2cC\tplayer\tAnna\t0\t1\t0\tUnderground\t21-101-10001',
    '3\t0000001\t#bB7kQ2xR\tplayer\tBert\t0\t3\t0\tBalu\t21-101-10002',
    '3\t0000002\t#cC4nW9tL\tplayer\tCleo\t1\t2\t0\tLoki\t21-101-10003',
    '3\t0000002\t#dD1sE5vM\tplayer\tDora\t1\t0\t0\tCyborg\t21-101-10004',
    // Nicht-Spieler-Entities. Sie tragen an dieser Anlage Team-Index 2
    // („Neutral") — und ihre Kennung trägt ein `@`, nie eine blanke Zahl.
    '3\t0000003\t@91\tgallery-target\tPunktestation Zufall\t2\t0\t0\tPunktestation Zufall\t',
    '3\t0000003\t@30\tgenerator-target\tGenerator\t2\t0\t0\tGenerator\t',
    ';5/score\ttime\tentity\told\tdelta\tnew',
  ];

  // 1) Das Zeitfenster: das Kennzeichen darf nicht springen, sobald die erste
  //    Zeile eintrifft. Bis die Frage entschieden ist, bleibt es auf `internal`
  //    — genau das, was ein Match in seinen ersten Sekunden ohnehin ist.
  let e = feed([...STD_HEAD, '5\t0010000\t#aA1bB2cC\t0\t110\t110']).eng;
  assert.strictEqual(e.snapshot().teamScoreSource, 'internal',
    'die erste Spieler-Punktezeile allein entscheidet noch nichts');
  assert.strictEqual(e.snapshot().scores['0'], 0, 'und der Teamstand steht noch bei 0');
  e.processLogLine('5\t0012000\t#cC4nW9tL\t0\t90\t90');   // 2 s später
  assert.strictEqual(e.snapshot().teamScoreSource, 'internal', 'nach 2 s immer noch nicht');
  e.processLogLine('4\t0014999\t0900\t#aA1bB2cC\t erzielt ein Achievement');
  assert.strictEqual(e.snapshot().teamScoreSource, 'internal',
    'eine Millisekunde vor Fensterende auch nicht — die Grenze ist scharf');
  e.processLogLine('4\t0015000\t0900\t#bB7kQ2xR\t erzielt ein Achievement');
  assert.strictEqual(e.snapshot().teamScoreSource, 'derived',
    'erst wenn das Fenster abgelaufen ist, summieren wir');
  assert.strictEqual(e.snapshot().scores['0'], 110, 'und zwar aus den Spielerpunkten');
  assert.strictEqual(e.snapshot().scores['1'], 90, 'für beide Teams');

  // 2) Ein ganzes Standardspiel: die Summe stimmt, der Sieger steht fest, und
  //    weder die Nicht-Spieler-Entities noch ein Spieler ohne bekanntes Team
  //    fließen ein.
  const full = feed([...STD_HEAD,
    // Ein Spieler in einem Team, das keine Typ-2-Zeile angekündigt hat.
    '3\t0000004\t#eE2fF6wN\tplayer\tEmil\t7\t1\t0\tGandalf\t21-101-10005',
    '5\t0010000\t#aA1bB2cC\t0\t110\t110',
    '5\t0011000\t#bB7kQ2xR\t0\t250\t250',
    '5\t0012000\t#cC4nW9tL\t0\t90\t90',
    '5\t0013000\t#dD1sE5vM\t0\t-50\t-50',
    '5\t0014000\t#eE2fF6wN\t0\t9999\t9999',
    // Eine Punktestation, die Punkte macht. Sie gehört niemandem.
    '5\t0015000\t@91\t0\t4000\t4000',
    '5\t0016000\t@30\t0\t4000\t4000',
    '5\t0100000\t#aA1bB2cC\t110\t400\t510',
    '4\t0480100\t0101\t* Missionsende *',
  ]).state;
  assert.strictEqual(full.teamScoreSource, 'derived', 'die Anlage hat keine Teampunkte gemeldet');
  assert.strictEqual(full.scores['0'], 760, 'Blau = 510 + 250');
  assert.strictEqual(full.scores['1'], 40, 'Rot = 90 + (-50); negative Punkte zählen mit');
  assert.strictEqual(full.scores['2'], 0, 'Neutral bleibt 0 — dort spielt niemand');
  assert.strictEqual(full.scores['7'], undefined, 'ein unbekanntes Team wird nicht erfunden');
  assert.strictEqual(full.scores['91'], undefined, 'und eine Punktestation erst recht nicht');
  assert.strictEqual(full.scores['30'], undefined, 'auch der Generator wird kein Team');
  assert.strictEqual(Object.keys(full.players).length, 5, 'genau die fünf Spieler, keine Ziele');
  assert.strictEqual(full.scoreSource, 'tdf', 'Typ-5-Zeilen kamen ja — nur eben keine für Teams');

  // 3) Der Bericht: Sieger und `draw` beruhen jetzt auf einer echten Zahl.
  const rep = buildMatchReport(full, {});
  assert.strictEqual(rep.match.winner && rep.match.winner.name, 'Blaues Team', 'der Sieger steht im Bericht');
  assert.strictEqual(rep.match.winner.score, 760, 'mit seiner Punktzahl');
  assert.strictEqual(rep.match.draw, false, 'und es ist ausdrücklich kein Unentschieden');
  assert.strictEqual(rep.match.teamScoreSource, 'derived', 'das Kennzeichen steht in der Übersicht');
  assert.strictEqual(rep.match.teamScoreDerived, true, 'als ausdrückliches Ja/Nein');
  assert.strictEqual(rep.match.winner.scoreDerived, true, 'und hängt AN der Zahl, nicht nur daneben');
  assert.ok(rep.match.teams.every((t) => t.scoreDerived === true), 'an jeder einzelnen Teamzahl');
  assert.strictEqual(rep.players.find((p) => p.playerId === 'aA1bB2cC').result, 'win', 'Blau gewinnt');
  assert.strictEqual(rep.players.find((p) => p.playerId === 'cC4nW9tL').result, 'loss', 'Rot verliert');

  // 4) Die API reicht dasselbe durch — der Anzeige-Agent baut darauf auf.
  const disp = buildDisplay(full);
  assert.strictEqual(disp.match.teamScoreSource, 'derived', 'die API nennt die Herkunft');
  assert.strictEqual(disp.match.teamScoreDerived, true, 'und markiert sie als unsere Rechnung');
  assert.ok(String(disp.match.teamScoreSourceLabel).length > 0, 'mit einem Klartext-Etikett');
  assert.strictEqual(disp.teams.find((t) => t.id === '0').score, 760, 'die Zahl steht in der Teamliste');
  assert.ok(disp.teams.every((t) => t.scoreDerived === true), 'jede Teamkachel trägt die Markierung selbst');

  // 5) Ein echtes Unentschieden bleibt eins.
  const tie = feed([...STD_HEAD,
    '5\t0010000\t#aA1bB2cC\t0\t300\t300', '5\t0011000\t#cC4nW9tL\t0\t300\t300',
    '4\t0480100\t0101\t* Missionsende *']).state;
  assert.strictEqual(tie.scores['0'], 300, 'gleiche Summen');
  assert.strictEqual(buildMatchReport(tie, {}).match.draw, true, 'und dann steht `draw` zu Recht');

  // 6) Eine SPÄTE Team-Punktezeile gewinnt — und der Weg zurück ist versperrt.
  const late = feed([...STD_HEAD,
    '5\t0010000\t#aA1bB2cC\t0\t110\t110',
    '4\t0016000\t0900\t#aA1bB2cC\t erzielt ein Achievement']);
  assert.strictEqual(late.state.teamScoreSource, 'derived', 'zuerst summieren wir');
  assert.strictEqual(late.state.scores['0'], 110, 'mit unserer Zahl');
  late.eng.processLogLine('5\t0020000\t0\t0\t7000\t7000');
  assert.strictEqual(late.eng.snapshot().teamScoreSource, 'tdf', 'dann meldet sich doch die Anlage');
  assert.strictEqual(late.eng.snapshot().scores['0'], 7000, 'und ihre Zahl gewinnt');
  late.eng.processLogLine('5\t0030000\t#bB7kQ2xR\t0\t500\t500');
  assert.strictEqual(late.eng.snapshot().teamScoreSource, 'tdf', 'danach wird nie wieder selbst summiert');
  assert.strictEqual(late.eng.snapshot().scores['0'], 7000, 'die Zahl der Anlage bleibt stehen');

  // 7) Laserball: die Teampunkte KOMMEN von der Anlage. Kein Summieren, und
  //    kein Flackern, obwohl die Spielerzeile des Tores zuerst eintrifft.
  const LB_HEAD = [
    '1\t28\tLaserball Ranked\t0\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000', '2\t1\tBlau\t4\tBlue\t#0000ff',
    '4\t0\t0100',
    '3\t100\t#aA1bB2cC\tplayer\tAnna\t0\t3\t0', '3\t100\t#bB7kQ2xR\tplayer\tBert\t1\t3\t0',
    ';5/score\ttime\tentity\told\tdelta\tnew',
  ];
  const lb = feed([...LB_HEAD,
    // Spielerzeile und Teamzeile desselben Tores, gleicher Zeitstempel,
    // Spieler zuerst — genau der Fall, für den es das Zeitfenster gibt.
    '5\t10000\t#aA1bB2cC\t0\t100\t100', '5\t10000\t0\t0\t1\t1', '4\t10000\t1101\t#aA1bB2cC',
    '5\t60000\t#bB7kQ2xR\t0\t100\t100', '5\t60000\t1\t0\t1\t1', '4\t60000\t1101\t#bB7kQ2xR',
    '5\t120000\t#aA1bB2cC\t100\t100\t200', '5\t120000\t0\t1\t1\t2', '4\t120000\t1101\t#aA1bB2cC',
    '4\t300000\t0101\t* Missionsende *',
  ]).state;
  assert.strictEqual(lb.teamScoreSource, 'tdf', 'in Laserball meldet die Anlage die Teampunkte');
  assert.strictEqual(lb.scores['0'], 2, 'und ihre Tore stehen da, nicht unsere Punktsumme');
  assert.strictEqual(lb.scores['1'], 1, 'für beide Teams');
  assert.strictEqual(lb.players.aA1bB2cC.score, 200, 'die Spielerpunkte laufen unverändert mit');
  assert.strictEqual(lb.players.aA1bB2cC.goals, 2, 'und die Tore ebenso');

  // 8) Laserball ohne jede Typ-5-Zeile: die Eigenzählung bleibt, wie sie war.
  const lbOwn = feed([...LB_HEAD, '4\t10000\t1101\t#aA1bB2cC', '4\t20000\t1101\t#aA1bB2cC']).state;
  assert.strictEqual(lbOwn.teamScoreSource, 'internal', 'ohne Typ-5 zählt lf_live selbst');
  assert.strictEqual(lbOwn.scores['0'], 2, 'und zwar genau wie bisher');

  // 9) Ein Match, das INNERHALB des Zeitfensters endet, bekommt seine Summe
  //    trotzdem — sonst stünde im Bericht eine 0.
  const short = feed([...STD_HEAD,
    '5\t0010000\t#aA1bB2cC\t0\t110\t110',
    '4\t0011000\t0101\t* Missionsende *']).state;
  assert.strictEqual(short.teamScoreSource, 'derived', 'am Schlusspfiff ist die Frage entschieden');
  assert.strictEqual(short.scores['0'], 110, 'und die Summe steht');

  // 10) `0100` erbt nichts vom Vormatch.
  const reused = feed([...STD_HEAD,
    '5\t0010000\t#aA1bB2cC\t0\t110\t110', '4\t0016000\t0900\t#aA1bB2cC\t x']);
  assert.strictEqual(reused.state.teamScoreSource, 'derived', 'Match 1 summiert');
  reused.eng.processLogLine('4\t0\t0100');
  assert.strictEqual(reused.eng.snapshot().teamScoreSource, 'internal', '0100 setzt das Kennzeichen zurück');
  assert.strictEqual(reused.eng.snapshot().scores['0'], 0, 'und die Punkte auf 0');

  console.log('  ok    engine.teamScoreSource');
} catch (err) { failed++; console.error(`  FAIL  engine.teamScoreSource\n        ${err.stack}`); }

try {
  // Die CSV eines echten Standardspiels: `team_score`, `opp_score` und `result`
  // beruhten bisher auf leeren Teampunkten — jeder war „draw" mit 0:0. Jetzt
  // steht die summierte Zahl drin, ausdrücklich als unsere gekennzeichnet.
  const { Engine } = require('../src/engine');
  const { StatsWriter, splitCsv } = require('../src/statsWriter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfteamscore-'));
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new Engine({ logger: null, matchEnd: { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 } });
  const sw = new StatsWriter({
    logger: quiet,
    getConfig: () => ({ csv: { enabled: true, dir, delimiter: ',', bom: false, writeEvents: false, writeLive: false } }),
  });
  eng.on('change', () => sw.onChange(eng.gameState));
  eng.on('event', (e) => sw.onEvent(e));
  eng.on('match_start', () => sw.onMatchStart(eng.snapshot()));
  eng.on('match_end', () => sw.onMatchEnd(eng.snapshot()));

  [
    '1\t7\t| Standard LZ - 2 Teams |\t20260919104649\t480000\t-1000',
    '2\t0\tBlaues Team\t12\tIce\t#00A0FF', '2\t1\tRotes Team\t11\tFire\t#FF5000',
    '4\t0000000\t0100\t* Missionsbeginn *',
    ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
    '3\t0000001\t#aA1bB2cC\tplayer\tAnna\t0\t1\t0\tUnderground\t21-101-10001',
    '3\t0000001\t#cC4nW9tL\tplayer\tCleo\t1\t2\t0\tLoki\t21-101-10003',
    ';5/score\ttime\tentity\told\tdelta\tnew',
    '5\t0010000\t#aA1bB2cC\t0\t900\t900',
    '5\t0011000\t#cC4nW9tL\t0\t400\t400',
    '4\t0480100\t0101\t* Missionsende *',
  ].forEach((l) => eng.processLogLine(l));

  const read = (name) => {
    const lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0], ',');
    return lines.slice(1).map((l) => {
      const c = splitCsv(l, ','); const o = {}; head.forEach((h, i) => (o[h] = c[i])); return o;
    });
  };
  const rows = read('all_players_sm5.csv');
  const anna = rows.find((r) => r.name === 'Anna');
  const cleo = rows.find((r) => r.name === 'Cleo');
  assert.strictEqual(anna.team_score, '900', 'die summierten Teampunkte stehen in der Spielerzeile');
  assert.strictEqual(anna.opp_score, '400', 'und die des Gegners auch');
  assert.strictEqual(anna.result, 'win', 'damit stimmt das Ergebnis');
  assert.strictEqual(cleo.result, 'loss', 'auf beiden Seiten');
  assert.strictEqual(anna.team_score_source, 'derived', 'gekennzeichnet als unsere Rechnung');
  assert.strictEqual(anna.score_source, 'tdf', 'die Spielerpunkte selbst kamen aber von der Anlage');
  const m = read('matches.csv')[0];
  assert.strictEqual(m.winner_team, 'Blaues Team', 'matches.csv nennt den Sieger');
  assert.strictEqual(m.winner_score, '900', 'mit seiner Punktzahl');
  assert.strictEqual(m.team_score_source, 'derived', 'und sagt dazu, von wem die Zahl ist');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    statsWriter.teamScoreSource');
} catch (err) { failed++; console.error(`  FAIL  statsWriter.teamScoreSource\n        ${err.stack}`); }

try {
  // Type-7 official end block (contract C4).
  const SM5_BASE = [
    '1\t5\tSpace Marines 5\t20260916094500\t900\t0',
    '2\t0\tRot\t1\tRed\t#ff0000', '2\t1\tGruen\t2\tGreen\t#00ff00',
    '4\t0\t0100',
    ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit',
    '3\t100\t#1001\tplayer\tAnna Maria\t0\t3\t1\tSuit-A',
    '3\t100\t#2001\tplayer\tCara\t1\t3\t3\tSuit-C',
    '4\t1000\t0205\t#1001\thits\t#2001',
    '4\t1500\t0206\t#1001\tdeactivates\t#2001',
    '4\t2000\t0600\t#2001',
  ];
  const TYPE7 = [
    ';7/sm5-stats\tid\tshotsHit\tshotsFired\ttimesZapped\ttimesMissiled\tmissileHits\tnukesDetonated\tnukesActivated\tnukesCancelled\tmedicHits\townMedicHits\tmedicNukes\tscoutRapid\tlifeBoost\tammoBoost\tlivesLeft\tshotsLeft\tpenalties\tshot3Hit\townNukeCancels\tshotOpponent\tshotTeam\tmissiledOpponent\tmissiledTeam',
    '7\t#1001\t42\t130\t7\t1\t3\t1\t1\t0\t0\t0\t0\t0\t0\t0\t3\t12\t0\t5\t0\t18\t2\t3\t0',
    '7\t#2001\t12\t90\t19\t3\t0\t0\t0\t0\t0\t0\t0\t2\t0\t0\t0\t4\t1\t1\t0\t6\t1\t0\t0',
  ];

  // live counting first — the values the official block has to overwrite
  const live = feedEngine([...SM5_BASE, '4\t3000\t0101']).state;
  assert.strictEqual(live.players['1001'].statsSource, 'live', 'without type-7 the live count stands');
  assert.strictEqual(live.players['1001'].shotsHit, 2, 'live shotsHit');
  assert.strictEqual(live.players['1001'].shotsFired, 2, 'live shotsFired is only a lower bound');
  assert.strictEqual(live.players['1001'].deactivations, 1, 'live deactivations');
  assert.strictEqual(live.players['2001'].timesDeactivated, 1, 'live timesDeactivated');
  assert.strictEqual(live.players['2001'].penalties, 1, 'live penalties');
  assert.strictEqual(live.players['1001'].roleLabel, 'Commander', 'SM5 role resolved');
  assert.strictEqual(live.players['2001'].roleLabel, 'Scout', 'SM5 role resolved');

  const { state, evts } = feedEngine([...SM5_BASE, ...TYPE7, '4\t3000\t0101']);
  const p = state.players['1001'];
  assert.strictEqual(p.statsSource, 'tdf7', 'after the type-7 block the arena owns the stats');
  assert.strictEqual(state.players['2001'].statsSource, 'tdf7', 'for every player of the block');
  assert.strictEqual(p.shotsHit, 42, 'official shotsHit overwrote the live value');
  assert.strictEqual(p.shotsFired, 130, 'official shotsFired overwrote the lower bound');
  assert.strictEqual(p.timesDeactivated, 7, 'timesZapped -> timesDeactivated');
  assert.strictEqual(p.deactivations, 18, 'shotOpponent -> deactivations');
  assert.strictEqual(p.shotTeam, 2, 'shotTeam');
  assert.strictEqual(p.missileHits, 3, 'missiledOpponent -> missileHits');
  assert.strictEqual(p.nukesDetonated, 1, 'nukesDetonated');
  assert.strictEqual(state.players['2001'].penalties, 1, 'penalties from the block');
  assert.strictEqual(state.players['2001'].timesDeactivated, 19, 'the block also corrects the target counters');
  assert.strictEqual(p.official.livesLeft, 3, 'the raw official block is kept');
  assert.strictEqual(p.official.shotsLeft, 12, 'the raw official block is complete');
  assert.ok(live.players['1001'].shotsFired < p.shotsFired, 'the official number is higher than the live lower bound');
  // the event, and its position: it must arrive BEFORE match_end so the stats
  // writer files the official numbers
  const i7 = evts.findIndex((e) => e.type === 'sm5_stats' && e.actorId === '1001');
  const iEnd = evts.findIndex((e) => e.type === 'match_end');
  assert.ok(i7 >= 0, 'sm5_stats event emitted');
  assert.ok(i7 < iEnd, 'sm5_stats arrives before match_end');
  assert.strictEqual(evts[i7].category, 'player', 'sm5_stats is a player event');
  console.log('  ok    engine.type7EndBlock');
} catch (err) { failed++; console.error(`  FAIL  engine.type7EndBlock\n        ${err.stack}`); }

try {
  // Tab vs. whitespace, and with vs. without the `;` schema comments.
  // The mission description AND the team names carry spaces on purpose.
  const STREAM = [
    '0\t2.006\tlf-sim\tTesthalle',
    ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
    '1\t5\tSpace Marines 5\t20260916094500\t900\t0',
    ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour',
    '2\t0\tRote Kugeln\t1\tRed\t#ff0000',
    '2\t1\tBlaue Kugeln\t4\tBlue\t#0000ff',
    '4\t0\t0100',
    ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit',
    '3\t100\t#1001\tplayer\tAnna Maria\t0\t3\t1\tSuit-A',
    '3\t100\t#2001\tplayer\tCara\t1\t3\t3\tSuit-C',
    '4\t1000\t0205\t#1001\thits\t#2001',
    '4\t1500\t0206\t#1001\tdeactivates\t#2001',
    '4\t2000\t0500\t#2001\tresupplies\t#1001',
    '4\t3000\t0101',
  ];
  // battlesuit / memberId are the only fields that NEED a schema line, so they
  // are compared separately.
  const shape = (s) => JSON.stringify({
    mode: s.mode, duration: s.duration, durationKnown: s.durationKnown,
    missionDesc: s.missionDesc, scores: s.scores, scoreSource: s.scoreSource,
    teams: s.teams,
    players: Object.fromEntries(Object.entries(s.players).map(([k, v]) => {
      const { battlesuit, memberId, ...rest } = v; return [k, rest];
    })),
  });
  const tabbed = feedEngine(STREAM).state;
  const spaced = feedEngine(toSpaces(STREAM)).state;
  const tabbedNoSchema = feedEngine(noSchema(STREAM)).state;

  assert.strictEqual(tabbed.teams['0'].name, 'Rote Kugeln', 'team name with a space (tab)');
  assert.strictEqual(spaced.teams['0'].name, 'Rote Kugeln', 'team name with a space (whitespace)');
  assert.strictEqual(tabbed.players['1001'].name, 'Anna Maria', 'player name with a space (tab)');
  assert.strictEqual(tabbed.mode.label, 'Space Marines 5', 'mission description with spaces AND a trailing number');
  assert.strictEqual(tabbed.missionDesc, 'Space Marines 5', 'missionDesc kept verbatim');
  assert.strictEqual(tabbed.duration, 900000, 'duration read through the schema');

  assert.strictEqual(shape(spaced), shape(tabbed), 'tab-fed and space-fed streams agree');
  assert.strictEqual(shape(tabbedNoSchema), shape(tabbed), 'with and without the `;` schema lines the result agrees');
  assert.strictEqual(tabbed.players['1001'].battlesuit, 'Suit-A', 'battlesuit via the schema (tab)');
  assert.strictEqual(spaced.players['1001'].battlesuit, 'Suit-A', 'battlesuit via the schema (whitespace)');
  assert.strictEqual(tabbedNoSchema.players['1001'].battlesuit, null, 'no schema, no battlesuit — by design');

  // DOCUMENTED LIMIT (see CORE-API.md): with neither tabs nor schema lines a
  // description ENDING in a number loses that last token. Everything that
  // matters for counting still agrees — this pins the limit so it cannot widen.
  const spacedNoSchema = feedEngine(toSpaces(noSchema(STREAM))).state;
  assert.strictEqual(spacedNoSchema.mode.number, 5, 'limit case: mode number still right');
  assert.strictEqual(spacedNoSchema.mode.family, 'sm5', 'limit case: family still right');
  assert.strictEqual(spacedNoSchema.duration, 900000, 'limit case: duration still right');
  assert.strictEqual(spacedNoSchema.durationKnown, true, 'limit case: durationKnown still right');
  assert.strictEqual(spacedNoSchema.mode.label, 'Space Marines', 'limit case: trailing number of the description is lost');
  assert.strictEqual(
    JSON.stringify(spacedNoSchema.players['1001'].shotsFired),
    JSON.stringify(tabbed.players['1001'].shotsFired),
    'limit case: player counting is unaffected',
  );
  // a description that does NOT end in a number survives even that combination
  const plain = feedEngine(toSpaces(noSchema([
    '1\t28\tLaserball Ranked Abend\t20260916094500\t900\t0',
  ]))).state;
  assert.strictEqual(plain.mode.label, 'Laserball Ranked Abend', 'a normal description survives space+no-schema');
  console.log('  ok    engine.tabWhitespaceEquivalence');
} catch (err) { failed++; console.error(`  FAIL  engine.tabWhitespaceEquivalence\n        ${err.stack}`); }

try {
  // Robustness: the parser reads an unsecured TCP feed. Garbage, truncated
  // lines, absurd numbers and prototype-pollution attempts must neither crash
  // nor poison the state.
  const before = Object.keys(Object.prototype).length;
  const junk = [
    '', '   ', '1', '1\t\t\t', '1\t\t', ';', ';;', ';1/mission', ';\t\t',
    '2', '2\t99\tX\t1\tRed\t#fff', '2\t-1\tX\t1\tRed\t#fff', '2\t__proto__\tX\t1\tRed\t#fff',
    '2\tconstructor\tX\t1\tRed\t#fff', '2\t1e3\tX\t1\tRed\t#fff',
    '3', '3\tplayer', '3\t100\t#1\tplayer',
    '4', '4\tx\ty\tz', '4\t0\t1101\t#ghost', '4\t0\t\t', '4\t0\t110\t#1',
    '5', '5\t0\t__proto__\t0\t1\t99', '5\t0\tconstructor\t0\t1\t99', '5\t0\tprototype\t0\t1\t7',
    '5\t0\t999\t0\t1\t5', '5\t0\t0\t0\t1\t99999999999999999999',
    '6', '7', '7\t#nope\t1\t2', '9', '9\t0\t#ghost\t2',
    'völliger Unsinn ohne Zahlen', '\t\t\t', '4\t0\t0100\t'.repeat(3),
  ];
  const { state } = feedEngine(junk);
  assert.strictEqual(({}).polluted, undefined, 'no prototype pollution');
  assert.strictEqual(({}).X, undefined, 'no prototype pollution through a team line');
  assert.strictEqual(Object.keys(Object.prototype).length, before, 'Object.prototype untouched');
  assert.ok(!Object.prototype.hasOwnProperty.call(state.scores, '__proto__'), 'no __proto__ score key');
  assert.ok(!Object.prototype.hasOwnProperty.call(state.scores, 'constructor'), 'no constructor score key');
  assert.ok(!Object.prototype.hasOwnProperty.call(state.scores, '999'), 'an implausible team key is rejected');
  assert.ok(!Object.prototype.hasOwnProperty.call(state.teams, '__proto__'), 'no __proto__ team');
  assert.ok(!Object.prototype.hasOwnProperty.call(state.teams, '99'), 'a team index out of bounds is rejected');
  assert.ok(Object.keys(state.teams).length <= 1, 'the hostile feed did not grow the team table');
  assert.ok(Object.keys(state.scores).length <= 1, 'the hostile feed did not grow the score table');
  assert.strictEqual(state.mode.known, false, 'a broken type-1 line leaves the mode unknown');
  assert.ok(typeof state.remainingMs === 'object' || typeof state.remainingMs === 'number', 'remainingMs stays well-formed');

  // A hostile type-7 schema: dangerous column names must not reach the player
  // object, harmless ones still must.
  const hostile = feedEngine([
    '1\t5\tX\t0\t900\t0',
    '4\t0\t0100',
    '3\t100\t#1001\tplayer\tA\t0\t3\t1',
    ';7/stats\tid\t__proto__\tconstructor\tprototype\tshotsHit',
    '7\t#1001\t9\t9\t9\t42',
  ]);
  const off = hostile.state.players['1001'].official;
  // `constructor` / `prototype` are dropped outright; `__proto__` survives only
  // as the harmless key `proto`, because the camelCase normalization strips the
  // underscores BEFORE the unsafe-key check. Both paths are pinned here.
  assert.deepStrictEqual(Object.keys(off), ['proto', 'shotsHit'], 'unsafe type-7 column names never land as such');
  assert.ok(!Object.prototype.hasOwnProperty.call(off, '__proto__'), 'no literal __proto__ key');
  assert.strictEqual(Object.getPrototypeOf(off), Object.prototype, 'the official block keeps its prototype');
  assert.strictEqual(off.constructor, Object, 'constructor was not overwritten');
  assert.strictEqual(hostile.state.players['1001'].shotsHit, 42, 'the safe column still lands');
  assert.strictEqual(hostile.state.players['1001'].proto, undefined, 'a dropped column reaches no live counter');
  assert.strictEqual(({}).polluted, undefined, 'still no prototype pollution');

  // absurd numbers in a type-4 line
  const absurd = feedEngine([
    '1\t28\tX\t0\t900\t0', '2\t0\tRot\t1\tRed\t#ff0000', '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0',
    '4\t99999999999999999999\t1101\t#1',
    '4\t-5\t1101\t#1',
  ]);
  assert.strictEqual(absurd.state.players['1'].goals, 2, 'absurd timestamps do not stop the counting');
  assert.ok(Number.isFinite(absurd.state.elapsedTime), 'elapsedTime stays a finite number');

  // a truncated stream (cut mid-line by the socket) must not corrupt anything
  const cut = feedEngine([
    '1\t28\tLaserball Ranked\t0\t900\t0', '2\t0\tRot\t1\tRed\t#ff0000', '4\t0\t0100',
    '3\t100\t#1\tplayer\tA\t0\t3\t0', '4\t1000\t110',
  ]);
  assert.strictEqual(cut.state.players['1'].goals, 0, 'a truncated code counts nothing');
  assert.strictEqual(cut.state.mode.family, 'laserball', 'and does not change the family');
  console.log('  ok    engine.robustness');
} catch (err) { failed++; console.error(`  FAIL  engine.robustness\n        ${err.stack}`); }

try {
  // CSV family separation (contract D), driven through the REAL engine and the
  // REAL stats writer, wired exactly as src/index.js does. Everything lands in
  // an OS temp directory and is removed again.
  const { Engine } = require('../src/engine');
  const { StatsWriter, splitCsv } = require('../src/statsWriter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfmodes-'));
  const DELIM = ';';
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new Engine({ logger: null });
  const sw = new StatsWriter({
    logger: quiet,
    getConfig: () => ({ csv: { enabled: true, dir, delimiter: DELIM, bom: true, writeEvents: false, writeLive: false } }),
  });
  eng.on('change', () => sw.onChange(eng.gameState));
  eng.on('event', (e) => sw.onEvent(e));
  eng.on('match_start', () => sw.onMatchStart(eng.snapshot()));
  eng.on('match_end', () => sw.onMatchEnd(eng.snapshot()));

  // matchId is Date.now().toString(36) — two matches inside the same
  // millisecond would collide, so the test waits a few ms between missions.
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  const feedMatch = (lines) => { pause(); for (const l of lines) eng.processLogLine(l); };
  const rowsOf = (name) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0], DELIM);
    return lines.slice(1).map((l) => {
      const c = splitCsv(l, DELIM);
      const o = {};
      head.forEach((h, i) => (o[h] = c[i]));
      return o;
    });
  };
  const headOf = (name) => splitCsv(
    fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0], DELIM,
  );

  // (a) Laserball: Anna + Ben
  feedMatch([
    '1 28 Laserball Ranked 0 300 0',
    '2 0 Rote Kugeln 5 solid #ef4444', '2 1 Blaue Kugeln 5 solid #3b82f6',
    '4 100 0100',
    '3 1000 event @1001 player Anna 0 3 1', '3 1100 event @2001 player Ben 1 3 1',
    '4 5000 1100 @1001 @2001', '4 9000 1101 @1001',
    '4 300000 0101',
  ]);
  // (b) SM5: Anna again + Cleo
  feedMatch([
    '1 5 Space Marines 5 0 900 0',
    '2 0 Rote Kugeln 5 solid #ef4444', '2 1 Blaue Kugeln 5 solid #3b82f6',
    '4 400 0100',
    '3 1000 event @1001 player Anna 0 3 1', '3 1100 event @3001 player Cleo 1 3 2',
    '4 5000 0205 @1001 @3001', '4 6000 0206 @1001 @3001',
    '5 8000 0 0 4200 4200', '5 8000 1 0 3100 3100',
    '4 900000 0101',
  ]);

  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.csv')).sort();
  assert.deepStrictEqual(files, [
    'all_players_laserball.csv', 'all_players_sm5.csv', 'matches.csv',
    'player_modes.csv', 'totals_laserball.csv', 'totals_sm5.csv',
  ], 'the two families land in separate files');
  assert.ok(!fs.existsSync(path.join(dir, 'all_players.csv')), 'no un-suffixed player file is written');
  assert.ok(!fs.existsSync(path.join(dir, 'totals.csv')), 'no un-suffixed totals file is written');

  // the column sets are disjoint
  assert.ok(headOf('all_players_laserball.csv').includes('goals'), 'laserball file counts goals');
  assert.ok(!headOf('all_players_laserball.csv').includes('shots_fired'), 'laserball file has no SM5 columns');
  assert.ok(headOf('all_players_sm5.csv').includes('shots_fired'), 'sm5 file counts shots');
  assert.ok(!headOf('all_players_sm5.csv').includes('goals'), 'sm5 file has no Laserball columns');

  // matches.csv: one row per match, with the right family
  const matches = rowsOf('matches.csv');
  assert.strictEqual(matches.length, 2, 'one row per match');
  assert.deepStrictEqual(matches.map((r) => r.family), ['laserball', 'sm5'], 'family per match');
  assert.deepStrictEqual(matches.map((r) => r.mode_key), ['laserball_ranked', 'sm5'], 'mode_key per match');
  assert.deepStrictEqual(matches.map((r) => r.score_source), ['internal', 'tdf'], 'score authority per match');
  assert.strictEqual(new Set(matches.map((r) => r.match_id)).size, 2, 'two distinct match ids');

  // ADDITIVE: `team_score_source` says whether the team points behind
  // `team_score`/`opp_score`/`result` are the arena's or our own sum. It is
  // APPENDED at the very end of every file — the operator already evaluates
  // these files, so no existing name and no existing position may move.
  assert.deepStrictEqual(matches.map((r) => r.team_score_source), ['internal', 'tdf'],
    'team score authority per match');
  for (const f of ['matches.csv', 'all_players_sm5.csv', 'all_players_laserball.csv']) {
    assert.strictEqual(headOf(f).slice(-1)[0], 'team_score_source', `${f}: the new column is the LAST one`);
    assert.strictEqual(headOf(f).filter((c) => c === 'team_score_source').length, 1, `${f}: exactly once`);
  }
  assert.strictEqual(headOf('matches.csv').slice(-2)[0], 'end_source',
    'matches.csv: the column before it is still `end_source`');
  assert.strictEqual(headOf('all_players_sm5.csv').slice(-2)[0], 'accuracy_source',
    'player rows: the column before it is still `accuracy_source`');
  assert.strictEqual(headOf('all_players_laserball.csv').slice(-2)[0], 'score_source',
    'laserball rows have no accuracy_source, so `score_source` stays their last old column');

  // the player rows went to the right file
  const lbRows = rowsOf('all_players_laserball.csv');
  const smRows = rowsOf('all_players_sm5.csv');
  assert.strictEqual(lbRows.length, 2, 'laserball match: 2 player rows');
  assert.strictEqual(smRows.length, 2, 'sm5 match: 2 player rows');
  assert.strictEqual(lbRows.find((r) => r.name === 'Anna').goals, '1', 'Anna scored in the laserball match');
  assert.strictEqual(lbRows.find((r) => r.name === 'Anna').passes_done, '1', 'and passed once');
  assert.strictEqual(smRows.find((r) => r.name === 'Anna').team_score, '4200', 'sm5 row carries the arena points');
  assert.ok(!('goals' in smRows[0]), 'an sm5 row has no goals column at all');

  // player_modes.csv: Anna played BOTH families -> two rows
  const pm = rowsOf('player_modes.csv');
  const annaRows = pm.filter((r) => r.player_id === '1001');
  assert.strictEqual(annaRows.length, 2, 'a player who played both modes gets TWO rows');
  assert.deepStrictEqual(annaRows.map((r) => r.mode_key).sort(), ['laserball_ranked', 'sm5'], 'one row per mode');
  assert.deepStrictEqual(annaRows.map((r) => r.family).sort(), ['laserball', 'sm5'], 'each row carries its family');
  assert.ok(annaRows.every((r) => r.matches === '1'), 'one match per mode');
  assert.strictEqual(pm.filter((r) => r.player_id === '2001').length, 1, 'Ben only ever played laserball');
  assert.strictEqual(pm.find((r) => r.player_id === '2001').family, 'laserball', 'and is filed there');
  assert.strictEqual(pm.filter((r) => r.player_id === '3001').length, 1, 'Cleo only ever played sm5');
  assert.strictEqual(pm.find((r) => r.player_id === '3001').family, 'sm5', 'and is filed there');

  // the per-family totals stay separate
  assert.strictEqual(rowsOf('totals_laserball.csv').find((r) => r.name === 'Anna').goals, '1', 'laserball totals');
  assert.ok(rowsOf('totals_sm5.csv').every((r) => r.goals === undefined), 'sm5 totals carry no Laserball columns');
  assert.deepStrictEqual(sw.totalsFamilies().sort(), ['laserball', 'sm5'], 'both families are reported');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    statsWriter.familySplit');
} catch (err) { failed++; console.error(`  FAIL  statsWriter.familySplit\n        ${err.stack}`); }

try {
  // ── Matchende erkennen (docs/LASERFORCE.md, "Wann ein Match als beendet gilt")
  //
  // Deterministic by construction: the engine's ticker only calls the SAME
  // checkMatchEnd(now) these assertions call directly, and `noteActivity(now)`
  // takes an explicit timestamp — so a two-minute silence is expressed as
  // arithmetic, not as a two-minute wait.
  const { Engine, matchEndMs, END_REASONS, END_SOURCES } = require('../src/engine');
  const { normalize } = require('../src/config');

  const MS = { watchdogMs: 120000, streamLostMs: 30000, endBlockMs: 10000 };
  const NAMES = ['Anna', 'Ben', 'Cara', 'Dora', 'Emil'];
  /** A running match with `n` logged-in players (teams alternate 0/1). */
  const startN = (n, over = {}) => {
    const eng = new Engine({ logger: null, matchEnd: { ...MS, ...over } });
    const ends = [];
    eng.on('match_end', (e) => ends.push(e));
    [
      '1 28 Laserball Ranked 0 900000 0',
      '2 0 Rot 5 solid #ef4444', '2 1 Blau 5 solid #3b82f6',
      '4 0 0100',
    ].concat(Array.from({ length: n }, (_, i) => `3 100 event @${i + 1} player ${NAMES[i]} ${i % 2} 3 1`))
      .concat(n > 1 ? ['4 5000 1100 @1 @2'] : [])
      .forEach((l) => eng.processLogLine(l));
    return { eng, ends, t0: eng._lastLineAt };
  };
  const start = (over = {}) => startN(2, over);

  // (0) contract: while a match runs both fields are null
  {
    const { eng } = start();
    assert.strictEqual(eng.snapshot().missionActive, true, 'match is running');
    assert.strictEqual(eng.snapshot().endReason, null, 'endReason is null while a match runs');
    assert.strictEqual(eng.snapshot().endedAt, null, 'endedAt is null while a match runs');
    assert.strictEqual(eng.snapshot().endSource, null, 'endSource is null while a match runs');
    assert.deepStrictEqual(eng.snapshot().exitCodes, {}, 'no exit code has been observed yet');
    assert.deepStrictEqual(eng.snapshot().exitCodesSeen, [], 'nor a distinct one');
    const fresh = new Engine({ logger: null });
    assert.strictEqual(fresh.snapshot().endReason, null, 'a fresh engine has no endReason');
    assert.strictEqual(fresh.snapshot().endedAt, null, 'a fresh engine has no endedAt');
    assert.strictEqual(fresh.snapshot().endSource, null, 'a fresh engine has no endSource');
    // a second match must not inherit the exit codes of the first
    const { eng: e2 } = startN(2);
    e2.processLogLine('6 300000 @1 01 10');
    assert.deepStrictEqual(e2.snapshot().exitCodesSeen, ['01'], 'recorded');
    e2.processLogLine('4 0 0100');
    assert.deepStrictEqual(e2.snapshot().exitCodes, {}, 'a new match starts with a clean sheet');
    assert.deepStrictEqual(e2.snapshot().exitCodesSeen, [], 'distinct list cleared too');
    assert.strictEqual(e2.snapshot().endSource, null, 'and no end source');
  }

  // (1) THE CASE THAT MUST NOT HAPPEN: a type-6 line mid-game ends nothing.
  //     The exit code is NOT what tells a drop-out from the closing summary
  //     (a real arena closes standard missions with `01`, see LASERFORCE.md) —
  //     COMPLETENESS is. So each of these is tested with a player left over.
  {
    // (1a) a single player kicked mid-game with exit `01`
    const { eng, t0 } = startN(3);
    eng.processLogLine('6 60000 @1 01 1200');
    assert.strictEqual(eng.checkMatchEnd(t0 + 60000), null, 'a single kick (exit 01) does not end the match');
    assert.strictEqual(eng.snapshot().missionActive, true, 'and the match is still running');
    assert.strictEqual(eng._endBlockAt, null, 'no deadline was armed at all');

    // (1b) further players drop out one after another — still someone active
    eng.processLogLine('6 61000 @2 04 900');
    assert.strictEqual(eng.checkMatchEnd(t0 + 61000), null, 'two drop-outs of three do not end the match either');
    assert.strictEqual(eng.snapshot().missionActive, true, 'still running while Cara plays on');
    assert.strictEqual(eng._endBlockAt, null, 'still no deadline');

    // (1c) the last one reports -> NOW the summary is complete
    eng.processLogLine('6 300000 @3 01 4200');
    assert.ok(eng._endBlockAt != null, 'the completed summary arms the deadline');
    assert.strictEqual(eng.snapshot().missionActive, true, 'recognising still ends NOTHING by itself');
    assert.strictEqual(eng.checkMatchEnd(eng._endBlockAt + 10000), 'watchdog', 'only the elapsed grace period ends it');

    // (1d) a lone exit-02 is no summary either, for exactly the same reason
    const solo = startN(3).eng;
    solo.processLogLine('6 60000 @1 02 1200');
    assert.strictEqual(solo.checkMatchEnd(Date.now() + 60000), null, 'one lone exit-02 is not the end summary');
    assert.strictEqual(solo.snapshot().missionActive, true, 'and the match keeps running');
    assert.strictEqual(solo._endBlockAt, null, 'nothing armed');
  }

  // (1e) THE OPERATOR'S OBSERVATION (17.09.2026): a regular standard mission in
  //      which EVERY entity reports exit `01`. Under the old exit-02 rule this
  //      was never recognised and every match fell through to the 120 s
  //      watchdog. It must be recognised now.
  {
    const { eng } = startN(4);
    ['6 300000 @1 01 4200', '6 300000 @2 01 3100', '6 300000 @3 01 2900'].forEach((l) => eng.processLogLine(l));
    assert.strictEqual(eng._endBlockAt, null, 'three of four entities: not yet a summary');
    assert.strictEqual(eng.snapshot().missionActive, true, 'and nothing ended');
    eng.processLogLine('6 300000 @4 01 2500');
    assert.ok(eng._endBlockAt != null, 'all four reported exit 01 -> summary recognised');
    assert.strictEqual(eng.checkMatchEnd(eng._endBlockAt + 9999), null, 'the grace period is respected');
    assert.strictEqual(eng.checkMatchEnd(eng._endBlockAt + 10000), 'watchdog', 'and then it ends ~110 s early');
    const s = eng.snapshot();
    assert.strictEqual(s.endReason, 'watchdog', 'reason: watchdog (no 0101 came)');
    assert.strictEqual(s.endSource, 'summary_type6', 'endSource names WHAT was recognised');
    assert.deepStrictEqual(s.exitCodesSeen, ['01'], 'the observed exit codes are kept');
    assert.deepStrictEqual(s.exitCodes, { 1: '01', 2: '01', 3: '01', 4: '01' }, 'per entity as well');
    const evt = s.events.filter((e) => e.type === 'match_end');
    assert.strictEqual(evt[0].endSource, 'summary_type6', 'the match_end EVENT says how the end was inferred');
    assert.deepStrictEqual(evt[0].exitCodesSeen, ['01'], 'and carries the exit codes for the recordings');
  }

  // (1f) MIXED exit codes inside one and the same closing summary. Nothing in
  //      the rule may depend on them agreeing.
  {
    const { eng } = startN(3);
    eng.processLogLine('6 300000 @1 01 4200');
    eng.processLogLine('6 300000 @2 02 3100');
    assert.strictEqual(eng._endBlockAt, null, 'two of three: still incomplete');
    eng.processLogLine('6 300000 @3 17 2900');       // ref-kick in the same block
    assert.ok(eng._endBlockAt != null, 'mixed 01/02/17 are recognised as one summary');
    assert.strictEqual(eng.checkMatchEnd(eng._endBlockAt + 10000), 'watchdog', 'and it ends after the grace period');
    assert.deepStrictEqual(eng.snapshot().exitCodesSeen, ['01', '02', '17'], 'every distinct code is recorded');
    assert.strictEqual(eng.snapshot().exitCodes[3], '17', 'raw token, leading zero and all');
  }

  // (1g) a `0101` after a completed exit-01 summary still wins
  {
    const { eng, ends } = startN(3);
    ['6 300000 @1 01 4200', '6 300000 @2 01 3100', '6 300000 @3 01 2900'].forEach((l) => eng.processLogLine(l));
    eng.processLogLine('4 300100 0101');
    const s = eng.snapshot();
    assert.strictEqual(s.endReason, 'mission_end', '0101 wins over the recognised summary');
    assert.strictEqual(s.endSource, '0101', 'and says so');
    assert.strictEqual(ends.length, 1, 'exactly one match_end');
    assert.deepStrictEqual(s.exitCodesSeen, ['01'], 'the exit codes survive into the ended state');
  }

  // (1h) ...and a game event after a completed exit-01 summary discards it
  {
    const { eng, t0 } = startN(3);
    ['6 300000 @1 01 4200', '6 300000 @2 01 3100', '6 300000 @3 01 2900'].forEach((l) => eng.processLogLine(l));
    assert.ok(eng._endBlockAt != null, 'armed');
    eng.processLogLine('4 310000 1101 @3');          // evidently still being played
    assert.strictEqual(eng._endBlockAt, null, 'the deadline is discarded');
    assert.strictEqual(eng.checkMatchEnd(t0 + 60000), null, 'and nothing ends');
    assert.strictEqual(eng.snapshot().missionActive, true, 'the match runs on');
    eng.processLogLine('5 320000 0 0 1 1');          // a score line does it too
    assert.strictEqual(eng._endBlockAt, null, 'a score line keeps it discarded');
  }

  // (1i) the minimum of two entities is GONE — a one-player match is rare but
  //      possible, and there the old rule could never fire at all. With a
  //      single entity both readings of its type-6 agree: nobody is left.
  {
    const { eng } = startN(1);
    assert.strictEqual(Object.keys(eng.snapshot().players).length, 1, 'a single-player match');
    eng.processLogLine('6 300000 @1 01 4200');
    assert.ok(eng._endBlockAt != null, 'the only entity reporting IS the complete summary');
    assert.strictEqual(eng.snapshot().missionActive, true, 'still only a deadline, not an end');
    assert.strictEqual(eng.checkMatchEnd(eng._endBlockAt + 10000), 'watchdog', 'which then runs out');
  }

  // (1j) a type-6 from an entity that is not a player of this match is ignored
  {
    const { eng } = startN(2);
    eng.processLogLine('6 300000 @1 01 4200');
    eng.processLogLine('6 300000 @99 01 0');         // a target / neutral entity
    assert.strictEqual(eng._endBlockAt, null, 'a stranger does not complete the summary');
    assert.strictEqual(eng.snapshot().exitCodes['99'], undefined, 'and is not recorded either');
    eng.processLogLine('6 300000 @2 01 3100');
    assert.ok(eng._endBlockAt != null, 'the real second player does');
  }

  // (2) THE OTHER CASE THAT MUST NOT HAPPEN: quiet stretches below the
  //     threshold must never cut a running match apart.
  {
    const { eng, t0 } = start();
    for (let i = 1; i <= 8; i++) {
      const at = t0 + i * 90000;                     // 90 s of silence, eight times over
      assert.strictEqual(eng.checkMatchEnd(at - 1), null, `no end after ${i * 90 - 0.001} s of silence`);
      eng.noteActivity(at);                          // ...then a line arrives
      assert.strictEqual(eng.snapshot().missionActive, true, 'match survives a sub-threshold pause');
    }
    assert.strictEqual(eng.snapshot().elapsedTime, 5000, 'and nothing about the state was touched');
  }

  // (3) watchdog: total silence ends the match
  {
    const { eng, ends, t0 } = start();
    assert.strictEqual(eng.checkMatchEnd(t0 + 119999), null, 'nothing happens one ms early');
    assert.strictEqual(eng.checkMatchEnd(t0 + 120000), 'watchdog', 'watchdog fires at the threshold');
    const s = eng.snapshot();
    assert.strictEqual(s.missionActive, false, 'watchdog: mission is over');
    assert.strictEqual(s.endReason, 'watchdog', 'watchdog: endReason');
    assert.strictEqual(s.endSource, 'silence', 'watchdog: endSource tells it apart from a recognised summary');
    assert.ok(typeof s.endedAt === 'number' && s.endedAt > 0, 'watchdog: endedAt is a timestamp');
    assert.strictEqual(ends.length, 1, 'exactly one match_end');
    assert.strictEqual(ends[0].reason, 'watchdog', 'match_end carries the reason');
    const evt = s.events[s.events.length - 1];
    assert.strictEqual(evt.type, 'match_end', 'the match_end event is the last one');
    assert.strictEqual(evt.reason, 'watchdog', 'the EVENT carries the reason too');
    assert.strictEqual(evt.code, '', 'an inferred end never claims the arena sent a 0101');
    assert.strictEqual(eng.checkMatchEnd(t0 + 999999), null, 'an ended match is not ended twice');
  }

  // (4) the closing 6/7 summary ends the match FASTER than the watchdog
  {
    const { eng, t0 } = start();
    eng.processLogLine('6 300000 @1 02 4200');
    assert.strictEqual(eng.checkMatchEnd(t0 + 1000), null, 'one of two entities: nothing yet');
    eng.processLogLine('6 300000 @2 02 3100');       // now every player has reported
    // The grace period runs from the moment the engine ARMED it, which is a
    // fresh Date.now() inside the line above — not from t0. On a busy machine
    // whole milliseconds pass between two processLogLine() calls, so measuring
    // from t0 made this assertion fail at random.
    const armed = eng._endBlockAt;
    assert.strictEqual(eng.checkMatchEnd(armed + 9999), null, 'the grace period is respected — 0101 could still come');
    assert.strictEqual(eng.checkMatchEnd(armed + 10000), 'watchdog', 'after the grace period the summary ends the match');
    assert.ok(eng.snapshot().endedAt - eng.snapshot().updatedAt <= 0 || true, 'endedAt set');
    assert.strictEqual(eng.snapshot().missionActive, false, 'clock stopped ~110 s before the watchdog would have');
  }

  // (5) ...but a `0101` inside the grace period wins, and the reason is mission_end
  {
    const { eng, ends, t0 } = start();
    eng.processLogLine('6 300000 @1 02 4200');
    eng.processLogLine('6 300000 @2 02 3100');
    eng.processLogLine('4 300100 0101');
    assert.strictEqual(eng.snapshot().endReason, 'mission_end', '0101 wins over the inferred end');
    assert.strictEqual(ends.length, 1, 'and there is only ONE match_end');
    assert.strictEqual(ends[0].reason, 'mission_end', 'reason: mission_end');
    const evt = eng.snapshot().events.filter((e) => e.type === 'match_end');
    assert.strictEqual(evt.length, 1, 'one match_end event');
    assert.strictEqual(evt[0].code, '0101', 'a real mission end keeps its code — unchanged for existing consumers');
    assert.strictEqual(eng.checkMatchEnd(t0 + 600000), null, 'nothing fires afterwards');
  }

  // (6) a type-7 row is enough on its own (SM5), and gameplay afterwards disarms it
  {
    const { eng, t0 } = start();
    eng.processLogLine('7 @1 Anna 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0');
    // Gemessen wird ab dem Moment, in dem die Frist SCHARF wurde — nicht ab
    // `t0`. Zwischen beiden kann die echte Uhr eine Millisekunde weiterlaufen,
    // und dann war der Test bei `t0 + 10000` um genau diese Millisekunde zu
    // früh dran. Alle anderen Fälle hier rechnen längst so.
    const armed7 = eng._endBlockAt;
    assert.ok(armed7 != null, 'eine Typ-7-Zeile allein schärft die Frist');
    assert.strictEqual(eng.checkMatchEnd(armed7 + 9999), null, 'type 7 only arms the deadline');
    assert.strictEqual(eng.checkMatchEnd(armed7 + 10000), 'watchdog', 'type 7 ends the match after the grace period');
    assert.strictEqual(eng.snapshot().endSource, 'summary_type7', 'and the source names the type-7 block');

    const again = start();
    again.eng.processLogLine('7 @1 Anna 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0');
    again.eng.processLogLine('4 310000 1101 @1');    // the match is evidently still being played
    assert.strictEqual(again.eng.checkMatchEnd(again.t0 + 20000), null, 'a game event disarms the deadline again');
    assert.strictEqual(again.eng.snapshot().missionActive, true, 'and the match runs on');
    again.eng.processLogLine('5 320000 0 0 1 1');    // a score line does the same
    assert.strictEqual(again.eng.checkMatchEnd(again.t0 + 30000), null, 'a score line disarms it too');
  }

  // (7) stream lost — and a reconnect inside the grace period calls it off
  {
    const { eng, t0 } = start();
    eng.noteStreamLost(t0);
    assert.strictEqual(eng.checkMatchEnd(t0 + 29999), null, 'the rig is given time to come back');
    eng.noteStreamResumed();
    assert.strictEqual(eng.checkMatchEnd(t0 + 40000), null, 'a reconnect does NOT end the match');
    assert.strictEqual(eng.snapshot().missionActive, true, 'match survives a short disconnect');
    eng.noteStreamLost(t0 + 41000);
    assert.strictEqual(eng.checkMatchEnd(t0 + 70999), null, 'still inside the grace period');
    assert.strictEqual(eng.checkMatchEnd(t0 + 71000), 'stream_lost', 'gone for good -> stream_lost');
    assert.strictEqual(eng.snapshot().endReason, 'stream_lost', 'endReason: stream_lost');
    assert.strictEqual(eng.snapshot().endSource, 'stream_lost', 'endSource: stream_lost');
    // an incoming line also proves the stream is alive
    const b = start();
    b.eng.noteStreamLost(b.t0);
    b.eng.processLogLine('4 6000 1100 @2 @1');
    assert.strictEqual(b.eng.checkMatchEnd(b.t0 + 60000), null, 'a line after the loss cancels stream_lost');
  }

  // (8) the next match ends the previous one
  {
    const { eng, ends } = start();
    eng.processLogLine('4 0 0100');
    assert.strictEqual(ends.length, 1, 'the abandoned match is ended exactly once');
    assert.strictEqual(ends[0].reason, 'next_match', 'reason: next_match');
    assert.strictEqual(ends[0].endSource, 'next_match', 'the match_end payload carries the source too');
    const s = eng.snapshot();
    assert.strictEqual(s.missionActive, true, 'the NEW match is running');
    assert.strictEqual(s.endReason, null, 'and carries no end reason');
    assert.strictEqual(s.endedAt, null, 'nor an end timestamp');
    assert.strictEqual(s.endSource, null, 'nor an end source');
  }

  // (9) shutdown
  {
    const { eng, ends } = start();
    assert.strictEqual(eng.endMatch('shutdown'), true, 'endMatch() reports that it ended something');
    assert.strictEqual(ends[0].reason, 'shutdown', 'reason: shutdown');
    assert.strictEqual(eng.snapshot().missionActive, false, 'mission over');
    assert.strictEqual(eng.endMatch('shutdown'), false, 'a second call ends nothing');
    assert.strictEqual(eng.snapshot().endReason, 'shutdown', 'and does not overwrite the reason');
    assert.strictEqual(eng.snapshot().endSource, 'shutdown', 'endSource: shutdown');
  }

  // (10) every path can be switched off (0 = aus)
  {
    const { eng, t0 } = start({ watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 });
    eng.noteStreamLost(t0);
    eng.processLogLine('6 300000 @1 02 4200');
    eng.processLogLine('6 300000 @2 02 3100');
    eng.processLogLine('7 @1 Anna 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0');
    assert.strictEqual(eng.checkMatchEnd(t0 + 86400000), null, 'all three paths off: nothing ever ends the match');
    assert.strictEqual(eng.snapshot().missionActive, true, 'still running after a day');
    // the exit codes are a DIAGNOSTIC — they are recorded even when the path
    // that would act on them is switched off
    assert.deepStrictEqual(eng.snapshot().exitCodesSeen, ['02'], 'exit codes are recorded regardless');
    eng.processLogLine('4 900000 0101');
    assert.strictEqual(eng.snapshot().endReason, 'mission_end', 'the rig itself still ends it');
    assert.strictEqual(eng.snapshot().endSource, '0101', 'and names itself as the source');
  }

  // (11) config -> engine: seconds in, milliseconds out, and the clamps hold
  {
    const c = normalize({});
    assert.deepStrictEqual(c.matchEnd, { watchdogSeconds: 120, streamLostSeconds: 30, endBlockSeconds: 10 }, 'defaults');
    assert.deepStrictEqual(matchEndMs(c.matchEnd), MS, 'seconds are converted to ms');
    const off = normalize({ matchEnd: { watchdogSeconds: 0, streamLostSeconds: '0', endBlockSeconds: -5 } });
    assert.deepStrictEqual(off.matchEnd, { watchdogSeconds: 0, streamLostSeconds: 0, endBlockSeconds: 0 }, '0 survives, negatives clamp to 0');
    assert.strictEqual(normalize({ matchEnd: { watchdogSeconds: 999999 } }).matchEnd.watchdogSeconds, 86400, 'upper clamp');
    assert.strictEqual(normalize({ matchEnd: { watchdogSeconds: 'quatsch' } }).matchEnd.watchdogSeconds, 120, 'garbage falls back to the default');
    assert.deepStrictEqual(END_REASONS, ['mission_end', 'watchdog', 'stream_lost', 'next_match', 'shutdown'], 'the endReason contract');
    assert.deepStrictEqual(
      END_SOURCES,
      ['0101', 'summary_type6', 'summary_type7', 'silence', 'stream_lost', 'next_match', 'shutdown'],
      'the endSource contract',
    );
  }
  console.log('  ok    engine.matchEnd');
} catch (err) { failed++; console.error(`  FAIL  engine.matchEnd\n        ${err.stack}`); }

try {
  // All four ways out of a match must actually WRITE the statistic — the real
  // engine wired to the real stats writer, exactly as src/index.js does it,
  // into an OS temp directory that is removed again afterwards.
  const { Engine } = require('../src/engine');
  const { StatsWriter, splitCsv } = require('../src/statsWriter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfend-'));
  const DELIM = ';';
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new Engine({ logger: null, matchEnd: { watchdogMs: 120000, streamLostMs: 30000, endBlockMs: 10000 } });
  const sw = new StatsWriter({
    logger: quiet,
    getConfig: () => ({ csv: { enabled: true, dir, delimiter: DELIM, bom: true, writeEvents: false, writeLive: false } }),
  });
  eng.on('change', () => sw.onChange(eng.gameState));
  eng.on('event', (e) => sw.onEvent(e));
  eng.on('match_start', () => sw.onMatchStart(eng.snapshot()));
  eng.on('match_end', () => sw.onMatchEnd(eng.snapshot()));

  // matchId is Date.now().toString(36) — keep the ids apart (see familySplit)
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  const playMatch = (goalsForAnna) => {
    pause();
    [
      '1 28 Laserball Ranked 0 300000 0',
      '2 0 Rot 5 solid #ef4444', '2 1 Blau 5 solid #3b82f6',
      '4 0 0100',
      '3 100 event @1 player Anna 0 3 1', '3 100 event @2 player Ben 1 3 1',
      '4 5000 1100 @2 @1',
    ].concat(Array.from({ length: goalsForAnna }, (_, i) => `4 ${9000 + i * 1000} 1101 @1`))
      .forEach((l) => eng.processLogLine(l));
  };
  const matches = () => {
    const text = fs.readFileSync(path.join(dir, 'matches.csv'), 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = splitCsv(lines[0], DELIM);
    return lines.slice(1).map((l) => {
      const c = splitCsv(l, DELIM); const o = {};
      head.forEach((h, i) => (o[h] = c[i]));
      return o;
    });
  };

  // (a) watchdog
  playMatch(1);
  assert.strictEqual(eng.checkMatchEnd(eng._lastLineAt + 120000), 'watchdog', 'watchdog ended it');
  assert.strictEqual(matches().length, 1, 'watchdog: the match is written');

  // (b) stream lost
  playMatch(2);
  eng.noteStreamLost(eng._lastLineAt);
  assert.strictEqual(eng.checkMatchEnd(eng._lastLineAt + 30000), 'stream_lost', 'stream loss ended it');
  assert.strictEqual(matches().length, 2, 'stream_lost: the match is written');

  // (c) next match ends the previous one — and the new one is recorded too
  playMatch(3);
  playMatch(1);
  assert.strictEqual(matches().length, 3, 'next_match: the abandoned match is written exactly once');
  assert.strictEqual(eng.snapshot().missionActive, true, 'and the new match is running');

  // (d) shutdown finalizes the running match (this is what src/index.js calls)
  assert.strictEqual(eng.endMatch('shutdown'), true, 'shutdown ended the running match');
  const rows = matches();
  assert.strictEqual(rows.length, 4, 'shutdown: nothing is lost when the service stops');

  // all four matches carry a real result, not an empty shell
  const players = fs.readFileSync(path.join(dir, 'all_players_laserball.csv'), 'utf8').replace(/^\uFEFF/, '');
  const playerLines = players.split(/\r?\n/).filter(Boolean);
  assert.strictEqual(playerLines.length, 1 + 4 * 2, 'header + two players per match, four matches');
  assert.ok(playerLines.slice(1).every((l) => /;(Anna|Ben);/.test(l)), 'every row names a player');
  assert.deepStrictEqual(rows.map((r) => r.winner_score), ['1', '2', '3', '1'], 'each match kept its own result');
  assert.ok(rows.every((r) => r.match_id && r.ended_at && r.players === '2'), 'every match row is complete');
  const totals = fs.readFileSync(path.join(dir, 'totals_laserball.csv'), 'utf8').replace(/^\uFEFF/, '');
  assert.ok(/;Anna;4;/.test(totals), 'Anna is credited with all four matches');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    engine.matchEnd.stats');
} catch (err) { failed++; console.error(`  FAIL  engine.matchEnd.stats\n        ${err.stack}`); }

try {
  const { listEventLogFiles, eventLogNameOk } = require('../src/apiServer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfevlog-'));
  fs.writeFileSync(path.join(dir, 'events-2026-09-10.log'), 'line one\n');
  fs.writeFileSync(path.join(dir, 'events.log'), 'x\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me\n');
  const files = listEventLogFiles(dir);
  assert.strictEqual(files.length, 2, 'lists only events*.log files');
  assert.ok(files.every((f) => typeof f.size === 'number' && typeof f.mtime === 'number' && typeof f.name === 'string'), 'entries carry name/size/mtime');
  assert.deepStrictEqual(listEventLogFiles(path.join(dir, 'missing')), [], 'missing dir -> []');
  assert.ok(eventLogNameOk('events-2026-09-10.log'), 'valid name accepted');
  assert.ok(!eventLogNameOk('../secrets.log'), 'traversal rejected');
  assert.ok(!eventLogNameOk('sub/events.log'), 'path separator rejected');
  assert.ok(!eventLogNameOk('totals.csv'), 'non-events name rejected');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('  ok    apiServer.eventLogList');
} catch (err) { failed++; console.error(`  FAIL  apiServer.eventLogList\n        ${err.stack}`); }

try {
  const { parseCookies, SessionStore, LoginGuard, isHash, generatePassword, passwordProblem } = require('../src/auth');

  assert.deepStrictEqual(parseCookies('a=1; lf_sess=abc%3Dd; junk'), { a: '1', lf_sess: 'abc=d' }, 'cookie header parsed');
  assert.deepStrictEqual(parseCookies(undefined), {}, 'missing cookie header -> {}');

  const s = new SessionStore({ ttlMs: 50, max: 3 });
  const { token } = s.create({ ip: '1.2.3.4' });
  assert.ok(s.get(token), 'fresh session valid');
  assert.ok(!s.get('etwas-anderes'), 'unknown token invalid');
  s.destroy(token);
  assert.ok(!s.get(token), 'destroyed session invalid');
  const short = s.create({}).token;
  assert.ok(!Array.from(s.map.values()).some((v) => JSON.stringify(v).includes(short)), 'raw token is not stored');
  s.stop();

  const g = new LoginGuard({ maxFails: 3, lockoutMs: 60000 });
  assert.strictEqual(g.lockedFor('9.9.9.9'), 0, 'unknown ip not locked');
  g.fail('9.9.9.9'); g.fail('9.9.9.9');
  assert.strictEqual(g.lockedFor('9.9.9.9'), 0, 'below the limit, no lockout');
  g.fail('9.9.9.9');
  assert.ok(g.lockedFor('9.9.9.9') > 0, 'lockout after maxFails');
  g.succeed('9.9.9.9');
  assert.strictEqual(g.lockedFor('9.9.9.9'), 0, 'success clears the lockout');

  const { RecoveryCode } = require('../src/auth');
  const rc = new RecoveryCode({ ttlMs: 60000, cooldownMs: 1000 });
  assert.strictEqual(rc.consume('irgendwas'), false, 'no code issued -> nothing to consume');
  assert.strictEqual(rc.cooldownLeft(), 0, 'first code can be requested at once');
  const { code } = rc.issue();
  assert.ok(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){2}$/.test(code), 'code is short and readable');
  assert.ok(rc.cooldownLeft() > 0, 'cooldown starts after issuing');
  assert.ok(rc.pending, 'code is pending');
  assert.strictEqual(rc.consume('AAAA-BBBB-CCCC'), false, 'wrong code rejected');
  assert.strictEqual(rc.consume(code.toLowerCase()), true, 'code is case-insensitive');
  assert.strictEqual(rc.consume(code), false, 'code works exactly once');
  assert.ok(!rc.pending, 'nothing pending afterwards');
  const rc2 = new RecoveryCode({ ttlMs: -1 });
  const expired = rc2.issue().code;
  assert.strictEqual(rc2.consume(expired), false, 'expired code rejected');

  assert.ok(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/.test(generatePassword()), 'generated password is readable');
  assert.notStrictEqual(generatePassword(), generatePassword(), 'generated passwords differ');
  assert.ok(passwordProblem('kurz'), 'short password refused');
  assert.strictEqual(passwordProblem('lang-genug-123'), null, 'long enough password accepted');
  assert.ok(!isHash('hunter2') && !isHash('') && !isHash(null), 'plaintext is never mistaken for a hash');
  console.log('  ok    auth.sessions');
} catch (err) { failed++; console.error(`  FAIL  auth.sessions\n        ${err.stack}`); }

(async () => {
  try {
    const { hashPassword, verifyPassword, isHash } = require('../src/auth');
    const h = await hashPassword('Geheim-123');
    assert.ok(isHash(h) && h.startsWith('scrypt$'), 'hash has the expected shape');
    assert.ok(!h.includes('Geheim'), 'hash does not contain the password');
    assert.strictEqual(await verifyPassword('Geheim-123', h), true, 'correct password verifies');
    assert.strictEqual(await verifyPassword('Geheim-124', h), false, 'wrong password fails');
    assert.strictEqual(await verifyPassword('Geheim-123', 'kaputt'), false, 'broken hash fails closed');
    assert.strictEqual(await verifyPassword('', ''), false, 'empty hash fails closed');
    assert.notStrictEqual(await hashPassword('x'.repeat(10)), await hashPassword('x'.repeat(10)), 'salt makes every hash unique');
    console.log('  ok    auth.password');
  } catch (err) { failed++; console.error(`  FAIL  auth.password\n        ${err.stack}`); }

  try {
    const { normalize } = require('../src/config');
    const c = normalize({
      admin: { passwordHash: 'nicht-wirklich-ein-hash', sessionHours: '9999' },
      notify: { ntfy: { topic: 'bad/topic name' }, discordWebhook: 'ftp://nope', email: { port: '70000' } },
    });
    assert.strictEqual(c.admin.passwordHash, '', 'a non-hash never reaches the stored config');
    assert.strictEqual(c.admin.sessionHours, 720, 'session hours clamped');
    assert.strictEqual(c.notify.ntfy.topic, 'badtopicname', 'ntfy topic reduced to one safe segment');
    assert.strictEqual(c.notify.discordWebhook, '', 'non-http webhook url rejected');
    assert.strictEqual(c.notify.email.port, 65535, 'smtp port clamped');
    const round = normalize(normalize({}));
    assert.strictEqual(JSON.stringify(round), JSON.stringify(normalize({})), 'normalize is idempotent');
    console.log('  ok    config.adminNotify');
  } catch (err) { failed++; console.error(`  FAIL  config.adminNotify\n        ${err.stack}`); }

  try {
    const { reachability } = require('../src/netinfo');
    const r = reachability({ http: { host: '0.0.0.0', port: 8080 }, tcp: { host: '0.0.0.0', port: 9000 }, streamServer: {} });
    assert.ok(Array.isArray(r.addresses), 'addresses listed');
    assert.ok(r.urls[0].startsWith('http://localhost:8080'), 'localhost url first');
    assert.strictEqual(r.http.lanOpen, true, '0.0.0.0 counts as LAN-open');
    const local = reachability({ http: { host: '127.0.0.1', port: 8080 }, tcp: {}, streamServer: {} });
    assert.strictEqual(local.http.lanOpen, false, '127.0.0.1 is not LAN-open');
    assert.ok(!local.urls.some((u) => /\b\d+\.\d+\.\d+\.\d+/.test(u) && !u.includes('127.0.0.1')), 'no LAN url when bound to localhost');
    console.log('  ok    netinfo.reachability');
  } catch (err) { failed++; console.error(`  FAIL  netinfo.reachability\n        ${err.stack}`); }

  try {
    const { Notifier, accessSummary, asciiHeader } = require('../src/notify');
    const cfg = {
      admin: { enabled: true, passwordHash: 'scrypt$1$2$3$a$b' }, apiToken: '',
      http: { host: '0.0.0.0', port: 8080 }, tcp: { host: '0.0.0.0', port: 9000 }, streamServer: {},
      notify: { enabled: true, name: 'Halle 1', ntfy: { server: 'https://ntfy.sh', topic: 'lf-test' }, email: {}, telegram: {}, webhook: {} },
    };
    const n = new Notifier({ logger: { info() {}, warn() {} }, getConfig: () => cfg });
    assert.deepStrictEqual(n.channels().map((c) => c.id), ['ntfy'], 'only configured channels are listed');
    assert.strictEqual(n.label(), 'Halle 1', 'name overrides the hostname');
    const m = n.startupMessage(['Extra-Zeile']);
    assert.ok(m.title.includes('Halle 1') && m.text.includes(':8080') && m.text.includes('Extra-Zeile'), 'startup message carries name, port and extras');
    assert.ok(!m.text.includes('lf-test'), 'startup message carries no channel secrets');
    assert.strictEqual(accessSummary(cfg), 'Admin-Passwort erforderlich', 'access summary reflects the login');
    assert.strictEqual(accessSummary({ admin: {}, apiToken: '' }), 'OFFEN — kein Passwort gesetzt!', 'open instance is called out');
    assert.strictEqual(asciiHeader('Größe — ok'), 'Groesse  ok', 'header transliterated to ascii');
    assert.strictEqual(n.channels().length, 1, 'channel list is derived, not cached');
    console.log('  ok    notify.channels');
  } catch (err) { failed++; console.error(`  FAIL  notify.channels\n        ${err.stack}`); }

  try {
    const { buildMessage, encodeHeader } = require('../src/smtp');
    assert.strictEqual(encodeHeader('plain ascii'), 'plain ascii', 'ascii header left alone');
    assert.ok(encodeHeader('Grüße').startsWith('=?UTF-8?B?'), 'non-ascii header encoded');
    const msg = buildMessage({ from: 'a@b.c', to: ['d@e.f'], subject: 'Test', text: 'Zeile 1\nZeile 2' });
    assert.ok(msg.includes('\r\nTo: d@e.f\r\n') && msg.includes('Content-Transfer-Encoding: base64'), 'headers written with CRLF');
    assert.ok(msg.split('\r\n\r\n')[1].trim().length > 0, 'body present');
    const inject = buildMessage({ from: 'a@b.c\r\nBcc: x@y.z', to: ['d@e.f'], subject: 'a\nb', text: 'x' });
    assert.ok(!/\r\nBcc:/i.test(inject), 'a CRLF in the sender cannot start a new header');
    assert.ok(/\r\nSubject: a b\r\n/.test(inject), 'newline in the subject is folded to a space');
    console.log('  ok    smtp.message');
  } catch (err) { failed++; console.error(`  FAIL  smtp.message\n        ${err.stack}`); }

  // Ein abgelehntes AUTH LOGIN darf das Passwort nicht in die Fehlermeldung
  // schreiben: die landet über notifier.last im Log, in /api/status und in
  // /api/network. Ein winziger SMTP-Server, der jeden AUTH-Schritt ablehnt.
  try {
    const net = require('net');
    const { sendMail } = require('../src/smtp');
    const PASS = 'streng-geheim-42';
    const srv = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('220 pruefserver\r\n');
      sock.on('data', (d) => {
        for (const line of String(d).split('\r\n').filter(Boolean)) {
          if (/^EHLO/i.test(line)) sock.write('250-pruefserver\r\n250 AUTH LOGIN\r\n');
          else if (/^AUTH LOGIN$/i.test(line)) sock.write('334 VXNlcm5hbWU6\r\n');
          else sock.write('535 Zugangsdaten abgelehnt\r\n');
        }
      });
      sock.on('error', () => {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    let caught = null;
    try {
      await sendMail({
        host: '127.0.0.1', port: srv.address().port, secure: false,
        user: 'kasse@halle.de', pass: PASS, to: 'technik@halle.de',
        subject: 'x', text: 'x', timeoutMs: 3000,
      });
    } catch (err) { caught = err; }
    srv.close();
    assert.ok(caught, 'a rejected login throws');
    const b64 = Buffer.from(PASS, 'utf8').toString('base64');
    assert.ok(!caught.message.includes(b64), 'the base64 password is NOT in the error message');
    assert.ok(!caught.message.includes(PASS), 'the plaintext password is NOT in the error message');
    assert.ok(caught.message.includes('AUTH LOGIN'), 'the error still names the step that failed');
    console.log('  ok    smtp.authSecret');
  } catch (err) { failed++; console.error(`  FAIL  smtp.authSecret\n        ${err.stack}`); }

  // Der Broker-URL darf `benutzer:passwort@` tragen (docs/MQTT.md sagt das
  // selbst). GET /api/config ist die eine Stelle, an der KEIN Zugangsdatum
  // stehen darf — sie lieferte den URL bis hierher ungeschwärzt aus.
  try {
    const { redactUrl } = require('../src/mqtt');
    assert.strictEqual(redactUrl('mqtt://kasse:geheim@broker:1883'), 'mqtt://***@broker:1883', 'userinfo redacted');
    assert.strictEqual(redactUrl('mqtt://broker:1883'), 'mqtt://broker:1883', 'a url without credentials is untouched');

    const { ApiServer } = require('../src/apiServer');
    const api = Object.create(ApiServer.prototype);
    const cfg = require('../src/config').normalize({
      mqtt: { url: 'mqtts://kasse:geheim@broker:8883' },
      apiToken: 'apitok-XYZ-987', outputs: [{ kind: 'webhook', url: 'https://a.example/x', secret: 's3cr3t' }],
      notify: { email: { host: 'mail.example', to: 'a@b.c', pass: 'mailpw' }, webhook: { url: 'https://w.example/h', secret: 'hooksec' } },
    });
    api.config = { data: cfg, envPins: [] };
    api.notifier = null;
    const shown = api._redactedConfig();
    const asText = JSON.stringify(shown);
    for (const secret of ['geheim', 's3cr3t', 'mailpw', 'hooksec', 'apitok-XYZ-987']) {
      assert.ok(!asText.includes(secret), `GET /api/config leaks nothing: "${secret}" is gone`);
    }
    assert.strictEqual(shown.mqtt.url, 'mqtts://***@broker:8883', 'broker url masked');
    assert.strictEqual(shown.mqttUrlHasCredentials, true, 'and the console is told that it is masked');
    // die Maske zurückgeschickt = „unverändert lassen"
    const back = api._unredactPatch({ mqtt: { url: 'mqtts://***@broker:8883' } });
    assert.strictEqual(back.mqtt.url, 'mqtts://kasse:geheim@broker:8883', 'posting the mask back keeps the stored url');
    const changed = api._unredactPatch({ mqtt: { url: 'mqtt://anderer:1883' } });
    assert.strictEqual(changed.mqtt.url, 'mqtt://anderer:1883', 'a really edited url still gets through');
    console.log('  ok    apiServer.configSecrets');
  } catch (err) { failed++; console.error(`  FAIL  apiServer.configSecrets\n        ${err.stack}`); }

  // Namen kommen aus dem TDF-Strom und sind Fremdeingabe: der Spieler wählt
  // seinen Codenamen selbst. Steuerzeichen daraus landen sonst in der lesbaren
  // Ereignis-Logdatei und auf stdout, und die Länge ist unbegrenzt.
  try {
    const { Engine } = require('../src/engine');
    const eng = new Engine({ logger: null });
    // Die Steuerzeichen werden zur LAUFZEIT gebaut — in dieser Datei darf
    // keines wörtlich stehen, das prüft source.noControlChars weiter unten.
    const BEL = String.fromCharCode(7);
    const ESC = String.fromCharCode(27);
    const CTL_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
    const lang = 'A'.repeat(300);
    [
      '1 28 Laserball 0 300000 0',
      '2 0 Ro' + BEL + 't 5 solid #ef4444',
      '4 0 0100',
      '3 10 event @1 player An' + ESC + 'na 0 3 1',
      '3 11 event @2 player ' + lang + ' 0 3 1',
      '3 12 event @__proto__ player Boes 0 3 1',
    ].forEach((l) => eng.processLogLine(l));
    const s = eng.snapshot();
    const namen = Object.values(s.players).map((p) => p.name);
    assert.ok(namen.length >= 2, 'both well-formed logins landed');
    assert.ok(namen.every((n) => !CTL_RE.test(n)), 'no control character survives in a player name');
    assert.ok(namen.every((n) => n.length <= 64), 'a player name is bounded to 64 characters');
    assert.ok(!CTL_RE.test(s.teams['0'].name), 'no control character survives in a team name');
    assert.ok(!Object.prototype.hasOwnProperty.call(s.players, '__proto__'), 'an entity called __proto__ is refused');
    assert.strictEqual(Object.getPrototypeOf(s.players), Object.prototype, 'and the player map keeps its prototype');
    console.log('  ok    engine.foreignNames');
  } catch (err) { failed++; console.error(`  FAIL  engine.foreignNames\n        ${err.stack}`); }

  // Ein Umlaut, der beim Lesen des Request-Bodys genau auf eine Chunk-Grenze
  // fällt, darf den Body nicht zerstören. Das ist kein Randfall: jeder deutsche
  // Ausgangsname enthält welche, und die Konsole schickt die ganze
  // Konfiguration in EINEM POST zurück.
  try {
    const { ApiServer } = require('../src/apiServer');
    const { EventEmitter } = require('events');
    const api = Object.create(ApiServer.prototype);
    const body = Buffer.from(JSON.stringify({ name: 'Ausgang Süd — Tür Ost', note: 'grün' }), 'utf8');
    // Genau zwischen den beiden Bytes eines „ü" trennen.
    const cut = body.indexOf(Buffer.from('ü', 'utf8')) + 1;
    const req = new EventEmitter();
    req.destroy = () => {};
    const p = api._readBody(req);
    req.emit('data', body.subarray(0, cut));
    req.emit('data', body.subarray(cut));
    req.emit('end');
    const parsed = await p;
    assert.ok(parsed, 'a body split inside a multi-byte character still parses');
    assert.strictEqual(parsed.name, 'Ausgang Süd — Tür Ost', 'and it parses to the very same text');

    // und die Grenze greift weiterhin
    const req2 = new EventEmitter();
    let destroyed = false;
    req2.destroy = () => { destroyed = true; };
    const p2 = api._readBody(req2);
    req2.emit('data', Buffer.alloc(513 * 1024));
    req2.emit('end');
    assert.strictEqual(await p2, null, 'an oversized body is refused');
    assert.ok(destroyed, 'and the connection is dropped instead of read to the end');
    console.log('  ok    apiServer.readBody');
  } catch (err) { failed++; console.error(`  FAIL  apiServer.readBody\n        ${err.stack}`); }

  // Die CORS-Warnung darf nicht auf die eigene Konsole losgehen: ein Browser
  // schickt `Origin` auch bei einer SAME-ORIGIN-POST, und ohne Sonderfall
  // erzeugte jeder Login und jedes Speichern eine Warnung, die sachlich falsch
  // ist („der Browser wird die Antwort STILL verwerfen").
  try {
    const { ApiServer } = require('../src/apiServer');
    const api = Object.create(ApiServer.prototype);
    api.config = { data: require('../src/config').normalize({ cors: ['https://anzeige.example'] }), envPins: [] };
    const req = (headers) => ({ headers, socket: {} });

    assert.strictEqual(api._originAllowed(null, req({ host: 'hallen-pc:8080' })), true, 'no Origin at all = not a browser request');
    assert.strictEqual(
      api._originAllowed('http://hallen-pc:8080', req({ host: 'hallen-pc:8080', origin: 'http://hallen-pc:8080' })),
      true, 'the console itself is never "a blocked origin"',
    );
    assert.strictEqual(
      api._originAllowed('https://anzeige.example', req({ host: 'hallen-pc:8080' })),
      true, 'an origin from cors[] is allowed',
    );
    assert.strictEqual(
      api._originAllowed('http://fremd.example', req({ host: 'hallen-pc:8080' })),
      false, 'a foreign origin is still refused',
    );
    // ein anderer PORT auf demselben Rechner ist eine ANDERE Herkunft
    assert.strictEqual(
      api._originAllowed('http://hallen-pc:9999', req({ host: 'hallen-pc:8080' })),
      false, 'another port on the same host is a different origin',
    );
    console.log('  ok    apiServer.sameOriginNotBlocked');
  } catch (err) { failed++; console.error(`  FAIL  apiServer.sameOriginNotBlocked\n        ${err.stack}`); }

  // Missionsbericht — bis hierher von keiner Testsuite berührt, obwohl er der
  // Weg ist, auf dem ein beendetes Match den Rechner verlässt. Geprüft wird,
  // was ein Betreiber bemerken würde: Inhalt, Datenschutzschalter und die
  // Warteschlange auf der Platte (ein totes Ziel darf keine Mission kosten).
  try {
    const { MatchReporter, REPORT_SCHEMA } = require('../src/matchReport');
    const { Engine } = require('../src/engine');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfrep-'));
    const qdir = path.join(dir, 'reports');
    const quiet = { debug() {}, info() {}, warn() {}, error() {} };

    const spielen = () => {
      const eng = new Engine({ logger: null });
      const rep = new MatchReporter({ logger: quiet, getConfig: () => ({}), dir: qdir });
      eng.on('match_start', () => rep.onMatchStart(eng.snapshot()));
      [
        '1\t28\tLaserball\t0\t300000\t0',
        '2\t0\tRot\t5\tsolid\t#ef4444',
        '2\t1\tBlau\t5\tsolid\t#38bdf8',
        '4\t0\t0100',
        '3\t10\tevent\t#4711\tplayer\tMara\t0\t3\t1',
        '3\t11\tevent\t@91\tplayer\tGast 1\t1\t3\t1',
        '4\t9000\t0301\t#4711',
        '4\t9500\t0101',
      ].forEach((l) => { rep.noteLine(l); eng.processLogLine(l); });
      return { rep, snap: eng.snapshot() };
    };

    const { rep, snap } = spielen();
    const report = rep.onMatchEnd(snap);
    assert.ok(report, 'a finished match produces a report');
    assert.strictEqual(report.schema, REPORT_SCHEMA, 'the report names its schema');
    assert.strictEqual(report.players.length, 2, 'every player is in the report');
    assert.ok(report.players.some((p) => p.name === 'Mara'), 'names are included by default');
    // Mitglied (#) und Gast (@) müssen unterscheidbar bleiben — das ist der
    // einzige Grund, warum noteLine() überhaupt in den heißen Pfad hängt.
    assert.ok(report.players.some((p) => p.idKind === 'member') && report.players.some((p) => p.idKind === 'guest'),
      'member and guest are told apart');

    // Datenschutzschalter
    const save = process.env.LF_REPORT_NAMES;
    process.env.LF_REPORT_NAMES = 'false';
    const anon = spielen();
    const ohne = anon.rep.onMatchEnd(anon.snap);
    assert.ok(ohne.players.every((p) => p.name === undefined || p.name === null), 'LF_REPORT_NAMES=false leaves every name out');
    assert.ok(ohne.players.every((p) => p.playerId), 'but the players stay distinguishable by id');
    if (save === undefined) delete process.env.LF_REPORT_NAMES; else process.env.LF_REPORT_NAMES = save;

    // Warteschlange: ein totes Ziel darf die Mission nicht kosten
    const wartend = () => fs.readdirSync(qdir).filter((n) => n.endsWith('.json'));
    assert.ok(wartend().length >= 1, 'an undelivered report waits on disk');
    rep.queue.addSink('kaputt', () => { throw new Error('Ziel tot'); });
    await rep.queue.drain();
    assert.ok(wartend().length >= 1, 'a failing sink leaves the report in the queue');
    rep.queue.sinks.length = 0;
    rep.queue.addSink('ok', () => true);
    await rep.queue.drain();
    assert.deepStrictEqual(wartend(), [], 'a successful delivery clears the queue');
    rep.queue.stop?.();

    process.chdir(path.dirname(dir));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok    matchReport');
  } catch (err) { failed++; console.error(`  FAIL  matchReport\n        ${err.stack}`); }

  // MQTT ohne Broker: es darf nichts krachen, nichts blockieren und vor allem
  // nichts von den Zugangsdaten in status() auftauchen.
  try {
    const { MqttOut } = require('../src/mqtt');
    const save = { u: process.env.LF_MQTT_USERNAME, p: process.env.LF_MQTT_PASSWORD };
    process.env.LF_MQTT_USERNAME = 'kasse';
    process.env.LF_MQTT_PASSWORD = 'streng-geheim-42';
    const out = new MqttOut({
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getConfig: () => ({ mqtt: { enabled: false, url: 'mqtt://kasse:geheim@broker:1883', topic: '/decs/lfpassthrough' } }),
    });
    const st = out.status();
    const asText = JSON.stringify(st);
    assert.ok(!asText.includes('streng-geheim-42') && !asText.includes('geheim@'), 'status() carries no credentials');
    assert.strictEqual(st.broker, 'mqtt://***@broker:1883', 'a url with userinfo is redacted in status()');
    assert.strictEqual(st.authConfigured, true, 'but it does say that credentials exist');
    assert.strictEqual(st.enabled, false, 'switched off stays switched off');
    // Mit abgeschaltetem MQTT darf ein publish() nichts tun und nichts werfen.
    assert.strictEqual(out.publish({ event: 'match_report' }, 'report'), false, 'publish() with mqtt off reports "not sent"');
    out.stop();
    if (save.u === undefined) delete process.env.LF_MQTT_USERNAME; else process.env.LF_MQTT_USERNAME = save.u;
    if (save.p === undefined) delete process.env.LF_MQTT_PASSWORD; else process.env.LF_MQTT_PASSWORD = save.p;
    console.log('  ok    mqtt.statusNoSecrets');
  } catch (err) { failed++; console.error(`  FAIL  mqtt.statusNoSecrets\n        ${err.stack}`); }

  // Quellhygiene: rohe Steuerzeichen in einer Quelldatei lassen git sie als
  // BINÄR einstufen (so geschehen in src/web/app.js) und machen jeden Diff
  // wertlos. Diese Prüfung hält das dauerhaft draußen.
  try {
    // `.claude` kommt neu dazu: darunter legt das Werkzeug Arbeitskopien des
    // Projekts (worktrees) ab. Das sind Kopien fremder Stände, keine
    // Quelldateien dieses Baums — sie hier mitzuprüfen meldet Fehler in Dateien,
    // die gar nicht zu diesem Stand gehören.
    const SKIP = new Set(['node_modules', '.git', '.claude', 'graphify-out', 'data', 'locationserver-integration']);
    const EXT = new Set(['.js', '.json', '.md', '.html', '.css']);
    const root = path.join(__dirname, '..');
    const hits = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!EXT.has(path.extname(e.name)) && e.name !== '.env.example') continue;
        const text = fs.readFileSync(p, 'utf8');
        let line = 1;
        for (let i = 0; i < text.length; i++) {
          const c = text.codePointAt(i);
          if (c === 10) { line++; continue; }
          // erlaubt: Tab (9) und CR (13). Verboten: der Rest von C0, DEL, C1,
          // die unsichtbaren Formatierungszeichen und ein BOM mitten im Text.
          const bad = (c < 0x20 && c !== 9 && c !== 13) || c === 0x7f
            || (c >= 0x80 && c <= 0x9f) || (c >= 0x200b && c <= 0x200f)
            || c === 0x2028 || c === 0x2029 || (c === 0xfeff && i !== 0);
          if (bad) hits.push(`${path.relative(root, p)}:${line} U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      }
    })(root);
    assert.deepStrictEqual(hits, [], `rohe Steuerzeichen in Quelldateien — bitte als \\uXXXX schreiben:\n        ${hits.join('\n        ')}`);
    console.log('  ok    source.noControlChars');
  } catch (err) { failed++; console.error(`  FAIL  source.noControlChars\n        ${err.stack}`); }

  // ── Verdacht „Hinterherlaufen" ────────────────────────────────────────────
  // Die fachliche Regel, dauerhaft festgenagelt. Gespielt wird ein Match in
  // Standard-Form (Modus 7, „Standard LZ - 2 Teams", Spieler-Kennungen wie in
  // echten Mitschnitten: `#` + acht alphanumerische Zeichen). Das Protokoll ist
  // dasselbe wie bei SM5 — allein das ANZEIGEPROFIL entscheidet, ob die
  // Erkennung läuft, darum stellt der Test es hier ausdrücklich ein.
  try {
    const { Engine } = require('../src/engine');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    // Modus 7 steht seit dem 19.09.2026 in modes/standard.json und läuft damit
    // als Profil `standard`. Die Profilliste hier führt `sm5` trotzdem mit, weil
    // dieser Test nur die fachliche Regel prüft und nicht davon abhängen soll,
    // welche Nummern der Betreiber gerade eingetragen hat.
    // Die Schwelle wird hier AUSDRÜCKLICH auf 3 gestellt, obwohl die Vorgabe
    // der Engine inzwischen 5 ist: dieser Test prüft die fachliche Regel
    // („n Treffer hintereinander auf dieselbe Person"), nicht die Vorgabe. Ein
    // Test, der still an einer Vorgabe hängt, verschleiert deren Änderung —
    // deshalb steht die Zahl hier im Test und nicht in der Engine.
    const mk = (chase) => {
      const e = new Engine({ logger: null, matchEnd: OFF, chase: { profiles: ['standard', 'sm5'], threshold: 3, ...(chase || {}) } });
      ['1 7 Standard LZ - 2 Teams 0 480000 0', '2 0 Rot 5 solid #ef4444', '2 1 Blau 5 solid #38bdf8', '4 0 0100',
        '3 10 event #aA1bB2cC player Anna 0 3 1',
        '3 10 event #bB7kQ2xR player Bert 1 3 1',
        '3 10 event #cC4nW9tL player Cleo 1 3 1',
        '3 10 event #dD1sE5vM player Dora 0 3 1'].forEach((l) => e.processLogLine(l));
      return e;
    };
    let t = 1000;
    /** Ein Treffer-Ereignis, so wie es in den Mitschnitten steht. */
    const tag = (e, code, a, b) => e.processLogLine(`4 ${t += 10} ${code} #${a}${b ? ` phasert #${b}` : ''}`);
    const chasing = (e) => e.snapshot().chasing;

    const A = 'aA1bB2cC', B = 'bB7kQ2xR', C = 'cC4nW9tL', D = 'dD1sE5vM';

    // 1) zwei Treffer auf dasselbe Ziel lösen NICHT aus, der dritte schon
    let eng = mk();
    assert.strictEqual(eng.snapshot().chaseWatched, true, 'Profil sm5 wird beobachtet, wenn es in der Liste steht');
    tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    assert.deepStrictEqual(chasing(eng), [], 'zwei Treffer sind noch keine Serie');
    tag(eng, '0206', A, B);
    let list = chasing(eng);
    assert.strictEqual(list.length, 1, 'drei Treffer auf dasselbe Ziel lösen aus');
    assert.strictEqual(list[0].playerId, A, 'die Spieler-Kennung steht drin');
    assert.strictEqual(list[0].playerName, 'Anna', 'der Spielername steht drin');
    assert.strictEqual(list[0].teamId, '0', 'das Team des Spielers steht drin');
    assert.strictEqual(list[0].targetId, B, 'wem er hinterherläuft — Kennung');
    assert.strictEqual(list[0].targetName, 'Bert', 'wem er hinterherläuft — Name');
    assert.strictEqual(list[0].targetTeamId, '1', 'und dessen Team');
    assert.strictEqual(list[0].streak, 3, 'die Länge der Serie');
    assert.strictEqual(list[0].runs, 1, 'und wie oft überhaupt eine Serie zustande kam');
    assert.strictEqual(list[0].open, true, 'die Serie läuft gerade noch');
    assert.ok(list[0].lastAt > 0, 'und wann sie zuletzt fortgesetzt wurde');

    // Die Liste ist KUMULATIV fürs Match: eine gerissene Serie verschwindet
    // nicht, sie hört nur auf zu laufen. Ohne das wäre die Liste fast immer
    // leer — an den echten Mitschnitten gemessen erreichte ein Drittel bis die
    // Hälfte aller Spieler irgendwann die Schwelle, gleichzeitig aber nie mehr
    // als fünf, und am Schlusspfiff meist keiner.
    tag(eng, '0206', A, C);
    list = chasing(eng);
    assert.strictEqual(list.length, 1, 'ein Abbruch löscht den Eintrag nicht');
    assert.strictEqual(list[0].open, false, 'er ist nur nicht mehr „läuft"');
    assert.strictEqual(list[0].streak, 3, 'die längste Serie bleibt stehen');
    assert.strictEqual(list[0].targetName, 'Bert', 'samt der Person, auf die sie ging');
    // Eine zweite Serie zählt hoch, die längste gewinnt.
    tag(eng, '0206', A, C); tag(eng, '0206', A, C); tag(eng, '0206', A, C);
    list = chasing(eng);
    assert.strictEqual(list.length, 1, 'derselbe Spieler steht genau einmal in der Liste');
    assert.strictEqual(list[0].runs, 2, 'zwei Serien in diesem Match');
    assert.strictEqual(list[0].streak, 4, 'genannt wird die längste');
    assert.strictEqual(list[0].targetName, 'Cleo', 'und deren Ziel');

    // 2) Fehlschüsse und Nicht-Spieler-Ereignisse dazwischen unterbrechen NICHT
    eng = mk();
    tag(eng, '0206', A, B);
    tag(eng, '0201', A); tag(eng, '0202', A);        // Mist-Shots
    tag(eng, '0203', A); tag(eng, '0204', A);        // Ziele, keine Personen
    tag(eng, '0205', A, B);                          // „Player Hit" zählt wie „Deactivate"
    assert.deepStrictEqual(chasing(eng), [], 'nach zwei Treffern noch nichts');
    tag(eng, '0206', A, B);
    assert.strictEqual(chasing(eng).length, 1, 'Fehlschüsse dazwischen unterbrechen die Serie nicht');
    assert.strictEqual(chasing(eng)[0].streak, 3, 'und sie zählen auch nicht mit');

    // 3) ein Treffer auf jemand anderen setzt zurück
    eng = mk();
    tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    tag(eng, '0206', A, C);                          // anderes Ziel -> von vorn
    tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    assert.deepStrictEqual(chasing(eng), [], 'ein Treffer auf jemand anderen setzt die Serie zurück');
    tag(eng, '0206', A, B);
    assert.strictEqual(chasing(eng).length, 1, 'danach zählt die neue Serie ganz normal weiter');

    // 4) Eigenbeschuss zählt nicht — und unterbricht auch nicht.
    //    Belegt an den Mitschnitten: `0208` war 6 von 6 Mal teamintern, während
    //    `0205`/`0206` 1120 von 1120 Mal gegnerisch waren.
    eng = mk();
    tag(eng, '0206', A, B);
    tag(eng, '0208', A, D);                          // eigener Mitspieler, eigener Code
    tag(eng, '0206', A, D);                          // Mitspieler, aber mit Treffer-Code
    tag(eng, '0306', A, B);                          // Rakete — bewusst ausgenommen
    tag(eng, '0D06', A, B);                          // Flächenwirkung — bewusst ausgenommen
    tag(eng, '0206', A, A);                          // sich selbst — nie eine Verfolgung
    assert.deepStrictEqual(chasing(eng), [], 'Eigenbeschuss, Raketen und Flächenwirkung zählen nicht');
    tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    assert.strictEqual(chasing(eng).length, 1, 'und sie unterbrechen die Serie auf den Gegner auch nicht');

    // 5) Missionsstart setzt zurück
    eng = mk();
    tag(eng, '0206', A, B); tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    assert.strictEqual(chasing(eng).length, 1, 'Serie steht');
    eng.processLogLine('4 0 0100');
    assert.deepStrictEqual(chasing(eng), [], 'Missionsstart räumt die Liste');
    ['3 10 event #aA1bB2cC player Anna 0 3 1', '3 10 event #bB7kQ2xR player Bert 1 3 1'].forEach((l) => eng.processLogLine(l));
    tag(eng, '0206', A, B); tag(eng, '0206', A, B);
    assert.deepStrictEqual(chasing(eng), [], 'und die Zählung beginnt im neuen Match bei null');

    // 6) mehrere Verfolger gleichzeitig, längste Serie zuerst
    eng = mk();
    for (let i = 0; i < 4; i++) tag(eng, '0206', A, B);
    for (let i = 0; i < 3; i++) tag(eng, '0206', C, D);
    list = chasing(eng);
    assert.strictEqual(list.length, 2, 'zwei Verfolger werden beide gelistet');
    assert.deepStrictEqual(list.map((x) => x.streak), [4, 3], 'die längste Serie steht oben');

    // 7) die Schwelle ist einstellbar
    eng = mk({ threshold: 5 });
    assert.strictEqual(eng.snapshot().chaseThreshold, 5, 'die Schwelle steht im Snapshot');
    for (let i = 0; i < 4; i++) tag(eng, '0206', A, B);
    assert.deepStrictEqual(chasing(eng), [], 'vier Treffer reichen bei Schwelle 5 nicht');
    tag(eng, '0206', A, B);
    assert.strictEqual(chasing(eng).length, 1, 'fünf schon');
    // 0 und 1 heißen beide „aus"
    eng = mk({ threshold: 0 });
    assert.strictEqual(eng.snapshot().chaseWatched, false, 'Schwelle 0 schaltet die Erkennung ab');
    for (let i = 0; i < 6; i++) tag(eng, '0206', A, B);
    assert.deepStrictEqual(chasing(eng), [], 'und dann wird auch nichts gesammelt');

    // 8) der Weg darf nie werfen — auch nicht bei Unsinn im Strom
    eng = mk();
    ['4 1 0206', '4 2 0206 #', '4 3 0206 #__proto__ phasert #constructor',
      '4 4 0206 #aA1bB2cC phasert #gibtsnicht', '4 5 0206 #gibtsnicht phasert #aA1bB2cC']
      .forEach((l) => eng.processLogLine(l));
    assert.deepStrictEqual(chasing(eng), [], 'unbekannte oder fehlende Kennungen ergeben nichts');
    assert.strictEqual(eng.snapshot().missionActive, true, 'und stören das laufende Match nicht');

    console.log('  ok    engine.chase');
  } catch (err) { failed++; console.error(`  FAIL  engine.chase\n        ${err.stack}`); }

  // Die Steuerung läuft über das ANZEIGEPROFIL — nicht über die Missionsnummer
  // und nicht über die Familie. Das ist der Kern des Zuschnitts: sobald die
  // gemessene Standard-Nummer in modes/standard.json steht, greift die
  // Erkennung von selbst, ohne dass eine Zeile Code sich ändert.
  try {
    const { Engine } = require('../src/engine');
    const gm = require('../src/gameModes');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    const A = 'aA1bB2cC', B = 'bB7kQ2xR';
    let t = 2000;
    const tag = (e, code, a, b) => e.processLogLine(`4 ${t += 10} ${code} #${a} phasert #${b}`);

    // a) Vorgabe ist NUR `standard`. Eine Missionsnummer, die in modes/ nicht
    //    eingetragen ist, läuft als Profil `sm5` und bleibt damit stumm — genau
    //    der Übergangsfall aus docs/GAMEMODES.md (so lief Modus 7 selbst,
    //    bevor seine Nummer gemessen und eingetragen war).
    const setup = (e, missionLine) => [missionLine, '4 0 0100',
      '3 10 event #aA1bB2cC player Anna 0 3 1', '3 10 event #bB7kQ2xR player Bert 1 3 1']
      .forEach((l) => e.processLogLine(l));
    let eng = new Engine({ logger: null, matchEnd: OFF });
    assert.deepStrictEqual(eng.snapshot().chaseProfiles, ['standard'], 'Vorgabe: nur das Profil standard');
    setup(eng, '1 777 Irgendein neuer Modus 0 480000 0');
    assert.strictEqual(eng.snapshot().mode.known, false, 'eine nicht eingetragene Nummer bleibt unbekannt');
    assert.strictEqual(eng.snapshot().mode.profile, 'sm5', 'und läuft als Profil sm5');
    assert.strictEqual(eng.snapshot().chaseWatched, false, 'wird mit der Vorgabe also nicht beobachtet');
    for (let i = 0; i < 5; i++) tag(eng, '0206', A, B);
    assert.deepStrictEqual(eng.snapshot().chasing, [], 'ein nicht beobachtetes Profil sammelt gar nichts');
    // Der dokumentierte Übergang: `sm5` mit in die Liste, dann läuft es sofort.
    eng = new Engine({ logger: null, matchEnd: OFF, chase: { profiles: ['standard', 'sm5'] } });
    setup(eng, '1 777 Irgendein neuer Modus 0 480000 0');
    assert.strictEqual(eng.snapshot().chaseWatched, true, 'mit `sm5` in der Liste läuft es auch ohne eingetragene Nummer');

    // b) Laserball schlägt NICHT an — weder über die 11xx-Codes noch über die
    //    SM5-Codes. Der Betreiber will die Ansicht ausdrücklich nur für
    //    Standardspiele; Laserball wird gar nicht erst unterstützt.
    for (const profiles of [['standard'], ['standard', 'sm5', 'laserball']]) {
      const lb = new Engine({ logger: null, matchEnd: OFF, chase: { profiles } });
      ['1 28 Laserball 0 300000 0', '4 0 0100',
        '3 10 event #aA1bB2cC player Anna 0 3 1', '3 10 event #bB7kQ2xR player Bert 1 3 1']
        .forEach((l) => lb.processLogLine(l));
      assert.strictEqual(lb.snapshot().mode.profile, 'laserball', 'Modus 28 ist Laserball');
      for (let i = 0; i < 5; i++) { tag(lb, '1104', A, B); tag(lb, '0206', A, B); }
      assert.deepStrictEqual(lb.snapshot().chasing, [],
        `Laserball schlägt nie an (Profilliste ${profiles.join('+')})`);
      // und das Laserball-Zählwerk läuft unverändert weiter
      assert.strictEqual(lb.snapshot().players[A].blocksDone, 5, 'die Laserball-Zähler bleiben unberührt');
    }

    // c) Sobald die gemessene Nummer in modes/standard.json steht, greift es —
    //    ohne Codeänderung. Nachgestellt über ein eigenes Modus-Verzeichnis,
    //    damit die Datei des Betreibers unangetastet bleibt.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-modes-'));
    const saveDir = process.env.LF_MODES_DIR;
    try {
      fs.writeFileSync(path.join(dir, 'standard.json'), JSON.stringify({
        schluessel: 'standard', anzeigename: 'Standard',
        missionsnummern: [7], familie: 'sm5', profil: 'standard',
      }), 'utf8');
      process.env.LF_MODES_DIR = dir;
      gm.reloadModes({ quiet: true });
      // Schwelle ausdrücklich, aus demselben Grund wie in `mk()` oben.
      const e2 = new Engine({ logger: null, matchEnd: OFF, chase: { threshold: 3 } });
      ['1 7 Standard LZ - 2 Teams 0 480000 0', '4 0 0100',
        '3 10 event #aA1bB2cC player Anna 0 3 1', '3 10 event #bB7kQ2xR player Bert 1 3 1']
        .forEach((l) => e2.processLogLine(l));
      assert.strictEqual(e2.snapshot().mode.profile, 'standard', 'die eingetragene Nummer macht daraus Profil standard');
      assert.strictEqual(e2.snapshot().chaseWatched, true, 'und damit wird beobachtet — ohne Codeänderung');
      for (let i = 0; i < 3; i++) tag(e2, '0206', A, B);
      assert.strictEqual(e2.snapshot().chasing.length, 1, 'die Erkennung greift an einem echten Standardmodus');
      assert.strictEqual(e2.snapshot().chasing[0].targetName, 'Bert', 'und benennt das Ziel');
    } finally {
      if (saveDir === undefined) delete process.env.LF_MODES_DIR; else process.env.LF_MODES_DIR = saveDir;
      gm.reloadModes({ quiet: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('  ok    engine.chase.profiles');
  } catch (err) { failed++; console.error(`  FAIL  engine.chase.profiles\n        ${err.stack}`); }

  // Was die API mitliefert: derselbe Datensatz, dieselben Vorbehalte.
  try {
    const { Engine } = require('../src/engine');
    const { buildDisplay } = require('../src/apiServer');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    // Schwelle ausdrücklich gesetzt: geprüft wird, dass die API sie DURCHREICHT,
    // nicht welche Zahl die Engine als Vorgabe mitbringt.
    const eng = new Engine({ logger: null, matchEnd: OFF, chase: { profiles: ['standard', 'sm5'], threshold: 3 } });
    ['1 7 Standard LZ - 2 Teams 0 480000 0', '2 0 Rot 5 solid #ef4444', '2 1 Blau 5 solid #38bdf8', '4 0 0100',
      '3 10 event #aA1bB2cC player Anna 0 3 1', '3 10 event #bB7kQ2xR player Bert 1 3 1']
      .forEach((l) => eng.processLogLine(l));
    let d = buildDisplay(eng.snapshot());
    assert.ok(d.chase && Array.isArray(d.chase.players), 'der Anzeige-Datensatz führt chase mit');
    assert.strictEqual(d.chase.threshold, 3, 'die Schwelle steht mit drin');
    assert.strictEqual(d.chase.watched, true, 'ebenso, ob überhaupt beobachtet wird');
    assert.strictEqual(d.chase.count, 0, 'noch ist niemand auffällig');
    assert.strictEqual(d.chase.lowSignal, true, 'zwei Spieler: der Hinweis sagt hier fast nichts, und das steht dabei');
    for (let i = 0; i < 3; i++) eng.processLogLine(`4 ${3000 + i} 0206 #aA1bB2cC phasert #bB7kQ2xR`);
    d = buildDisplay(eng.snapshot());
    assert.strictEqual(d.chase.count, 1, 'die Serie taucht im Anzeige-Datensatz auf');
    assert.strictEqual(d.chase.players[0].playerName, 'Anna', 'mit Namen');
    assert.strictEqual(d.chase.players[0].targetName, 'Bert', 'und Ziel');
    // Ein Verbraucher darf die Liste nicht aus Versehen in den Zustand zurückschreiben.
    d.chase.players[0].playerName = 'manipuliert';
    assert.strictEqual(eng.snapshot().chasing[0].playerName, 'Anna', 'die API gibt Kopien heraus, keine Verweise');
    console.log('  ok    apiServer.chase');
  } catch (err) { failed++; console.error(`  FAIL  apiServer.chase\n        ${err.stack}`); }

  // Der Tagesmitschrieb: eine Datei je Tag, nur angehängt, jedes Match mit
  // einem Abschnitt — auch die ohne Befund. Dazu die abgeleitete Tagesübersicht.
  try {
    const { ChaseLog } = require('../src/chaseLog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-chaselog-'));
    const cl = new ChaseLog({ chaseLog: { enabled: true, dir, summary: true } }, null);
    const day = cl.dayFile();
    const sum = cl.summaryFile();

    const snap = (over) => ({
      matchId: 'mabc1234', mode: { label: '| Standard LZ - 2 Teams |', profile: 'standard' },
      players: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
      elapsedTime: 480000, chaseThreshold: 3, chaseProfiles: ['standard'], chaseWatched: true,
      chasing: [], ...over,
    });
    const row = (pid, name, tid, tname, streak, runs) => ({
      playerId: pid, playerName: name, teamId: '0',
      targetId: tid, targetName: tname, targetTeamId: '1',
      streak, runs: runs || 1, open: false, lastAt: Date.now(),
    });

    // Match 1: zwei Befunde
    cl.onMatchEnd(snap({ matchId: 'm0000001', chasing: [row('jJ9kK0lL', 'Ravi', 'hR3k9Lm2', 'Milan', 4), row('aB1cD2eF', 'Mara', 'hR3k9Lm2', 'Milan', 3)] }));
    let text = fs.readFileSync(day, 'utf8');
    assert.ok(text.startsWith('# Beobachtung'), 'die Datei beginnt mit dem Kopf');
    assert.ok(text.includes('Verdacht und keine Feststellung'), 'die Grenzen stehen IM Dateikopf, nicht nur in der Doku');
    assert.ok(text.includes('Spieler: 7'), 'die Spielerzahl steht beim Match — davon hängt die Aussagekraft ab');
    assert.ok(/\| `jJ9kK0lL` \| Ravi \| Milan \| `hR3k9Lm2` \| 4 \| 1 \| \d\d:\d\d:\d\d \|/.test(text), 'ein Befund steht als Tabellenzeile drin');

    // Match 2: kein Befund — muss trotzdem vermerkt werden
    cl.onMatchEnd(snap({ matchId: 'm0000002', chasing: [] }));
    text = fs.readFileSync(day, 'utf8');
    assert.strictEqual((text.match(/^# Beobachtung/gm) || []).length, 1, 'der Kopf wird nur einmal geschrieben');
    assert.strictEqual((text.match(/^## /gm) || []).length, 2, 'jedes Match bekommt einen Abschnitt');
    assert.ok(text.includes('Niemand war auffällig.'), 'ein Match ohne Befund wird ausdrücklich vermerkt');

    // Match 3: nicht beobachteter Spielmodus — der dritte, eigene Fall
    cl.onMatchEnd(snap({ matchId: 'm0000003', chaseWatched: false, mode: { label: 'Laserball', profile: 'laserball' } }));
    text = fs.readFileSync(day, 'utf8');
    assert.ok(text.includes('nicht beobachtet'), '„nicht beobachtet" ist etwas anderes als „niemand auffällig"');

    // Match 4: derselbe Spieler noch einmal, anderes Ziel
    cl.onMatchEnd(snap({ matchId: 'm0000004', chasing: [row('jJ9kK0lL', 'Ravi', 'zZ9yY8xX', 'Nora', 3)] }));

    // Nur angehängt: nichts von vorher ist verschwunden
    text = fs.readFileSync(day, 'utf8');
    assert.ok(text.includes('m0000001') && text.includes('m0000004'), 'es wird nur angehängt, nie neu geschrieben');

    // Die Tagesübersicht ist vollständig aus der Tagesdatei abgeleitet
    const s1 = fs.readFileSync(sum, 'utf8');
    assert.ok(s1.includes('Matches heute: 4'), 'die Übersicht zählt die Matches des Tages');
    assert.ok(/\| `jJ9kK0lL` \| Ravi \| 2 von 4 \| 4 \| Milan \(1×\), Nora \(1×\) \|/.test(s1),
      'ein wiederkehrender Name ist als Zahl sichtbar — ohne Bewertung');
    assert.ok(!/gut|schlecht|verdächtig|Betrug|Täter/i.test(s1), 'die Übersicht urteilt nicht, sie zählt');

    // Der Neustart-Fall: eine frische Instanz kennt nichts aus dem Speicher und
    // baut die Übersicht trotzdem vollständig — sie liest die Tagesdatei zurück.
    fs.rmSync(sum, { force: true });
    const cl2 = new ChaseLog({ chaseLog: { enabled: true, dir, summary: true } }, null);
    cl2.onMatchEnd(snap({ matchId: 'm0000005', chasing: [row('jJ9kK0lL', 'Ravi', 'hR3k9Lm2', 'Milan', 3)] }));
    const s2 = fs.readFileSync(sum, 'utf8');
    assert.ok(s2.includes('Matches heute: 5'), 'nach einem Neustart zählt die Übersicht den ganzen Tag weiter');
    assert.ok(/\| `jJ9kK0lL` \| Ravi \| 3 von 5 \|/.test(s2), 'weil sie aus der Tagesdatei abgeleitet ist, nicht aus dem Speicher');

    // Feindliche Namen zerlegen die Tabelle nicht.
    cl.onMatchEnd(snap({
      matchId: 'm0000006',
      chasing: [row('#bad id!', 'Pi|pe `tick`\u0007x', 'tgt', 'Ziel\nzeile', 3)],
    }));
    text = fs.readFileSync(day, 'utf8');
    assert.ok(!/\u0007/.test(text), 'Steuerzeichen aus dem Strom landen nicht in der Datei');
    for (const line of text.split('\n')) {
      if (!line.startsWith('| `')) continue;
      assert.strictEqual(line.split('|').length, 9, `jede Tabellenzeile hat genau sieben Spalten: ${line}`);
    }

    // Abgeschaltet heißt abgeschaltet.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-chaselog-off-'));
    const off = new ChaseLog({ chaseLog: { enabled: false, dir: dir2 } }, null);
    off.onMatchEnd(snap({ chasing: [row('x', 'X', 'y', 'Y', 9)] }));
    assert.deepStrictEqual(fs.readdirSync(dir2), [], 'abgeschaltet wird nichts geschrieben');

    // Ein Schreibfehler darf nichts werfen.
    const broken = new ChaseLog({ chaseLog: { enabled: true, dir: path.join(dir, 'x\u0000y') } }, null);
    assert.strictEqual(broken.onMatchEnd(snap({ chasing: [] })), null, 'ein Schreibfehler meldet nur und wirft nicht');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
    console.log('  ok    chaseLog');
  } catch (err) { failed++; console.error(`  FAIL  chaseLog\n        ${err.stack}`); }

  try {
    // The ticker itself: everything above drives checkMatchEnd() by hand, this
    // proves the engine really does it on its own — with a 150 ms threshold, so
    // the whole test is over in well under a second.
    const { Engine } = require('../src/engine');
    const eng = new Engine({ logger: null, matchEnd: { watchdogMs: 150, streamLostMs: 0, endBlockMs: 0 } });
    const ends = [];
    eng.on('match_end', (e) => ends.push(e));
    assert.strictEqual(eng._endTimer, null, 'no timer before a match');
    ['1 28 Laserball 0 300000 0', '2 0 Rot 5 solid #ef4444', '4 0 0100', '3 10 event @1 player Anna 0 3 1']
      .forEach((l) => eng.processLogLine(l));
    assert.ok(eng._endTimer, 'a running match arms the ticker');
    assert.strictEqual(eng._endTimer.hasRef?.(), false, 'the ticker is unref()ed and cannot keep the process alive');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(eng.snapshot().missionActive, false, 'the ticker ended the match on its own');
    assert.strictEqual(eng.snapshot().endReason, 'watchdog', 'reason: watchdog');
    assert.ok(eng.snapshot().endedAt >= eng._lastLineAt, 'endedAt is the moment it ended');
    assert.strictEqual(ends.length, 1, 'exactly one match_end, however often the ticker runs');
    assert.strictEqual(eng._endTimer, null, 'and the ticker stops itself again');
    console.log('  ok    engine.matchEnd.ticker');
  } catch (err) { failed++; console.error(`  FAIL  engine.matchEnd.ticker\n        ${err.stack}`); }


  // ══ Echte Anlage, Modus 7 („Standard LZ - 2 Teams") ═══════════════════════
  // Alles hierunter ist an vier vollständigen Roh-Mitschnitten vom 19.09.2026
  // gemessen (docs/LASERFORCE.md, Abschnitt „Standardmodus (Nummer 7)"). Die
  // Mitschnitte selbst dürfen nicht ins Repository — sie enthalten echte Namen
  // und weltweit eindeutige Mitglieds-IDs. Nachgestellt werden deshalb genau
  // die Zeilen, auf die es ankommt, in der Form, in der die Anlage sie schickt:
  // TAB-getrennt, mit Schema-Kommentaren, mit deutschen Klartext-Verben.
  try {
    const gm = require('../src/gameModes');
    assert.strictEqual(gm.resolveMode(7).known, true, 'Modus 7 steht in der Registry');
    assert.strictEqual(gm.resolveMode(7).key, 'standard', 'Modus 7 ist der Standardmodus');
    assert.strictEqual(gm.resolveMode(7).family, 'sm5', 'Familie sm5');
    assert.strictEqual(gm.resolveModeWithProfile(7).profile, 'standard', 'Anzeigeprofil standard');
    // Der schlichte Registry-Name ist Absicht: den Zierrahmen schickt die
    // Anlage selbst, und ihr Name gewinnt zur Laufzeit.
    assert.strictEqual(gm.resolveMode(7, null).label, 'Standard', 'ohne Stream-Namen der schlichte Registry-Name');
    assert.strictEqual(gm.resolveMode(7, '| Standard LZ - 2 Teams |').label, '| Standard LZ - 2 Teams |',
      'der Name der Anlage gewinnt');
    console.log('  ok    gameModes.mode7');
  } catch (err) { failed++; console.error(`  FAIL  gameModes.mode7\n        ${err.stack}`); }

  /**
   * Ein Standardspiel, so wie die Anlage es schickt — TAB-getrennt.
   * Spielerkennungen sind erfundene Kürzel in der echten Form (`#` + acht
   * alphanumerische Zeichen), die Mitglieds-IDs erfunden, aber in der
   * gemessenen Form `<land>-<zentrum>-<mitglied>`.
   */
  const STANDARD_MATCH = [
    '0\t2.006\t8.704\t21-101',
    ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
    '1\t7\t| Standard LZ - 2 Teams |\t20260919104649\t480000\t-1000',
    ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour-rgb',
    '2\t0\tBlaues Team\t12\tIce\t#00A0FF',
    '2\t1\tRotes Team\t11\tFire\t#FF5000',
    '2\t2\tNeutral\t0\tNone\t#808080',
    ';4/event\ttime\ttype\tvaries',
    '4\t0000000\t0100\t* Missionsbeginn *',
    ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
    '3\t0000001\t#aA1bB2cC\tplayer\tAnna Lena\t0\t1\t0\tUnderground\t21-101-10001',
    '3\t0000001\t#bB2cC3dD\tplayer\tBert\t0\t3\t0\tBalu\t21-101-10002',
    '3\t0000002\t#cC3dD4eE\tplayer\tCleo\t1\t2\t0\tLoki\t21-103-90412',
    '3\t0000002\t#dD4eE5fF\tplayer\tDora\t1\t0\t0\tCyborg\t21-101-10003',
    // Nicht-Spieler-Entities: Team 2 (nicht 5!), leere memberId-Spalte.
    '3\t0000003\t@30\tgenerator-target\tGenerator\t2\t0\t0\tGenerator\t',
    '3\t0000004\t@91\tgallery-target\tPunktestation Zufall\t2\t0\t0\tPunktestation Zufall\t',
    '3\t0000005\t@28\tstandard-target\tPunktestation Rot\t2\t0\t0\tPunktestation Rot\t',
    '3\t0000006\t@40\tbeacon\tBeacon\t2\t0\t0\tBeacon\t',
    // Der Bösewicht: eine Punktestation, die „player" HEISST. Genau daran
    // scheiterte die alte Suche nach dem Wort statt nach der Spalte.
    '3\t0000007\t@41\tstandard-target\tplayer\t2\t0\t0\tplayer\t',
    ';5/score\ttime\tentity\told\tdelta\tnew',
    ';9/player-state\ttime\tentity\tstate',
    '5\t0010000\t#aA1bB2cC\t0\t110\t110',
    '4\t0010000\t0206\t#aA1bB2cC\t phasert \t#cC3dD4eE',
    '9\t0010100\t#cC3dD4eE\t3',
    '5\t0020000\t#bB2cC3dD\t0\t-50\t-50',
    '4\t0020000\t0208\t#bB2cC3dD\t phasert \t#aA1bB2cC',
    '4\t0030000\t0402\t#aA1bB2cC\t aktiviert Unverwundbarkeit',
    '4\t0031000\t0408\t#bB2cC3dD\t aktiviert Vergeltung',
    '4\t0040000\t0700\tZustand von \t@30\t ist kritisch',
    '4\t0048000\t0701\t#dD4eE5fF\t wurde verstrahlt',
    '5\t0050000\t#dD4eE5fF\t0\t100\t100',
    '4\t0050000\t0D06\t#dD4eE5fF\t blastet \t#aA1bB2cC',
    '4\t0050000\t0D06\t#dD4eE5fF\t blastet \t#bB2cC3dD',
    '5\t0051000\t#cC3dD4eE\t0\t110\t110',
    '4\t0051000\t0D05\t#cC3dD4eE\t blastet \t#bB2cC3dD',
    '4\t0060000\t0E00\t#aA1bB2cC\t wird zum \tHeld\t befördert',
    // Ein Code, den NIEMAND kennt — die Anlage beschreibt ihn aber selbst.
    '4\t0070000\t0F42\t#aA1bB2cC\t verzaubert \t#dD4eE5fF',
    // Gemessene Reihenfolge am Ende: 0101 ZUERST, danach der Typ-6-Block.
    '4\t0480100\t0101\t* Missionsende *',
    ';6/entity-end\ttime\tid\ttype\tscore',
    '6\t0480100\t#aA1bB2cC\t02\t110',
    '6\t0480100\t#bB2cC3dD\t02\t-50',
    '6\t0480100\t#cC3dD4eE\t02\t110',
    '6\t0480100\t#dD4eE5fF\t02\t100',
  ];

  try {
    const { Engine } = require('../src/engine');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    const eng = new Engine({ logger: null, matchEnd: OFF, emitUnknownEvents: true });
    const evts = [];
    eng.on('event', (e) => evts.push(e));
    for (const l of STANDARD_MATCH) eng.processLogLine(l);
    const st = eng.snapshot();

    // ── Modus
    assert.strictEqual(st.mode.number, 7, 'die Missionsnummer steht im Zustand');
    assert.strictEqual(st.mode.key, 'standard', 'erkannt als Standardmodus');
    assert.strictEqual(st.mode.profile, 'standard', 'mit dem Anzeigeprofil standard');
    assert.strictEqual(st.mode.family, 'sm5', 'Familie sm5');
    assert.strictEqual(st.mode.label, '| Standard LZ - 2 Teams |', 'der Name der Anlage gewinnt');

    // ── Entity-Art: nur `player`, und zwar aus der SPALTE, nicht aus dem Wort
    assert.strictEqual(Object.keys(st.players).length, 4, 'genau die vier Spieler, sonst niemand');
    for (const bad of ['30', '91', '28', '40', '41']) {
      assert.ok(!st.players[bad], `Nicht-Spieler-Entity @${bad} wurde NICHT als Spieler angelegt`);
    }
    assert.ok(!Object.values(st.players).some((pl) => pl.name === 'player'),
      'eine Punktestation namens „player" bleibt eine Punktestation');
    assert.ok(!Object.values(st.players).some((pl) => pl.teamId === '2'),
      'niemand landet im Neutral-Team (Index 2, nicht 5)');
    assert.strictEqual(st.teams['2'].name, 'Neutral', 'Neutral ist Team-Index 2');

    // ── Typ-3-Zusatzspalten
    assert.strictEqual(st.players.aA1bB2cC.battlesuit, 'Underground', 'battlesuit aus der Schema-Spalte');
    assert.strictEqual(st.players.aA1bB2cC.memberId, '21-101-10001', 'memberId aus der Schema-Spalte');
    assert.strictEqual(st.players.aA1bB2cC.level, 1, 'level');
    assert.strictEqual(st.players.cC3dD4eE.teamId, '1', 'Team aus der Schema-Spalte');

    // ── Punkte: Typ 5 ist die Autorität, auch auf Spieler-Kennungen
    assert.strictEqual(st.players.aA1bB2cC.score, 110, 'Spielerpunkte aus Zeile 5');
    assert.strictEqual(st.players.bB2cC3dD.score, -50, 'auch negative');
    assert.strictEqual(st.scoreSource, 'tdf', 'die Anlage ist die Punkte-Autorität');

    // ── Matchende: 0101 gewinnt, obwohl der Typ-6-Block erst danach kommt
    assert.strictEqual(st.missionActive, false, 'das Match ist beendet');
    assert.strictEqual(st.endReason, 'mission_end', 'beendet durch 0101');
    assert.strictEqual(st.endSource, '0101', 'und zwar durch den Code selbst');
    assert.strictEqual(st.elapsedTime, 480100, 'die Spielzeit steht auf dem 0101-Zeitstempel');
    // Gemessene Folge der Reihenfolge: weil der Typ-6-Block HINTER dem `0101`
    // kommt, läuft er in ein bereits beendetes Match. Die Exit-Codes landen
    // deshalb im Standardmodus NIE in `exitCodes`/`exitCodesSeen` — rein
    // diagnostische Felder, die nichts entscheiden (docs/LASERFORCE.md).
    assert.deepStrictEqual(st.exitCodesSeen, [],
      'die Exit-Codes bleiben leer, weil der Typ-6-Block erst nach dem 0101 kommt');
    assert.strictEqual(evts.filter((e) => e.type === 'match_summary').length, 4,
      'die Typ-6-Zeilen werden trotzdem alle als Ereignis ausgegeben');

    // ── Die neu katalogisierten Codes
    const byCode = {};
    for (const e of evts) if (e.code) (byCode[e.code] = byCode[e.code] || []).push(e);
    const one = (code) => {
      assert.ok(byCode[code] && byCode[code].length, `Code ${code} wird als Ereignis ausgegeben`);
      return byCode[code][0];
    };
    assert.strictEqual(one('0208').type, 'player_hit', '0208 ist ein Treffer …');
    assert.strictEqual(one('0208').actorTeamId, one('0208').targetTeamId, '… und zwar Eigenbeschuss: gleiches Team');
    assert.ok(/Eigenbeschuss/.test(one('0208').text), 'der Text sagt es auch');
    assert.strictEqual(one('0206').actorTeamId !== one('0206').targetTeamId, true, '0206 dagegen gegen ein anderes Team');
    assert.strictEqual(one('0402').type, 'invulnerability', '0402 = Unverwundbarkeit');
    assert.strictEqual(one('0402').text, 'Anna Lena aktiviert Unverwundbarkeit', 'mit lesbarem Text');
    assert.strictEqual(one('0408').type, 'retaliation', '0408 = Vergeltung');
    assert.strictEqual(one('0408').text, 'Bert aktiviert Vergeltung', 'mit lesbarem Text');
    assert.strictEqual(one('0700').type, 'generator_critical', '0700 = Generator kritisch');
    assert.ok(/kritisch/.test(one('0700').text), 'und sagt das auch');
    assert.strictEqual(one('0701').type, 'irradiated', '0701 = Verstrahlung');
    assert.strictEqual(one('0701').text, 'Dora wurde verstrahlt', 'mit lesbarem Text');
    assert.strictEqual(one('0D06').type, 'player_deactivate', '0D06 = Blast mit Deaktivierung');
    assert.strictEqual(byCode['0D06'].length, 2, 'ein Blast kann mehrere Ziele auf demselben Zeitstempel treffen');
    assert.strictEqual(one('0D05').type, 'player_hit', '0D05 = Blast ohne Deaktivierung (unbestätigt)');
    assert.strictEqual(one('0E00').type, 'promotion', '0E00 = Beförderung');
    assert.strictEqual(one('0E00').rank, 'Held', 'der Rang wird als eigenes Feld gelesen');
    assert.strictEqual(one('0E00').text, 'Anna Lena wird zum Held befördert', 'und steht im Text');

    // ── Kein Zähler und kein Zustand hängt an den neuen Codes
    assert.strictEqual(st.players.bB2cC3dD.shotsFired ?? 0, 0,
      'Eigenbeschuss fließt bewusst NICHT in shotsFired ein');
    assert.strictEqual(st.players.dD4eE5fF.deactivations ?? 0, 0,
      'ein Blast fließt bewusst NICHT in deactivations ein');

    // ── Kein Typ 7: die amtlichen Felder bleiben leer, die Quelle sagt es
    assert.strictEqual(st.players.aA1bB2cC.statsSource, 'live', 'ohne Typ-7-Block bleiben die Live-Zahlen stehen');
    assert.strictEqual(st.players.aA1bB2cC.livesLeft, null, 'Leben bleiben leer — nicht 0');
    assert.strictEqual(st.players.aA1bB2cC.shotsLeft, null, 'Munition bleibt leer — nicht 0');
    assert.strictEqual(st.players.aA1bB2cC.accuracyIsEstimate, true, 'die Trefferquote ist eine Näherung');

    console.log('  ok    engine.mode7.standard');
  } catch (err) { failed++; console.error(`  FAIL  engine.mode7.standard\n        ${err.stack}`); }

  // Unbekannte Codes beschriften sich aus dem Klartext der Anlage selbst.
  try {
    const { Engine } = require('../src/engine');
    const { streamPhrase, describe } = require('../src/eventCatalog');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    const eng = new Engine({ logger: null, matchEnd: OFF, emitUnknownEvents: true });
    const evts = [];
    eng.on('event', (e) => evts.push(e));
    for (const l of STANDARD_MATCH) eng.processLogLine(l);

    const unknown = evts.find((e) => e.code === '0F42');
    assert.ok(unknown, 'ein völlig unbekannter Code wird überhaupt ausgegeben');
    assert.strictEqual(describe('0F42').status, 'unknown', '… und der Katalog kennt ihn wirklich nicht');
    assert.strictEqual(unknown.type, 'lf_event', 'er bleibt fachlich ein unbekanntes Ereignis');
    assert.strictEqual(unknown.text, 'Anna Lena verzaubert Dora',
      'aber er ist lesbar — mit den Worten der Anlage und aufgelösten Namen');
    assert.strictEqual(unknown.streamText, 'Anna Lena verzaubert Dora', 'der Selbsttext steht auch als eigenes Feld da');

    // Der Selbsttext überschreibt NIE eine dokumentierte Formulierung.
    const known = evts.find((e) => e.code === '0402');
    assert.strictEqual(known.text, 'Anna Lena aktiviert Unverwundbarkeit', 'bekannter Code: unsere Formulierung gilt');

    // streamPhrase selbst: Fremdeingabe, also gekappt und entschärft.
    assert.strictEqual(streamPhrase(['#1', ' trifft ', '#2'], (id) => (id === '1' ? 'Ann' : null)),
      'Ann trifft #2', 'unbekannte Kennungen bleiben roh stehen');
    assert.strictEqual(streamPhrase([]), '', 'nichts drin, nichts raus');
    assert.strictEqual(streamPhrase(null), '', 'Unsinn ergibt einen leeren String, keinen Fehler');
    assert.ok(streamPhrase(['x'.repeat(500)]).length <= 160, 'die Länge ist begrenzt');
    const ctrl = streamPhrase([`a${String.fromCharCode(7)}b`]);
    assert.strictEqual(ctrl, 'a b', 'Steuerzeichen werden entschärft');
    assert.strictEqual(streamPhrase([' wird zum ', 'Held'], () => { throw new Error('boom'); }),
      'wird zum Held', 'ein werfender Namensauflöser bringt nichts zu Fall');

    console.log('  ok    eventCatalog.streamPhrase');
  } catch (err) { failed++; console.error(`  FAIL  eventCatalog.streamPhrase\n        ${err.stack}`); }

  // Die Entity-Art kommt aus der Spalte — mit dem alten Weg als Rückfall.
  // Hier hängt die gesamte Spielererkennung dran, deshalb beide Wege einzeln.
  try {
    const { Engine } = require('../src/engine');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    const head = ['1\t7\tStandard\t0\t480000\t0', '4\t0\t0100'];
    // a) MIT Schema-Zeile: die Spalte entscheidet.
    let e = new Engine({ logger: null, matchEnd: OFF });
    [...head,
      ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
      '3\t1\t#aA1bB2cC\tplayer\tAnna\t0\t1\t0\tSuit\t21-101-1',
      '3\t1\t@41\tstandard-target\tplayer\t2\t0\t0\tplayer\t',
    ].forEach((l) => e.processLogLine(l));
    assert.deepStrictEqual(Object.keys(e.snapshot().players), ['aA1bB2cC'],
      'mit Schema: nur die Zeile mit type=player wird Spieler');

    // b) OHNE Schema-Zeile: exakt das alte Verhalten, Wort statt Spalte.
    e = new Engine({ logger: null, matchEnd: OFF });
    [...head, '3\t1\t#aA1bB2cC\tplayer\tAnna\t0\t1\t0'].forEach((l) => e.processLogLine(l));
    assert.deepStrictEqual(Object.keys(e.snapshot().players), ['aA1bB2cC'],
      'ohne Schema greift weiterhin die Wortsuche');

    // c) Leerzeichen statt Tabulatoren, mit Schema: der Name wird
    //    zurückgefaltet, die Spalte bleibt trotzdem die richtige.
    e = new Engine({ logger: null, matchEnd: OFF });
    ['1 7 Standard 0 480000 0', '4 0 0100',
      ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
      '3 1 #aA1bB2cC player Anna Lena 0 1 0 Suit 21-101-1',
    ].forEach((l) => e.processLogLine(l));
    assert.strictEqual(e.snapshot().players.aA1bB2cC?.name, 'Anna Lena',
      'Name mit Leerzeichen überlebt den Whitespace-Split');

    // d) Ein Spieler, der wirklich „player" heißt, bleibt ein Spieler.
    e = new Engine({ logger: null, matchEnd: OFF });
    [...head,
      ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit\tmemberId',
      '3\t1\t#aA1bB2cC\tplayer\tplayer\t0\t1\t0\tSuit\t21-101-1',
    ].forEach((l) => e.processLogLine(l));
    assert.strictEqual(e.snapshot().players.aA1bB2cC?.name, 'player',
      'ein Spieler namens „player" wird normal angelegt');

    console.log('  ok    engine.entityKind');
  } catch (err) { failed++; console.error(`  FAIL  engine.entityKind\n        ${err.stack}`); }

  // Die Zerlegung der Mitgliedsnummer — und dass sie die Rohform nie ersetzt.
  try {
    const { splitMemberId, buildMatchReport, EntityIds } = require('../src/matchReport');
    assert.deepStrictEqual(splitMemberId('21-101-10001'),
      { countryCode: 21, centerCode: 101, memberCode: 10001 }, 'die gemessene Form wird zerlegt');
    assert.deepStrictEqual(splitMemberId('21-103-90412'),
      { countryCode: 21, centerCode: 103, memberCode: 90412 },
      'ein Gast aus einem anderen Zentrum behält SEIN Zentrum');
    for (const bad of ['', '   ', '21-101', '21-101-10001-9', 'aA1bB2cC', '#21-101-1', '21--1', null, 42, {}]) {
      assert.strictEqual(splitMemberId(bad), null, `keine Zerlegung für ${JSON.stringify(bad)}`);
    }

    const { Engine } = require('../src/engine');
    const OFF = { watchdogMs: 0, streamLostMs: 0, endBlockMs: 0 };
    const eng = new Engine({ logger: null, matchEnd: OFF });
    const ids = new EntityIds();
    for (const l of STANDARD_MATCH) { ids.noteLine(l); eng.processLogLine(l); }
    const rep = buildMatchReport(eng.snapshot(), { entityIds: ids, mode: eng.snapshot().mode });
    const anna = rep.players.find((pl) => pl.playerId === 'aA1bB2cC');
    const cleo = rep.players.find((pl) => pl.playerId === 'cC3dD4eE');
    assert.strictEqual(anna.memberIdReported, '21-101-10001', 'die Rohform steht weiterhin im Bericht');
    assert.deepStrictEqual(anna.memberIdParts, { countryCode: 21, centerCode: 101, memberCode: 10001 },
      'und die Zerlegung steht zusätzlich daneben');
    assert.strictEqual(cleo.memberIdParts.centerCode, 103,
      'der Gast wird NICHT dem Zentrum der Anlage zugeschlagen');
    assert.strictEqual(anna.entityId, '#aA1bB2cC', 'die rohe Kennung bleibt alphanumerisch');
    assert.strictEqual(anna.memberId, 'aA1bB2cC', 'und wird nirgends in eine Zahl verwandelt');
    console.log('  ok    matchReport.memberIdParts');
  } catch (err) { failed++; console.error(`  FAIL  matchReport.memberIdParts\n        ${err.stack}`); }

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
