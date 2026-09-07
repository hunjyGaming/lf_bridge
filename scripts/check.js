'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mods = [
  '../src/config', '../src/logger', '../src/engine', '../src/localRoster', '../src/statsWriter',
  '../src/tcpIngest', '../src/outputs', '../src/streamServer', '../src/apiServer',
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
  const players = fs.readFileSync(path.join(dir, 'stats', 'all_players.csv'), 'utf8');
  assert.ok(players.includes('Mara') && players.includes('win'), 'all_players.csv has the winner row');
  const totals = fs.readFileSync(path.join(dir, 'stats', 'totals.csv'), 'utf8').replace(/^﻿/, '');
  assert.ok(totals.split(/\r?\n/).filter(Boolean).length === 3, 'totals.csv: header + 2 players');
  assert.ok(totals.includes('Mara;1;1;0;0;2;1'), 'Mara totals: 1 match, 1 win, 2 goals, 1 assist');
  assert.ok(fs.existsSync(path.join(dir, 'stats', 'matches')), 'per-match folder written');
  // a second match aggregates
  const st2 = structuredClone(st); st2.matchId = 'm2'; st2.players['1001'].goals = 1; st2.scores = { 0: 1, 1: 2 };
  sw.onChange(st2); sw.onMatchStart(st2); sw.onMatchEnd(st2);
  const totals2 = fs.readFileSync(path.join(dir, 'stats', 'totals.csv'), 'utf8');
  assert.ok(totals2.includes('Mara;2;1;1;0;3;'), 'Mara after 2 matches: 2 played, 1 win, 1 loss, 3 goals total');
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

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
