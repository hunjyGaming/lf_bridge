'use strict';

const crypto = require('crypto');

/**
 * Admin-Anmeldung für die Web-Konsole.
 *
 * Drei Bausteine, bewusst ohne externe Abhängigkeit:
 *   - Passwort-Hash: scrypt mit zufälligem Salt, Format
 *     `scrypt$N$r$p$<salt b64>$<hash b64>`. Der Vergleich ist zeitkonstant.
 *   - SessionStore: Cookie-Sessions im Arbeitsspeicher. Ein Neustart meldet
 *     alle ab — auf einem Hallen-PC genau das gewünschte Verhalten.
 *   - LoginGuard: Fehlversuchs-Zähler je IP mit Sperrzeit gegen Durchprobieren.
 *
 * Gehasht wird asynchron (crypto.scrypt), damit ein Login-Versuch niemals den
 * Event-Loop blockiert — währenddessen läuft ein Match weiter.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'scrypt';

/** Zeichenvorrat ohne 0/O/1/l/I — ein generiertes Passwort muss abtippbar sein. */
const PW_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function scryptAsync(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, params, (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

/** `scrypt$N$r$p$salt$hash` für ein Klartext-Passwort. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return [PREFIX, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

/** Blockierende Variante — nur für das CLI-Skript (scripts/setpw.js). */
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return [PREFIX, SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), dk.toString('base64')].join('$');
}

function isHash(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX + '$') && stored.split('$').length === 6;
}

/** Zeitkonstanter Vergleich. Ein kaputter/leerer Hash ergibt immer `false`. */
async function verifyPassword(password, stored) {
  if (!isHash(stored)) return false;
  try {
    const [, N, r, p, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    if (!salt.length || !expect.length) return false;
    const dk = await scryptAsync(password, salt, expect.length, {
      N: parseInt(N, 10) || SCRYPT.N,
      r: parseInt(r, 10) || SCRYPT.r,
      p: parseInt(p, 10) || SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    });
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  } catch {
    return false;
  }
}

/** Zufälliges, vorlesbares Startpasswort: 4 Gruppen à 4 Zeichen. */
function generatePassword(groups = 4, size = 4) {
  const out = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < size; i++) s += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
    out.push(s);
  }
  return out.join('-');
}

/** Mindestanforderung an ein selbst gesetztes Passwort. */
const MIN_PASSWORD_LENGTH = 8;
function passwordProblem(pw) {
  if (typeof pw !== 'string' || !pw.trim()) return 'Passwort fehlt';
  if (pw.length < MIN_PASSWORD_LENGTH) return `mindestens ${MIN_PASSWORD_LENGTH} Zeichen`;
  if (pw.length > 200) return 'höchstens 200 Zeichen';
  return null;
}

/**
 * Sessions im Arbeitsspeicher. Der Token landet als HttpOnly-Cookie beim Browser,
 * gespeichert wird hier nur sein SHA-256 — wer die Datei/den Heap liest, bekommt
 * keinen benutzbaren Cookie-Wert.
 */
class SessionStore {
  constructor({ ttlMs = 12 * 3600 * 1000, max = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();               // sha256(token) -> { exp, created, ip, ua }
    this._sweeper = setInterval(() => this.sweep(), 300000);
    this._sweeper.unref?.();
  }

  static _key(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

  create({ ip = '?', ua = '' } = {}) {
    if (this.map.size >= this.max) this.sweep(true);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(SessionStore._key(token), { exp: now + this.ttlMs, created: now, ip, ua: String(ua).slice(0, 120) });
    return { token, expiresAt: now + this.ttlMs };
  }

  /** Gültige Session oder null. Verlängert nicht — die Laufzeit ist absolut. */
  get(token) {
    if (!token) return null;
    const k = SessionStore._key(token);
    const s = this.map.get(k);
    if (!s) return null;
    if (s.exp <= Date.now()) { this.map.delete(k); return null; }
    return s;
  }

  destroy(token) { if (token) this.map.delete(SessionStore._key(token)); }
  destroyAll() { this.map.clear(); }
  get size() { return this.map.size; }

  /** Abgelaufene entfernen; mit `force` zusätzlich die ältesten, bis Platz ist. */
  sweep(force = false) {
    const now = Date.now();
    for (const [k, s] of this.map) if (s.exp <= now) this.map.delete(k);
    if (!force) return;
    while (this.map.size >= this.max) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].created - b[1].created)[0];
      if (!oldest) break;
      this.map.delete(oldest[0]);
    }
  }

  setTtl(ms) { this.ttlMs = Math.max(60000, ms | 0); }
  stop() { clearInterval(this._sweeper); }
}

/**
 * Fehlversuchs-Bremse je IP. Nach `maxFails` Versuchen ist die IP für
 * `lockoutMs` gesperrt; jeder weitere Fehlversuch in der Sperre verlängert sie
 * (gedeckelt auf das 8-fache). Ein erfolgreicher Login setzt alles zurück.
 */
class LoginGuard {
  constructor({ maxFails = 8, lockoutMs = 10 * 60000 } = {}) {
    this.maxFails = maxFails;
    this.lockoutMs = lockoutMs;
    this.map = new Map();               // ip -> { fails, until }
  }

  configure({ maxFails, lockoutMs }) {
    if (Number.isFinite(maxFails)) this.maxFails = maxFails;
    if (Number.isFinite(lockoutMs)) this.lockoutMs = lockoutMs;
  }

  /** Verbleibende Sperrzeit in ms (0 = frei). */
  lockedFor(ip) {
    const e = this.map.get(ip);
    if (!e || !e.until) return 0;
    const left = e.until - Date.now();
    if (left <= 0) { e.until = 0; e.fails = 0; return 0; }
    return left;
  }

  fail(ip) {
    if (this.map.size > 2000) this.map.clear();
    const e = this.map.get(ip) || { fails: 0, until: 0 };
    e.fails++;
    if (e.fails >= this.maxFails) {
      const over = e.fails - this.maxFails;
      e.until = Date.now() + Math.min(this.lockoutMs * (1 + over), this.lockoutMs * 8);
    }
    this.map.set(ip, e);
    return e;
  }

  succeed(ip) { this.map.delete(ip); }
}

/**
 * Ein einzelner Wiederherstellungs-Code („Passwort vergessen").
 *
 * Gedacht für den Hallen-PC ohne Monitor und ohne SSH: der Code geht über den
 * eingerichteten Benachrichtigungskanal raus (Discord/ntfy/Mail), nur wer den
 * bekommt, kann das Passwort neu setzen. Bis dahin bleibt das alte gültig —
 * wer den Knopf drückt, sperrt damit also niemanden aus.
 *
 * Es gibt immer höchstens einen offenen Code; ein neuer ersetzt den alten.
 */
class RecoveryCode {
  constructor({ ttlMs = 15 * 60000, cooldownMs = 2 * 60000 } = {}) {
    this.ttlMs = ttlMs;
    this.cooldownMs = cooldownMs;
    this.current = null;            // { hash, exp }
    this.lastIssued = 0;
  }

  static _hash(code) {
    return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest();
  }

  /** ms bis der nächste Code angefordert werden darf (0 = jetzt). */
  cooldownLeft() {
    const left = this.lastIssued + this.cooldownMs - Date.now();
    return left > 0 ? left : 0;
  }

  issue() {
    const code = generatePassword(3, 4).toUpperCase();
    this.current = { hash: RecoveryCode._hash(code), exp: Date.now() + this.ttlMs };
    this.lastIssued = Date.now();
    return { code, expiresAt: this.current.exp };
  }

  /** Prüft zeitkonstant und verbraucht den Code bei Erfolg. */
  consume(code) {
    const c = this.current;
    if (!c) return false;
    if (c.exp <= Date.now()) { this.current = null; return false; }
    const got = RecoveryCode._hash(code || '');
    const ok = got.length === c.hash.length && crypto.timingSafeEqual(got, c.hash);
    if (ok) this.current = null;
    return ok;
  }

  clear() { this.current = null; }
  get pending() { return !!(this.current && this.current.exp > Date.now()); }
}

/** `cookie:`-Header -> Objekt. Unbekanntes/kaputtes wird still übersprungen. */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

module.exports = {
  hashPassword, hashPasswordSync, verifyPassword, isHash,
  generatePassword, passwordProblem, MIN_PASSWORD_LENGTH,
  SessionStore, LoginGuard, RecoveryCode, parseCookies,
};
