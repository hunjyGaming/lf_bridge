'use strict';

const crypto = require('crypto');
const { sendMail } = require('./smtp');
const { reachability, addressSummary } = require('./netinfo');

/**
 * Betriebs-Benachrichtigungen — „auf welcher IP und welchem Port läuft die
 * Kiste gerade?", ohne Monitor am Hallen-PC.
 *
 * Kanäle (alle optional, alle über .env, jeweils EINE Zeile):
 *   Discord   LF_NOTIFY_DISCORD_WEBHOOK=https://discord.com/api/webhooks/…
 *   ntfy      LF_NOTIFY_NTFY_TOPIC=lf-live-halle        (Push aufs Handy, kein Konto)
 *   Telegram  LF_NOTIFY_TELEGRAM_TOKEN= + LF_NOTIFY_TELEGRAM_CHAT_ID=
 *   Slack     LF_NOTIFY_SLACK_WEBHOOK=https://hooks.slack.com/services/…
 *   Webhook   LF_NOTIFY_WEBHOOK_URL=…                   (eigenes JSON, optional HMAC)
 *   E-Mail    LF_NOTIFY_EMAIL_TO= + LF_NOTIFY_SMTP_HOST/USER/PASS
 *
 * Ausgelöst wird: einmal beim Start und danach, wenn sich die IP-Adressen
 * ändern (DHCP-Lease, Kabel umgesteckt). Fehler beim Senden werden geloggt und
 * sonst ignoriert — eine kaputte Benachrichtigung darf den Dienst nie aufhalten.
 */

const HTTP_TIMEOUT_MS = 10000;
const DISCORD_LIMIT = 1900;

class Notifier {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;
    this.last = [];                 // Ergebnis des letzten Sendevorgangs
    this.lastAt = 0;
  }

  get cfg() { return this.getConfig().notify || {}; }

  /** Name dieser Installation in der Nachricht. */
  label() {
    const n = (this.cfg.name || '').trim();
    return n || require('os').hostname();
  }

  /** Was ist tatsächlich konfiguriert? Wird in der Konsole angezeigt (ohne Secrets). */
  channels() {
    const c = this.cfg;
    const out = [];
    const host = (u) => { try { return new URL(u).host; } catch { return '—'; } };
    if (c.discordWebhook) out.push({ id: 'discord', label: 'Discord', target: host(c.discordWebhook) });
    if (c.slackWebhook) out.push({ id: 'slack', label: 'Slack', target: host(c.slackWebhook) });
    if (c.ntfy?.topic) out.push({ id: 'ntfy', label: 'ntfy', target: `${host(c.ntfy.server || 'https://ntfy.sh')}/${c.ntfy.topic}` });
    if (c.telegram?.botToken && c.telegram?.chatId) out.push({ id: 'telegram', label: 'Telegram', target: `Chat ${c.telegram.chatId}` });
    if (c.webhook?.url) out.push({ id: 'webhook', label: 'Webhook', target: host(c.webhook.url) });
    if (c.email?.to && c.email?.host) out.push({ id: 'email', label: 'E-Mail', target: c.email.to });
    return out;
  }

  /** Kann tatsächlich etwas rausgehen? (Kanal eingerichtet UND nicht abgeschaltet) */
  get configured() { return this.cfg.enabled !== false && this.channels().length > 0; }

  // ---- Nachrichten ----

  /**
   * Der Text, der beim Start rausgeht. `extra` hängt zusätzliche Zeilen an
   * (z. B. das generierte Erst-Passwort).
   */
  startupMessage(extra = []) {
    const cfg = this.getConfig();
    const r = reachability(cfg);
    const lines = [];

    const main = primaryUrl(r);
    lines.push(`Konsole:  ${main}`);
    const rest = r.urls.filter((u) => u !== main);
    if (rest.length) lines.push(`weitere:  ${rest.join('   ')}`);
    lines.push('');
    lines.push(`Rechner:      ${r.hostname}  (${r.platform})`);
    lines.push(`IP-Adressen:  ${addressSummary(r.addresses)}`);
    lines.push(`Web/API:      ${r.http.bind}:${r.http.port}${r.http.lanOpen ? '  (im ganzen LAN)' : '  (eingeschränkt)'}`);
    lines.push(`Laserforce:   ${r.tcp.bind}:${r.tcp.port}  (Log-Stream rein)`);
    if (r.stream.enabled) lines.push(`Raw-Stream:   ${r.stream.bind}:${r.stream.port}`);
    lines.push(`Zugang:       ${accessSummary(cfg)}`);
    for (const line of extra) lines.push(line);

    return {
      title: `LF Live gestartet — ${this.label()}`,
      text: lines.join('\n'),
      info: r,
    };
  }

  /**
   * Wiederherstellungs-Code („Passwort vergessen"). Geht denselben Weg wie die
   * Startnachricht — auf einem Rechner ohne Monitor und ohne Shell ist das die
   * einzige Stelle, an der so ein Code ankommen kann.
   */
  recoveryMessage(code, expiresAt) {
    const r = reachability(this.getConfig());
    const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
    const text = [
      'Jemand hat für die LF-Live-Konsole ein neues Passwort angefordert.',
      '',
      `Code:     ${code}`,
      `gültig:   ${mins} Minuten`,
      `Konsole:  ${primaryUrl(r)}`,
      '',
      'Auf der Anmeldeseite "Passwort vergessen" wählen, den Code eingeben und',
      'ein neues Passwort setzen. Bis dahin gilt das alte Passwort weiter.',
      'Warst du das nicht? Dann einfach ignorieren — der Code läuft ab.',
    ].join('\n');
    return { title: `LF Live — Wiederherstellungs-Code für ${this.label()}`, text, priority: 'high', tag: 'key' };
  }

  /** Konsole läuft, aber noch niemand hat ein Passwort vergeben. */
  setupMessage() {
    const r = reachability(this.getConfig());
    const text = [
      'Die Konsole wartet auf die Einrichtung — es ist noch kein Admin-Passwort gesetzt.',
      '',
      `Einrichten:   ${primaryUrl(r).replace(/\/$/, '')}/setup`,
      `IP-Adressen:  ${addressSummary(r.addresses)}`,
      '',
      'Bis dahin ist die Konsole gesperrt: außer der Einrichtungsseite geht nichts.',
    ].join('\n');
    return { title: `LF Live — Einrichtung offen auf ${this.label()}`, text, priority: 'high', tag: 'warning' };
  }

  ipChangeMessage() {
    const cfg = this.getConfig();
    const r = reachability(cfg);
    const text = [
      `Die IP-Adresse dieses Rechners hat sich geändert.`,
      '',
      `Konsole:      ${primaryUrl(r)}`,
      `IP-Adressen:  ${addressSummary(r.addresses)}`,
      `Web/API:      ${r.http.bind}:${r.http.port}`,
    ].join('\n');
    return { title: `LF Live — neue IP auf ${this.label()}`, text, info: r };
  }

  // ---- Versand ----

  /**
   * An alle konfigurierten Kanäle schicken. Löst nie aus (jeder Kanal wird
   * einzeln abgefangen) und liefert je Kanal ein Ergebnis.
   */
  async send({ title, text, info = null, priority = 'default', tag = 'rocket' }) {
    if (this.cfg.enabled === false) return [];
    const chans = this.channels();
    if (!chans.length) return [];

    const jobs = chans.map(async (ch) => {
      try {
        await this._sendTo(ch.id, { title, text, info, priority, tag });
        return { id: ch.id, label: ch.label, ok: true, detail: 'gesendet', at: Date.now() };
      } catch (err) {
        this.log?.warn('notify', `${ch.label}: ${err.message}`);
        return { id: ch.id, label: ch.label, ok: false, detail: err.message, at: Date.now() };
      }
    });

    const res = await Promise.all(jobs);
    this.last = res;
    this.lastAt = Date.now();
    const ok = res.filter((r) => r.ok).length;
    this.log?.info('notify', `Startinfo an ${ok}/${res.length} Kanal/Kanäle gesendet (${res.map((r) => r.label).join(', ')})`);
    return res;
  }

  /** Testnachricht — gleicher Inhalt wie beim Start, nur anders betitelt. */
  async test() {
    const m = this.startupMessage();
    return this.send({ ...m, title: `LF Live Test — ${this.label()}`, tag: 'white_check_mark' });
  }

  async _sendTo(id, msg) {
    const c = this.cfg;
    switch (id) {
      case 'discord': return this._discord(c.discordWebhook, msg);
      case 'slack': return this._slack(c.slackWebhook, msg);
      case 'ntfy': return this._ntfy(c.ntfy, msg);
      case 'telegram': return this._telegram(c.telegram, msg);
      case 'webhook': return this._webhook(c.webhook, msg);
      case 'email': return this._email(c.email, msg);
      default: throw new Error(`unbekannter Kanal ${id}`);
    }
  }

  // ---- einzelne Kanäle ----

  async _discord(url, { title, text }) {
    const body = `**${title}**\n\`\`\`\n${clip(text, DISCORD_LIMIT)}\n\`\`\``;
    await postJson(url, { content: body, username: 'LF Live', allowed_mentions: { parse: [] } });
  }

  async _slack(url, { title, text }) {
    await postJson(url, { text: `*${title}*\n\`\`\`${clip(text, 3000)}\`\`\`` });
  }

  async _ntfy(conf, { title, text, priority, tag }) {
    const server = String(conf.server || 'https://ntfy.sh').replace(/\/+$/, '');
    const url = `${server}/${encodeURIComponent(conf.topic)}`;
    const headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      // ntfy-Header sind ASCII — Umlaute werden hier transliteriert, der Body bleibt UTF-8.
      Title: asciiHeader(title),
      Tags: tag,
      Priority: String(priority === 'high' ? 4 : 3),
    };
    if (conf.token) headers.Authorization = `Bearer ${conf.token}`;
    await fetchOk(url, { method: 'POST', headers, body: text });
  }

  async _telegram(conf, { title, text }) {
    const url = `https://api.telegram.org/bot${conf.botToken}/sendMessage`;
    await postJson(url, {
      chat_id: conf.chatId,
      text: `${title}\n\n${clip(text, 3500)}`,
      disable_web_page_preview: true,
    });
  }

  async _webhook(conf, { title, text, info }) {
    const payload = { service: 'lf-live', event: 'status', ts: Date.now(), title, text, info };
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'lf-live/1.0' };
    if (conf.secret) {
      const ts = String(payload.ts);
      headers['X-LFB-Timestamp'] = ts;
      headers['X-LFB-Signature'] = 'sha256=' + crypto.createHmac('sha256', conf.secret).update(`${ts}.${body}`).digest('hex');
    }
    await fetchOk(conf.url, { method: 'POST', headers, body });
  }

  async _email(conf, { title, text }) {
    await sendMail({
      host: conf.host,
      port: conf.port || 587,
      secure: !!conf.secure,
      user: conf.user || '',
      pass: conf.pass || '',
      from: conf.from || conf.user,
      to: conf.to,
      subject: title,
      text,
      rejectUnauthorized: conf.rejectUnauthorized !== false,
    });
  }
}

// ---- Helfer ----

/** Die Adresse, die man jemandem nennt — LAN vor localhost. */
function primaryUrl(r) {
  return r.urls.find((u) => !u.includes('localhost')) || r.urls[0] || '';
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** Umlaute/Sonderzeichen für Header, die nur ASCII vertragen (ntfy Title). */
function asciiHeader(s) {
  return String(s ?? '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 200) || 'LF Live';
}

async function fetchOk(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ` — ${clip(body.replace(/\s+/g, ' '), 160)}` : ''}`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Zeitüberschreitung nach ${HTTP_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function postJson(url, obj) {
  return fetchOk(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'lf-live/1.0' },
    body: JSON.stringify(obj),
  });
}

/** Einzeiler „wie kommt man rein" für die Startnachricht. */
function accessSummary(cfg) {
  const login = cfg.admin?.enabled !== false && !!cfg.admin?.passwordHash;
  const token = !!cfg.apiToken;
  if (login && token) return 'Admin-Passwort (Konsole) + API-Token';
  if (login) return 'Admin-Passwort erforderlich';
  if (token) return 'API-Token erforderlich';
  return 'OFFEN — kein Passwort gesetzt!';
}

module.exports = { Notifier, accessSummary, asciiHeader };
