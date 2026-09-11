'use strict';

/**
 * End-to-end: boot the service, replay a match, verify every API surface,
 * the WebSocket stream, the access token and a signed webhook.
 *   node scripts/itest.js
 */
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const HTTP_PORT = 18066;
const TCP_PORT = 19066;
const WH_PORT = 18067;
const TOKEN = 'itest-token-abc';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-it-'));

const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, t = 8000) {
  const end = Date.now() + t;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  throw new Error('waitFor timed out');
}
const J = (u, o = {}) => fetch(u, o).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
function done(code) { for (const p of procs) try { p.kill('SIGKILL'); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(code); }

(async () => {
  const received = [];
  const wh = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise((r) => wh.listen(WH_PORT, '127.0.0.1', r));

  // run with cwd = temp dir so config.json lands there, not in the repo
  const svc = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], {
    cwd: dir,
    env: { ...process.env, LF_HTTP_PORT: String(HTTP_PORT), LF_TCP_PORT: String(TCP_PORT), LF_HTTP_HOST: '127.0.0.1', LF_TCP_HOST: '127.0.0.1', LF_API_TOKEN: TOKEN, LF_LOG_LEVEL: 'warn' },
  });
  procs.push(svc);
  svc.stdout.on('data', (d) => process.stdout.write(`[svc] ${d}`));
  svc.stderr.on('data', (d) => process.stderr.write(`[svc!] ${d}`));

  const BASE = `http://127.0.0.1:${HTTP_PORT}`;
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  await waitFor(async () => (await J(`${BASE}/api/health`)).status === 200);
  console.log('service up');

  // token enforcement
  assert.strictEqual((await J(`${BASE}/api/state`)).status, 401, 'no token -> 401');
  assert.strictEqual((await J(`${BASE}/api/state`, { headers: { Authorization: 'Bearer nope' } })).status, 401, 'bad token -> 401');
  assert.strictEqual((await J(`${BASE}/api/health`)).status, 200, 'health stays open');

  // local TCP receiver for a "tcp" output
  const TCP_OUT_PORT = WH_PORT + 1;
  const tcpLines = [];
  const tcpRecv = net.createServer((s) => { let b = ''; s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { tcpLines.push(b.slice(0, i)); b = b.slice(i + 1); } }); });
  await new Promise((r) => tcpRecv.listen(TCP_OUT_PORT, '127.0.0.1', r));

  // configure outputs + raw stream server through the config API
  const cfg = (await J(`${BASE}/api/config`, { headers: AUTH })).body.data;
  cfg.outputs = [
    { name: 'wh', kind: 'webhook', url: `http://127.0.0.1:${WH_PORT}/h`, enabled: true, secret: 'sec', events: ['goal', 'match_start'] },
    { name: 'tcpout', kind: 'tcp', host: '127.0.0.1', port: TCP_OUT_PORT, enabled: true, events: ['*'] },
  ];
  const STREAM_PORT = WH_PORT + 2;
  cfg.streamServer = { enabled: true, port: STREAM_PORT };
  await fetch(`${BASE}/api/config`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  await sleep(400); // let the tcp output connect + stream server bind

  // raw TCP stream: without the token line the server must drop us
  await new Promise((resolve, reject) => {
    const bad = net.connect(STREAM_PORT, '127.0.0.1');
    let got = '';
    bad.on('data', (d) => { got += d; });
    bad.on('close', () => { try { assert.strictEqual(got, '', 'unauthenticated stream client gets nothing'); resolve(); } catch (e) { reject(e); } });
    bad.on('error', () => resolve());
  });
  console.log('raw stream auth OK  unauthenticated client dropped');

  // raw TCP stream consumer (token line first)
  const streamMsgs = [];
  const sc = net.connect(STREAM_PORT, '127.0.0.1');
  { let b = ''; sc.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { try { streamMsgs.push(JSON.parse(b.slice(0, i))); } catch {} b = b.slice(i + 1); } }); }
  await new Promise((r) => sc.on('connect', r));
  sc.write(JSON.stringify({ token: TOKEN }) + '\n');

  // WS consumer
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws?token=${TOKEN}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
  // WS without token must fail
  await new Promise((res) => { const b = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`); b.on('open', () => { assert.fail('ws without token connected'); }); b.on('error', () => res()); });

  // feed a match
  await new Promise((res, rej) => {
    const c = net.connect(TCP_PORT, '127.0.0.1', () => {
      c.write([
        '1 0 0 0 300000 0', '2 0 Rot Team 5 s #ef4444', '2 1 Blau Team 5 s #3b82f6',
        '4 500 0100',
        '3 1000 event @1001 player Mara 0 3 1', '3 1100 event @2001 player Lea 1 3 1',
        '4 9000 1100 @2001 @2001', '4 12000 1101 @2001', '4 30000 0101', '',
      ].join('\n'));
      setTimeout(() => { c.end(); res(); }, 300);
    });
    c.on('error', rej);
  });

  let st;
  await waitFor(async () => {
    st = (await J(`${BASE}/api/state`, { headers: AUTH })).body?.data;
    return st && st.players['2001']?.goals === 1;
  });
  assert.strictEqual(st.teams['0'].name, 'Rot Team', 'multi-word team name');
  assert.strictEqual(Object.values(st.scores).reduce((a, b) => a + b, 0), 1, 'score total 1');
  console.log('/api/state OK  scores', JSON.stringify(st.scores));

  const teams = (await J(`${BASE}/api/teams`, { headers: AUTH })).body.data;
  const players = (await J(`${BASE}/api/players`, { headers: AUTH })).body.data;
  const events = (await J(`${BASE}/api/events?since=0&limit=20`, { headers: AUTH })).body.data;
  const status = (await J(`${BASE}/api/status`, { headers: AUTH })).body.data;
  assert.ok(teams.teams['1'].color === '#3b82f6', 'teams endpoint');
  assert.strictEqual(players.length, 2, 'players endpoint');
  assert.ok(events.some((e) => e.type === 'goal') && events.some((e) => e.type === 'match_start'), 'events endpoint');
  assert.ok(events.some((e) => e.type === 'goal' && e.category === 'score' && typeof e.phrase === 'string' && e.phrase), 'events carry enriched category + phrase');
  assert.ok(events.some((e) => e.type === 'match_start' && e.code === '0100'), 'match_start enriched with code 0100');
  assert.ok(status.tcp.lines >= 8, 'status endpoint counts lines');
  console.log('/api/teams /players /events /status OK');

  await waitFor(() => msgs.some((m) => m.type === 'event' && m.data.type === 'goal'));
  assert.ok(msgs.some((m) => m.type === 'hello') && msgs.some((m) => m.type === 'state'), 'ws hello+state');
  console.log('ws stream OK ', [...new Set(msgs.map((m) => m.type))].join(','));

  await waitFor(() => received.some((r) => r.headers['x-lfb-event'] === 'goal'));
  const g = received.find((r) => r.headers['x-lfb-event'] === 'goal');
  const exp = 'sha256=' + crypto.createHmac('sha256', 'sec').update(`${g.headers['x-lfb-timestamp']}.${g.body}`).digest('hex');
  assert.strictEqual(g.headers['x-lfb-signature'], exp, 'webhook HMAC valid');
  console.log('webhook output OK   signed goal delivered');

  await waitFor(() => tcpLines.some((l) => { try { return JSON.parse(l).data?.type === 'goal'; } catch { return false; } }));
  console.log('tcp output OK       NDJSON goal delivered to socket');

  await waitFor(() => streamMsgs.some((m) => m.type === 'event' && m.data.type === 'goal'));
  assert.ok(streamMsgs.some((m) => m.type === 'hello'), 'stream server hello');
  console.log('raw stream OK       hello + event over plain TCP');

  // CSV stats written after the mission-end
  await waitFor(() => fs.existsSync(path.join(dir, 'data', 'stats', 'all_players.csv')));
  const allp = fs.readFileSync(path.join(dir, 'data', 'stats', 'all_players.csv'), 'utf8');
  assert.ok(allp.includes('Lea') && /;win|win;/.test(allp), 'all_players.csv has Lea with a result');
  const files = (await J(`${BASE}/api/stats/files`, { headers: AUTH })).body.data;
  assert.ok(files.some((f) => f.name.endsWith('_players.csv')) && files.some((f) => f.name === 'totals.csv'), 'stats/files lists match + totals');
  const totals = (await J(`${BASE}/api/stats/totals`, { headers: AUTH })).body.data;
  assert.ok(totals.find((r) => r.name === 'Lea')?.goals === '1', 'stats/totals has Lea with 1 goal');
  const dl = await fetch(`${BASE}/api/stats/file?name=totals.csv`, { headers: AUTH });
  assert.ok(dl.headers.get('content-type').includes('text/csv'), 'stats/file downloads as CSV');
  console.log('csv stats OK        all_players + totals written, downloadable');

  // readable event-log file written under data/logs/
  const logDir = path.join(dir, 'data', 'logs');
  await waitFor(() => { try { return fs.readdirSync(logDir).some((f) => f.endsWith('.log')); } catch { return false; } });
  const logFile = fs.readdirSync(logDir).find((f) => f.endsWith('.log'));
  const logText = fs.readFileSync(path.join(logDir, logFile), 'utf8');
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}\+\d\d:\d\d\.\d{3} {2}\[\S+\] {2}\S/m.test(logText), 'event log has readable, columned lines');
  assert.ok(/──── Match .+ ────/.test(logText), 'event log has a match header/footer');
  assert.ok(/\bgoal\b|\bTor\b/.test(logText), 'event log recorded the goal');
  console.log('event log OK        readable lines in', path.join('data', 'logs', logFile));

  ws.close(); wh.close(); sc.destroy(); tcpRecv.close();
  console.log('\nALL E2E CHECKS PASSED');
  done(0);
})().catch((e) => { console.error('\nFAILED:', e.stack); done(1); });
