'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { resolveMode } = require('./gameModes');
const { describe } = require('./eventCatalog');

/**
 * capture.js — byte-exact raw recording of the Laserforce TCP stream.
 *
 * A diagnosis tool for a test phase, NOT for permanent operation: it is off by
 * default (config.capture.enabled) and can be switched on and off from the web
 * console without a restart.
 *
 * WHAT IT WRITES
 *   One `.tdf` file per mission, containing the incoming bytes UNCHANGED —
 *   tabs, `\r\n`, the `;` schema-comment lines, everything. No normalisation,
 *   no re-serialisation, no line-ending conversion. Those details are the whole
 *   point of the recording: `scripts/replay.js` feeds such a file back into a
 *   bridge and must reproduce the exact same end state.
 *
 *   Next to every `.tdf` a `.txt` companion holds a short German summary for
 *   the operator (mode, teams, players, duration, how the match ended, line and
 *   event-code counts).
 *
 * WHERE A MISSION STARTS
 *   The type-0/1/2 lines (header, mission type, teams) arrive BEFORE the mission
 *   start `0100` (docs/LASERFORCE.md). A file that began at `0100` would not
 *   contain the game mode and would be worthless. A new mission therefore begins
 *   at a type-0 or type-1 line, and only as a fallback at `0100`. Everything
 *   that arrives before the first recognised mission goes into a `vorlauf` file.
 *
 * WHY THE FILE IS NAMED LATE, NOT RENAMED
 *   The file name carries the mode, which is only known once the type-1 line has
 *   been read. Instead of creating a file early and renaming it afterwards
 *   (a rename of a file with an open handle is exactly what fails on a Windows
 *   hall PC, and it breaks any listing or download in flight), the first bytes
 *   of a mission are held in memory until the mode is known — at the type-1
 *   line, at `0100` at the latest, and in any case after HEADER_HOLD_BYTES. The
 *   header is a handful of lines, so the window is tiny and bounded.
 *
 * SAFETY (an unattended hall PC must never be filled up)
 *   - per file      config.capture.maxFileMB   — recording of that mission stops
 *   - file count    config.capture.maxFiles    — oldest are deleted
 *   - directory     config.capture.maxTotalMB  — oldest are deleted
 *   A write error never reaches the stream or the engine; after MAX_ERRORS
 *   failures the recorder switches itself off and says so in the log.
 *
 * WRITING
 *   Bytes are queued and written in batches (FLUSH_BYTES, or once a second) —
 *   the TCP path itself only pushes a buffer into an array. The batched write is
 *   synchronous on purpose: it keeps the byte order, the size accounting and the
 *   close sequence (flush -> summary -> prune) trivially correct, and one 64 KiB
 *   append per second is nothing next to the per-line work the engine does
 *   anyway.
 *
 * PRIVACY: a recording contains player names and the globally unique Laserforce
 * member ids (`#…`). Operators send these files elsewhere — the console says so
 * at the switch, and so does docs/CAPTURE.md.
 */

const LF = 0x0a;
/** Held in memory until the mode is known. A TDF header is far below this. */
const HEADER_HOLD_BYTES = 64 * 1024;
/** Queue size that triggers a write. */
const FLUSH_BYTES = 64 * 1024;
/** Periodic flush + housekeeping while a mission is open. */
const TICK_MS = 1000;
/** No data at all for this long -> the mission is closed ("Zeitgeber"). */
const IDLE_CLOSE_MS = 5 * 60 * 1000;
/** Grace period after `0101` so a straggling line still lands in the file. */
const LINGER_MS = 5000;
/** Same guard as tcpIngest: a peer that never sends a newline. */
const MAX_PARTIAL = 1 << 20;
/** Consecutive write failures after which the recorder gives up for good. */
const MAX_ERRORS = 5;
/** Upper bound for "everything as one file" — beyond it, download singly. */
const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

/** The only file names that are ever listed, served or deleted. */
const NAME_RE = /^[A-Za-z0-9._-]+\.(tdf|txt)$/;

class Capture {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;
    this._m = null;            // mission being recorded, or null
    this._rest = null;         // trailing partial line (bytes)
    this._tick = null;
    this._linger = null;
    this._errors = 0;
    this._off = false;         // switched off after repeated write errors
    this._dirUsed = null;      // resolved dir of the running recording
    this._dirReady = false;
    this._held = [];           // `;`/blank lines waiting for the next mission
    this._heldBytes = 0;
    this._lastName = null;
    this._onExit = () => { try { this.shutdown(); } catch { /* last resort */ } };
    process.on('exit', this._onExit);
  }

  get cfg() {
    const c = this.getConfig().capture;
    return c && typeof c === 'object' ? c : { enabled: false, dir: 'data/capture', maxFileMB: 20, maxFiles: 50, maxTotalMB: 500 };
  }
  get enabled() { return this.cfg.enabled === true && !this._off; }
  get maxFileBytes() { return Math.max(1, num(this.cfg.maxFileMB, 20)) * 1024 * 1024; }
  get maxTotalBytes() { return Math.max(1, num(this.cfg.maxTotalMB, 500)) * 1024 * 1024; }
  get maxFiles() { return Math.max(1, num(this.cfg.maxFiles, 50)); }

  dir() { return path.resolve(process.cwd(), String(this.cfg.dir || 'data/capture')); }

  // ---- TCP hooks -----------------------------------------------------------

  /**
   * Raw bytes straight off the socket. Cheapest possible path when switched
   * off: one config read and a boolean.
   */
  onData(chunk) {
    if (!this.enabled) {
      if (this._m) this._close('umschalter');
      this._rest = null;
      return;
    }
    if (!chunk || !chunk.length) return;
    // A directory change from the console starts a new file set.
    const dir = this.dir();
    if (this._dirUsed && dir !== this._dirUsed) { this._close('umschalter'); this._dirReady = false; }
    this._dirUsed = dir;
    try { this._frame(chunk); }
    catch (err) { this._fail(err); }
  }

  /** The Laserforce socket went away — whatever was open ends here. */
  onStreamEnd() {
    if (this._rest && this._m) { try { this._append(this._rest); } catch { /* best effort */ } }
    this._rest = null;
    this._held = []; this._heldBytes = 0;   // a reconnect resends its own header
    if (this._m) this._close('abbruch');
  }

  /** Called after a console save: pick up enabled/dir changes right away. */
  reconcile() {
    if (!this.enabled && this._m) this._close('umschalter');
    if (this.enabled && this._dirUsed && this.dir() !== this._dirUsed) {
      this._close('umschalter');
      this._dirReady = false;
      this._dirUsed = this.dir();
    }
  }

  /** Flush and finish on shutdown. Idempotent. */
  shutdown() {
    if (this._rest && this._m) { try { this._append(this._rest); } catch { /* best effort */ } }
    this._rest = null;
    if (this._m) this._close('dienstende');
  }

  // ---- framing -------------------------------------------------------------

  /**
   * Split the byte stream into raw lines, each INCLUDING its terminator, so the
   * concatenation of everything written back is the original stream.
   */
  _frame(chunk) {
    let buf = this._rest ? Buffer.concat([this._rest, chunk]) : chunk;
    this._rest = null;
    let start = 0;
    for (;;) {
      const i = buf.indexOf(LF, start);
      if (i < 0) break;
      this._onRawLine(buf.subarray(start, i + 1));
      start = i + 1;
    }
    if (start >= buf.length) return;
    const rest = buf.subarray(start);
    // A peer that never sends a newline must not grow the buffer without end;
    // write what we have and carry on (still byte-exact).
    if (rest.length >= MAX_PARTIAL) { this._onRawLine(rest); return; }
    this._rest = Buffer.from(rest);
  }

  _onRawLine(raw) {
    let info;
    try { info = classify(raw); } catch { info = { kind: 'data' }; }
    try {
      if (this._starts(info)) this._begin();
      else if (!this._m) {
        // Nothing open. A `;` schema comment names the columns of the rows that
        // FOLLOW (docs/LASERFORCE.md) and therefore belongs to the mission that
        // is about to start, not to a file of its own — hold it back. Blank
        // lines are held the same way so they never create a junk file.
        if (info.kind !== 'data') return this._hold(raw, info);
        this._begin(true);
      }
      this._append(raw);
      this._note(info);
    } catch (err) { this._fail(err); }
  }

  /** Park a line that has no mission yet; it is replayed into the next one. */
  _hold(raw, info) {
    this._held.push({ raw, info });
    this._heldBytes += raw.length;
    // Never grow without bound: a feed that only ever sends comments becomes a
    // `vorlauf` file rather than an ever-growing buffer.
    if (this._heldBytes > HEADER_HOLD_BYTES) this._begin(true);
  }

  /**
   * Does this line open a NEW mission?
   *   type 0 / type 1  — the real boundary; a SECOND type-0 or type-1 always
   *                      starts a new one, the pair 0+1 of one header does not
   *   `0100`           — fallback for a feed that sends no header lines
   */
  _starts(info) {
    if (info.kind !== 'data') return false;
    const m = this._m;
    if (info.type === '0') return !m || m.pre || m.has0 || m.sawStart || m.body > 0;
    if (info.type === '1') return !m || m.pre || m.has1 || m.sawStart || m.body > 0;
    if (info.code === '0100') return !m || m.pre || m.sawStart;
    return false;
  }

  _begin(pre) {
    if (this._m) this._close('naechstes');
    const now = new Date();
    this._m = {
      pre: !!pre,
      id: shortId(),
      startedAt: now,
      endedAt: null,
      endReason: null,
      name: null,
      file: null,
      queue: [],
      queued: 0,
      bytes: 0,
      lines: 0,
      body: 0,          // lines that are neither header nor comment
      schema: 0,
      byType: {},
      codes: new Map(),
      teams: new Map(),
      players: new Set(),
      mode: null,
      maxTime: null,
      has0: false,
      has1: false,
      sawStart: false,
      truncated: false,
      lastAt: Date.now(),
    };
    if (pre) this._openFile(this._m);
    if (!this._tick) {
      this._tick = setInterval(() => this._housekeep(), TICK_MS);
      this._tick.unref?.();
    }
    // Whatever was waiting for a mission goes in first, in the order it arrived.
    const held = this._held;
    this._held = [];
    this._heldBytes = 0;
    for (const h of held) { this._append(h.raw); this._note(h.info); }
  }

  /** Per-second flush plus the idle watchdog. */
  _housekeep() {
    const m = this._m;
    if (!m) { if (this._tick) { clearInterval(this._tick); this._tick = null; } return; }
    try { this._flush(m); } catch (err) { this._fail(err); }
    if (Date.now() - m.lastAt > IDLE_CLOSE_MS) this._close('zeitgeber');
  }

  // ---- accounting ----------------------------------------------------------

  /** Everything the companion `.txt` reports, collected as the lines go by. */
  _note(info) {
    const m = this._m;
    if (!m) return;
    m.lastAt = Date.now();
    m.lines++;
    if (info.kind === 'schema') { m.schema++; return; }
    if (info.kind === 'blank') return;

    const t = info.type;
    if (t != null && t !== '') m.byType[t] = (m.byType[t] || 0) + 1;
    if (!['0', '1', '2'].includes(t)) m.body++;

    if (typeof info.time === 'number' && (m.maxTime == null || info.time > m.maxTime)) m.maxTime = info.time;

    if (t === '0') m.has0 = true;
    if (t === '1') {
      m.has1 = true;
      if (!m.mode) m.mode = resolveMode(info.missionType, info.missionDesc);
      if (!m.file) this._openFile(m);
    }
    if (t === '2' && info.teamIndex !== '' && m.teams.size < 32) m.teams.set(info.teamIndex, info.teamName || `Team ${info.teamIndex}`);
    if (t === '3' && info.isPlayer && info.entityId && m.players.size < 200) m.players.add(info.entityId);
    if (t === '4' && info.code) {
      m.codes.set(info.code, (m.codes.get(info.code) || 0) + 1);
      if (info.code === '0100') { m.sawStart = true; if (!m.file) this._openFile(m); }
      if (info.code === '0101' && !m.pre) {
        m.endReason = '0101';
        // Let a straggler still land in this file, then close promptly — the
        // operator should not have to wait for the next match for his file.
        clearTimeout(this._linger);
        this._linger = setTimeout(() => { if (this._m === m) this._close('0101'); }, LINGER_MS);
        this._linger.unref?.();
      }
    }
  }

  // ---- writing -------------------------------------------------------------

  _append(raw) {
    const m = this._m;
    if (!m || m.truncated) return;
    if (m.bytes + raw.length > this.maxFileBytes) {
      m.truncated = true;
      this._flush(m);
      this.log.warn('capture', `${m.name || m.id}: Grenze von ${num(this.cfg.maxFileMB, 20)} MB erreicht — Mitschnitt dieser Mission beendet, die Auswertung läuft weiter`);
      return;
    }
    m.bytes += raw.length;
    m.queue.push(raw);
    m.queued += raw.length;
    if (!m.file) {
      if (m.queued >= HEADER_HOLD_BYTES) this._openFile(m);
      return;
    }
    if (m.queued >= FLUSH_BYTES) this._flush(m);
  }

  /**
   * Fix the file name. Called once the mode is known (type-1), at `0100` at the
   * latest, or when the held header grows too large.
   */
  _openFile(m) {
    if (m.file) return;
    const stamp = stampOf(m.startedAt);
    m.name = m.pre
      ? `${stamp}_vorlauf_${m.id}.tdf`
      : `${stamp}_${m.mode && m.mode.number != null ? `mode${m.mode.number}` : 'mode-unbekannt'}_${slug(m.mode && m.mode.label) || 'unbekannt'}_${m.id}.tdf`;
    m.file = path.join(this._dirUsed || this.dir(), m.name);
    this._lastName = m.name;
    this.log.info('capture', `Mitschnitt läuft: ${m.name}`);
    this._flush(m);
  }

  _flush(m) {
    if (!m || !m.file || !m.queue.length) return;
    const chunk = Buffer.concat(m.queue, m.queued);
    m.queue.length = 0;
    m.queued = 0;
    try {
      this._ensureDir();
      fs.appendFileSync(m.file, chunk);
      this._errors = 0;
    } catch (err) {
      this._fail(err);
    }
  }

  _ensureDir() {
    if (this._dirReady) return;
    fs.mkdirSync(this._dirUsed || this.dir(), { recursive: true });
    this._dirReady = true;
  }

  _close(reason) {
    const m = this._m;
    if (!m) return;
    this._m = null;
    clearTimeout(this._linger); this._linger = null;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    m.endedAt = new Date();
    if (!m.endReason) m.endReason = reason;
    try {
      if (!m.file && (m.bytes > 0 || m.queued > 0)) this._openFile(m);
      this._flush(m);
      if (m.file) {
        this._writeSummary(m);
        this.log.info('capture', `Mitschnitt fertig: ${m.name} · ${fmtBytes(m.bytes)} · ${m.lines} Zeilen · ${END_REASON[m.endReason] || m.endReason}`);
      }
      this._prune();
    } catch (err) { this._fail(err); }
  }

  /** The German companion sheet an operator can quote from in a message. */
  _writeSummary(m) {
    const file = m.file.replace(/\.tdf$/, '.txt');
    try { fs.writeFileSync(file, summaryText(m, this)); }
    catch (err) { this._fail(err); }
  }

  /**
   * A write failed. The recording is subordinate to everything else: it never
   * throws upward, and after repeated failures it switches itself off.
   */
  _fail(err) {
    this._errors++;
    const msg = err && err.message ? err.message : String(err);
    if (this._errors >= MAX_ERRORS) {
      this._off = true;
      this._m = null;
      if (this._tick) { clearInterval(this._tick); this._tick = null; }
      clearTimeout(this._linger); this._linger = null;
      this.log.error('capture', `Mitschnitt nach ${this._errors} Schreibfehlern abgeschaltet (zuletzt: ${msg}) — Stream und Auswertung laufen weiter. Zum Wiedereinschalten in der Konsole aus- und wieder anschalten.`);
      return;
    }
    this.log.warn('capture', `Schreibfehler (${this._errors}/${MAX_ERRORS}): ${msg}`);
  }

  // ---- housekeeping --------------------------------------------------------

  /** Enforce maxFiles and maxTotalMB. Never touches the file being recorded. */
  _prune() {
    const dir = this._dirUsed || this.dir();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const recs = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.tdf') || !NAME_RE.test(e.name)) continue;
      let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      let txt = 0;
      try { txt = fs.statSync(path.join(dir, e.name.replace(/\.tdf$/, '.txt'))).size; } catch { /* none */ }
      recs.push({ name: e.name, mtime: st.mtimeMs, size: st.size + txt });
    }
    recs.sort((a, b) => b.mtime - a.mtime);   // newest first

    const drop = recs.slice(this.maxFiles);
    let keep = recs.slice(0, this.maxFiles);
    let total = keep.reduce((s, r) => s + r.size, 0);
    while (keep.length > 1 && total > this.maxTotalBytes) {
      const oldest = keep.pop();
      total -= oldest.size;
      drop.push(oldest);
    }
    for (const r of drop) {
      if (this._m && this._m.name === r.name) continue;
      this._removePair(dir, r.name);
      this.log.info('capture', `alter Mitschnitt gelöscht (Grenze erreicht): ${r.name}`);
    }
  }

  _removePair(dir, name) {
    for (const n of [name, name.replace(/\.tdf$/, '.txt')]) {
      try { fs.unlinkSync(path.join(dir, n)); } catch { /* already gone */ }
    }
  }

  // ---- console helpers -----------------------------------------------------

  status() {
    const c = this.cfg;
    return {
      enabled: c.enabled === true,
      disabledByError: this._off,
      dir: c.dir,
      resolvedDir: this.dir(),
      maxFileMB: num(c.maxFileMB, 20), maxFiles: num(c.maxFiles, 50), maxTotalMB: num(c.maxTotalMB, 500),
      recording: !!this._m,
      file: this._m ? (this._m.name || '(Kopf wird gesammelt)') : null,
      bytes: this._m ? this._m.bytes : 0,
      lines: this._m ? this._m.lines : 0,
      mode: this._m && this._m.mode ? { ...this._m.mode } : null,
      lastFile: this._lastName,
    };
  }

  /** Every recording in the folder, newest first. */
  listFiles() {
    const dir = this.dir();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isFile() || !NAME_RE.test(e.name)) continue;
      let st; try { st = fs.statSync(path.join(dir, e.name)); } catch { continue; }
      out.push({
        name: e.name,
        size: st.size,
        mtime: st.mtimeMs,
        kind: e.name.endsWith('.txt') ? 'txt' : 'tdf',
        mode: modeFromName(e.name),
        recording: !!(this._m && this._m.name === e.name),
      });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Read one recording. Path handling is the same as StatsWriter.readFile():
   * backslashes normalised, `..` and absolute paths refused, and the resolved
   * path must stay inside the folder. On top of that only our own file-name
   * shape is served at all.
   */
  readFile(name) {
    const safeName = String(name).replace(/\\/g, '/');
    if (safeName.includes('..') || safeName.startsWith('/')) return null;
    if (!NAME_RE.test(safeName)) return null;
    const full = path.join(this.dir(), safeName);
    if (!full.startsWith(this.dir() + path.sep)) return null;
    try { return fs.readFileSync(full); } catch { return null; }
  }

  /** Delete one recording (a `.tdf` takes its `.txt` with it). */
  deleteFile(name) {
    const safeName = String(name).replace(/\\/g, '/');
    if (safeName.includes('..') || safeName.startsWith('/')) return { ok: false, error: 'bad_name' };
    if (!NAME_RE.test(safeName)) return { ok: false, error: 'bad_name' };
    const full = path.join(this.dir(), safeName);
    if (!full.startsWith(this.dir() + path.sep)) return { ok: false, error: 'bad_name' };
    if (this._m && this._m.name && (safeName === this._m.name || safeName === this._m.name.replace(/\.tdf$/, '.txt'))) {
      return { ok: false, error: 'recording' };
    }
    if (!fs.existsSync(full)) return { ok: false, error: 'not_found' };
    if (safeName.endsWith('.tdf')) this._removePair(this.dir(), safeName);
    else { try { fs.unlinkSync(full); } catch { return { ok: false, error: 'not_found' }; } }
    return { ok: true, deleted: 1 };
  }

  /** Delete everything except a recording that is running right now. */
  deleteAll() {
    let deleted = 0;
    const running = this._m && this._m.name ? [this._m.name, this._m.name.replace(/\.tdf$/, '.txt')] : [];
    for (const f of this.listFiles()) {
      if (running.includes(f.name)) continue;
      try { fs.unlinkSync(path.join(this.dir(), f.name)); deleted++; } catch { /* already gone */ }
    }
    return { ok: true, deleted };
  }

  /**
   * Everything as ONE file: a plain ZIP built here with the built-in `zlib` —
   * no new dependency. Bounded by BUNDLE_MAX_BYTES because it is assembled in
   * memory; above that the operator downloads single files.
   */
  bundle() {
    const list = this.listFiles();
    if (!list.length) return { ok: false, error: 'empty' };
    const total = list.reduce((s, f) => s + f.size, 0);
    if (total > BUNDLE_MAX_BYTES) return { ok: false, error: 'too_large', bytes: total, limit: BUNDLE_MAX_BYTES };
    const files = [];
    for (const f of list) {
      const data = this.readFile(f.name);
      if (data) files.push({ name: f.name, data, mtime: f.mtime });
    }
    if (!files.length) return { ok: false, error: 'empty' };
    try { return { ok: true, buffer: zipOf(files), count: files.length }; }
    catch (err) { return { ok: false, error: 'zip_failed', hint: err.message }; }
  }
}

// ---------------------------------------------------------------------------
// line classification — tolerant, never throws, never changes a byte
// ---------------------------------------------------------------------------

/**
 * Enough of a line to keep the summary honest. A real TDF row is TAB delimited;
 * the whitespace split is the tolerant fallback for a space-delimited feed
 * (docs/LASERFORCE.md, "Tabulatoren, Leerzeichen und der Spaltenversatz").
 */
function classify(raw) {
  const body = raw.toString('utf8').replace(/[\r\n]+$/, '');
  if (!body.trim()) return { kind: 'blank' };
  if (body.startsWith(';')) return { kind: 'schema' };

  const tab = body.includes('\t') ? body.split('\t') : null;
  const ws = body.trim().split(/\s+/);
  const at = (i) => String((tab ? tab[i] : ws[i]) ?? '').trim();

  const out = { kind: 'data', type: ws[0], code: null, time: null };
  const t = out.type;

  if (['3', '4', '5', '6', '9'].includes(t)) {
    const n = parseInt(ws[1], 10);
    if (Number.isFinite(n)) out.time = n;
  }
  if (t === '4') out.code = at(2).toUpperCase();
  if (t === '1') {
    out.missionType = at(1);
    out.missionDesc = tab ? at(2) : joinDesc(ws, 2);
  }
  if (t === '2') {
    out.teamIndex = at(1);
    out.teamName = tab ? at(2) : joinDesc(ws, 2);
  }
  if (t === '3') {
    out.entityId = at(2).replace(/^[@#]/, '');
    out.isPlayer = (tab ? at(3) : ws[3]) === 'player' && at(5) !== '5';
  }
  return out;
}

/** Description tokens of a space-delimited line: everything but the trailing numbers. */
function joinDesc(ws, from) {
  let end = ws.length;
  let dropped = 0;
  while (end > from + 1 && dropped < 3 && /^-?\d+$/.test(ws[end - 1])) { end--; dropped++; }
  return ws.slice(from, end).join(' ');
}

// ---------------------------------------------------------------------------
// the companion sheet
// ---------------------------------------------------------------------------

const END_REASON = {
  '0101': 'regulär beendet (Mission End 0101)',
  naechstes: 'abgelöst vom Start des nächsten Matches',
  abbruch: 'Stream-Abbruch (Laserforce hat die Verbindung beendet)',
  zeitgeber: 'Zeitgeber — es kamen keine Daten mehr',
  umschalter: 'Mitschnitt in der Konsole abgeschaltet',
  dienstende: 'Dienst wurde beendet',
};

const TYPE_LABEL = {
  0: 'Kopf / Version', 1: 'Mission (Modus)', 2: 'Team', 3: 'Login (Entity)',
  4: 'Ereignis', 5: 'Punktestand', 6: 'Entity-Ende', 7: 'SM5-Endblock',
  8: '(undokumentiert)', 9: 'Spieler-Status',
};

function summaryText(m, cap) {
  const L = [];
  const mode = m.mode;
  L.push('LF Live — Begleitzettel zum Roh-Mitschnitt');
  L.push('='.repeat(62));
  L.push('');
  L.push(`Datei            ${m.name}`);
  L.push(`Beginn           ${fmtWall(m.startedAt)}`);
  L.push(`Ende             ${fmtWall(m.endedAt || new Date())}  (${fmtDur(m.endedAt - m.startedAt)} Wanduhr)`);
  if (m.pre) {
    L.push('Inhalt           Vorlauf — alles, was vor der ersten erkannten Mission ankam');
  } else {
    L.push(`Spielmodus       ${mode ? `${mode.number == null ? '—' : mode.number} · ${mode.label} (Familie ${mode.family}${mode.known ? '' : ', Nummer nicht in der Registry'})` : 'unbekannt — keine Typ-1-Zeile im Mitschnitt'}`);
    L.push(`Teams            ${m.teams.size ? [...m.teams.entries()].map(([i, n]) => `${i} ${n}`).join(' · ') : '—'}`);
    L.push(`Spieler          ${m.players.size || '—'}`);
    L.push(`Spieldauer       ${m.maxTime == null ? '—' : `${(m.maxTime / 1000).toFixed(1)} s (letzte Zeitmarke im Stream)`}`);
    L.push(`Missionsstart    ${m.sawStart ? 'ja (0100 gesehen)' : 'nein — der Mitschnitt enthält keinen Start'}`);
  }
  L.push(`Ende des Matches ${END_REASON[m.endReason] || m.endReason || '—'}`);
  L.push(`Umfang           ${fmtBytes(m.bytes)} · ${m.lines} Zeilen`);
  if (m.truncated) {
    L.push('');
    L.push(`!! ABGESCHNITTEN — die Grenze von ${num(cap.cfg.maxFileMB, 20)} MB je Datei wurde erreicht.`);
    L.push('   Ab dieser Stelle wurde nichts mehr mitgeschrieben. Der Stream und die');
    L.push('   Auswertung liefen davon unberührt weiter.');
  }

  L.push('');
  L.push('Zeilen je Typ');
  if (m.schema) L.push(`  ;  Schema-Kommentar        ${String(m.schema).padStart(6)}`);
  for (const t of Object.keys(m.byType).sort()) {
    const label = TYPE_LABEL[t] || '(unbekannter Zeilentyp)';
    L.push(`  ${String(t).padEnd(2)} ${label.padEnd(23)} ${String(m.byType[t]).padStart(6)}`);
  }

  if (m.codes.size) {
    L.push('');
    L.push('Gesehene Typ-4-Codes');
    for (const [code, n] of [...m.codes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      let label = '';
      try { label = describe(code).label; } catch { label = ''; }
      L.push(`  ${code.padEnd(6)} ${String(label).slice(0, 30).padEnd(31)} ${String(n).padStart(6)}`);
    }
  }

  L.push('');
  L.push('Zurückspielen');
  L.push(`  node scripts/replay.js "${m.name}" --host 127.0.0.1 --port 9000`);
  L.push('  (--realtime spielt in echter Geschwindigkeit, --speed 8 achtfach)');
  L.push('');
  L.push('Datenschutz');
  L.push('  Dieser Mitschnitt enthält Spielernamen und die weltweit eindeutigen');
  L.push('  Laserforce-Mitglieds-IDs (#…) der Spieler. Nur an Personen weitergeben,');
  L.push('  denen diese Daten anvertraut werden dürfen, und danach löschen.');
  L.push('');
  return L.join('\r\n');
}

// ---------------------------------------------------------------------------
// zip (built-in zlib only — no new dependency)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosStamp(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/** Minimal, standards-conforming ZIP (deflate or stored, no zip64). */
function zipOf(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'ascii');       // NAME_RE guarantees ascii
    const crc = crc32(f.data);
    const packed = zlib.deflateRawSync(f.data, { level: 6 });
    const deflated = packed.length < f.data.length;
    const body = deflated ? packed : f.data;
    const method = deflated ? 8 : 0;
    const st = dosStamp(f.mtime);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(st.time, 10); lh.writeUInt16LE(st.date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(st.time, 12); cd.writeUInt16LE(st.date, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function num(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function shortId() { return (Date.now().toString(36).slice(-3) + Math.random().toString(36).slice(2, 5)).toLowerCase(); }

function slug(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
    .replace(/-+$/, '');
}

/** `<name>_mode28_laserball-ranked_ab12cd.tdf` -> what the console shows. */
function modeFromName(name) {
  const m = /_mode(\d+|-unbekannt)_([a-z0-9-]*)_/.exec(name);
  if (!m) return /_vorlauf_/.test(name) ? { number: null, label: 'Vorlauf' } : null;
  return { number: m[1] === '-unbekannt' ? null : parseInt(m[1], 10), label: m[2] || '' };
}

function stampOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function fmtWall(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDur(ms) {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} min`;
}
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

module.exports = { Capture, classify, zipOf, crc32, slug, modeFromName };
