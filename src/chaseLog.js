'use strict';

const fs = require('fs');
const path = require('path');

/**
 * chaseLog.js — the Verdacht „Hinterherlaufen" written down, one file per day.
 *
 * Two readers, two needs, one format: the hall operator wants to see in the
 * evening what stood out during the day, and the next person to work on this
 * wants to evaluate the file. Markdown serves both — it reads as plain text and
 * parses as a table.
 *
 * WHAT IS WRITTEN
 *   data/chase/verfolger-YYYY-MM-DD.md            APPEND ONLY. One section per
 *     match, in the order the matches ended. A match with no finding gets its
 *     line too — otherwise nobody can tell "nothing stood out tonight" from
 *     "the writing was not running", and that is a difference that matters.
 *   data/chase/verfolger-YYYY-MM-DD-uebersicht.md  REBUILT after every match.
 *     Who was listed in how many matches of the day, against whom, longest run.
 *
 * Why an overview file at all, when the day log is append-only: a player who
 * shows up in six matches of an evening is a different observation from one who
 * showed up once, and the day log cannot show that without being read end to
 * end. Why it is a SECOND file and not a block inside the day log: rewriting
 * would break the append-only guarantee that protects the log against a crash.
 *
 * Why it can be rebuilt at all: the overview is derived from the day log by
 * READING IT BACK, not from anything held in memory. So it is correct after a
 * restart, after a crash, and even if somebody deletes it — it is regenerated
 * from the authoritative file at the next match end. That is also why the rows
 * below are written in a strict, machine-readable shape.
 *
 * The overview carries COUNTS and nothing else. No score, no ranking, no
 * verdict: the file states what was measured and leaves the judgement to the
 * person reading it.
 *
 * WHEN IT IS WRITTEN
 *   Once per match end. Never in the event path. The write is synchronous
 *   precisely because it happens once per match: it costs a millisecond or two
 *   at a moment when the match is already over, and in exchange the order of
 *   the file is guaranteed without a queue, a timer or a flush-on-exit.
 *
 * A write error is logged once and otherwise swallowed. A log file must never
 * be able to disturb a running arena.
 */

/** Longest text taken from the stream into one Markdown cell. */
const CELL_MAX = 64;
/** Most findings written for a single match — a runaway feed cannot bloat the file. */
const ROWS_MAX = 200;
/** Most rows in the day overview. */
const SUMMARY_MAX = 200;
/** Most targets named per player in the overview before it says "u. a.". */
const TARGETS_MAX = 4;
/** Ceiling for the day log we read back to build the overview (1 MiB is many days). */
const READBACK_MAX = 1024 * 1024;

/**
 * Text from the TCP stream into a Markdown table cell.
 *
 * Player and mode names are FOREIGN INPUT. Three things must not survive:
 * control characters (they make the file unreadable and can repaint a
 * terminal), the pipe (it would tear the table apart) and the backtick (it
 * would open a code span). The pipe is REPLACED, not escaped, on purpose — an
 * escaped pipe would make reading the file back ambiguous, and the overview
 * depends on reading it back. `stripControls()` below does the first of the
 * three.
 */

/**
 * Steuerzeichen raus, ohne eine einzige Escape-Sequenz im Quelltext: die
 * Zeichenklasse wird ueber den Codepunkt geprueft. Das ist hier kein Geschmack,
 * sondern Notwehr — ein Zeichenklassen-Literal mit rohen Steuerbytes laesst git
 * die Datei als BINAER einstufen, und genau das faengt scripts/check.js
 * (source.noControlChars) ab. Laeuft einmal je Matchende ueber eine Handvoll
 * kurzer Namen; die Schleife kostet nichts.
 */
function stripControls(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || (c >= 0x7f && c <= 0x9f)) ? ' ' : ch;
  }
  return out;
}

function cell(v) {
  return stripControls(String(v == null ? '' : v))
    .replace(/\|/g, '/')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CELL_MAX) || '—';
}

/** An id into a code span. Arena ids are `#` + alphanumerics; anything else is cut. */
function idCell(v) {
  const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
  return s || '—';
}

function p2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; }
function hms(d) { return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }
function hm(d) { return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }

/** ms -> `8:00`. Empty string when there is nothing sensible to show. */
function mmss(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return '';
  const t = Math.floor(v / 1000);
  return `${Math.floor(t / 60)}:${p2(t % 60)}`;
}

/**
 * The header of a fresh day file. It travels WITH the file: if the operator
 * forwards it to somebody, the limits of the detection go along. Everything in
 * here is deliberately careful in tone — this is a suspicion out of a
 * heuristic, and the file may well end up in front of the player it names.
 */
function dayHeader(dateStr, threshold) {
  return [
    `# Beobachtung „Hinterherlaufen" — ${dateStr}`,
    '',
    'Diese Datei hält fest, wo lf_live **vermutet** hat, dass ein Spieler einer',
    'bestimmten Person hinterherläuft. Aufgenommen wird, wer',
    `**${threshold}-mal hintereinander dieselbe Person getroffen** hat.`,
    '',
    '**Das ist ein Verdacht und keine Feststellung.** Was die Erkennung *nicht*',
    'leisten kann, gehört zu jedem Blick in diese Datei dazu:',
    '',
    '- Sie sieht nur **Treffer**. Wer jemandem hinterherläuft und dabei nicht',
    '  trifft, steht hier nicht.',
    '- Sie kennt **keine Entfernung und keine Position**. Drei Treffer aus der',
    '  Ferne sehen für sie aus wie drei Treffer aus zwei Metern.',
    '- Bei **wenigen Spielern** in der Arena bedeutet ein Eintrag fast nichts:',
    '  wo es nur einen Gegner gibt, ist jede Serie zwangsläufig auf dieselbe',
    '  Person. Die Spielerzahl steht deshalb bei jedem Match dabei.',
    '- Zwei Spieler, die sich **gegenseitig** verfolgen, sind meist ein Duell',
    '  und kein Nachstellen. Solche Paare stehen hier beide drin.',
    '- Ein **guter Spieler mit vielen Treffern** erzeugt rein rechnerisch mehr',
    '  Serien als ein schwacher.',
    '',
    'An echten Mitschnitten gemessen: mit der Schwelle 3 taucht in einem Match',
    'mit 30 bis 41 Spielern etwa ein Drittel bis die Hälfte aller Spieler',
    'irgendwann einmal hier auf. Ein einzelner Eintrag ist also Alltag; erst',
    'eine auffällig lange Serie oder ein Name, der immer wiederkehrt, ist',
    'überhaupt einen Blick wert. Die Schwelle lässt sich hochsetzen',
    '(`engine.chase.threshold`, siehe docs/CONFIG.md).',
    '',
    'Gelistet wird je Spieler die **längste** Serie des Matches und die Person,',
    'auf die sie ging; „Serien" sagt, wie oft in dem Match überhaupt eine',
    'zustande kam.',
    '',
    'Nur angehängt, nie neu geschrieben. Enthält **Spielernamen**.',
    '',
    '',
  ].join('\n');
}

class ChaseLog {
  /**
   * @param {object} config  the resolved config object (config.data)
   * @param {object} [logger] app logger, for the one-time fs-error warning
   */
  constructor(config, logger) {
    this.log = logger || null;
    this._warned = false;
    this.configure(config);
  }

  /** Re-read the settings after a console save. Never throws. */
  configure(config) {
    try {
      const cfg = (config && config.chaseLog) || {};
      this.enabled = cfg.enabled !== false;
      this.summary = cfg.summary !== false;
      this._dirRel = typeof cfg.dir === 'string' && cfg.dir.trim() ? cfg.dir.trim() : 'data/chase';
      this.dir = path.resolve(process.cwd(), this._dirRel);
    } catch (_err) {
      this.enabled = false;
    }
    return this.status();
  }

  dayFile(d = new Date()) { return path.join(this.dir, `verfolger-${ymd(d)}.md`); }
  summaryFile(d = new Date()) { return path.join(this.dir, `verfolger-${ymd(d)}-uebersicht.md`); }

  status() {
    return {
      enabled: this.enabled === true,
      summary: this.summary === true,
      dir: this._dirRel,
      file: this.enabled ? this.dayFile() : null,
      summaryFile: this.enabled && this.summary ? this.summaryFile() : null,
    };
  }

  /**
   * One finished match. Appends its section and rebuilds the day overview.
   * @param {object} snapshot `engine.snapshot()` of the match that just ended
   */
  onMatchEnd(snapshot) {
    if (!this.enabled) return null;
    try {
      const s = snapshot || {};
      const players = s.players && typeof s.players === 'object' ? Object.keys(s.players).length : 0;
      // No player ever logged in: that was not a match, and a section about it
      // would only make the day harder to read.
      if (!players) return null;

      const now = new Date();
      const file = this.dayFile(now);
      const text = this._section(s, players, now);

      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // The header goes in exactly once, when the day file comes into being —
      // after that the file is only ever appended to.
      const head = fs.existsSync(file) ? '' : dayHeader(ymd(now), Math.max(0, Number(s.chaseThreshold) || 0));
      fs.appendFileSync(file, head + text);

      if (this.summary) this._writeSummary(now);
      return file;
    } catch (err) {
      this._warnOnce(err);
      return null;
    }
  }

  // ---- the day log ---------------------------------------------------------

  /** One match as Markdown. Always has a heading and always says something. */
  _section(s, players, now) {
    const mode = cell((s.mode && s.mode.label) || s.missionDesc || 'unbekannter Modus');
    const id = idCell(s.matchId) || '—';
    const th = Math.max(0, Number(s.chaseThreshold) || 0);
    const dur = mmss(s.elapsedTime) || mmss(s.duration);
    const list = Array.isArray(s.chasing) ? s.chasing.slice(0, ROWS_MAX) : [];

    const out = [];
    // The heading carries the match id in a fixed shape — `_readDay()` finds the
    // section boundaries by exactly this line.
    out.push(`## ${hm(now)} · Match \`${id}\` · ${mode}`);
    out.push('');
    const facts = [`Spieler: ${players}`];
    if (dur) facts.push(`Dauer: ${dur}`);
    facts.push(`Schwelle: ${th} Treffer hintereinander`);
    if (players < 6) facts.push('**wenige Spieler — ein Eintrag sagt hier kaum etwas**');
    out.push(`- ${facts.join(' · ')}`);

    if (s.chaseWatched !== true) {
      const prof = (s.mode && s.mode.profile) || '?';
      const watched = Array.isArray(s.chaseProfiles) && s.chaseProfiles.length
        ? s.chaseProfiles.map((p) => `\`${idCell(p)}\``).join(', ')
        : '—';
      out.push(`- Dieser Spielmodus wird nicht beobachtet (Anzeigeprofil \`${idCell(prof)}\`, beobachtet werden: ${watched}).`);
      out.push('');
      return out.join('\n') + '\n';
    }

    if (!list.length) {
      out.push('- Niemand war auffällig.');
      out.push('');
      return out.join('\n') + '\n';
    }

    out.push('');
    out.push('| Spieler-Kennung | Spieler | blieb dran an | Ziel-Kennung | längste Serie | Serien | zuletzt |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of list) {
      const at = Number(c.lastAt);
      out.push(`| \`${idCell(c.playerId)}\` | ${cell(c.playerName)} | ${cell(c.targetName)} `
        + `| \`${idCell(c.targetId)}\` | ${Math.max(0, Number(c.streak) || 0)} `
        + `| ${Math.max(1, Number(c.runs) || 1)} `
        + `| ${Number.isFinite(at) && at > 0 ? hms(new Date(at)) : '—'} |`);
    }
    out.push('');
    return out.join('\n') + '\n';
  }

  // ---- the day overview ----------------------------------------------------

  /**
   * Rebuild the overview from the day log. Reading the authoritative file back
   * (instead of counting along in memory) is what makes the overview survive a
   * restart — and it can never drift away from the log.
   */
  _writeSummary(now) {
    const day = ymd(now);
    const parsed = this._readDay(this.dayFile(now));
    if (!parsed) return;
    const text = this._summaryText(day, parsed, now);
    // Written through a temp file and renamed, so a crash mid-write cannot
    // leave half an overview behind. The day log itself is never touched.
    const target = this.summaryFile(now);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  /**
   * Read the day log back. Returns `{matches, watched, byPlayer}` or null.
   * Strictly tolerant: anything that does not match the shapes this class
   * writes is ignored, so a hand-edited file can never crash the service.
   */
  _readDay(file) {
    let raw;
    try {
      const st = fs.statSync(file);
      if (st.size > READBACK_MAX) return null;   // do not read an oversized file into memory
      raw = fs.readFileSync(file, 'utf8');
    } catch (_err) {
      return null;
    }
    const HEAD = /^## \d{2}:\d{2} · Match `([A-Za-z0-9._-]{1,32})` · /;
    const ROW = /^\| `([A-Za-z0-9._-]{1,32})` \| (.*?) \| (.*?) \| `([A-Za-z0-9._-]{1,32})` \| (\d{1,6}) \| (\d{1,6}) \| ([0-9:]{1,8}|—) \|$/;
    const matches = new Set();
    const watched = new Set();
    const byPlayer = new Map();   // playerId -> {name, matches:Set, best, targets:Map}
    let cur = null;
    for (const line of raw.split('\n')) {
      const h = HEAD.exec(line);
      if (h) { cur = h[1]; matches.add(cur); continue; }
      const r = ROW.exec(line);
      if (!r || !cur) continue;
      const [, pid, pname, tname, , streakRaw] = r;
      const streak = parseInt(streakRaw, 10);
      if (!Number.isFinite(streak)) continue;
      watched.add(cur);
      let e = byPlayer.get(pid);
      if (!e) {
        if (byPlayer.size >= SUMMARY_MAX * 4) continue;
        e = { name: pname, matches: new Set(), best: 0, targets: new Map() };
        byPlayer.set(pid, e);
      }
      e.name = pname;                       // the most recent spelling wins
      e.matches.add(cur);
      if (streak > e.best) e.best = streak;
      e.targets.set(tname, (e.targets.get(tname) || 0) + 1);
    }
    return { matches: matches.size, watched: watched.size, byPlayer };
  }

  _summaryText(day, parsed, now) {
    const rows = [...parsed.byPlayer.entries()]
      .map(([pid, e]) => ({
        pid,
        name: e.name,
        matches: e.matches.size,
        best: e.best,
        targets: [...e.targets.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))),
      }))
      // In wie vielen Matches, dann längste Serie, dann Name. Das ist eine
      // Sortierung, keine Bewertung.
      .sort((a, b) => b.matches - a.matches || b.best - a.best || String(a.name).localeCompare(String(b.name)))
      .slice(0, SUMMARY_MAX);

    const out = [];
    out.push(`# Tagesübersicht „Hinterherlaufen" — ${day}`);
    out.push('');
    out.push(`Stand ${hms(now)}. Diese Datei wird nach jedem Match **neu geschrieben**;`);
    out.push(`sie ist vollständig aus \`verfolger-${day}.md\` abgeleitet und enthält nichts,`);
    out.push('was dort nicht steht. Maßgeblich ist immer die Tagesdatei.');
    out.push('');
    out.push('Hier stehen **Zahlen, keine Bewertung**. Dass ein Name mehrfach vorkommt,');
    out.push('heißt nicht, dass etwas vorgefallen ist — es heißt, dass die Serie mehrfach');
    out.push('zustande kam. Die Grenzen der Erkennung stehen im Kopf der Tagesdatei.');
    out.push('');
    out.push(`- Matches heute: ${parsed.matches} · davon mit mindestens einem Eintrag: ${parsed.watched}`);
    out.push('');
    if (!rows.length) {
      out.push('Heute war niemand auffällig.');
      out.push('');
      return out.join('\n');
    }
    out.push('| Spieler-Kennung | Spieler | in Matches | längste Serie | blieb dran an |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const names = r.targets.slice(0, TARGETS_MAX).map(([n, c]) => `${n} (${c}×)`).join(', ');
      const more = r.targets.length > TARGETS_MAX ? `, u. a. ${r.targets.length - TARGETS_MAX} weitere` : '';
      out.push(`| \`${r.pid}\` | ${r.name} | ${r.matches} von ${parsed.matches} | ${r.best} | ${names}${more} |`);
    }
    out.push('');
    return out.join('\n');
  }

  _warnOnce(err) {
    if (this._warned) return;
    this._warned = true;
    const msg = err && err.message ? err.message : String(err);
    if (this.log && typeof this.log.warn === 'function') {
      this.log.warn('chaselog', `Schreiben fehlgeschlagen, weitere Fehler werden unterdrückt: ${msg}`);
    }
  }
}

module.exports = { ChaseLog };
