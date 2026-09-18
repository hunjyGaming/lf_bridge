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
  const wh = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ url: req.url, headers: req.headers, body: b }); res.end('ok'); }); });
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

  // ---- admin login ----------------------------------------------------------
  const CONSOLE_POST = { 'Content-Type': 'application/json', 'X-LF-Console': '1' };
  const login = (password, extra = {}) => fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { ...CONSOLE_POST, ...extra }, body: JSON.stringify({ password }),
  });

  // No notification channel here, so nothing could deliver a generated password:
  // the console must wait to be set up instead of inventing one nobody can read.
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'initial-admin-password.txt')), 'no password invented without a way to deliver it');

  const setupRedirect = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.strictEqual(setupRedirect.status, 302, 'console redirects before setup');
  assert.strictEqual(setupRedirect.headers.get('location'), '/setup', 'redirect points at the setup page');
  assert.strictEqual((await fetch(`${BASE}/login`, { redirect: 'manual' })).headers.get('location'), '/setup', 'login page sends you to setup first');
  assert.strictEqual((await fetch(`${BASE}/setup`)).status, 200, 'setup page is public');
  assert.strictEqual((await J(`${BASE}/api/state`)).status, 401, 'API stays shut while setup is pending');

  const pre = (await J(`${BASE}/api/auth/session`)).body.data;
  assert.ok(pre.setupPending && !pre.passwordSet, 'session endpoint reports setup pending');

  const doSetup = (pw) => fetch(`${BASE}/api/auth/setup`, { method: 'POST', headers: CONSOLE_POST, body: JSON.stringify({ next: pw }) });
  assert.strictEqual((await doSetup('kurz')).status, 400, 'setup refuses a short password');
  const initialPw = 'erst-passwort-123';
  const setupOk = await doSetup(initialPw);
  assert.strictEqual(setupOk.status, 200, 'setup accepts a proper password');
  assert.ok(/lf_sess=/.test(setupOk.headers.get('set-cookie') || ''), 'setup logs you straight in');
  assert.strictEqual((await doSetup('noch-ein-versuch')).status, 409, 'setup is a one-time door');
  console.log('setup OK            first password chosen in the browser');

  // from here on it behaves like a normal protected console
  const rootOut = await fetch(`${BASE}/`, { redirect: 'manual' });
  assert.strictEqual(rootOut.status, 302, 'console redirects while logged out');
  assert.strictEqual(rootOut.headers.get('location'), '/login', 'redirect now points at the login page');
  assert.strictEqual((await fetch(`${BASE}/app.js`, { redirect: 'manual' })).status, 302, 'console script is not public either');
  assert.strictEqual((await fetch(`${BASE}/setup`, { redirect: 'manual' })).headers.get('location'), '/login', 'setup page is closed again');
  assert.strictEqual((await fetch(`${BASE}/login`)).status, 200, 'login page is public');
  assert.strictEqual((await fetch(`${BASE}/styles.css`)).status, 200, 'the login page can load its stylesheet');

  const sess = (await J(`${BASE}/api/auth/session`)).body.data;
  assert.ok(sess.loginRequired && !sess.authenticated && sess.passwordSet, 'session endpoint reports the real state');
  assert.deepStrictEqual(sess.recoveryChannels, [], 'no channel -> nothing to recover through');
  assert.strictEqual((await fetch(`${BASE}/api/auth/recover`, { method: 'POST', headers: CONSOLE_POST, body: '{}' })).status, 409, 'recovery refused without a channel');

  assert.strictEqual((await login('falsch')).status, 401, 'wrong password rejected');
  const crossSite = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ password: initialPw }),
  });
  assert.strictEqual(crossSite.status, 403, 'cross-site login blocked');

  const ok = await login(initialPw);
  assert.strictEqual(ok.status, 200, 'correct password accepted');
  const setCookie = ok.headers.get('set-cookie') || '';
  assert.ok(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'session cookie is HttpOnly + SameSite');
  const COOKIE = { Cookie: setCookie.split(';')[0] };

  assert.strictEqual((await J(`${BASE}/api/state`, { headers: COOKIE })).status, 200, 'session opens the API');
  assert.strictEqual((await fetch(`${BASE}/`, { headers: COOKIE, redirect: 'manual' })).status, 200, 'console served to a session');
  await new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/ws`, { headers: COOKIE });
    w.on('open', () => { w.close(); res(); });
    w.on('error', rej);
  });
  console.log('admin login OK      redirect, cookie, API + websocket');

  // change the password: other sessions die, this one is renewed
  const NEXT_PW = 'neues-geheimnis-123';
  const chg = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST', headers: { ...CONSOLE_POST, ...COOKIE }, body: JSON.stringify({ current: initialPw, next: NEXT_PW }),
  });
  assert.strictEqual(chg.status, 200, 'password change accepted');
  const COOKIE2 = { Cookie: (chg.headers.get('set-cookie') || '').split(';')[0] };
  assert.strictEqual((await J(`${BASE}/api/state`, { headers: COOKIE })).status, 401, 'old session invalidated');
  assert.strictEqual((await J(`${BASE}/api/state`, { headers: COOKIE2 })).status, 200, 'renewed session still works');
  assert.strictEqual((await login(initialPw)).status, 401, 'old password no longer works');
  assert.strictEqual((await login('kurz')).status, 401, 'short guess rejected');

  const lo = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { ...CONSOLE_POST, ...COOKIE2 } });
  assert.strictEqual(lo.status, 200, 'logout accepted');
  assert.strictEqual((await J(`${BASE}/api/state`, { headers: COOKIE2 })).status, 401, 'session gone after logout');
  const again = await login(NEXT_PW);
  assert.strictEqual(again.status, 200, 'new password logs in');
  console.log('password change OK  sessions cut, new password active');

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
  // The mission line declares mode 0 (not in the registry), the 11xx codes prove
  // it is Laserball — so everything is filed under the `laserball` family.
  await waitFor(() => fs.existsSync(path.join(dir, 'data', 'stats', 'all_players_laserball.csv')));
  const allp = fs.readFileSync(path.join(dir, 'data', 'stats', 'all_players_laserball.csv'), 'utf8');
  assert.ok(allp.includes('Lea') && /;win|win;/.test(allp), 'all_players_laserball.csv has Lea with a result');
  assert.ok(/;mode_0;/.test(allp) && /;laserball;/.test(allp), 'player rows carry mode_key + family');
  const files = (await J(`${BASE}/api/stats/files`, { headers: AUTH })).body.data;
  assert.ok(files.some((f) => f.name.endsWith('_players.csv')) && files.some((f) => f.name === 'totals_laserball.csv'), 'stats/files lists match + totals');
  assert.ok(files.some((f) => f.name === 'matches.csv') && files.some((f) => f.name === 'player_modes.csv'), 'stats/files lists matches + player_modes');
  const totals = (await J(`${BASE}/api/stats/totals`, { headers: AUTH })).body.data;
  assert.ok(totals.find((r) => r.name === 'Lea')?.goals === '1', 'stats/totals has Lea with 1 goal');
  const modes = fs.readFileSync(path.join(dir, 'data', 'stats', 'player_modes.csv'), 'utf8');
  assert.ok(/;mode_0;[^;]*;laserball;1;/.test(modes), 'player_modes.csv: one laserball match per player');
  const dl = await fetch(`${BASE}/api/stats/file?name=totals_laserball.csv`, { headers: AUTH });
  assert.ok(dl.headers.get('content-type').includes('text/csv'), 'stats/file downloads as CSV');
  console.log('csv stats OK        all_players + totals + player_modes written, downloadable');

  // ---- a SECOND match, SM5 this time: real TAB-delimited feed with `;` schema
  // comments and an official type-7 end block. Proves end-to-end that the two
  // mode families are detected, served and filed separately by the live service.
  {
    const T7HEAD = [';7/sm5-stats', 'id', 'shotsHit', 'shotsFired', 'timesZapped', 'timesMissiled', 'missileHits',
      'nukesDetonated', 'nukesActivated', 'nukesCancelled', 'medicHits', 'ownMedicHits', 'medicNukes', 'scoutRapid',
      'lifeBoost', 'ammoBoost', 'livesLeft', 'shotsLeft', 'penalties', 'shot3Hit', 'ownNukeCancels',
      'shotOpponent', 'shotTeam', 'missiledOpponent', 'missiledTeam'].join('\t');
    await new Promise((res, rej) => {
      const c = net.connect(TCP_PORT, '127.0.0.1', () => {
        c.write([
          ';1/mission\ttype\tdesc\tstart\tduration\tpenalty',
          '1\t5\tSpace Marines 5\t20260916094500\t900\t0',
          ';2/team\tindex\tdesc\tcolour-enum\tcolour-desc\tcolour',
          '2\t0\tRote Kugeln\t1\tRed\t#ef4444',
          '2\t1\tBlaue Kugeln\t4\tBlue\t#3b82f6',
          '4\t500\t0100',
          ';3/entity-start\ttime\tid\ttype\tdesc\tteam\tlevel\tcategory\tbattlesuit',
          '3\t1000\t#1001\tplayer\tMara\t0\t3\t1\tSuit-A',
          '3\t1100\t#3001\tplayer\tNoa\t1\t3\t5\tSuit-B',
          '4\t5000\t0205\t#1001\thits\t#3001',
          '4\t6000\t0206\t#1001\tdeactivates\t#3001',
          ';5/score\ttime\tentity\told\tdelta\tnew',
          '5\t8000\t0\t0\t4200\t4200',
          '5\t8000\t1\t0\t3100\t3100',
          T7HEAD,
          '7\t#1001\t42\t130\t7\t1\t3\t1\t1\t0\t0\t0\t0\t0\t0\t0\t3\t12\t0\t5\t0\t18\t2\t3\t0',
          '7\t#3001\t12\t90\t19\t3\t0\t0\t0\t0\t0\t0\t0\t2\t0\t0\t0\t4\t1\t1\t0\t6\t1\t0\t0',
          '4\t120000\t0101', '',
        ].join('\n'));
        setTimeout(() => { c.end(); res(); }, 400);
      });
      c.on('error', rej);
    });

    let s5;
    await waitFor(async () => {
      s5 = (await J(`${BASE}/api/state`, { headers: AUTH })).body?.data;
      return s5 && s5.mode && s5.mode.family === 'sm5' && s5.players['1001']?.statsSource === 'tdf7';
    });
    assert.strictEqual(s5.mode.key, 'sm5', 'mode key served by /api/state');
    assert.strictEqual(s5.mode.known, true, 'mode 5 is a known mode');
    assert.strictEqual(s5.mode.source, 'tdf', 'mode came from the type-1 line');
    assert.strictEqual(s5.mode.label, 'Space Marines 5', 'mission description with spaces AND a trailing number');
    assert.strictEqual(s5.missionDesc, 'Space Marines 5', 'missionDesc served too');
    assert.strictEqual(s5.durationKnown, true, 'the reported duration is used');
    assert.strictEqual(s5.duration, 900000, '900 s -> 900000 ms');
    assert.strictEqual(s5.remainingMs, 780000, 'remainingMs is pre-computed by the engine');
    assert.strictEqual(s5.scoreSource, 'tdf', 'the type-5 lines own the score');
    assert.strictEqual(s5.scores['0'], 4200, 'arena points served as the team score');
    assert.strictEqual(s5.teams['0'].name, 'Rote Kugeln', 'tab-delimited team name with a space');
    assert.strictEqual(s5.players['1001'].name, 'Mara', 'player carried over');
    assert.strictEqual(s5.players['1001'].roleLabel, 'Commander', 'SM5 role served');
    assert.strictEqual(s5.players['1001'].battlesuit, 'Suit-A', 'battlesuit read via the `;` schema line');
    assert.strictEqual(s5.players['1001'].shotsFired, 130, 'official type-7 numbers won over the live count');
    assert.strictEqual(s5.players['1001'].deactivations, 18, 'shotOpponent -> deactivations');
    assert.strictEqual(s5.players['3001'].timesDeactivated, 19, 'the block corrects the target counters too');

    const modeApi = (await J(`${BASE}/api/modes`, { headers: AUTH })).body.data;
    assert.deepStrictEqual(modeApi.families, ['laserball', 'sm5'], '/api/modes lists both families');
    assert.strictEqual(modeApi.defaultFamily, 'sm5', '/api/modes names the default family');
    assert.ok(modeApi.modes.some((m) => m.number === 28 && m.family === 'laserball'), '/api/modes registry lists Laserball');
    assert.ok(modeApi.modes.some((m) => m.number === 5 && m.family === 'sm5'), '/api/modes registry lists SM5');
    assert.strictEqual(modeApi.current.family, 'sm5', '/api/modes reports the mode running now');
    assert.strictEqual(modeApi.scoreboard.laserball[0].key, 'goals', 'scoreboard columns per family');
    assert.ok(modeApi.scoreboard.sm5.some((c) => c.key === 'shotsFired'), 'sm5 scoreboard columns served');

    // the SM5 match lands in its OWN files, the Laserball ones are untouched
    await waitFor(() => fs.existsSync(path.join(dir, 'data', 'stats', 'all_players_sm5.csv')));
    const sm5csv = fs.readFileSync(path.join(dir, 'data', 'stats', 'all_players_sm5.csv'), 'utf8').replace(/^\uFEFF/, '');
    const sm5head = sm5csv.split(/\r?\n/)[0].split(';');
    assert.ok(sm5head.includes('shots_fired') && !sm5head.includes('goals'), 'sm5 file carries SM5 columns only');
    assert.ok(/;tdf7;/.test(sm5csv) && /;sm5;/.test(sm5csv), 'sm5 rows marked tdf7 + family sm5');
    const lbHead = fs.readFileSync(path.join(dir, 'data', 'stats', 'all_players_laserball.csv'), 'utf8')
      .replace(/^\uFEFF/, '').split(/\r?\n/)[0].split(';');
    assert.ok(lbHead.includes('goals') && !lbHead.includes('shots_fired'), 'laserball file still carries Laserball columns only');
    assert.ok(fs.existsSync(path.join(dir, 'data', 'stats', 'totals_sm5.csv')), 'totals_sm5.csv written');

    // Mara played BOTH families -> exactly two rows in player_modes.csv
    const modeRows = fs.readFileSync(path.join(dir, 'data', 'stats', 'player_modes.csv'), 'utf8')
      .replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1)
      .map((l) => l.split(';'))
      .filter((c) => c[0] === '1001');
    assert.strictEqual(modeRows.length, 2, 'player_modes.csv: two rows for the player who played both modes');
    assert.deepStrictEqual(modeRows.map((c) => c[2]).sort(), ['mode_0', 'sm5'], 'one row per mode key');
    assert.deepStrictEqual(modeRows.map((c) => c[4]).sort(), ['laserball', 'sm5'], 'each row carries its own family');
    const matchIdx2 = fs.readFileSync(path.join(dir, 'data', 'stats', 'matches.csv'), 'utf8').replace(/^\uFEFF/, '')
      .split(/\r?\n/).filter(Boolean);
    assert.strictEqual(matchIdx2.length, 3, 'matches.csv: header + 2 matches');
    console.log('csv families OK     laserball + sm5 filed apart, Mara has a row per mode');
  }

  // readable event-log file written under data/logs/
  const logDir = path.join(dir, 'data', 'logs');
  await waitFor(() => { try { return fs.readdirSync(logDir).some((f) => f.endsWith('.log')); } catch { return false; } });
  const logFile = fs.readdirSync(logDir).find((f) => f.endsWith('.log'));
  const logText = fs.readFileSync(path.join(logDir, logFile), 'utf8');
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}\+\d\d:\d\d\.\d{3} {2}\[\S+\] {2}\S/m.test(logText), 'event log has readable, columned lines');
  assert.ok(/──── Match .+ ────/.test(logText), 'event log has a match header/footer');
  assert.ok(/\bgoal\b|\bTor\b/.test(logText), 'event log recorded the goal');
  console.log('event log OK        readable lines in', path.join('data', 'logs', logFile));

  // ---- startup notification: password on the first start, IP on every one ----
  // A second, independent instance: it has a notification channel, so it may
  // generate the first password and send it — the only way onto a PC with no
  // monitor and no shell.
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lflive-it2-'));
    const PORT2 = HTTP_PORT + 30;
    const env2 = {
      ...process.env,
      LF_HTTP_PORT: String(PORT2), LF_TCP_PORT: String(TCP_PORT + 30),
      LF_HTTP_HOST: '127.0.0.1', LF_TCP_HOST: '127.0.0.1', LF_LOG_LEVEL: 'error',
      LF_NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${WH_PORT}/notify`,
    };
    const notes = () => received.filter((r) => r.headers['x-lfb-event'] === undefined && /notify/.test(r.url || '')).map((r) => JSON.parse(r.body));

    const first = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], { cwd: dir2, env: env2 });
    procs.push(first);
    first.stderr.on('data', (d) => process.stderr.write(`[svc2!] ${d}`));
    await waitFor(async () => (await J(`http://127.0.0.1:${PORT2}/api/health`)).status === 200);
    await waitFor(() => notes().length >= 1, 12000).catch(() => {
      throw new Error(`startup notification never arrived — webhook receiver saw: ${JSON.stringify(received.map((r) => r.url))}`);
    });
    const firstMsg = notes()[0];

    const pwFile = path.join(dir2, 'data', 'initial-admin-password.txt');
    assert.ok(fs.existsSync(pwFile), 'a deliverable password is generated on the first start');
    const pw = fs.readFileSync(pwFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4})+$/.test(l));
    assert.ok(pw, 'password file holds a password');
    assert.ok(firstMsg.text.includes(pw), 'first start sends the admin password');
    assert.ok(/Admin-Passwort:/.test(firstMsg.text) && /Erster Start/.test(firstMsg.text), 'and labels it as the first-start password');
    assert.ok(/:\d+\//.test(firstMsg.text) && firstMsg.info.addresses, 'first start also carries IP and port');
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT2}/`, { redirect: 'manual' })).headers.get('location'), '/login', 'that instance is locked, not waiting for setup');

    first.kill('SIGKILL');
    await sleep(500);

    // second start: same config.json, password already set -> no password in the message
    const second = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js')], { cwd: dir2, env: env2 });
    procs.push(second);
    await waitFor(async () => (await J(`http://127.0.0.1:${PORT2}/api/health`)).status === 200);
    await waitFor(() => notes().length >= 2);
    const secondMsg = notes()[1];
    assert.ok(!secondMsg.text.includes(pw), 'second start does NOT repeat the password');
    assert.ok(!/Erster Start/.test(secondMsg.text) && !/Admin-Passwort:/.test(secondMsg.text), 'second start carries no password block');
    assert.ok(/Konsole:/.test(secondMsg.text) && /IP-Adressen:/.test(secondMsg.text), 'second start still reports IP and port');

    // "forgot password": the code goes to the channel, never over HTTP
    const rec = await fetch(`http://127.0.0.1:${PORT2}/api/auth/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' }, body: '{}' });
    assert.strictEqual(rec.status, 200, 'recovery accepted when a channel exists');
    const recBody = await rec.json();
    await waitFor(() => notes().length >= 3);
    const codeMsg = notes()[2];
    const code = (codeMsg.text.match(/Code:\s+([A-Z0-9-]+)/) || [])[1];
    assert.ok(code, 'recovery code delivered through the channel');
    assert.ok(!JSON.stringify(recBody).includes(code), 'recovery code never travels over HTTP');
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' }, body: JSON.stringify({ password: pw }) })).status, 200, 'old password still valid while a code is open');

    const confirm = (body) => fetch(`http://127.0.0.1:${PORT2}/api/auth/recover/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' }, body: JSON.stringify(body) });
    assert.strictEqual((await confirm({ code: 'XXXX-XXXX-XXXX', next: 'ein-neues-1234' })).status, 401, 'wrong code rejected');
    const used = await confirm({ code, next: 'ein-neues-1234' });
    assert.strictEqual(used.status, 200, 'correct code sets a new password');
    assert.strictEqual((await confirm({ code, next: 'noch-eins-1234' })).status, 401, 'the code is single use');
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT2}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LF-Console': '1' }, body: JSON.stringify({ password: 'ein-neues-1234' }) })).status, 200, 'recovered password works');
    console.log('notification OK     1st start: password · 2nd start: IP only · recovery code via channel');

    second.kill('SIGKILL');
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
  }

  ws.close(); wh.close(); sc.destroy(); tcpRecv.close();
  console.log('\nALL E2E CHECKS PASSED');
  done(0);
})().catch((e) => { console.error('\nFAILED:', e.stack); done(1); });
