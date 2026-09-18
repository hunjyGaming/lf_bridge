'use strict';

const net = require('net');
const tls = require('tls');
const os = require('os');

/**
 * Winziger SMTP-Client — genug, um eine Statusmail zu verschicken.
 *
 * Bewusst ohne Abhängigkeit (das Projekt hängt sonst nur an `ws`): EHLO,
 * optional STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA/QUIT. Kein Anhang, kein
 * Pooling, kein Retry — genau ein kurzer Text pro Aufruf.
 *
 *   port 465  -> secure: true   (implizites TLS)
 *   port 587  -> secure: false  (Klartext-Verbindung, dann STARTTLS)
 *   port 25   -> secure: false  (STARTTLS, falls der Server es anbietet)
 */

const CRLF = '\r\n';

class SmtpError extends Error {
  constructor(message, code) { super(message); this.name = 'SmtpError'; this.code = code || 0; }
}

/** Liest zeilenweise und löst je Kommando genau eine vollständige SMTP-Antwort auf. */
class Conn {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.pending = null;          // { resolve, reject, timer }
    this.closed = false;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs);
    this._onData = (chunk) => { this.buf += chunk; this._drain(); };
    this._onErr = (err) => this._fail(new SmtpError(err.message));
    this._onEnd = () => { this.closed = true; this._fail(new SmtpError('Verbindung vom Server beendet')); };
    this._onTimeout = () => { try { socket.destroy(); } catch {} this._fail(new SmtpError('Zeitüberschreitung')); };
    socket.on('data', this._onData);
    socket.on('error', this._onErr);
    socket.on('end', this._onEnd);
    socket.on('timeout', this._onTimeout);
  }

  detach() {
    const s = this.socket;
    s.removeListener('data', this._onData);
    s.removeListener('error', this._onErr);
    s.removeListener('end', this._onEnd);
    s.removeListener('timeout', this._onTimeout);
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  _fail(err) {
    const p = this.pending;
    this.pending = null;
    if (p) { clearTimeout(p.timer); p.reject(err); }
  }

  /**
   * Eine Antwort besteht aus Zeilen `NNN-text` (weitere folgen) und endet mit
   * `NNN text`. Erst dann ist das Kommando beantwortet.
   */
  _drain() {
    if (!this.pending) return;
    const lines = this.buf.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!/^\d{3}[ -]/.test(line)) continue;
      if (line[3] === '-') continue;                 // Zwischenzeile
      const consumed = lines.slice(0, i + 1);
      this.buf = lines.slice(i + 1).join(CRLF);
      const code = parseInt(line.slice(0, 3), 10);
      const text = consumed.map((l) => l.slice(4)).join('\n');
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      return p.resolve({ code, text });
    }
  }

  /** Antwort abwarten (ohne etwas zu senden) — für die Begrüßung. */
  read() {
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new SmtpError('interner Fehler: doppelte Leseanforderung'));
      const timer = setTimeout(() => { this.pending = null; reject(new SmtpError('Zeitüberschreitung beim Warten auf den Server')); }, this.timeoutMs);
      this.pending = { resolve, reject, timer };
      this._drain();
    });
  }

  /**
   * Ein Kommando senden und genau eine Antwort abwarten.
   *
   * `label` ist das, was im Fehlertext steht. Ohne Angabe ist es das erste Wort
   * der Zeile — das reicht für `EHLO`, `MAIL FROM`, `DATA`. Bei `AUTH LOGIN`
   * IST die ganze Zeile aber der base64-kodierte Benutzername bzw. das
   * base64-kodierte Passwort; dort MUSS ein Label mitgegeben werden, sonst
   * stünde das Passwort im Klartext-Äquivalent in der Fehlermeldung — und die
   * landet über notify.last im Log, in /api/status und in /api/network.
   */
  async cmd(line, { expect, label } = {}) {
    if (this.closed) throw new SmtpError('Verbindung geschlossen');
    this.socket.write(line + CRLF);
    const res = await this.read();
    if (expect && !expect.includes(res.code)) {
      throw new SmtpError(`${label || line.split(' ')[0]} -> ${res.code} ${res.text.split('\n')[0]}`, res.code);
    }
    return res;
  }

  write(raw) { this.socket.write(raw); }
  close() { try { this.socket.destroy(); } catch {} }
}

function connect({ host, port, secure, timeoutMs, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port };
    const socket = secure
      ? tls.connect({ ...opts, servername: host, rejectUnauthorized })
      : net.connect(opts);
    const onErr = (err) => { socket.destroy(); reject(new SmtpError(`Verbindung zu ${host}:${port} fehlgeschlagen — ${err.message}`)); };
    const onTimeout = () => { socket.destroy(); reject(new SmtpError(`Zeitüberschreitung beim Verbinden zu ${host}:${port}`)); };
    socket.once('error', onErr);
    socket.setTimeout(timeoutMs, onTimeout);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.removeListener('error', onErr);
      socket.removeListener('timeout', onTimeout);
      resolve(socket);
    });
  });
}

/** Header-Wert RFC-2047-kodieren, sobald etwas außerhalb von ASCII vorkommt. */
function encodeHeader(value) {
  const v = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7e]/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** Nur eine Adresse, keine Steuerzeichen — schützt die Kopfzeilen vor Injection. */
function cleanAddress(a) {
  return String(a ?? '').replace(/[\r\n<>,;]/g, '').trim();
}

function buildMessage({ from, to, subject, text }) {
  const body = Buffer.from(String(text ?? ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1' + CRLF);
  const headers = [
    `From: ${cleanAddress(from)}`,
    `To: ${to.map(cleanAddress).join(', ')}`,
    `Subject: ${encodeHeader(String(subject ?? '').replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${os.hostname()}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ];
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF;
}

/** Zeilen, die mit "." beginnen, verdoppeln — sonst endet die Mail zu früh. */
function dotStuff(msg) {
  return msg.replace(/\r?\n\./g, CRLF + '..');
}

/**
 * Verschickt genau eine Textmail.
 * @returns {Promise<{ok:true, code:number, response:string}>}
 */
async function sendMail({
  host, port = 587, secure = false, user = '', pass = '',
  from, to, subject, text,
  timeoutMs = 15000, rejectUnauthorized = true, clientName = os.hostname(),
}) {
  if (!host) throw new SmtpError('SMTP-Host fehlt');
  const rcpts = (Array.isArray(to) ? to : String(to || '').split(',')).map(cleanAddress).filter(Boolean);
  if (!rcpts.length) throw new SmtpError('kein Empfänger');
  const sender = cleanAddress(from || user || `lf-live@${os.hostname()}`);

  const socket = await connect({ host, port, secure, timeoutMs, rejectUnauthorized });
  const conn = new Conn(socket, timeoutMs);
  try {
    await conn.read();                                       // 220 Begrüßung
    let ehlo = await conn.cmd(`EHLO ${clientName}`, { expect: [250] });

    if (!secure && /\bSTARTTLS\b/i.test(ehlo.text)) {
      await conn.cmd('STARTTLS', { expect: [220] });
      const plain = conn.socket;
      conn.detach();
      const upgraded = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: plain, servername: host, rejectUnauthorized }, () => resolve(t));
        t.once('error', (err) => reject(new SmtpError(`STARTTLS fehlgeschlagen — ${err.message}`)));
      });
      conn.attach(upgraded);
      ehlo = await conn.cmd(`EHLO ${clientName}`, { expect: [250] });
    }

    if (user) {
      const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
      if (/AUTH[^\n]*\bPLAIN\b/i.test(ehlo.text)) {
        await conn.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, { expect: [235], label: 'AUTH PLAIN' });
      } else if (/AUTH[^\n]*\bLOGIN\b/i.test(ehlo.text)) {
        await conn.cmd('AUTH LOGIN', { expect: [334] });
        await conn.cmd(b64(user), { expect: [334], label: 'AUTH LOGIN (Benutzer)' });
        await conn.cmd(b64(pass), { expect: [235], label: 'AUTH LOGIN (Passwort)' });
      } else {
        throw new SmtpError('Server bietet weder AUTH PLAIN noch AUTH LOGIN an');
      }
    }

    await conn.cmd(`MAIL FROM:<${sender}>`, { expect: [250] });
    for (const r of rcpts) await conn.cmd(`RCPT TO:<${r}>`, { expect: [250, 251] });
    await conn.cmd('DATA', { expect: [354] });
    conn.write(dotStuff(buildMessage({ from: sender, to: rcpts, subject, text })));
    const done = await conn.cmd('.', { expect: [250] });
    try { await conn.cmd('QUIT'); } catch {}
    return { ok: true, code: done.code, response: done.text.split('\n')[0] };
  } finally {
    conn.close();
  }
}

module.exports = { sendMail, SmtpError, buildMessage, encodeHeader };
