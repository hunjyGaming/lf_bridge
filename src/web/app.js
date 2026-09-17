'use strict';

// Zuallererst: die gespeicherte Theme-Wahl auf <html> setzen. Das laeuft vor
// dem ersten Anstrich, damit die Konsole nicht kurz in der falschen Helligkeit
// aufblitzt. Ohne eigene Wahl entscheidet die CSS-Regel (prefers-color-scheme,
// Vorgabe dunkel). Ein Inline-Skript im HTML ginge nicht — die Konsole liefert
// eine Content-Security-Policy mit `script-src 'self'` aus.
try {
  const saved = localStorage.getItem('lf_theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch {}

const $ = (id) => document.getElementById(id);
const el = (t, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(t), props);
  for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
// Reicht fuer die sieben echten Laserforce-Team-Indizes (0-7 ohne die 5 =
// „Neutral", siehe docs/LASERFORCE.md) plus einen Rest-Ton.
const TEAM_FALLBACK = ['#ef4444', '#38bdf8', '#22c55e', '#eab308', '#a855f7', '#f97316', '#ec4899', '#94a3b8'];
/**
 * Teamfarbe aus dem TCP-Feed, bevor sie in CSS landet. Akzeptiert
 * ausschliesslich `#rgb` / `#rrggbb`; alles andere (leer, `url(...)`,
 * `red;--x:y`, beliebiger Text) faellt auf die Hausfarbe zurueck. Ohne diese
 * Pruefung koennte ein feindlicher Feed eine CSS-Deklaration einschmuggeln.
 */
const HEXCOLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function safeColor(v, i) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (HEXCOLOR.test(s)) return s;
  return TEAM_FALLBACK[((i | 0) % TEAM_FALLBACK.length + TEAM_FALLBACK.length) % TEAM_FALLBACK.length];
}
/** Setzt die geprueften Teamfarbe als CSS-Variable auf einem Knoten. */
function paintTeam(node, color) { node.style.setProperty('--team', color); return node; }

// ---------------- event language (shared: Live-Feed + Ereignisse) ----------------
// Renders straight from the WS `event` frame. Prefers a server-supplied
// `category` / `label` / `phrase` if a later build adds them (see docs/API.md),
// otherwise derives category + a readable German sentence from the structured fields.
const EV_CATS = ['match', 'score', 'possession', 'combat', 'player', 'special', 'other'];
const EV_CAT_LABEL = {
  match: 'Match', score: 'Treffer', possession: 'Ballbesitz', combat: 'Duell',
  player: 'Spieler', special: 'Spezial', other: 'Sonstiges',
};
// Mirrors the category taxonomy in src/eventCatalog.js (match / score / possession
// / combat / player / special / other) so a future server-supplied `category` and
// this client-side fallback agree.
const EV_TYPE_CAT = {
  match_start: 'match', match_end: 'match',
  goal: 'score',
  pass: 'possession', clear: 'possession', steal: 'possession', failed_clear: 'possession',
  block: 'combat',
  reset: 'special',
  player_join: 'player', status: 'player',
};
function evtCategory(e) {
  if (e && e.category && EV_CAT_LABEL[e.category]) return e.category;
  return (e && EV_TYPE_CAT[e.type]) || 'other';
}
function evtTag(e) {
  return (e && typeof e.label === 'string' && e.label) || EV_CAT_LABEL[evtCategory(e)];
}
function evtScoreLine(e) {
  if (!e || !e.scores) return '';
  return Object.keys(e.scores).sort().map((k) => e.scores[k]).join(':');
}
function evtSentence(e) {
  if (!e) return '';
  if (typeof e.phrase === 'string' && e.phrase) return e.phrase;
  const a = e.actorName || (e.actorId ? '#' + e.actorId : 'Jemand');
  const t = e.targetName || (e.targetId ? '#' + e.targetId : null);
  switch (e.type) {
    case 'match_start': return 'Match gestartet';
    case 'match_end':   return 'Match beendet' + (e.scores ? ` — Endstand ${evtScoreLine(e)}` : '');
    case 'player_join': return `${a} betritt Team ${e.teamId != null ? e.teamId : '?'}`;
    case 'pass':        return t ? `${a} passt zu ${t}` : `${a} passt`;
    case 'clear':       return t ? `${a} klärt zu ${t}` : `${a} klärt`;
    case 'failed_clear':return `${a} vergibt den Clear`;
    case 'steal':       return t ? `${a} erobert den Ball von ${t}` : `${a} erobert den Ball`;
    case 'block':       return t ? `${a} blockt ${t}` : `${a} blockt`;
    case 'reset':       return t ? `${a} setzt ${t} zurück` : `${a} setzt zurück`;
    case 'goal': {
      const as = e.assistName ? ` (Vorlage: ${e.assistName})` : '';
      const sc = e.scores ? ` — ${evtScoreLine(e)}` : '';
      return `${a} trifft${as}${sc}`;
    }
    case 'status': {
      const s = Number(e.status);
      if (s === 3) return `${a} ist ausgeschieden`;
      if (s === 2) return `${a} im Reset`;
      if (s === 0) return `${a} ist wieder aktiv`;
      return `${a}: Status ${e.status}`;
    }
  }
  return e.text || e.type || 'Ereignis';
}
function evtMatchShort(e) {
  return e && e.matchId ? String(e.matchId).slice(-4) : '—';
}

let token = localStorage.getItem('lf_token') || '';
let cfg = null;
// Game-mode registry from GET /api/modes — holds the per-family scoreboard
// layout (src/gameModes.js scoreboardColumns). The console never hard-wires a
// column set of its own, so a mode change rebuilds the table from the server's
// definition without a reload.
let MODES = null;
let modesLoading = false;
let outputs = [];
let stream = { enabled: false, port: 9100 };
let editing = null; // output being edited, or a fresh draft
let lastLogTs = 0;

// ---------------- fetch ----------------
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  // marks a mutating request as coming from this console (CSRF gate, see SECURITY.md)
  if (method !== 'GET' && method !== 'HEAD') headers['X-LF-Console'] = '1';
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !raw) {
    // Admin-Login aktiv? Dann zurück zur Anmeldeseite, sonst der alte Token-Dialog.
    if (data && data.loginRequired) { location.replace('/login'); return new Promise(() => {}); }
    await askToken();
    return api(path, { method, body });
  }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || res.statusText), { status: res.status, data });
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
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 4200);
}
function note(msg, bad) {
  const n = $('note');
  n.textContent = msg;
  n.classList.toggle('bad', !!bad);
  clearTimeout(note._t);
  note._t = setTimeout(() => (n.textContent = ''), 6000);
}

// ---------------- Hell / Dunkel ----------------
// Vorgabe bleibt dunkel: ohne eigene Wahl entscheidet die CSS-Regel
// (prefers-color-scheme), und die ist auf dunkel voreingestellt. Eine Wahl per
// Knopf wird gespeichert und gewinnt ab dann — auch nach einem Neustart.
function themePicked() {
  try { const t = localStorage.getItem('lf_theme'); return (t === 'light' || t === 'dark') ? t : null; } catch { return null; }
}
function themeNow() {
  const picked = themePicked();
  if (picked) return picked;
  try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; }
}
function paintThemeBtn() {
  const b = $('theme-btn');
  if (!b) return;
  const dark = themeNow() === 'dark';
  b.textContent = dark ? 'Hell' : 'Dunkel';
  b.title = dark ? 'Auf helle Darstellung umschalten' : 'Auf dunkle Darstellung umschalten';
  b.setAttribute('aria-label', b.title);
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('lf_theme', t); } catch {}
  paintThemeBtn();
}
$('theme-btn')?.addEventListener('click', () => applyTheme(themeNow() === 'dark' ? 'light' : 'dark'));
try {
  // Ohne eigene Wahl folgt die Konsole dem System, auch wenn es zur Laufzeit wechselt.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (!themePicked()) paintThemeBtn(); });
} catch {}
paintThemeBtn();

// ---------------- tabs ----------------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'log') pollLogs();
  if (b.dataset.tab === 'stats') loadStats();
  // Die Wertetabellen werden nur gebaut, solange der Live-Bereich zu sehen ist
  // — beim Zurückkommen holt ein Bild alles nach.
  if (b.dataset.tab === 'live') { boardsDue = true; schedulePaint(); }
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
    else if (m.type === 'event') { pushFeed(m.data); events.add(m.data); fireFlow(); }
  };
}

// ---------------- Zeichentakt ----------------
// Der Dienst schickt den Zustand fuenfmal je Sekunde und JEDES Ereignis
// einzeln. Bei ueber fuenfzig Spielern kommen so leicht hundert Nachrichten pro
// Sekunde herein — und jede einzelne loeste bisher sofort Zeichenarbeit aus.
// Gemessen ging dabei der groesste Teil nicht ins Bauen der Knoten, sondern in
// erzwungene Layout-Rechnungen (`offsetWidth`/`scrollHeight` mitten im
// Nachrichtenfluss): drei Stueck je Ereignis, jede ueber die ganze Seite.
//
// Darum sammelt sich hier alles Gezeichnete und geht EINMAL je Bild raus. Was
// in derselben 1/60 Sekunde mehrfach anfaellt, sieht ohnehin niemand doppelt.
// Ist das Fenster im Hintergrund, wird gar nicht gezeichnet; beim Zurueckkehren
// holt ein Bild alles nach. Ein Ersatz-Zeitgeber springt ein, falls der Browser
// uns keine Bilder gibt (verdecktes Fenster) — die Konsole bleibt dann zwar
// langsamer, steht aber nie still.
let paintRaf = 0, paintTimer = null;
let boardsDue = false;
const PAINT_FALLBACK_MS = 100;
function schedulePaint() {
  if (document.hidden) return;
  if (!paintRaf) paintRaf = requestAnimationFrame(paintFrame);
  if (!paintTimer) paintTimer = setTimeout(paintFrame, PAINT_FALLBACK_MS);
}
function paintFrame() {
  if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
  if (paintTimer) { clearTimeout(paintTimer); paintTimer = null; }
  if (document.hidden) return;
  flushFeed();
  flushFlow();
  if (boardsDue) {
    boardsDue = false;
    // Die Tabellen gehoeren in den Live-Bereich; ist ein anderer Reiter offen,
    // gibt es nichts zu zeigen. Der Umschalter oben holt das nach.
    if (lastState && $('tab-live').classList.contains('active')) renderBoards(lastState);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  boardsDue = true;
  schedulePaint();
});

// ---------------- signal flow ----------------
// Der Lichtpunkt auf der Leitung wird je Bild hoechstens einmal neu gestartet —
// oefter kann ihn niemand sehen, denn der Browser zeichnet nicht haeufiger. Der
// Neustart laeuft ueber die laufende Animation selbst; der alte Weg (Klasse ab,
// `offsetWidth` lesen, Klasse dran) erzwang dafuer jedes Mal eine komplette
// Layout-Rechnung und war unter Last der teuerste Einzelposten der Oberflaeche.
let flowDue = false, flowOffT = null;
function fireFlow() { flowDue = true; schedulePaint(); }
function flushFlow() {
  if (!flowDue) return;
  flowDue = false;
  for (const id of ['wire-a', 'wire-b']) {
    const w = $(id);
    if (!w) continue;
    const dot = w.querySelector('.pulse');
    const anims = (w.classList.contains('fire') && dot && dot.getAnimations) ? dot.getAnimations() : [];
    if (anims.length) {
      // laeuft schon: einfach an den Anfang zuruecksetzen — kein Layout noetig
      for (const a of anims) { try { a.currentTime = 0; a.play(); } catch {} }
    } else {
      w.classList.remove('fire'); void w.offsetWidth; w.classList.add('fire');
    }
  }
  clearTimeout(flowOffT);
  flowOffT = setTimeout(() => {
    for (const id of ['wire-a', 'wire-b']) $(id)?.classList.remove('fire');
  }, 700);
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
  if (rl) {
    const urls = st.network?.urls || [];
    const lan = urls.filter((u) => !u.includes('localhost'));
    rl.textContent = lan.length
      ? `Konsole: ${location.origin}   ·   im LAN: ${lan.join('   ·   ')}${st.network?.hostname ? `   ·   Rechner: ${st.network.hostname}` : ''}`
      : `Konsole: ${location.origin}`;
  }

  const mt = st.match || {};
  // Der Status-Abruf läuft auch dann weiter, wenn keine State-Frames mehr
  // kommen: er ist damit die zuverlässigste Stelle, um die Uhr anzuhalten.
  lastFeedAt = Date.now();
  if (!mt.active) stopClock(false);
  renderMatchEnd(!!mt.active, mt.endReason, mt.endedAt);
  $('node-engine').classList.toggle('lit', mt.active);
  // The engine hands us `remainingMs` finished; when the rig reported no duration
  // (`durationKnown:false`) there is nothing to count down and we show the elapsed
  // time instead. Never `durationMs - elapsedMs` here.
  $('engine-state').textContent = mt.active
    ? (mt.durationKnown ? fmt(mt.remainingMs) : '+' + fmt(mt.elapsedMs))
    : 'Leerlauf';
  $('engine-sub').textContent = mt.active ? `${mt.players} Spieler` : 'kein Match';

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

// ---------------- game mode ----------------
/**
 * Registry, per-PROFILE scoreboard layout and the label table. Loaded once;
 * retried if it failed. The family says what is counted, the profile says what
 * is shown — the console never decides either for itself.
 */
async function loadModes() {
  if (modesLoading) return;
  modesLoading = true;
  try { const r = await api('/api/modes'); MODES = (r && r.data) || null; }
  catch { MODES = null; }
  modesLoading = false;
}
/**
 * Column set for a mode, straight from the server's scoreboardColumns().
 * The mode's display PROFILE wins; a state frame from an older build that only
 * carries a family still resolves, because `scoreboard` is keyed by both.
 */
function scoreboardFor(mode) {
  const sb = MODES && MODES.scoreboard;
  if (!sb) return [];
  const m = mode && typeof mode === 'object' ? mode : {};
  for (const k of [m.profile, m.family, MODES.defaultProfile, MODES.defaultFamily]) {
    if (k && Array.isArray(sb[k])) return sb[k];
  }
  return [];
}
/** Untrusted stream value -> finite number. */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---------------- column formats ----------------
// Every column carries `format` from src/gameModes.js: 'int' | 'text' | 'percent'.
// A column label is looked up in the same table (MODES.metrics, keyed by both
// the camelCase field name and the snake_case CSV column) — the console keeps
// no label map of its own any more.
/** Metric description {key,csv,label,short,help,format} or null. */
function metric(key) {
  const t = MODES && MODES.metrics;
  const m = t && Object.prototype.hasOwnProperty.call(t, key) ? t[key] : null;
  return m && typeof m === 'object' ? m : null;
}
/** Label for a metric; unknown keys stay readable via their snake_case name. */
function metricLabel(key) {
  const m = metric(key);
  return (m && m.label) || String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
/**
 * AUSGESCHRIEBENE Bezeichnung einer Spalte — nie die Kurzform `short`.
 * Der Betreiber will „Deaktivierungen", nicht „D".
 */
function colLabel(c) {
  if (!c) return '';
  if (typeof c.label === 'string' && c.label) return c.label;
  return metricLabel(c.key);
}
/** Erklaersatz einer Spalte (aus /api/modes), sonst leer. */
function colHelp(c) {
  if (!c) return '';
  if (typeof c.help === 'string' && c.help) return c.help;
  const m = metric(c.key);
  return (m && m.help) || '';
}
/** Tooltip for a column head: the long label, plus the one-line explanation. */
function colTitle(c) {
  const label = colLabel(c);
  const help = colHelp(c);
  return help ? `${label} — ${help}` : String(label);
}
/** A value nobody has measured yet. Stays EMPTY — never 0, never a dash. */
const isBlank = (v) => v == null || v === '';
/**
 * Percent from the engine's fraction (`accuracy` is 0…1). A value above 1 is
 * taken as an already-finished percentage, so a later server-side change of
 * unit cannot turn 43 % into 4300 %.
 */
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return `${Math.round((n <= 1 ? n * 100 : n) * 10) / 10} %`;
}
/**
 * One cell value, rendered by its declared format.
 *   int     — a number, as before
 *   text    — the text itself (e.g. the role "Commander")
 *   percent — a percentage
 *   null/'' — EMPTY. livesLeft/shotsLeft only report at the end of a match; a 0
 *             there would read as "no lives left" instead of "not reported yet".
 */
function cellText(value, format) {
  if (isBlank(value)) return '';
  if (format === 'text') return String(value);
  if (format === 'percent') return pct(value);
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '';
}
/** Declared format of a scoreboard column; falls back to the label table. */
const colFormat = (key, col) => (col && col.format) || (metric(key) || {}).format || 'int';
/**
 * One scoreboard cell. A column with `received` keeps the long-standing
 * "gemacht/kassiert" pair; if one half was never reported, only the half that
 * exists is shown — a 0 would invent a measurement.
 */
function playerCell(p, c) {
  const main = cellText(p[c.key], colFormat(c.key, c));
  if (!c.received) return main;
  const rec = cellText(p[c.received], colFormat(c.received, null));
  if (main !== '' && rec !== '') return `${main}/${rec}`;
  return main || rec;
}

/**
 * Mode indicator in the console head. `label` comes from the TCP feed and is
 * written with textContent only. It is visibly set apart when the detection was
 * not certain: `known:false` (number not in the registry) or `source:'inferred'`
 * (the engine corrected the family itself because the event codes disagreed
 * with the type-1 line).
 */
function renderMode(s) {
  const m = (s && s.mode) || null;
  const chip = $('chip-mode');
  const name = $('mode-name');
  const flag = $('mode-flag');
  if (!chip) return;
  name.textContent = (m && typeof m.label === 'string' && m.label) ? m.label : '—';

  let note = '', hint = '';
  if (m && m.known === false) {
    note = 'unbekannt';
    hint = `Modus-Nummer ${m.number == null ? '—' : m.number} steht nicht in der Registry. Gezählt wird als Familie ${m.family}.`;
  } else if (m && m.source === 'inferred') {
    note = 'abgeleitet';
    hint = `Familie ${m.family} aus den Event-Codes erkannt — die Typ-1-Zeile sagte etwas anderes.`;
  }
  flag.textContent = note;
  flag.hidden = !note;
  chip.classList.toggle('unsure', !!note);
  chip.title = hint || (m ? `Spielmodus ${m.key}${m.number == null ? '' : ' (Nr. ' + m.number + ')'}` : 'Spielmodus');

  const src = $('score-src');
  if (src) {
    const tdf = s && s.scoreSource === 'tdf';
    src.textContent = tdf ? 'Punkte: Anlage' : 'Punkte: Eigenzählung';
    src.classList.toggle('own', !tdf);
    src.title = tdf
      ? 'Der Punktestand kommt aus den Typ-5-Zeilen der Anlage.'
      : 'Punktestand aus der Eigenzählung von lf_live — bis die Anlage ihn selbst meldet.';
  }
}
/** Dezentes Kennzeichen an SM5-Spielern: woher deren Zahlen stammen. */
function statsMark(p) {
  if (p.statsSource === 'tdf7') {
    return el('sup', { className: 'ss ok', title: 'Offizieller Endblock der Anlage (Typ 7).' }, 'offiziell');
  }
  if (p.statsSource === 'live') {
    return el('sup', { className: 'ss', title: 'Selbst mitgezählt — eine Untergrenze (die Anlage meldet keinen eigenen Schuss-Event). Die offiziellen Zahlen kommen am Matchende.' }, 'live');
  }
  return null;
}
/**
 * Dezentes Kennzeichen an der Trefferquote: sie ist eine Schätzung, und zwar
 * eine nach OBEN. Ein folgenloser Schuss erzeugt kein Ereignis und fehlt darum
 * im Nenner, während jeder Treffer im Zähler steht — die Quote fällt live also
 * systematisch zu hoch aus. Nach dem Endblock der Anlage ist sie amtlich.
 */
function accuracyMark(p) {
  if (!p || p.accuracyIsEstimate !== true) return null;
  const live = p.accuracySource !== 'tdf7';
  return el('sup', {
    className: 'ss est',
    title: live
      ? 'Schätzung aus der Eigenzählung — systematisch ZU HOCH: ein folgenloser Schuss erzeugt kein Ereignis und fehlt im Nenner, jeder Treffer zählt aber im Zähler. Amtlich wird die Quote mit dem Endblock der Anlage.'
      : 'Schätzung — der genaue Wert liegt noch nicht vor.',
  }, 'ca.');
}

// ---------------- Matchende ----------------
// Contract: gameState.endReason / gameState.endedAt (also unter `match` im
// Status). Beide Felder sind ADDITIV — ein Dienst, der sie noch nicht kennt,
// liefert sie schlicht nicht, und dann bleibt die Anzeige wie bisher leer.
const END_REASON = {
  mission_end: { short: 'regulär beendet', help: 'Die Anlage hat das Spielende selbst gemeldet (Typ-4-Code 0101).' },
  watchdog: { short: 'vom Spielleiter beendet bzw. Zeitüberschreitung', help: 'Kein Spielende im Stream — lf_live hat das Match nach Ablauf der Zeit bzw. anhaltender Stille geschlossen.' },
  stream_lost: { short: 'Verbindung verloren', help: 'Die Verbindung zur Anlage brach ab, während das Match lief.' },
  next_match: { short: 'durch neues Match abgelöst', help: 'Die Anlage hat ein neues Match gestartet, ohne das alte zu beenden.' },
  shutdown: { short: 'Dienst beendet', help: 'lf_live wurde beendet, während das Match lief.' },
};
/** Reine Anzeige: unbekannte Gründe bleiben lesbar, Text immer per textContent. */
function endReasonText(reason) {
  const e = END_REASON[reason];
  if (e) return e;
  return { short: 'beendet', help: `Grund laut Dienst: ${String(reason)}` };
}
function hhmm(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}
/**
 * Zeigt an, WIE das Match geendet hat — sobald kein Match mehr läuft und der
 * Dienst einen Grund nennt. Läuft eines, verschwindet die Zeile wieder.
 */
let endInfo = { reason: null, endedAt: null };
function renderMatchEnd(active, reason, endedAt) {
  const tag = $('match-end');
  if (!tag) return;
  // Zwei Quellen (State-Frame und Status-Abruf) melden dasselbe Ende; kennt eine
  // die Felder noch nicht, überschreibt sie die andere nicht mit „nichts".
  if (active) endInfo = { reason: null, endedAt: null };
  else endInfo = { reason: reason || endInfo.reason, endedAt: endedAt || endInfo.endedAt };
  if (active || !endInfo.reason) { tag.hidden = true; tag.textContent = ''; tag.removeAttribute('title'); return; }
  const e = endReasonText(endInfo.reason);
  const at = hhmm(endInfo.endedAt);
  tag.textContent = at ? `Ende ${at} · ${e.short}` : `Ende · ${e.short}`;
  tag.title = e.help;
  tag.hidden = false;
}

// ---------------- live rendering ----------------
let clockTimer = null, clockMs = 0, clockUp = false, matchDur = 0;
// Wann kamen zuletzt frische Match-Daten an (State-Frame oder Status-Abruf)?
// Die Uhr zählt nur weiter, solange der Dienst antwortet — sonst steht sie,
// statt eine Laufzeit zu erfinden, die niemand mehr bestätigt.
let lastFeedAt = Date.now();
const CLOCK_STALL_MS = 12000;
function stopClock(stale) {
  clearInterval(clockTimer);
  clockTimer = null;
  const c = $('clock');
  if (!c) return;
  c.classList.toggle('stale', !!stale);
  if (stale) c.title = 'Keine frischen Daten vom Dienst — die Uhr steht.';
  else c.removeAttribute('title');
}
function startClock() {
  // Bewusst NICHT idempotent: jeder State-Frame setzt den Zeitgeber neu auf. So
  // zaehlt er nur in den Sekunden, in denen der Dienst gerade nichts schickt,
  // und kann der Anzeige nie eine Sekunde vorweg- oder hinterherlaufen. Das
  // kostet gemessen 0,02 ms je Frame — nichts, was sich zu aendern lohnte.
  stopClock(false);
  clockTimer = setInterval(() => {
    if (Date.now() - lastFeedAt > CLOCK_STALL_MS) return stopClock(true);
    clockMs = Math.max(0, clockMs + (clockUp ? 1000 : -1000));
    drawClock();
  }, 1000);
}
function renderLive(s) {
  lastState = s;
  $('mid-label').textContent = s.missionActive ? 'Match läuft' : 'kein Match';
  $('tab-live').classList.toggle('match-live', s.missionActive);
  renderMode(s);

  // The clock. `remainingMs` arrives finished from the engine; `durationKnown:false`
  // means the rig reported no game length, and then we count UP from 0 ("Laufzeit")
  // instead of showing an invented countdown. Nothing here recomputes it.
  matchDur = s.durationKnown === true ? num(s.duration) : 0;
  clockUp = s.durationKnown !== true;
  clockMs = clockUp ? Math.max(0, num(s.elapsedTime)) : Math.max(0, num(s.remainingMs));
  drawClock();
  lastFeedAt = Date.now();
  // Kein laufendes Match -> die Uhr steht. Sie zählt nie über das Matchende
  // hinaus weiter, auch nicht, wenn danach gar nichts mehr hereinkommt.
  if (s.missionActive) startClock(); else stopClock(false);
  renderMatchEnd(!!s.missionActive, s.endReason, s.endedAt);

  if (!MODES) loadModes();
  // Die Wertetabellen sind das Teuerste an dieser Anzeige. Sie werden darum
  // nicht fuenfmal je Sekunde gebaut, sondern hoechstens einmal je Bild — und
  // nur, wenn der Live-Bereich ueberhaupt zu sehen ist.
  boardsDue = true;
  schedulePaint();
}

// ---------------- adaptive Team-Anzeige ----------------
// Eine Anzeige fuer 1 bis 7 Teams und fuer „Jeder gegen jeden" — ohne
// Einstellung, allein aus dem State-Frame. Die Uhr sitzt in jeder Aufteilung
// prominent (siehe .scorebar in styles.css).

/** Wieviele Spalten die kompakte Ansicht zeigt, bevor der Umschalter greift. */
const COMPACT_MAX = 5;
let showAllCols = false;
try { showAllCols = localStorage.getItem('lf_cols_all') === '1'; } catch {}
let lastState = null;

/** Team-Ids numerisch ordnen (0,1,2,…); alles Nicht-Numerische hinten. */
function cmpTeamId(a, b) {
  const na = Number(a), nb = Number(b);
  const fa = Number.isFinite(na), fb = Number.isFinite(nb);
  if (fa && fb) return na - nb;
  if (fa) return -1;
  if (fb) return 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * „Jeder gegen jeden" aus den DATEN erkennen — die API kennt dafuer kein Feld
 * und die Konsole hat dafuer keine Einstellung.
 *
 * Gewaehlte Signatur: **jeder Spieler sitzt in einem eigenen Team** (so viele
 * Teams wie Spieler, mindestens drei). Das ist die einzige der beiden
 * denkbaren Signaturen, die sich nicht anders erklaeren laesst — mehrere Teams
 * mit je genau einem Spieler sind kein Mannschaftsspiel.
 *
 * Die andere denkbare Signatur — alle Spieler in EINEM Team — wird bewusst
 * nicht gewertet: sie sieht genauso aus wie ein Koop-Spiel gegen Ziele oder
 * wie ein Match, in dem gerade erst die erste Mannschaft eingeloggt ist. Fuer
 * ein einzelnes Team zeigt die Konsole ohnehin genau eine Liste, also das,
 * was eine Rangliste auch waere.
 *
 * Ein Fehlschluss bleibt harmlos: die Rangliste traegt die Teamfarbe und den
 * Teamnamen jedes Spielers und dieselben Spalten wie die Teamansicht.
 */
function isFreeForAll(players, teamIds) {
  return players.length >= 3 && teamIds.length === players.length;
}

/**
 * Das Platzproblem der ausgeschriebenen Bezeichnungen: das SM5-Profil hat 15
 * Spalten. Standardmaessig zeigt die Konsole die ersten `COMPACT_MAX` — das
 * sind die, die das Profil selbst nach vorn stellt — und blendet den Rest
 * hinter einen Umschalter. Kuerzel gibt es nicht.
 */
function visibleCols(scols) {
  if (!Array.isArray(scols)) return [];
  return (showAllCols || scols.length <= COMPACT_MAX) ? scols : scols.slice(0, COMPACT_MAX);
}

function syncColsToggle(scols) {
  const b = $('cols-toggle');
  const n = $('cols-note');
  if (!b || !n) return;
  const total = scols.length;
  const shown = visibleCols(scols).length;
  b.hidden = total <= COMPACT_MAX;
  b.textContent = showAllCols ? 'Weniger Werte' : 'Alle Werte';
  b.setAttribute('aria-pressed', String(showAllCols));
  b.title = showAllCols
    ? 'Zurück auf die wichtigsten Werte'
    : 'Alle Werte dieses Spielmodus zeigen — die Tabelle lässt sich dann seitlich schieben, die Namensspalte bleibt stehen.';
  n.textContent = !total ? '' : (total <= COMPACT_MAX ? `${total} Werte` : `${shown} von ${total} Werten`);
}
$('cols-toggle')?.addEventListener('click', () => {
  showAllCols = !showAllCols;
  try { localStorage.setItem('lf_cols_all', showAllCols ? '1' : '0'); } catch {}
  if (lastState) renderBoards(lastState);
});

/** Ein Teamblock in der Kopfleiste: Farbbalken, Name, Punktestand. */
function teamCard(m, score) {
  const c = paintTeam(el('div', { className: 'team-card' }), m.color);
  c.append(
    el('span', { className: 'tc-bar' }),
    el('span', { className: 'tc-name', title: m.name }, m.name),
    el('span', { className: 'tc-score' }, String(score)));
  return c;
}

/** Eine Spielerzeile. `o.rank` setzt die Platzziffer, `o.team` die Farbmarke. */
function playerRow(p, cols, o) {
  const tr = el('tr');
  if (o.rank != null) tr.append(el('td', { className: 'rk' }, String(o.rank) + '.'));
  const nameCell = el('td', { className: 'pl' });
  const tm = o.teamOf ? o.teamOf(p) : null;
  if (tm) {
    const dot = paintTeam(el('span', { className: 'team-dot' }), tm.color);
    dot.title = tm.name;
    nameCell.append(dot);
  }
  nameCell.append(document.createTextNode(p.name == null ? '' : String(p.name)));
  tr.append(nameCell);
  for (const c of cols) {
    const td = el('td', {}, playerCell(p, c));
    // Die Trefferquote ist live nur geschätzt — und zwar nach oben.
    if (c.key === 'accuracy' && !isBlank(p[c.key])) {
      const mk = accuracyMark(p);
      if (mk) td.append(mk);
    }
    tr.append(td);
  }
  if (o.sm5) { const mk = statsMark(p); if (mk) nameCell.append(mk); }
  if (o.ballHolderId != null && o.ballHolderId === p.id) tr.classList.add('has-ball');
  if (p.status === 3) tr.classList.add('is-out');
  return tr;
}

/** Eine Wertetabelle. Kopfzeilen tragen die AUSGESCHRIEBENE Bezeichnung. */
function statTable(list, cols, o) {
  const wide = cols.length > COMPACT_MAX;
  const tbl = el('table', { className: 'stat' + (wide ? ' wide' : '') });
  const head = el('tr');
  if (o.rank) head.append(el('th', { className: 'th-rank', title: 'Platzierung' }, '#'));
  head.append(el('th', { className: 'th-name' }, 'Spieler'));
  for (const c of cols) head.append(el('th', { title: colTitle(c) }, colLabel(c)));
  tbl.append(head);
  if (!list.length) {
    tbl.append(el('tr', {}, el('td', { className: 'stat-empty', colSpan: cols.length + 1 + (o.rank ? 1 : 0) },
      'Noch keine Spieler angemeldet.')));
    return tbl;
  }
  list.forEach((p, i) => tbl.append(playerRow(p, cols, { ...o, rank: o.rank ? i + 1 : null })));
  return tbl;
}

/**
 * Kopfleiste (Teams bzw. Fuehrende) und Wertetabellen — der adaptive Teil.
 * Wird auch vom Spalten-Umschalter gerufen, ohne die Uhr anzufassen.
 */
function renderBoards(s) {
  const players = Object.values(s.players || {});
  const teamIds = [...new Set(players.map((p) => String(p.teamId)))].sort(cmpTeamId);
  const metas = teamIds.map((t, i) => {
    const raw = (s.teams && s.teams[t]) || null;
    const name = (raw && typeof raw.name === 'string' && raw.name) ? raw.name : `Team ${t}`;
    return { id: t, name, color: safeColor(raw && raw.color, i) };
  });
  const byTeam = new Map(metas.map((m) => [m.id, m]));
  const teamScore = (t) => (s.scores && s.scores[t] != null ? num(s.scores[t]) : 0);

  const ffa = isFreeForAll(players, teamIds);
  // 2 Teams -> das gewohnte Gegenueber · 1 sowie 3–7 Teams -> Raster ·
  // jeder gegen jeden -> Fuehrende + Rangliste.
  const layout = ffa ? 'ffa' : (teamIds.length === 2 ? 'duel' : 'multi');
  $('scorebar').className = 'scorebar ' + layout;

  const scols = scoreboardFor(s.mode);
  const cols = visibleCols(scols);
  const sortKey = scols.length ? scols[0].key : null;
  const sm5 = !!(s.mode && s.mode.family === 'sm5');
  syncColsToggle(scols);
  renderLegend(s, scols, sm5);

  const rowOpts = { sm5, ballHolderId: s.ballHolderId };

  // ---- Kopfleiste ----
  const head = $('score-teams');
  head.textContent = '';
  const anyScore = teamIds.some((t) => s.scores && s.scores[t] != null);
  const ffaValue = anyScore ? ((p) => teamScore(String(p.teamId))) : ((p) => num(sortKey ? p[sortKey] : 0));
  const ranked = players.slice().sort((x, y) => ffaValue(y) - ffaValue(x));

  if (!metas.length) {
    head.append(el('div', { className: 'score-empty' }, 'Noch keine Teams gemeldet.'));
  } else if (ffa) {
    ranked.slice(0, 3).forEach((p, i) => {
      const m = byTeam.get(String(p.teamId)) || { name: '', color: safeColor(null, i) };
      const chip = paintTeam(el('div', { className: 'lead-chip' }), m.color);
      chip.append(
        el('span', { className: 'lead-rank' }, String(i + 1) + '.'),
        el('span', { className: 'lead-name', title: m.name }, p.name == null ? '' : String(p.name)),
        el('span', { className: 'lead-score' }, String(ffaValue(p))));
      head.append(chip);
    });
  } else {
    for (const m of metas) head.append(teamCard(m, teamScore(m.id)));
  }

  // ---- Wertetabellen ----
  const wrap = $('stat-cols');
  wrap.textContent = '';
  wrap.classList.toggle('single', ffa || metas.length <= 1);
  if (ffa) {
    const box = el('div', { className: 'stat-col' });
    box.style.setProperty('--team', 'var(--accent)');
    box.append(el('h4', {}, 'Rangliste · jeder gegen jeden',
      el('span', { className: 'col-sub' }, `${players.length} Spieler`)));
    // Farbmarke je Zeile: bei „jeder gegen jeden" traegt jeder Spieler sein
    // eigenes Team — die Marke ordnet die Zeile trotzdem sichtbar zu, damit
    // ein Fehlschluss der Erkennung nichts verschluckt.
    box.append(el('div', { className: 'stat-scroll' },
      statTable(ranked, cols, { ...rowOpts, rank: true, teamOf: (p) => byTeam.get(String(p.teamId)) || null })));
    wrap.append(box);
    return;
  }
  if (!metas.length) {
    wrap.append(el('p', { className: 'muted empty-note' }, 'Noch keine Spieler — sobald sich jemand anmeldet, erscheint hier eine Tabelle je Team.'));
    return;
  }
  for (const m of metas) {
    const tp = players.filter((p) => String(p.teamId) === m.id)
      .sort((x, y) => (sortKey ? num(y[sortKey]) - num(x[sortKey]) : 0));
    const box = paintTeam(el('div', { className: 'stat-col' }), m.color);
    box.append(el('h4', { title: m.name }, m.name,
      el('span', { className: 'col-sub' }, `${tp.length} Spieler`)));
    box.append(el('div', { className: 'stat-scroll' }, statTable(tp, cols, rowOpts)));
    wrap.append(box);
  }
}

// ---------------- Legende ----------------
// Erklaert jede Kennzahl, die im AKTUELLEN Spielmodus zu sehen ist, dazu die
// Lesehilfen der Anzeige. Texte kommen aus /api/modes (`help`); die Legende
// wird nur neu gebaut, wenn sich Modus oder Spaltensatz aendern.
let legendSig = null;
function renderLegend(s, scols, sm5) {
  const body = $('legend-body');
  if (!body) return;
  const modeLabel = (s.mode && typeof s.mode.label === 'string' && s.mode.label) ? s.mode.label : '';
  const sig = `${modeLabel} ${sm5} ${scols.map((c) => c.key + '/' + (c.received || '')).join(',')}`;
  if (sig === legendSig) return;
  legendSig = sig;

  $('legend-mode').textContent = modeLabel ? ` · Spielmodus „${modeLabel}"` : '';
  body.textContent = '';
  const item = (term, desc, isNote) => body.append(el('div', { className: 'lg-item' + (isNote ? ' note' : '') },
    el('span', { className: 'lg-term' }, term),
    el('span', { className: 'lg-desc' }, desc)));
  const heading = (t) => body.append(el('h5', { className: 'lg-head' }, t));

  // `groupLabel` liefert der Dienst mit (/api/modes). Die Spalten werden nach
  // Gruppe gebuendelt — in der Reihenfolge, in der die Gruppen zum ersten Mal
  // vorkommen. Fehlt die Angabe, bleibt es eine schlichte Liste; die Legende
  // funktioniert in beiden Faellen.
  const groups = [];
  const bucket = new Map();
  for (const c of scols) {
    const g = (typeof c.groupLabel === 'string' && c.groupLabel) ? c.groupLabel : '';
    if (!bucket.has(g)) { bucket.set(g, []); groups.push(g); }
    bucket.get(g).push(c);
  }
  for (const g of groups) {
    if (g) heading(g);
    for (const c of bucket.get(g)) item(colLabel(c), colHelp(c) || 'Wert aus dem Datenstrom der Anlage.');
  }

  heading('Zeichen in der Anzeige');
  if (scols.some((c) => c.received)) {
    item('Zwei Zahlen wie 3/1',
      'Die erste Zahl ist, was der Spieler selbst gemacht hat, die zweite, was ihm widerfahren ist. Bei Steals heißt 3/1: dreimal den Ball abgenommen, einmal selbst verloren.', true);
  }
  item('Leere Zelle',
    'Diesen Wert hat die Anlage noch nicht gemeldet. Leer heißt ausdrücklich nicht null — manche Zahlen kommen erst am Spielende.', true);
  if (sm5) {
    item('„live" hinter dem Namen',
      'Diese Zahlen hat lf_live selbst mitgezählt. Sie sind eine Untergrenze und können noch steigen.', true);
    item('„offiziell" hinter dem Namen',
      'Die Anlage hat ihre eigenen Endzahlen für diesen Spieler geschickt. Diese Werte sind amtlich.', true);
  }
  if (scols.some((c) => c.key === 'accuracy')) {
    item('„ca." an der Trefferquote',
      'Solange das Spiel läuft, ist die Quote nur geschätzt und fällt dabei zu hoch aus: ein Schuss ohne Treffer erzeugt keine Meldung und fehlt in der Rechnung. Am Spielende wird sie amtlich.', true);
  }
  if (!sm5) {
    item('Heller Balken links am Namen', 'Dieser Spieler hat gerade den Ball.', true);
  }
  item('Blasse Zeile', 'Dieser Spieler ist gerade ausgeschieden und spielt nicht mit.', true);
  item('Punkte über den Tabellen', 'Der große Wert je Team ist der Spielstand, den die Anlage meldet. Wo sie noch keinen schickt, zählt lf_live selbst — das steht unter der Uhr.', true);
}
function drawClock() {
  const ms = Math.max(0, num(clockMs));
  $('clock').textContent = (clockUp ? '+' : '') + fmt(ms);
  const cap = $('clock-cap');
  if (cap) cap.textContent = clockUp ? 'Laufzeit' : 'Restzeit';
  // No duration reported -> no progress to show. A bar that fills against an
  // invented length would be a lie, so it stays empty.
  const fill = $('mid-prog-fill');
  if (fill) fill.style.width = (!clockUp && matchDur > 0) ? (Math.min(1, Math.max(0, 1 - ms / matchDur)) * 100).toFixed(1) + '%' : '0%';
}
function fmt(ms) { const t = Math.floor((ms || 0) / 1000); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; }
// Der Verlauf zeigt die letzten 80 Zeilen. Die Ereignisse kommen einzeln
// herein, angehaengt wird aber gebuendelt je Bild: das Nachfuehren des
// Bildlaufs (`scrollHeight`) zwingt den Browser zu einer vollen Layout-Rechnung,
// und die soll einmal je Bild anfallen, nicht einmal je Ereignis. Laenger als
// 80 Zeilen wird der Stapel nie — auch nicht, wenn im Hintergrund gesammelt wird.
const FEED_MAX = 80;
const feedQueue = [];
function feedLine(evt) {
  const cat = evtCategory(evt);
  return el('div', { className: 'fe', style: `--cat:var(--cat-${cat})` },
    el('span', { className: 'ft' }, fmt(evt.elapsedMs)),
    el('i', { className: 'flamp' }),
    el('span', { className: 'fx' + (cat === 'score' ? ' fg' : '') }, evtSentence(evt)));
}
function pushFeed(evt) {
  feedQueue.push(evt);
  if (feedQueue.length > FEED_MAX) feedQueue.splice(0, feedQueue.length - FEED_MAX);
  schedulePaint();
}
function flushFeed() {
  if (!feedQueue.length) return;
  const f = $('feed');
  const frag = document.createDocumentFragment();
  for (const evt of feedQueue) frag.append(feedLine(evt));
  feedQueue.length = 0;
  f.append(frag);
  while (f.childElementCount > FEED_MAX) f.removeChild(f.firstChild);
  f.scrollTop = f.scrollHeight;
}

// ---------------- Ereignisse (event feed tab) ----------------
const events = (() => {
  const MAX = 200;
  const LOG = [];              // newest first
  let paused = false;
  let bufferedWhilePaused = 0;
  let ready = false;
  let hidden;
  try { hidden = new Set(JSON.parse(localStorage.getItem('lf_ev_hidden') || '[]').filter((c) => EV_CATS.includes(c))); }
  catch { hidden = new Set(); }

  const rowFor = (e) => {
    const cat = evtCategory(e);
    const row = el('div', { className: 'ev-row' },
      el('span', { className: 'ev-tc' }, fmt(e.elapsedMs)),
      el('span', { className: 'ev-mid' }, evtMatchShort(e)),
      el('i', { className: 'ev-lamp' }),
      el('span', { className: 'ev-tag' }, evtTag(e)),
      el('span', { className: 'ev-txt' }, evtSentence(e)));
    row.dataset.cat = cat;
    row.dataset.eid = e.id != null ? String(e.id) : '';
    if (hidden.has(cat)) row.hidden = true;
    return row;
  };

  // Wieviele Zeilen gerade sichtbar sind — mitgefuehrt, statt bei jedem
  // Ereignis neu gezaehlt.
  let shown = 0;
  let emptyNode = null;

  function syncCount() {
    const c = $('ev-count');
    if (c) c.textContent = LOG.length ? `${shown}/${LOG.length}` : '';
  }
  /** Der Hinweis, wenn nichts zu sehen ist — genau ein Knoten, nie mehrere. */
  function syncEmpty(log) {
    if (shown) { if (emptyNode) { emptyNode.remove(); emptyNode = null; } return; }
    const text = LOG.length
      ? 'Alle Kategorien ausgeblendet — oben wieder einblenden.'
      : 'Noch keine Ereignisse — warten auf den Laserforce-Stream.';
    if (!emptyNode) { emptyNode = el('p', { className: 'ev-empty' }, text); log.append(emptyNode); }
    else if (emptyNode.textContent !== text) emptyNode.textContent = text;
  }

  /**
   * Kompletter Neuaufbau — nur wo er noetig ist: beim ersten Oeffnen, nach
   * einem Filterwechsel und nach dem Nachladen. NICHT je Ereignis: bei fuenfzig
   * Spielern kamen so zweihundert Zeilen mal die Ereignisrate zusammen,
   * gemessen ueber vierzigtausend verworfene Knoten je Sekunde — auch dann,
   * wenn dieser Bereich gar nicht zu sehen war.
   */
  function render() {
    const log = $('ev-log');
    if (!log) return;
    log.textContent = '';
    emptyNode = null;
    shown = 0;
    const frag = document.createDocumentFragment();
    for (const e of LOG) {
      const row = rowFor(e);
      if (!row.hidden) shown++;
      frag.append(row);
    }
    log.append(frag);
    syncEmpty(log);
    syncCount();
  }

  /** Eine neue Zeile nach oben, die aelteste raus — der Rest bleibt stehen. */
  function addRow(e) {
    const log = $('ev-log');
    if (!log) return;
    if (emptyNode) { emptyNode.remove(); emptyNode = null; }
    const row = rowFor(e);
    if (!row.hidden) shown++;
    log.prepend(row);
    while (log.childElementCount > MAX) {
      const last = log.lastElementChild;
      if (!last) break;
      if (!last.hidden) shown--;
      last.remove();
    }
    syncEmpty(log);
    syncCount();
  }

  function add(e) {
    if (!e || typeof e !== 'object') return;
    if (LOG.length && LOG[0].id != null && e.id === LOG[0].id) return;
    if (paused) { bufferedWhilePaused++; syncPause(); return; }
    LOG.unshift(e);
    if (LOG.length > MAX) LOG.length = MAX;
    if (ready) addRow(e);
  }

  function syncPause() {
    const b = $('ev-pause');
    if (!b) return;
    b.textContent = paused ? (bufferedWhilePaused ? `Live (+${bufferedWhilePaused})` : 'Live') : 'Pause';
    b.classList.toggle('armed', paused);
  }

  async function togglePause() {
    paused = !paused;
    // Nach dem Nachladen einmal komplett neu — die nachgereichten Zeilen stehen
    // mitten in der Liste, nicht oben.
    if (!paused && bufferedWhilePaused) { bufferedWhilePaused = 0; await backfill(); if (ready) render(); }
    syncPause();
  }

  async function backfill() {
    try {
      const r = await api('/api/events?limit=200');
      const rows = Array.isArray(r.data) ? r.data : [];
      const have = new Set(LOG.map((e) => e.id));
      for (const e of rows) if (!have.has(e.id)) LOG.push(e);
      LOG.sort((x, y) => (y.id || 0) - (x.id || 0));
      if (LOG.length > MAX) LOG.length = MAX;
    } catch {}
  }

  function buildFilters() {
    const wrap = $('ev-filters');
    if (!wrap || wrap.childElementCount) return;
    for (const cat of EV_CATS) {
      const b = el('button', { className: 'ev-chip', type: 'button', title: `${EV_CAT_LABEL[cat]} ein-/ausblenden` },
        el('i', { className: 'ev-lamp', style: `--lamp:var(--cat-${cat})` }), EV_CAT_LABEL[cat]);
      b.dataset.cat = cat;
      const paint = () => { b.classList.toggle('off', hidden.has(cat)); b.setAttribute('aria-pressed', String(!hidden.has(cat))); };
      paint();
      b.addEventListener('click', () => {
        if (hidden.has(cat)) hidden.delete(cat); else hidden.add(cat);
        try { localStorage.setItem('lf_ev_hidden', JSON.stringify([...hidden])); } catch {}
        paint();
        render();
      });
      wrap.append(b);
    }
  }

  async function probeFile() {
    const link = $('ev-file');
    if (!link) return;
    for (const path of ['/api/logs/events', '/api/events/file']) {
      try {
        const res = await fetch(path, { method: 'HEAD', headers: token ? { Authorization: 'Bearer ' + token } : {} });
        if (res.ok) { link.href = path + (token ? `?token=${encodeURIComponent(token)}` : ''); link.hidden = false; return; }
      } catch {}
    }
  }

  async function onShow() {
    buildFilters();
    syncPause();
    if (!ready) {
      await backfill();
      ready = true;
      probeFile();
    }
    render();
  }

  function copy() {
    const lines = [...LOG].reverse()
      .filter((e) => !hidden.has(evtCategory(e)))
      .map((e) => `${fmt(e.elapsedMs).padStart(6)}  ${evtMatchShort(e).padEnd(4)}  ${evtTag(e).padEnd(10)}  ${evtSentence(e)}`);
    const text = lines.join('\n');
    navigator.clipboard.writeText(text)
      .then(() => toast(`${lines.length} Zeilen kopiert`))
      .catch(() => toast('Kopieren nicht möglich', true));
  }

  $('ev-pause')?.addEventListener('click', togglePause);
  $('ev-copy')?.addEventListener('click', copy);

  return { add, onShow };
})();
document.querySelector('.tabs button[data-tab="events"]')?.addEventListener('click', () => events.onShow());

// ---------------- settings ----------------
const PIN_MAP = {
  'logLevel': 's-loglevel',
  'http.host': 's-http-host', 'http.port': 's-http-port', 'http.trustProxy': 's-trust-proxy',
  'tcp.host': 's-tcp-host', 'tcp.port': 's-tcp-port',
  'apiToken': 's-token', 'cors': 's-cors', 'rateLimitPerMin': 's-rate',
  'outputAllow': 's-output-allow', 'stateTickMs': 's-state-tick',
  'streamServer.enabled': 'stream-enabled', 'streamServer.host': 'stream-host', 'streamServer.port': 'stream-port',
  'match.defaultDurationMs': 's-duration',
  'csv.enabled': 's-csv-enabled', 'csv.delimiter': 's-csv-delim', 'csv.writeEvents': 's-csv-events', 'csv.writeLive': 's-csv-live',
  'localRoster.enabled': 's-roster-enabled', 'localRoster.file': 's-roster-file',
  'capture.enabled': 's-cap-enabled', 'capture.maxFileMB': 's-cap-maxfile',
  'capture.maxFiles': 's-cap-maxfiles', 'capture.maxTotalMB': 's-cap-maxtotal',
  'admin.enabled': 's-admin-enabled', 'admin.sessionHours': 's-session-hours',
  'notify.enabled': 's-notify-enabled', 'notify.onStart': 's-notify-start',
  'notify.onIpChange': 's-notify-ip', 'notify.name': 's-notify-name',
  'notify.discordWebhook': 's-nt-discord', 'notify.slackWebhook': 's-nt-slack',
  'notify.ntfy.topic': 's-nt-ntfy-topic', 'notify.ntfy.server': 's-nt-ntfy-server', 'notify.ntfy.token': 's-nt-ntfy-token',
  'notify.telegram.botToken': 's-nt-tg-token', 'notify.telegram.chatId': 's-nt-tg-chat',
  'notify.webhook.url': 's-nt-hook-url', 'notify.webhook.secret': 's-nt-hook-secret',
  'notify.email.to': 's-nt-mail-to', 'notify.email.host': 's-nt-smtp-host', 'notify.email.port': 's-nt-smtp-port',
  'notify.email.user': 's-nt-smtp-user', 'notify.email.pass': 's-nt-smtp-pass',
  'notify.email.from': 's-nt-smtp-from', 'notify.email.secure': 's-nt-smtp-secure',
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
  if (set.has('apiToken')) $('s-token-clear').disabled = true;
}

async function loadConfig() {
  const res = await api('/api/config');
  cfg = res.data;
  outputs = structuredClone(cfg.outputs || []);
  stream = { ...cfg.streamServer };

  $('s-tcp-port').value = cfg.tcp.port; $('s-tcp-host').value = cfg.tcp.host;
  $('s-http-port').value = cfg.http.port; $('s-http-host').value = cfg.http.host;
  // the server never returns the token itself — an empty field keeps what is stored
  $('s-token').value = '';
  $('s-token').placeholder = cfg.apiTokenSet ? 'gesetzt — leer lassen behält ihn' : 'leer = offen im LAN';
  $('s-token-clear').checked = false;
  $('s-token-clear').disabled = !cfg.apiTokenSet;
  $('s-cors').value = (cfg.cors || []).join('\n');
  $('s-rate').value = cfg.rateLimitPerMin ?? 0;
  $('s-trust-proxy').checked = !!cfg.http.trustProxy;
  $('s-output-allow').value = (cfg.outputAllow || []).join(', ');
  $('s-state-tick').value = cfg.stateTickMs ?? 200;
  $('s-duration').value = cfg.match.defaultDurationMs;
  $('s-loglevel').value = cfg.logLevel;

  $('s-csv-enabled').checked = cfg.csv.enabled;
  $('s-csv-delim').value = cfg.csv.delimiter;
  $('s-csv-events').checked = cfg.csv.writeEvents;
  $('s-csv-live').checked = cfg.csv.writeLive;
  $('csv-dir').textContent = cfg.csv.dir;

  $('s-roster-enabled').checked = cfg.localRoster.enabled;
  $('s-roster-file').value = cfg.localRoster.file;

  const cap = cfg.capture || {};
  $('s-cap-enabled').checked = !!cap.enabled;
  $('s-cap-maxfile').value = cap.maxFileMB ?? 20;
  $('s-cap-maxfiles').value = cap.maxFiles ?? 50;
  $('s-cap-maxtotal').value = cap.maxTotalMB ?? 500;
  $('cap-dir').textContent = cap.dir || 'data/capture';
  capturePrivacy();
  loadCapture();

  applyAdmin(cfg, res.envPins || []);
  applyNotify(cfg);

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
    http: { host: $('s-http-host').value.trim(), port: +$('s-http-port').value, trustProxy: $('s-trust-proxy').checked },
    tcp: { host: $('s-tcp-host').value.trim(), port: +$('s-tcp-port').value },
    apiToken: $('s-token').value.trim(),
    apiTokenClear: $('s-token-clear').checked,
    cors: $('s-cors').value.split('\n').map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: Math.max(0, +$('s-rate').value || 0),
    outputAllow: $('s-output-allow').value.split(',').map((s) => s.trim()).filter(Boolean),
    stateTickMs: Math.min(5000, Math.max(50, +$('s-state-tick').value || 200)),
    match: { defaultDurationMs: +$('s-duration').value },
    csv: {
      enabled: $('s-csv-enabled').checked,
      delimiter: $('s-csv-delim').value,
      writeEvents: $('s-csv-events').checked,
      writeLive: $('s-csv-live').checked,
    },
    localRoster: { enabled: $('s-roster-enabled').checked, file: $('s-roster-file').value.trim() || 'data/roster.csv' },
    capture: {
      enabled: $('s-cap-enabled').checked,
      maxFileMB: Math.min(2000, Math.max(1, +$('s-cap-maxfile').value || 20)),
      maxFiles: Math.min(1000, Math.max(1, +$('s-cap-maxfiles').value || 50)),
      maxTotalMB: Math.min(100000, Math.max(1, +$('s-cap-maxtotal').value || 500)),
    },
    admin: { enabled: $('s-admin-enabled').checked, sessionHours: Math.min(720, Math.max(1, +$('s-session-hours').value || 12)) },
    notify: collectNotify(),
    outputs,
    streamServer: { enabled: stream.enabled, host: $('stream-host').value.trim() || '127.0.0.1', port: +$('stream-port').value || 9100 },
  };
}
$('save').addEventListener('click', async () => {
  $('save').disabled = true;
  try {
    const nt = $('s-token').value.trim();
    const cleared = $('s-token-clear').checked;
    await api('/api/config', { method: 'POST', body: collectConfig() });
    // an empty field means "unchanged" now, so only touch the stored token deliberately
    if (cleared) { token = ''; localStorage.setItem('lf_token', ''); }
    else if (nt && nt !== token) { token = nt; localStorage.setItem('lf_token', token); }
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

// ---------------- Konsolen-Login ----------------
function applyAdmin(c, pins) {
  const pinned = pins.includes('admin.passwordHash');
  $('s-admin-enabled').checked = c.admin?.enabled !== false;
  $('s-session-hours').value = c.admin?.sessionHours ?? 12;

  const set = !!c.adminPasswordSet;
  $('admin-state').textContent = pinned
    ? 'Passwort ist in der .env festgelegt (LF_ADMIN_PASSWORD) — hier nicht änderbar.'
    : set
      ? 'Passwort ist gesetzt. Die Konsole verlangt eine Anmeldung.'
      : 'Kein Passwort gesetzt — die Konsole ist offen. Bitte eins vergeben.';
  $('admin-state').classList.toggle('is-bad', !set && !pinned);

  for (const id of ['s-pw-current', 's-pw-new', 'pw-save']) $(id).disabled = pinned;
  $('s-pw-current').placeholder = set ? '' : '— noch keins gesetzt —';
  $('s-pw-current').disabled = pinned || !set;
}

$('pw-save').addEventListener('click', async () => {
  const next = $('s-pw-new').value;
  const current = $('s-pw-current').value;
  if (next.length < 8) return void ($('pw-status').textContent = 'Mindestens 8 Zeichen.');
  $('pw-save').disabled = true;
  $('pw-status').textContent = 'speichert…';
  try {
    await api('/api/auth/password', { method: 'POST', body: { current, next }, raw: true });
    $('s-pw-new').value = ''; $('s-pw-current').value = '';
    $('pw-status').textContent = 'Passwort geändert.';
    toast('Passwort geändert — andere Browser wurden abgemeldet');
    await loadConfig();
  } catch (err) {
    const hint = err.data?.hint;
    $('pw-status').textContent = err.message === 'bad_password' ? 'Aktuelles Passwort stimmt nicht.' : (hint || err.message);
  }
  $('pw-save').disabled = false;
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', raw: true }); } catch {}
  location.replace('/login');
});

// ---------------- Start-Benachrichtigung ----------------
// Feld-Id -> Pfad in cfg.notify. Ein Eintrag mit `secret` wird vom Server als
// Maske geliefert; unverändert zurückgeschickt behält er den gespeicherten Wert.
const NOTIFY_FIELDS = [
  ['s-nt-discord', 'discordWebhook', true],
  ['s-nt-slack', 'slackWebhook', true],
  ['s-nt-ntfy-topic', 'ntfy.topic', false],
  ['s-nt-ntfy-server', 'ntfy.server', false],
  ['s-nt-ntfy-token', 'ntfy.token', true],
  ['s-nt-tg-token', 'telegram.botToken', true],
  ['s-nt-tg-chat', 'telegram.chatId', false],
  ['s-nt-hook-url', 'webhook.url', true],
  ['s-nt-hook-secret', 'webhook.secret', true],
  ['s-nt-mail-to', 'email.to', false],
  ['s-nt-smtp-host', 'email.host', false],
  ['s-nt-smtp-user', 'email.user', false],
  ['s-nt-smtp-pass', 'email.pass', true],
  ['s-nt-smtp-from', 'email.from', false],
];
const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function plant(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = (o[k] = o[k] || {});
  o[last] = value;
}

function applyNotify(c) {
  const n = c.notify || {};
  $('s-notify-enabled').checked = n.enabled !== false;
  $('s-notify-start').checked = n.onStart !== false;
  $('s-notify-ip').checked = n.onIpChange !== false;
  $('s-notify-name').value = n.name || '';

  for (const [id, path] of NOTIFY_FIELDS) $(id).value = dig(n, path) ?? '';
  $('s-nt-smtp-port').value = n.email?.port ?? 587;
  $('s-nt-smtp-secure').checked = !!n.email?.secure;

  const chans = c.notifyChannels || [];
  const last = c.notifyLast || [];
  if (!chans.length) {
    $('notify-state').textContent = 'Kein Kanal eingerichtet — es geht nichts raus. Eine Zeile in der .env genügt, z. B. LF_NOTIFY_NTFY_TOPIC=lf-live-halle1';
  } else {
    const tail = last.length ? `  ·  zuletzt: ${last.map((r) => `${r.label} ${r.ok ? 'ok' : '✕ ' + r.detail}`).join(', ')}` : '';
    $('notify-state').textContent = `Kanäle: ${chans.map((ch) => `${ch.label} (${ch.target})`).join('  ·  ')}${tail}`;
  }
}

function collectNotify() {
  const n = {
    enabled: $('s-notify-enabled').checked,
    onStart: $('s-notify-start').checked,
    onIpChange: $('s-notify-ip').checked,
    name: $('s-notify-name').value.trim(),
    email: { port: +$('s-nt-smtp-port').value || 587, secure: $('s-nt-smtp-secure').checked },
  };
  for (const [id, path] of NOTIFY_FIELDS) plant(n, path, $(id).value.trim());
  return n;
}

$('notify-test').addEventListener('click', async () => {
  $('notify-test').disabled = true;
  $('notify-status').textContent = 'sendet…';
  try {
    const r = await api('/api/notify/test', { method: 'POST' });
    const sent = r.data.sent || [];
    if (!sent.length) $('notify-status').textContent = 'Kein Kanal eingerichtet.';
    else $('notify-status').textContent = sent.map((s) => `${s.label}: ${s.ok ? 'ok' : s.detail}`).join('  ·  ');
  } catch (err) { $('notify-status').textContent = 'Fehler: ' + err.message; }
  $('notify-test').disabled = false;
});

// ---------------- stats ----------------
// Totals are written per family (totals_<family>.csv) and the column sets differ;
// the console shows them under the display PROFILE that family is read with and
// asks the server for it (`?profile=`). It never hard-wires a column list: it
// takes the header of whatever file the server handed it, and every label comes
// from the label table in /api/modes — exactly like the live scoreboard takes
// its columns from the server's scoreboardColumns().
let totalsProfile = null;      // the profile currently shown (null until pinned)
let totalsProfiles = [];       // [{profile,label,family}] that have recorded data
/** Column label for a totals header cell; unknown keys stay readable. */
const totalsLabel = (k) => metricLabel(k);

async function loadStats() {
  try {
    if (!MODES) await loadModes();   // labels come from /api/modes
    const q = totalsProfile ? `?profile=${encodeURIComponent(totalsProfile)}` : '';
    const [tot, files] = await Promise.all([api('/api/stats/totals' + q), api('/api/stats/files')]);
    // The server names the profiles that have recorded data; an older build that
    // only knows families still works — one entry per family, labelled as before.
    totalsProfiles = Array.isArray(tot.profiles) && tot.profiles.length
      ? tot.profiles.filter((e) => e && e.profile)
      : (Array.isArray(tot.families) ? tot.families.map((f) => ({ profile: f, label: f, family: f })) : []);
    // First visit: pin the console to a concrete profile and ask again, so the
    // switcher and the table can never disagree about what is on screen.
    if (!totalsProfile && totalsProfiles.length) {
      totalsProfile = tot.profile || totalsProfiles[0].profile;
      return loadStats();
    }
    renderProfileSwitch();
    renderTotals(tot.data);
    renderStatsFiles(files.data);
  } catch (err) { note('Statistik laden fehlgeschlagen: ' + err.message, true); }
}

/** Only offer what has data; with a single profile there is nothing to switch. */
function renderProfileSwitch() {
  const wrap = $('totals-profile');
  if (!wrap) return;
  wrap.textContent = '';
  if (totalsProfiles.length < 2) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const e of totalsProfiles) {
    const b = el('button', { type: 'button', className: e.profile === totalsProfile ? 'on' : '' }, e.label || e.profile);
    b.title = `Anzeigeprofil ${e.profile}${e.family ? ` · Zahlen aus der Familie ${e.family}` : ''}`;
    b.addEventListener('click', () => { if (totalsProfile === e.profile) return; totalsProfile = e.profile; loadStats(); });
    wrap.append(b);
  }
}

function renderTotals(rows) {
  const t = $('totals-table');
  t.textContent = '';
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) { t.append(el('tbody', {}, el('tr', {}, el('td', { className: 'muted' }, 'Noch keine aufgezeichneten Matches.')))); return; }
  // Column order is the CSV header order the writer produced for this family:
  // player_id (hidden), name, matches, wins, losses, draws, die Familien-Zähler,
  // score und die abgeleitete Spalte. Nichts davon steht hier fest.
  const keys = Object.keys(list[0]).filter((k) => k && k !== 'player_id');
  const head = el('tr');
  keys.forEach((k) => head.append(el('th', { title: colTitle({ key: k, label: totalsLabel(k) }) }, totalsLabel(k))));
  t.append(el('thead', {}, head));
  const body = el('tbody');
  for (const r of list) {
    const tr = el('tr');
    keys.forEach((k, i) => {
      // Zahlenspalten sind Summen — eine fehlende Summe ist tatsächlich 0.
      // Textspalten (Name, Quelle, Zeitstempel) bleiben Text und dürfen leer sein.
      const fmt = colFormat(k, null);
      const v = r[k];
      const td = el('td', {}, fmt === 'int' && isBlank(v) ? '0' : cellText(v, fmt));
      if (i === 0) td.className = 'pl';
      tr.append(td);
    });
    body.append(tr);
  }
  t.append(body);
}
function renderStatsFiles(files) {
  const wrap = $('stats-files');
  wrap.textContent = '';
  if (!files.length) { wrap.append(el('p', { className: 'muted empty-note' }, 'Noch keine Dateien — sie entstehen automatisch am Ende jedes Matches.')); return; }
  for (const f of files) {
    const url = `/api/stats/file?name=${encodeURIComponent(f.name)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
    const a = el('a', { href: url, className: 'ocard', download: f.name.split('/').pop() });
    a.append(
      el('div', { className: 'ocard-top' },
        el('span', { className: 'badge amber' }, 'CSV'),
        el('span', { className: 'ocard-name' }, f.name),
        el('span', { className: 'ocard-target ml-auto' }, `${(f.size / 1024).toFixed(1)} kB · ${new Date(f.mtime).toLocaleString()}`)));
    wrap.append(a);
  }
}
$('totals-refresh').addEventListener('click', loadStats);

// ---------------- Roh-Mitschnitt ----------------
// Same shape as the CSV file list above: list from the server, download through
// /api/capture/file, delete through the mutating POST endpoint.
function capturePrivacy() {
  $('cap-privacy').hidden = !$('s-cap-enabled').checked;
}
$('s-cap-enabled').addEventListener('change', capturePrivacy);

async function loadCapture() {
  try {
    const r = await api('/api/capture/files');
    renderCaptureState(r.status);
    renderCaptureFiles(r.data || []);
  } catch (err) { $('cap-state').textContent = 'Liste nicht abrufbar: ' + err.message; }
}

function renderCaptureState(st) {
  const s = $('cap-state');
  if (!st) { s.textContent = '—'; return; }
  if (st.disabledByError) { s.textContent = 'nach Schreibfehlern abgeschaltet — aus- und wieder anschalten'; s.classList.add('is-bad'); return; }
  s.classList.remove('is-bad');
  if (!st.enabled) { s.textContent = 'aus'; return; }
  s.textContent = st.recording
    ? `nimmt gerade auf: ${st.file} (${(st.bytes / 1024).toFixed(1)} kB, ${st.lines} Zeilen)`
    : `an, wartet auf das nächste Spiel · Grenzen ${st.maxFileMB} MB/Datei · ${st.maxFiles} Dateien · ${st.maxTotalMB} MB gesamt`;
}

function renderCaptureFiles(files) {
  const wrap = $('cap-files');
  wrap.textContent = '';
  const link = (name) => `/api/capture/file?name=${encodeURIComponent(name)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
  $('cap-bundle').href = '/api/capture/bundle' + (token ? `?token=${encodeURIComponent(token)}` : '');
  $('cap-bundle').hidden = !files.length;
  $('cap-delall').hidden = !files.length;
  if (!files.length) {
    wrap.append(el('p', { className: 'muted empty-note' }, 'Noch keine Mitschnitte — sie entstehen automatisch, sobald der Mitschnitt an ist und ein Spiel läuft.'));
    return;
  }
  for (const f of files) {
    const c = el('div', { className: 'ocard' });
    const mode = f.mode ? (f.mode.number == null ? f.mode.label : `Modus ${f.mode.number} · ${f.mode.label}`) : '';
    const top = el('div', { className: 'ocard-top' },
      el('span', { className: 'badge ' + (f.kind === 'tdf' ? 'amber' : '') }, f.kind === 'tdf' ? 'TDF' : 'Zettel'),
      el('span', { className: 'ocard-name' }, f.name),
      el('span', { className: 'ocard-target' }, [mode, f.recording ? 'läuft gerade' : ''].filter(Boolean).join(' · ')));
    const actions = el('div', { className: 'ocard-actions' });
    const dl = el('a', { className: 'ghost mini', href: link(f.name), download: f.name }, 'Herunterladen');
    actions.append(dl, ghost('Löschen', async () => {
      if (!confirm(`„${f.name}" löschen?${f.kind === 'tdf' ? '\nDer zugehörige Begleitzettel (.txt) geht mit.' : ''}`)) return;
      try { await api('/api/capture/delete', { method: 'POST', body: { name: f.name } }); toast('Gelöscht'); loadCapture(); }
      catch (err) { toast('Löschen fehlgeschlagen: ' + err.message, true); }
    }));
    top.append(actions);
    c.append(top, el('div', { className: 'ocard-meta' },
      el('span', {}, `${(f.size / 1024).toFixed(1)} kB`),
      el('span', {}, new Date(f.mtime).toLocaleString())));
    wrap.append(c);
  }
}

$('cap-refresh').addEventListener('click', loadCapture);
$('cap-delall').addEventListener('click', async () => {
  if (!confirm('Wirklich ALLE Mitschnitte löschen?\nDas lässt sich nicht rückgängig machen.')) return;
  try { const r = await api('/api/capture/delete', { method: 'POST', body: { all: true } }); toast(`${r.data.deleted} Dateien gelöscht`); loadCapture(); }
  catch (err) { toast('Löschen fehlgeschlagen: ' + err.message, true); }
});

// ---------------- outputs ----------------
function renderOutputs() {
  const wrap = $('output-list');
  wrap.textContent = '';
  if (!outputs.length) wrap.append(el('p', { className: 'muted empty-note' }, 'Noch keine Ziele — mit „Ziel hinzufügen" schickst du Match-Daten an eine IP:Port im LAN.'));
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

    const bar = el('div', { className: 'row end mt-sm' });
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
  // outputs-only save: never touch the access token from here
  try { await api('/api/config', { method: 'POST', body: { ...collectConfig(), apiToken: '', apiTokenClear: false } }); await loadConfig(); refreshStatus(); }
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
  await loadModes();          // scoreboard layout must be there before the first state frame
  connectWs();
  refreshStatus();
  setInterval(refreshStatus, 3000);
})();
