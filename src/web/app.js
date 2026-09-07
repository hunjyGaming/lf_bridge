'use strict';

const $ = (id) => document.getElementById(id);
const el = (t, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(t), props);
  for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const TEAM_FALLBACK = ['#ef4444', '#38bdf8', '#22c55e', '#eab308', '#a855f7'];

let token = localStorage.getItem('lf_token') || '';
let cfg = null;
let outputs = [];
let stream = { enabled: false, port: 9100 };
let editing = null; // output being edited, or a fresh draft
let lastLogTs = 0;

// ---------------- fetch ----------------
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) { await askToken(); return api(path, { method, body }); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status });
  return data;
}
function askToken() {
  return new Promise((resolve) => {
    const dlg = $('token-dialog');
    $('token-input').value = token;
    dlg.showModal();
    dlg.addEventListener('close', () => {
      token = $('token-input').value.trim();
      localStorage.setItem('lf_token', token);
      resolve();
    }, { once: true });
  });
}

// ---------------- toast ----------------
let toastT;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.style.borderColor = bad ? 'var(--alert)' : 'var(--edge)';
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 4200);
}
function note(msg, bad) {
  const n = $('note');
  n.textContent = msg;
  n.style.color = bad ? 'var(--alert)' : 'var(--ink-dim)';
  clearTimeout(note._t);
  note._t = setTimeout(() => (n.textContent = ''), 6000);
}

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'log') pollLogs();
  if (b.dataset.tab === 'stats') loadStats();
}));
document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); toast('Kopiert'); }
  catch { toast('Kopieren nicht möglich', true); }
}));

// ---------------- websocket ----------------
let ws;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws${q}`);
  ws.onclose = () => { setChip('chip-lf', 'off', 'Laserforce'); setTimeout(connectWs, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'state') renderLive(m.data);
    else if (m.type === 'event') { pushFeed(m.data); fireFlow(); }
  };
}

// ---------------- signal flow ----------------
function fireFlow() {
  for (const id of ['wire-a', 'wire-b']) {
    const w = $(id);
    w.classList.remove('fire'); void w.offsetWidth; w.classList.add('fire');
    setTimeout(() => w.classList.remove('fire'), 700);
  }
}
function renderFlow(st) {
  const feeding = st.tcp.connected || (st.tcp.lastLineAt && Date.now() - st.tcp.lastLineAt < 8000);
  $('node-in').classList.toggle('lit', !!feeding);
  $('flow').classList.toggle('streaming', !!feeding && st.match.active);
  $('in-sub').textContent = ':' + st.tcp.port;
  setChip('chip-lf', st.tcp.connected ? 'on' : (feeding ? 'live' : 'off'), 'Laserforce');

  const hint = $('conn-hint');
  hint.hidden = !!st.tcp.connected;
  if (!st.tcp.connected) {
    hint.textContent = `Laserforce nicht verbunden. Log-Export im Laserforce-System auf  ${st.tcp.host}:${st.tcp.port}  richten.`;
  }
  const rl = $('reach-line');
  if (rl && st.lan) rl.textContent = `Konsole: ${location.origin}   ·   von anderen Rechnern im LAN: http://${st.lan}:${st.http.port}/`;
  else if (rl) rl.textContent = `Konsole: ${location.origin}`;

  $('node-engine').classList.toggle('lit', st.match.active);
  $('engine-state').textContent = st.match.active ? fmt(Math.max(0, st.match.durationMs - st.match.elapsedMs)) : 'Leerlauf';
  $('engine-sub').textContent = st.match.active ? `${st.match.players} Spieler` : 'kein Match';

  const outs = st.outputs || [];
  const active = outs.filter((o) => o.enabled);
  const okc = active.filter((o) => o.last?.ok || (o.kind === 'tcp' && o.connected)).length;
  $('out-count').textContent = `${active.length} aktiv`;
  $('node-out').classList.toggle('lit', active.length > 0);
  const mini = $('out-mini');
  mini.textContent = '';
  for (const o of active.slice(0, 6)) {
    const led = el('i', { className: 'led ' + outLed(o) });
    mini.append(el('li', {}, led, o.name));
  }
  if (st.streamServer?.enabled) mini.append(el('li', {}, el('i', { className: 'led ' + (st.streamServer.clients ? 'on' : '') }), `raw:${st.streamServer.port}`));

  setChip('chip-clients', st.http.clients ? 'on' : 'off', `${st.http.clients} Clients`);
  setChip('chip-outputs', active.length && okc === active.length ? 'on' : (okc ? 'live' : (active.length ? 'bad' : 'off')), `${okc}/${active.length} Ziele`);
}
function outLed(o) {
  if (o.kind === 'tcp') return o.connected ? 'on' : 'bad';
  if (!o.last) return '';
  return o.last.ok ? 'on' : 'bad';
}
function setChip(id, cls, text) {
  const c = $(id);
  c.lastChild.textContent = ' ' + text;
  c.querySelector('.led').className = 'led ' + (cls === 'off' ? '' : cls);
}

// ---------------- live rendering ----------------
let clockTimer = null, remaining = 0;
function renderLive(s) {
  const players = Object.values(s.players || {});
  const teamIds = [...new Set(players.map((p) => String(p.teamId)))].sort();
  const meta = (t, i) => s.teams?.[t] || { name: `Team ${t}`, color: TEAM_FALLBACK[i] || '#9aa' };

  const [a, b] = teamIds;
  paintSide('side-a', a ? meta(a, 0) : { name: '—', color: '#555' }, a ? (s.scores?.[a] ?? 0) : 0);
  paintSide('side-b', b ? meta(b, 1) : { name: '—', color: '#555' }, b ? (s.scores?.[b] ?? 0) : 0);

  $('mid-label').textContent = s.missionActive ? 'Match läuft' : 'kein Match';
  $('tab-live').classList.toggle('match-live', s.missionActive);
  remaining = (s.duration || 0) - (s.elapsedTime || 0);
  drawClock();
  clearInterval(clockTimer);
  if (s.missionActive) clockTimer = setInterval(() => { remaining -= 1000; drawClock(); }, 1000);

  const cols = $('stat-cols');
  cols.textContent = '';
  teamIds.forEach((t, i) => {
    const tm = meta(t, i);
    const tp = players.filter((p) => String(p.teamId) === t).sort((x, y) => y.goals - x.goals);
    const box = el('div', { className: 'stat-col' }, el('h4', { style: `color:${tm.color}` }, tm.name));
    const tbl = el('table', { className: 'stat' });
    tbl.append(trow('th', ['Spieler', 'T', 'V', 'St', 'Bl', 'Rs', 'Cl', 'Ps']));
    for (const p of tp) {
      const tr = trow('td', [p.name, p.goals, p.assists || 0,
        `${p.stealsDone}/${p.stealsReceived || 0}`, `${p.blocksDone}/${p.blocksReceived || 0}`,
        `${p.resetsDone}/${p.resetsReceived || 0}`, `${p.clearsDone}/${p.clearsReceived || 0}`,
        `${p.passesDone}/${p.passesReceived || 0}`]);
      tr.firstChild.className = 'pl';
      if (s.ballHolderId === p.id) tr.classList.add('has-ball');
      if (p.status === 3) tr.classList.add('is-out');
      tbl.append(tr);
    }
    box.append(tbl);
    cols.append(box);
  });
}
function paintSide(id, m, score) {
  const e = $(id);
  e.querySelector('.sname').textContent = m.name;
  e.querySelector('.sname').style.color = m.color;
  e.querySelector('.sscore').textContent = score;
}
function trow(cell, vals) { const tr = el('tr'); for (const v of vals) tr.append(el(cell, {}, String(v))); return tr; }
function drawClock() { let ms = remaining < 0 ? 0 : remaining; $('clock').textContent = fmt(ms); }
function fmt(ms) { const t = Math.floor((ms || 0) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
function pushFeed(evt) {
  const f = $('feed');
  const line = el('div', { className: 'fe' },
    el('span', { className: 'ft' }, fmt(evt.elapsedMs)),
    el('span', { className: evt.type === 'goal' ? 'fg' : '' }, evt.text || evt.type));
  f.append(line);
  while (f.childElementCount > 80) f.removeChild(f.firstChild);
  f.scrollTop = f.scrollHeight;
}

// ---------------- settings ----------------
const PIN_MAP = {
  'logLevel': 's-loglevel',
  'http.host': 's-http-host', 'http.port': 's-http-port',
  'tcp.host': 's-tcp-host', 'tcp.port': 's-tcp-port',
  'apiToken': 's-token', 'cors': 's-cors', 'rateLimitPerMin': 's-rate',
  'streamServer.enabled': 'stream-enabled', 'streamServer.host': 'stream-host', 'streamServer.port': 'stream-port',
  'match.defaultDurationMs': 's-duration',
  'csv.enabled': 's-csv-enabled', 'csv.delimiter': 's-csv-delim', 'csv.writeEvents': 's-csv-events', 'csv.writeLive': 's-csv-live',
  'localRoster.enabled': 's-roster-enabled', 'localRoster.file': 's-roster-file',
};
function applyPins(pins) {
  const set = new Set(pins || []);
  for (const [key, id] of Object.entries(PIN_MAP)) {
    const inp = $(id);
    if (!inp) continue;
    const on = set.has(key);
    inp.disabled = on;
    inp.closest('label:not(.switch)')?.classList.toggle('pinned', on);
    if (on && inp.title !== 'aus .env') inp.title = 'per .env festgelegt — hier nicht änderbar';
    if (!on) inp.removeAttribute('title');
  }
}

async function loadConfig() {
  const res = await api('/api/config');
  cfg = res.data;
  outputs = structuredClone(cfg.outputs || []);
  stream = { ...cfg.streamServer };

  $('s-tcp-port').value = cfg.tcp.port; $('s-tcp-host').value = cfg.tcp.host;
  $('s-http-port').value = cfg.http.port; $('s-http-host').value = cfg.http.host;
  $('s-token').value = cfg.apiToken || '';
  $('s-cors').value = (cfg.cors || []).join('\n');
  $('s-rate').value = cfg.rateLimitPerMin ?? 0;
  $('s-duration').value = cfg.match.defaultDurationMs;
  $('s-loglevel').value = cfg.logLevel;

  $('s-csv-enabled').checked = cfg.csv.enabled;
  $('s-csv-delim').value = cfg.csv.delimiter;
  $('s-csv-events').checked = cfg.csv.writeEvents;
  $('s-csv-live').checked = cfg.csv.writeLive;
  $('csv-dir').textContent = cfg.csv.dir;

  $('s-roster-enabled').checked = cfg.localRoster.enabled;
  $('s-roster-file').value = cfg.localRoster.file;

  $('stream-enabled').checked = stream.enabled;
  $('stream-host').value = stream.host || '';
  $('stream-port').value = stream.port;
  streamNote();

  applyPins(res.envPins);

  const base = location.origin;
  $('ch-rest').textContent = base + '/api';
  $('ch-ws').textContent = base.replace(/^http/, 'ws') + '/ws';
  renderOutputs();
}
$('stream-enabled').addEventListener('change', () => { stream.enabled = $('stream-enabled').checked; streamNote(); });
$('stream-port').addEventListener('input', () => { stream.port = +$('stream-port').value || stream.port; streamNote(); });
$('stream-host').addEventListener('input', () => { stream.host = $('stream-host').value.trim(); streamNote(); });
function streamNote() {
  const host = (stream.host && stream.host !== '0.0.0.0') ? stream.host : location.hostname;
  $('stream-note').textContent = stream.enabled
    ? `An. Verbinden z. B. mit  nc ${host} ${stream.port || 9100}  — liefert JSON-Zeilen. Bind ${stream.host || '127.0.0.1'}${(stream.host && stream.host !== '127.0.0.1') ? '' : ' (nur dieser PC — für LAN 0.0.0.0)'}.`
    : 'Aus. Für Tools, die eine Socket-Verbindung aufmachen statt HTTP.';
}

function collectConfig() {
  return {
    logLevel: $('s-loglevel').value,
    http: { host: $('s-http-host').value.trim(), port: +$('s-http-port').value },
    tcp: { host: $('s-tcp-host').value.trim(), port: +$('s-tcp-port').value },
    apiToken: $('s-token').value.trim(),
    cors: $('s-cors').value.split('\n').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Math.max(0, +$('s-rate').value || 0),
    match: { defaultDurationMs: +$('s-duration').value },
    csv: {
      enabled: $('s-csv-enabled').checked,
      delimiter: $('s-csv-delim').value,
      writeEvents: $('s-csv-events').checked,
      writeLive: $('s-csv-live').checked,
    },
    localRoster: { enabled: $('s-roster-enabled').checked, file: $('s-roster-file').value.trim() || 'data/roster.csv' },
    outputs,
    streamServer: { enabled: stream.enabled, host: $('stream-host').value.trim() || '127.0.0.1', port: +$('stream-port').value || 9100 },
  };
}
$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    const nt = $('s-token').value.trim();
    await api('/api/config', { method: 'POST', body: collectConfig() });
    if (nt !== token) { token = nt; localStorage.setItem('lf_token', token); }
    await loadConfig();
    note('Gespeichert');
    refreshStatus();
  } catch (err) { note('Fehler: ' + err.message, true); }
  $('save').disabled = false;
});
$('roster-reload').addEventListener('click', async () => {
  $('roster-status').textContent = 'lädt…';
  try { const r = await api('/api/roster/reload', { method: 'POST' }); $('roster-status').textContent = r.data.lastError ? r.data.lastError : `${r.data.players} Namen geladen`; }
  catch (err) { $('roster-status').textContent = err.message; }
});

// ---------------- stats ----------------
async function loadStats() {
  try {
    const [tot, files] = await Promise.all([api('/api/stats/totals'), api('/api/stats/files')]);
    renderTotals(tot.data);
    renderStatsFiles(files.data);
  } catch (err) { note('Statistik laden fehlgeschlagen: ' + err.message, true); }
}
function renderTotals(rows) {
  const t = $('totals-table');
  t.textContent = '';
  if (!rows.length) { t.append(el('tbody', {}, el('tr', {}, el('td', { style: 'color:var(--ink-2)' }, 'Noch keine aufgezeichneten Matches.')))); return; }
  const cols = [['name', 'Spieler'], ['matches', 'M'], ['wins', 'S'], ['goals', 'Tore'], ['assists', 'Vorl.'],
    ['steals_done', 'Steals'], ['blocks_done', 'Blocks'], ['resets_done', 'Resets'], ['clears_done', 'Clears'],
    ['passes_done', 'Pässe'], ['goals_per_match', '⌀ Tore']];
  const head = el('tr');
  cols.forEach(([, l]) => head.append(el('th', {}, l)));
  t.append(el('thead', {}, head));
  const body = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    cols.forEach(([k], i) => { const td = el('td', {}, r[k] ?? '0'); if (i === 0) td.className = 'pl'; tr.append(td); });
    body.append(tr);
  }
  t.append(body);
}
function renderStatsFiles(files) {
  const wrap = $('stats-files');
  wrap.textContent = '';
  if (!files.length) { wrap.append(el('p', { className: 'muted', style: 'padding:16px 4px' }, 'Noch keine Dateien — sie entstehen automatisch am Ende jedes Matches.')); return; }
  for (const f of files) {
    const url = `/api/stats/file?name=${encodeURIComponent(f.name)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
    const a = el('a', { href: url, className: 'ocard', download: f.name.split('/').pop() });
    a.style.textDecoration = 'none';
    a.append(
      el('div', { className: 'ocard-top' },
        el('span', { className: 'badge amber' }, 'CSV'),
        el('span', { className: 'ocard-name' }, f.name),
        el('span', { className: 'ocard-target', style: 'margin-left:auto' }, `${(f.size / 1024).toFixed(1)} kB · ${new Date(f.mtime).toLocaleString()}`)));
    wrap.append(a);
  }
}
$('totals-refresh').addEventListener('click', loadStats);

// ---------------- outputs ----------------
function renderOutputs() {
  const wrap = $('output-list');
  wrap.textContent = '';
  if (!outputs.length) wrap.append(el('p', { className: 'muted', style: 'padding:16px 4px' }, 'Noch keine Ziele — mit „Ziel hinzufügen" schickst du Match-Daten an eine IP:Port im LAN.'));
  outputs.forEach((o, i) => wrap.append(outputCard(o, i)));
}
function outputCard(o, i) {
  const c = el('div', { className: 'ocard' });
  const top = el('div', { className: 'ocard-top' },
    el('span', { className: 'badge ' + (o.kind === 'webhook' ? '' : 'amber') }, o.kind),
    el('span', { className: 'ocard-name' }, o.name),
    el('span', { className: 'ocard-target' }, o.kind === 'webhook' ? (o.url || '—') : `${o.host || '—'}:${o.port || '—'}`));
  const actions = el('div', { className: 'ocard-actions' });
  const sw = el('label', { className: 'switch' });
  const swi = el('input', { type: 'checkbox', checked: !!o.enabled });
  swi.addEventListener('change', async () => { o.enabled = swi.checked; await quickSave(); });
  sw.append(swi, el('span'));
  actions.append(sw,
    ghost('Test', async (b) => { b.disabled = true; const r = await api('/api/outputs/test', { method: 'POST', body: { output: o } }); b.disabled = false; toast(`${o.name}: ${r.data.ok ? 'OK' : (r.data.detail || r.data.error || 'Fehler')}`, !r.data.ok); setTimeout(refreshStatus, 400); }),
    ghost('Ändern', () => openForm(o)),
    ghost('Löschen', async () => { if (!confirm(`„${o.name}" löschen?`)) return; outputs.splice(i, 1); await quickSave(); }));
  top.append(actions);
  c.append(top);

  const st = liveOutputStatus(o.id);
  const meta = el('div', { className: 'ocard-meta' },
    el('span', {}, 'Events: ' + (o.events || ['*']).join(',')),
    o.sendState ? el('span', {}, '+ State') : null,
    st ? el('span', {}, statusText(o, st)) : null);
  c.append(meta);
  return c;
}
let LAST_STATUS = null;
function liveOutputStatus(id) { return LAST_STATUS?.outputs?.find((x) => x.id === id) || null; }
function statusText(o, st) {
  if (o.kind === 'tcp') return st.connected ? '● verbunden' : '○ nicht verbunden';
  if (!st.last) return 'noch nicht gesendet';
  return (st.last.ok ? '● ' : '○ ') + (st.last.detail || (st.last.ok ? 'ok' : 'Fehler'));
}

function openForm(o) {
  editing = o
    ? { ...o }
    : { name: '', kind: 'tcp', enabled: true, events: ['*'], sendEvents: true, sendState: false, host: '', port: 7000, url: '', secret: '', includeState: false };
  render();

  function render() {
    const f = $('output-form');
    f.hidden = false;
    f.textContent = '';
    f.append(el('span', { className: 'eyebrow' }, o ? 'Ziel ändern' : 'Neues Ziel'));
    f.append(txt('Name', 'name'));

    const seg = el('div', { className: 'seg' });
    for (const k of ['webhook', 'tcp', 'udp']) {
      const btn = el('button', { className: editing.kind === k ? 'on' : '' }, k.toUpperCase());
      btn.type = 'button';
      btn.addEventListener('click', () => { grab(); editing.kind = k; render(); });
      seg.append(btn);
    }
    f.append(el('label', {}, 'Art', seg));

    if (editing.kind === 'webhook') {
      f.append(txt('URL', 'url'));
      f.append(txt('Secret (optional — aktiviert HMAC-Signatur)', 'secret', 'password'));
    } else {
      const g = el('div', { className: 'grid2' });
      g.append(txt('Host / IP', 'host'), txt('Port', 'port', 'number'));
      f.append(g);
    }

    f.append(txt('Events (Komma, * = alle)', 'events'));
    const chks = el('div', { className: 'row' });
    chks.append(box('Events senden', 'sendEvents'), box('State senden', 'sendState'));
    f.append(chks);

    const bar = el('div', { className: 'row end' });
    bar.style.marginTop = '12px';
    bar.append(
      ghost('Abbrechen', () => { f.hidden = true; editing = null; }),
      btnPrimary(o ? 'Übernehmen' : 'Hinzufügen', submit),
    );
    f.append(bar);
  }

  function txt(label, key, type = 'text') {
    const l = el('label', {}, label);
    const v = key === 'events' ? (editing.events || ['*']).join(',') : (editing[key] ?? '');
    const inp = el('input', { type, value: v });
    inp.dataset.key = key;
    l.append(inp);
    return l;
  }
  function box(label, key) {
    const l = el('label', { className: 'row-chk inline' });
    const inp = el('input', { type: 'checkbox', checked: !!editing[key] });
    inp.dataset.key = key; inp.dataset.bool = '1';
    l.append(inp, document.createTextNode(' ' + label));
    return l;
  }
  function grab() {
    $('output-form').querySelectorAll('[data-key]').forEach((inp) => {
      const k = inp.dataset.key;
      if (inp.dataset.bool) editing[k] = inp.checked;
      else if (k === 'events') {
        const arr = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
        editing.events = arr.length ? arr : ['*'];
      } else if (inp.type === 'number') editing[k] = +inp.value;
      else editing[k] = inp.value.trim();
    });
  }
  async function submit() {
    grab();
    if (!editing.name) editing.name = editing.kind.toUpperCase() + ' ' + (outputs.length + 1);
    if (editing.kind === 'webhook' && !/^https?:\/\//.test(editing.url)) return toast('URL muss mit http:// oder https:// beginnen', true);
    if (editing.kind !== 'webhook' && (!editing.host || !editing.port)) return toast('Host und Port angeben', true);
    if (editing.id) outputs[outputs.findIndex((x) => x.id === editing.id)] = editing;
    else outputs.push(editing);
    $('output-form').hidden = true;
    editing = null;
    await quickSave();
  }
}
$('add-output').addEventListener('click', () => openForm(null));

async function quickSave() {
  try { await api('/api/config', { method: 'POST', body: collectConfig() }); await loadConfig(); refreshStatus(); }
  catch (err) { toast('Speichern fehlgeschlagen: ' + err.message, true); }
}
function ghost(label, fn) { const b = el('button', { className: 'ghost mini' }, label); b.addEventListener('click', () => fn(b)); return b; }
function btnPrimary(label, fn) { const b = el('button', {}, label); b.addEventListener('click', () => fn(b)); return b; }

// ---------------- status poll ----------------
async function refreshStatus() {
  try { const r = await api('/api/status'); LAST_STATUS = r.data; renderFlow(r.data); if ($('tab-outputs').classList.contains('active')) renderOutputs(); }
  catch {}
}

// ---------------- log ----------------
let logTimer = null;
async function pollLogs() { clearInterval(logTimer); await fetchLogs(); logTimer = setInterval(fetchLogs, 2000); }
async function fetchLogs() {
  if (!$('tab-log').classList.contains('active')) { clearInterval(logTimer); return; }
  try {
    const r = await api('/api/logs?limit=300');
    const v = $('log');
    for (const e of r.data) {
      if (e.ts <= lastLogTs) continue;
      lastLogTs = e.ts;
      v.append(el('div', { className: 'lg-' + e.level }, `${new Date(e.ts).toLocaleTimeString()}  ${e.level.toUpperCase().padEnd(5)} ${e.scope}: ${e.msg}`));
    }
    while (v.childElementCount > 500) v.removeChild(v.firstChild);
    if ($('log-auto').checked) v.scrollTop = v.scrollHeight;
  } catch {}
}
$('log-clear').addEventListener('click', () => { $('log').textContent = ''; lastLogTs = 0; });

// ---------------- init ----------------
(async () => {
  try { await loadConfig(); } catch (err) { note('Konfig laden fehlgeschlagen: ' + err.message, true); }
  connectWs();
  refreshStatus();
  setInterval(refreshStatus, 3000);
})();
