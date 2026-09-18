'use strict';

/**
 * tdfSchema.js — reads the `;` schema-comment lines of a TDF stream.
 *
 * A TDF stream prefixes (most of) its line types with a comment line that names
 * the columns of the following rows of that type, e.g.
 *
 *     ;1/2/mission<TAB>type<TAB>desc<TAB>start<TAB>duration<TAB>penalty
 *     1<TAB>28<TAB>Laserball Ranked<TAB>...<TAB>900<TAB>0
 *
 * Those comments are the most reliable source for column positions: TDF
 * versions 2.000-2.006 differ exactly there (`duration` from 2.001, `penalty`
 * from 2.003, `battlesuit` from 2.003, `memberId` in late 2.006 ...).
 *
 * The engine used to drop every `;` line. It still behaves identically when no
 * schema is recognised — every lookup then reports "unknown" and the caller
 * falls back to its hard-coded column position.
 *
 * Design rules (see the contract):
 *   - tolerant: names are compared case-insensitively and ignore `-`, `_` and
 *     spaces, so `shots-hit` == `shotsHit` == `shots hit`.
 *   - never throws. On anything unexpected `indexOf()` returns -1 and `get()`
 *     returns `undefined`, which puts the caller back on the positional path.
 *
 * Column numbering: index 0 is the line-type column of the data row (the `1` in
 * the example above), so `indexOf('1', 'duration')` returns the index usable
 * directly as `cols[idx]`.
 */

/** Line-type names as they may appear in the comment header, -> type digit. */
const TYPE_WORDS = {
  info: '0',
  header: '0',
  mission: '1',
  game: '1',
  team: '2',
  entitystart: '3',
  entitystarts: '3',
  entity: '3',
  player: '3',
  event: '4',
  events: '4',
  score: '5',
  scores: '5',
  entityend: '6',
  entityends: '6',
  sm5stats: '7',
  stats: '7',
  statistics: '7',
  playerstate: '9',
  state: '9',
  entitystate: '9',
};

/** Compare-key for a column name: lower case, no separators. */
function key(name) {
  if (name == null) return '';
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Split a line into fields: tab-delimited when possible, else whitespace. */
function fieldsOf(text) {
  if (text.indexOf('\t') !== -1) {
    const parts = text.split('\t').map((s) => s.trim());
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    if (parts.length > 1) return parts;
  }
  return text.split(/\s+/).filter(Boolean);
}

class TdfSchema {
  constructor() {
    /** @type {Map<string,{names:string[], index:Map<string,number>}>} */
    this._byType = new Map();
    /** Schema whose line type could not be derived from its own header field. */
    this._pending = null;
  }

  /** Forget every observed schema. */
  reset() {
    this._byType = new Map();
    this._pending = null;
  }

  /**
   * Take in one `;` comment line. Silently ignores anything that does not look
   * like a column header. Never throws.
   * @param {string} line
   */
  observe(line) {
    try {
      if (typeof line !== 'string') return;
      const body = line.replace(/^\s*;+\s*/, '');
      if (!body.trim()) return;
      const fields = fieldsOf(body);
      if (fields.length < 2) return;

      // Documented form: `;<type>/<name>  col1  col2 …` — the first field is the
      // type descriptor and therefore describes column 0 of the data row.
      // Without a recognisable type descriptor the header is assumed to start
      // straight at column 1, so a placeholder keeps the indices aligned.
      const lineType = TdfSchema.typeOf(fields[0]);
      const names = lineType != null ? fields : ['(type)'].concat(fields);

      const index = new Map();
      for (let i = 0; i < names.length; i++) {
        const k = key(names[i]);
        // first occurrence wins — a duplicated name keeps the leftmost column
        if (k && !index.has(k)) index.set(k, i);
      }
      const entry = { names, index };

      if (lineType != null) {
        this._byType.set(lineType, entry);
        this._pending = null;
      } else {
        // Fallback per contract: the header belongs to the type of the next
        // non-comment line (resolved by noteLineType()).
        this._pending = entry;
      }
    } catch (_err) {
      // schema observation is best effort and must never disrupt the parser
    }
  }

  /**
   * Tell the schema which line type followed the last unlabelled `;` header.
   * No-op when the header already named its own type. Never throws.
   * @param {string} lineType
   */
  noteLineType(lineType) {
    try {
      if (!this._pending) return;
      const t = TdfSchema.normType(lineType);
      if (t == null) return;
      this._byType.set(t, this._pending);
      this._pending = null;
    } catch (_err) {
      /* ignore */
    }
  }

  /**
   * 0-based column index of `colName` in rows of `lineType`, or -1.
   * @returns {number}
   */
  indexOf(lineType, colName) {
    try {
      const entry = this._byType.get(TdfSchema.normType(lineType));
      if (!entry) return -1;
      const idx = entry.index.get(key(colName));
      return Number.isInteger(idx) ? idx : -1;
    } catch (_err) {
      return -1;
    }
  }

  /** Known column names of a line type (index 0 = the line-type column), or []. */
  names(lineType) {
    try {
      const entry = this._byType.get(TdfSchema.normType(lineType));
      return entry ? entry.names.slice() : [];
    } catch (_err) {
      return [];
    }
  }

  /**
   * Read a column by name out of an already-split row.
   *
   * TAB vs. WHITESPACE — the reason this takes two representations:
   * a real TDF row is TAB-delimited, but `engine.processLogLine` splits on
   * `/\s+/`. As soon as a field contains a space (mission `desc`, team name,
   * player name) that field falls apart into several tokens, so a schema index
   * (which counts TAB columns) no longer addresses the same value. Example:
   *   `1 \t 5 \t Space Marines 5 \t … \t 900000 \t 0`
   *   -> `duration` is TAB column 4, but whitespace token 6.
   *
   * Therefore:
   *   - `tabCols` (the row split on `\t`, passed whenever the line contained a
   *     tab) is the only representation a schema index is applied to.
   *   - without `tabCols` the schema index is used on `cols` only when the row
   *     provably cannot have been mis-split (`cols.length <= names.length`);
   *     a longer row means a field was torn apart and we fall back.
   *   - otherwise `fallbackIdx` (the caller's hard-coded position) is read from
   *     `cols`, i.e. exactly the pre-existing behaviour.
   *
   * @param {string} lineType
   * @param {string} colName
   * @param {string[]} cols        the whitespace-split data row (index 0 = line type)
   * @param {number} [fallbackIdx] positional index used when no schema applies
   * @param {string[]|null} [tabCols] the same row split on '\t', or null
   * @returns {string|undefined}
   */
  get(lineType, colName, cols, fallbackIdx, tabCols) {
    try {
      const idx = this.indexOf(lineType, colName);
      if (idx >= 0) {
        if (Array.isArray(tabCols) && tabCols.length > 1) {
          // tab columns line up with the schema one-to-one
          if (idx < tabCols.length) return tabCols[idx];
        } else if (Array.isArray(cols)) {
          const names = this.names(lineType);
          if (cols.length <= names.length && idx < cols.length) return cols[idx];
        }
      }
      if (Array.isArray(cols) && Number.isInteger(fallbackIdx) && fallbackIdx >= 0 && fallbackIdx < cols.length) {
        return cols[fallbackIdx];
      }
      return undefined;
    } catch (_err) {
      return undefined;
    }
  }

  /**
   * Split a raw line into TAB columns, or null when the line has no tab.
   * Kept here so engine and schema agree on the exact same splitting rule.
   * @param {string} line
   * @returns {string[]|null}
   */
  static tabColumns(line) {
    try {
      if (typeof line !== 'string' || line.indexOf('\t') === -1) return null;
      const parts = line.split('\t').map((s) => s.trim());
      while (parts.length && parts[parts.length - 1] === '') parts.pop();
      return parts.length > 1 ? parts : null;
    } catch (_err) {
      return null;
    }
  }

  /** true when a schema for this line type was observed. */
  has(lineType) {
    try {
      return this._byType.has(TdfSchema.normType(lineType));
    } catch (_err) {
      return false;
    }
  }

  /** Accept '1', 1, ' 1 ' as the same line type. Returns null when unusable. */
  static normType(lineType) {
    if (lineType == null) return null;
    const s = String(lineType).trim();
    return /^\d{1,2}$/.test(s) ? String(parseInt(s, 10)) : null;
  }

  /**
   * Derive the line type from the first field of a comment header, e.g.
   * `1/2/mission`, `1`, `mission`, `sm5-stats`. Returns null when unclear.
   */
  static typeOf(token) {
    if (token == null) return null;
    const s = String(token).trim();
    const m = s.match(/^(\d{1,2})(?:\D|$)/);
    if (m) {
      const t = TdfSchema.normType(m[1]);
      if (t != null) return t;
    }
    // word form: try the whole token and each `/`-separated part
    const parts = [s].concat(s.split(/[/\\|]+/));
    for (const p of parts) {
      const k = key(p);
      if (k && Object.prototype.hasOwnProperty.call(TYPE_WORDS, k)) return TYPE_WORDS[k];
    }
    return null;
  }
}

module.exports = { TdfSchema, schemaKey: key };
