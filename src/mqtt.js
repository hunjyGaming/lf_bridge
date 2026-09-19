'use strict';

const os = require('os');
const { mqttCredentials } = require('./config');

/**
 * MQTT out — the bridge to the FunZone location server (docs/MQTT.md).
 *
 * The location server runs a local broker and subscribes to exactly ONE topic,
 * `/decs/lfpassthrough`, and forwards whatever arrives there 1:1 to the online
 * broker under `location/<LOCATION_ID>/LFstatus` (QoS 1, retain false). That is
 * the whole contract; we are the publisher on the local side.
 *
 * Two properties of the other side shape this module and are NOT bugs on our
 * side (both are written up in docs/MQTT.md):
 *
 *   1. It subscribes to the literal topic, no wildcard, and its message handler
 *      additionally does `if (topic !== LOCAL_TOPIC) return;`. A sub-topic such
 *      as `/decs/lfpassthrough/match_start` therefore NEVER reaches it. Hence
 *      `topicSuffixes` defaults to FALSE: everything goes to the base topic and
 *      the payload's `event` field tells the messages apart.
 *   2. Its allowlist check compares the ENTIRE payload string against
 *      `LF_PASSTHROUGH_EVENTS` (its `extractEventName()` is dead code). With a
 *      named allowlist nothing of ours can ever match; only `*` lets us
 *      through. We deliberately do not work around that — see docs/MQTT.md.
 *
 * Rules this module lives by:
 *   · OFF by default. Switched off it costs one property read per call.
 *   · It must never block, delay or crash the TDF parser. Every public method
 *     swallows its own errors; nothing here is awaited by the engine path.
 *   · Publishing is subordinate to parsing. We only hand a message to the
 *     client while it is actually connected; otherwise it is dropped and
 *     COUNTED, or — if `queueMax` was raised — parked in a BOUNDED buffer whose
 *     oldest entry falls out first. Never memory that grows without limit.
 *   · TRANSPORT, not delivery guarantee. `publish()` returns true only when a
 *     message really went to a connected broker, so a caller with a durable
 *     queue (src/matchReport.js) keeps its copy when it did not. Delivery is
 *     at-least-once; the receiving side deduplicates on `matchId`.
 *   · No broker running is a normal state, not an emergency: one message, then
 *     quiet, ordered reconnect attempts.
 *   · Credentials come from the environment only (see `mqttCredentials()` in
 *     src/config.js). They are never part of `config.json`, never logged and
 *     never in `status()`. A URL carrying userinfo is redacted everywhere.
 */

/** How long the same connection error stays quiet before it is logged again. */
const ERROR_QUIET_MS = 5 * 60 * 1000;

/** Payload schema marker — consumers can branch on it if we ever change shape. */
const SCHEMA = 'lf-bridge/mqtt/1';

class MqttOut {
  constructor({ logger, getConfig }) {
    this.log = logger;
    this.getConfig = getConfig;

    this._client = null;
    this._connected = false;
    this._applied = null;       // JSON of the settings the current client was built from
    this._stopped = false;

    /** Bounded outbound queue: [{ topic, body, qos, retain }] — oldest first. */
    this._queue = [];

    /** Wall-clock start of the match we announced, so match_end can measure it. */
    this._startedAt = null;
    this._startedMatchId = null;

    this._stats = {
      published: 0,     // handed to a connected broker
      confirmed: 0,     // PUBACK seen (QoS 1/2) resp. written (QoS 0)
      unconfirmed: 0,   // handed over but the confirmation came back as an error
      dropped: 0,       // could not be handed over at all
      queued: 0,        // currently parked in the memory buffer
      errors: 0,
      connects: 0,
      lastPublishAt: null,
      lastError: null,
      lastErrorAt: null,
    };
    this._errQuiet = { message: null, at: 0, suppressed: 0 };
  }

  // ─── configuration ────────────────────────────────────────────────────────

  get cfg() {
    const c = this.getConfig();
    return (c && c.mqtt) || {};
  }

  get enabled() {
    return this.cfg.enabled === true;
  }

  /** Base topic, trailing slashes trimmed. */
  get baseTopic() {
    return String(this.cfg.topic || '/decs/lfpassthrough').replace(/\/+$/, '') || '/decs/lfpassthrough';
  }

  /**
   * Where a message with this suffix goes. With `topicSuffixes: false` (the
   * default, and the only setting the location server can actually receive)
   * every message lands on the base topic and is told apart by `event`.
   */
  topicFor(suffix) {
    if (!suffix || this.cfg.topicSuffixes !== true) return this.baseTopic;
    return `${this.baseTopic}/${String(suffix).replace(/^\/+/, '')}`;
  }

  /** Topic for online/offline (last will). Empty setting = the data topic. */
  get statusTopic() {
    const t = String(this.cfg.statusTopic || '').trim().replace(/\/+$/, '');
    return t || this.baseTopic;
  }

  /** The configured placeholder duration — never a measurement. */
  _defaultDurationMs() {
    try {
      const c = this.getConfig();
      const v = c && c.match && c.match.defaultDurationMs;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  }

  /** Name this installation announces itself under. */
  get name() {
    const c = this.getConfig();
    return (c && c.notify && c.notify.name) || os.hostname();
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Called once at boot and after every config change. Builds, rebuilds or
   * tears down the client. Never throws.
   */
  reconcile() {
    try {
      if (this._stopped) return;
      if (!this.enabled) {
        if (this._client) {
          this.log?.info('mqtt', 'ausgeschaltet — Verbindung wird getrennt');
          this._teardown();
        }
        return;
      }
      const want = this._signature();
      if (this._client && this._applied === want) return;
      if (this._client) {
        this.log?.info('mqtt', 'Einstellungen geändert — Verbindung wird neu aufgebaut');
        this._teardown();
      }
      this._applied = want;
      this._connect();
    } catch (err) {
      this._noteError(`reconcile: ${err.message}`);
    }
  }

  /** Everything a running client would have to be rebuilt for. */
  _signature() {
    const c = this.cfg;
    const cred = safeCredentials();
    return JSON.stringify([
      c.url, this.baseTopic, this.statusTopic, c.qos, c.retain, c.clientId,
      c.reconnectSeconds, c.tlsInsecure, c.publishStatus,
      // only whether credentials exist, never their value
      !!cred.username, !!cred.password,
    ]);
  }

  _connect() {
    let mqtt;
    try {
      // Required lazily on purpose: a missing/broken `mqtt` package must not
      // keep the whole bridge from starting. The TDF path does not need it.
      mqtt = require('mqtt');
    } catch (err) {
      this._noteError(`Paket "mqtt" nicht ladbar (${err.message}) — MQTT bleibt aus, alles andere läuft weiter`);
      return;
    }

    const c = this.cfg;
    const url = String(c.url || '').trim();
    if (!url) {
      this._noteError('keine Broker-Adresse gesetzt (LF_MQTT_URL / mqtt.url) — MQTT bleibt aus');
      return;
    }

    const cred = safeCredentials();
    const options = {
      clientId: String(c.clientId || '').trim() || `lf-bridge-${os.hostname()}-${Math.random().toString(16).slice(2, 8)}`.slice(0, 96),
      clean: true,
      reconnectPeriod: Math.max(1000, Math.round((Number(c.reconnectSeconds) || 5) * 1000)),
      connectTimeout: 10000,
      // Our own bounded queue is the only buffer. Without this, mqtt.js would
      // grow an unbounded in-memory store while the broker is away — exactly
      // what must not happen on an unattended hall PC.
      queueQoS0: false,
    };
    if (cred.username) options.username = cred.username;
    if (cred.password) options.password = cred.password;
    if (c.tlsInsecure === true) options.rejectUnauthorized = false;

    // Last will — same spirit as the location server's own bridge: a plain
    // status message on the status topic, QoS 1, not retained, so our death is
    // visible on the other side instead of silently looking like "no games".
    if (c.publishStatus !== false) {
      options.will = {
        topic: this.statusTopic,
        payload: JSON.stringify(this._statusPayload('offline', 'last_will')),
        qos: this._qos(),
        retain: false,
      };
    }

    try {
      this._client = mqtt.connect(url, options);
    } catch (err) {
      this._client = null;
      this._noteError(`Verbindung nicht aufbaubar: ${err.message}`);
      return;
    }

    this.log?.info('mqtt', `Broker ${redactUrl(url)} · Topic ${this.baseTopic} · QoS ${this._qos()}`);

    this._client.on('connect', () => {
      this._connected = true;
      this._stats.connects += 1;
      this._errQuiet = { message: null, at: 0, suppressed: 0 };
      this.log?.info('mqtt', `verbunden mit ${redactUrl(url)}`);
      if (this.cfg.publishStatus !== false) {
        this._enqueue(this.statusTopic, JSON.stringify(this._statusPayload('online', 'connect')));
      }
      this._flush();
    });

    this._client.on('reconnect', () => {
      // Deliberately debug: this fires every `reconnectPeriod` while a broker
      // is down and would otherwise fill the log of an unattended PC.
      this.log?.debug?.('mqtt', 'Wiederverbindungsversuch');
    });

    this._client.on('close', () => {
      if (this._connected) this.log?.warn('mqtt', 'Verbindung geschlossen — es wird weiter versucht');
      this._connected = false;
    });

    this._client.on('offline', () => { this._connected = false; });

    this._client.on('error', (err) => {
      this._connected = false;
      this._noteError(err && (err.code || err.message) ? (err.code || err.message) : String(err));
    });
  }

  _teardown() {
    const client = this._client;
    this._client = null;
    this._connected = false;
    if (!client) return;
    try { client.removeAllListeners(); } catch {}
    try { client.end(true); } catch {}
  }

  /**
   * Orderly shutdown: say goodbye ourselves (the will only fires on an
   * ungraceful death) and close. Best effort and time-boxed — the shutdown
   * path in src/index.js must not wait on a broker that is not there.
   */
  stop() {
    this._stopped = true;
    const client = this._client;
    if (!client) return;
    try {
      if (this._connected && this.cfg.publishStatus !== false) {
        client.publish(this.statusTopic, JSON.stringify(this._statusPayload('offline', 'shutdown')), { qos: this._qos(), retain: false });
      }
    } catch {}
    this._client = null;
    this._connected = false;
    try { client.removeAllListeners(); } catch {}
    try { client.end(false, {}, () => {}); } catch { try { client.end(true); } catch {} }
  }

  // ─── publishing ───────────────────────────────────────────────────────────

  _qos() {
    const q = parseInt(this.cfg.qos, 10);
    return q === 0 || q === 1 || q === 2 ? q : 1;
  }

  /**
   * THE interface for everything that is not a round start/end — the mission
   * report is published through exactly this call:
   *
   *     mqtt.publish(payload, topicSuffix)
   *
   * @param {object} payload      a finished object; it is JSON-serialized as-is.
   *                              If it carries no `event`, the `topicSuffix` is
   *                              used as the event name so the receiving side
   *                              can tell messages apart on the shared topic.
   * @param {string} [topicSuffix] appended to the base topic ONLY when
   *                              `mqtt.topicSuffixes` is on; otherwise it just
   *                              names the event. May be omitted.
   * @param {function} [onAck]    optional: called as `onAck(err)` once the
   *                              broker has CONFIRMED the message (PUBACK at
   *                              QoS 1/2). At QoS 0 there is nothing to confirm
   *                              and it fires right after the write. Purely
   *                              additive — existing callers ignore it.
   * @returns {boolean}           **true only when the message was handed to a
   *                              CONNECTED broker.** Anything else is false:
   *                              MQTT off, no connection, unusable payload,
   *                              write error — and also a message that merely
   *                              went into the local memory buffer.
   *
   * WHY `false` FOR A BUFFERED MESSAGE, and this is the whole point of the
   * return value: the memory buffer does not survive a restart. Reporting
   * "taken" for something that a power cut would erase would make a caller with
   * a DISK queue (src/matchReport.js) throw away its only durable copy. So the
   * honest answer to "could you take it?" is no unless it really went out.
   * Transport is this module's job; RETENTION belongs to the caller that has a
   * disk queue. The buffer is a bonus for installations without one, never a
   * promise — hence `queueMax` defaults to 0.
   *
   * Delivery is explicitly AT LEAST ONCE. The receiving side deduplicates on
   * `matchId`, so a caller may safely retry a message that returned false even
   * if it turns out to have arrived after all.
   *
   * Never throws. A caller on the engine path can ignore the return value.
   */
  publish(payload, topicSuffix, onAck) {
    try {
      if (!this.enabled) return false;
      if (!payload || typeof payload !== 'object') return false;
      const envelope = this._envelope(payload, topicSuffix);
      let body;
      try { body = JSON.stringify(envelope); }
      catch (err) { this._noteError(`Nutzlast nicht serialisierbar: ${err.message}`); return false; }
      return this._enqueue(this.topicFor(topicSuffix), body, onAck);
    } catch (err) {
      this._noteError(`publish: ${err.message}`);
      return false;
    }
  }

  /**
   * Common header. `event` is set from the payload, else from the topic suffix.
   * `type` carries the same value: the location server's (unused) event
   * extractor reads `event` first and `type` second, so a fixed location server
   * works with either — see docs/MQTT.md.
   */
  _envelope(payload, topicSuffix) {
    const now = Date.now();
    const event = typeof payload.event === 'string' && payload.event
      ? payload.event
      : (typeof payload.type === 'string' && payload.type ? payload.type : (topicSuffix ? String(topicSuffix) : 'lf_message'));
    return {
      schema: SCHEMA,
      ...payload,
      // the header wins over whatever the payload happened to carry
      event,
      type: event,
      service: 'lf-live',
      name: this.name,
      ts: now,
      iso: new Date(now).toISOString(),
    };
  }

  /** Online/offline notice — the counterpart of the last will. */
  _statusPayload(status, cause) {
    const now = Date.now();
    return {
      schema: SCHEMA,
      event: status === 'online' ? 'bridge_online' : 'bridge_offline',
      type: status === 'online' ? 'bridge_online' : 'bridge_offline',
      service: 'lf-live',
      name: this.name,
      status,
      cause,
      ts: now,
      iso: new Date(now).toISOString(),
    };
  }

  /**
   * Hand a finished message to the client, or park it in the bounded buffer.
   * Returns TRUE only for the first case — see `publish()` for why.
   *
   * We only call `client.publish()` while the client reports `connected`.
   * mqtt.js would otherwise pile QoS>0 messages up in an unbounded in-memory
   * store; a broker that stays away for a whole event evening would then eat
   * the hall PC's memory. Our buffer has a hard ceiling instead: when it is
   * full the OLDEST message is thrown away (the newest match state is the
   * interesting one) and `dropped` counts it — visible in getStatus(). With the
   * default `queueMax: 0` there is no buffer at all and nothing can grow.
   */
  _enqueue(topic, body, onAck) {
    const qos = this._qos();
    const retain = this.cfg.retain === true;
    const client = this._client;

    if (client && this._connected) {
      try {
        client.publish(topic, body, { qos, retain }, (err) => {
          // QoS 1/2: this is the PUBACK. QoS 0: fires right after the write —
          // the protocol has no confirmation there, and `true` then means no
          // more than "written to the socket".
          if (err) { this._stats.unconfirmed += 1; this._noteError(`publish: ${err.message}`); }
          else this._stats.confirmed += 1;
          if (typeof onAck === 'function') { try { onAck(err || null); } catch {} }
        });
        this._stats.published += 1;
        this._stats.lastPublishAt = Date.now();
        return true;
      } catch (err) {
        this._stats.dropped += 1;
        this._noteError(`publish: ${err.message}`);
        return false;
      }
    }

    const max = clampInt(this.cfg.queueMax, 0, 0, 10000);
    if (max <= 0) {
      this._stats.dropped += 1;
      if (typeof onAck === 'function') { try { onAck(new Error('keine Broker-Verbindung')); } catch {} }
      return false;
    }
    this._queue.push({ topic, body, qos, retain });
    while (this._queue.length > max) {
      this._queue.shift();
      this._stats.dropped += 1;
      if (this._stats.dropped === 1 || this._stats.dropped % 100 === 0) {
        this.log?.warn('mqtt', `Puffer voll (${max}) — ${this._stats.dropped} Nachricht(en) verworfen; der Broker ist nicht erreichbar`);
      }
    }
    this._stats.queued = this._queue.length;
    // Parked, not delivered. The caller must keep its own copy.
    return false;
  }

  /** Send everything that piled up while the broker was away. */
  _flush() {
    if (!this._client || !this._connected || !this._queue.length) return;
    const pending = this._queue;
    this._queue = [];
    this._stats.queued = 0;
    let sent = 0;
    for (const m of pending) {
      try {
        this._client.publish(m.topic, m.body, { qos: m.qos, retain: m.retain }, (err) => {
          if (err) { this._stats.unconfirmed += 1; this._noteError(`publish (Nachzügler): ${err.message}`); }
          else this._stats.confirmed += 1;
        });
        this._stats.published += 1;
        sent += 1;
      } catch (err) {
        this._noteError(`publish (Nachzügler): ${err.message}`);
        break;
      }
    }
    if (sent) {
      this._stats.lastPublishAt = Date.now();
      this.log?.info('mqtt', `${sent} zwischengespeicherte Nachricht(en) nachgereicht`);
    }
  }

  // ─── round start / round end ──────────────────────────────────────────────

  /**
   * Mission start — the operator's literal wish: "beim Starten einer Runde die
   * genaue Laufzeit per MQTT senden".
   *
   * THE POINT OF THIS WHOLE FUNCTION, and the reason it is not a two-liner:
   * `gameState.durationKnown === false` means the rig told us NOTHING about the
   * length of this game; `gameState.duration` is then merely the configured
   * placeholder (`match.defaultDurationMs`). A number like that, published in a
   * field called `durationMs`, would read on the other side exactly like a
   * measurement — and an invented duration that looks measured is worse than
   * no duration at all. So:
   *
   *   durationKnown === true   -> durationMs = the reported length,
   *                               durationSource = "arena"
   *   durationKnown === false  -> durationMs = null  (!),
   *                               durationSource = "unknown",
   *                               the placeholder rides along separately as
   *                               `configuredDurationMs` and is clearly not a
   *                               measurement.
   *
   * Three independent markers (`durationMs: null`, `durationKnown: false`,
   * `durationSource: "unknown"`) say the same thing, so no consumer can read
   * past it by accident. docs/MQTT.md spells this out.
   *
   * The type-1 mission line carries the duration and arrives BEFORE the `0100`
   * start code (engine contract C1), so at this moment the value is as good as
   * it will ever get.
   */
  publishMatchStart(snapshot) {
    try {
      if (!this.enabled || this.cfg.publishMatchStart === false) return false;
      const s = snapshot || {};
      const now = Date.now();
      this._startedAt = now;
      this._startedMatchId = s.matchId || null;

      const known = s.durationKnown === true;
      const reported = Number.isFinite(s.duration) ? s.duration : null;

      return this.publish({
        event: 'match_start',
        matchId: s.matchId || null,
        match: {
          matchId: s.matchId || null,
          startedAt: now,
          startedAtIso: new Date(now).toISOString(),
          // the length of the round as REPORTED, milliseconds — null when unknown
          durationMs: known ? reported : null,
          durationSeconds: known && reported != null ? Math.round(reported / 1000) : null,
          durationKnown: known,
          durationSource: known ? 'arena' : 'unknown',
          // The configured placeholder, straight from `match.defaultDurationMs`
          // — NEVER a measurement, and deliberately in a field of its own so it
          // can never be mistaken for one. Carried in both cases so a display
          // has something to show while `durationMs` is null.
          configuredDurationMs: this._defaultDurationMs(),
          mode: modeOf(s),
          missionDesc: s.missionDesc || null,
          teams: teamsOf(s),
          // HONEST, and worth knowing: the rig sends its entity lines (type 3)
          // AFTER the start code `0100`, and `0100` clears the roster. At this
          // instant the count is therefore normally 0 — not "nobody played".
          // `playersFinal: false` says so; the real size is in `match_end` and
          // in the mission report. Teams (type 2) DO arrive before `0100` and
          // are complete here.
          players: playerCount(s),
          playersFinal: false,
        },
      }, 'match_start');
    } catch (err) {
      this._noteError(`match_start: ${err.message}`);
      return false;
    }
  }

  /**
   * Mission end — the ACTUAL runtime plus why the match counts as over.
   *
   * `actualDurationMs` is the arena's own game clock (`elapsedTime`, column 1
   * of every in-game line, milliseconds) — that is the runtime that was really
   * played. `wallClockMs` is what this bridge measured between its own
   * match_start message and now; it is null when we joined mid-match, and it is
   * NOT a substitute for the arena clock, only a cross-check.
   *
   * `endReason` / `endSource` come straight from the engine (docs/LASERFORCE.md):
   * a `0101` from the rig and a watchdog end are very different statements and
   * must stay distinguishable downstream.
   */
  publishMatchEnd(snapshot) {
    try {
      if (!this.enabled || this.cfg.publishMatchEnd === false) return false;
      const s = snapshot || {};
      const endedAt = Number.isFinite(s.endedAt) ? s.endedAt : Date.now();
      const sameMatch = this._startedMatchId && s.matchId === this._startedMatchId;
      const wall = sameMatch && this._startedAt ? Math.max(0, endedAt - this._startedAt) : null;
      const known = s.durationKnown === true;
      const elapsed = Number.isFinite(s.elapsedTime) ? s.elapsedTime : null;

      const out = this.publish({
        event: 'match_end',
        matchId: s.matchId || null,
        match: {
          matchId: s.matchId || null,
          startedAt: sameMatch ? this._startedAt : null,
          endedAt,
          endedAtIso: new Date(endedAt).toISOString(),
          // the runtime that was actually played, milliseconds
          actualDurationMs: elapsed,
          actualDurationSeconds: elapsed == null ? null : Math.round(elapsed / 1000),
          // what was scheduled — again null when the rig never said
          plannedDurationMs: known && Number.isFinite(s.duration) ? s.duration : null,
          durationKnown: known,
          durationSource: known ? 'arena' : 'unknown',
          configuredDurationMs: this._defaultDurationMs(),
          wallClockMs: wall,
          endReason: s.endReason || null,
          endSource: s.endSource || null,
          mode: modeOf(s),
          missionDesc: s.missionDesc || null,
          teams: teamsOf(s),
          // here the roster IS complete — every entity has registered
          players: playerCount(s),
          playersFinal: true,
          scores: s.scores && typeof s.scores === 'object' ? { ...s.scores } : {},
          scoreSource: s.scoreSource || 'internal',
        },
      }, 'match_end');

      this._startedAt = null;
      this._startedMatchId = null;
      return out;
    } catch (err) {
      this._noteError(`match_end: ${err.message}`);
      return false;
    }
  }

  // ─── status / diagnostics ─────────────────────────────────────────────────

  /**
   * For getStatus() and the console. Contains NO credentials: the URL is
   * stripped of any userinfo, username and password never leave src/mqtt.js.
   */
  status() {
    const c = this.cfg;
    const cred = safeCredentials();
    return {
      enabled: this.enabled,
      connected: this._connected,
      state: !this.enabled ? 'off' : (this._connected ? 'connected' : 'connecting'),
      broker: redactUrl(c.url || ''),
      topic: this.baseTopic,
      statusTopic: this.statusTopic,
      topicSuffixes: c.topicSuffixes === true,
      qos: this._qos(),
      retain: c.retain === true,
      authConfigured: !!(cred.username || cred.password),
      queued: this._queue.length,
      queueMax: clampInt(c.queueMax, 0, 0, 10000),
      published: this._stats.published,
      confirmed: this._stats.confirmed,
      unconfirmed: this._stats.unconfirmed,
      dropped: this._stats.dropped,
      errors: this._stats.errors,
      connects: this._stats.connects,
      lastPublishAt: this._stats.lastPublishAt,
      lastError: this._stats.lastError,
      lastErrorAt: this._stats.lastErrorAt,
    };
  }

  /**
   * One message, then quiet. A missing broker repeats its ECONNREFUSED every
   * `reconnectPeriod`; logging each one would bury everything else in the log
   * of a machine nobody is watching. The same message is therefore logged at
   * most every five minutes, with the count of what was swallowed.
   */
  _noteError(message) {
    const msg = String(message || 'unbekannter Fehler').slice(0, 300);
    this._stats.errors += 1;
    this._stats.lastError = msg;
    this._stats.lastErrorAt = Date.now();

    const now = Date.now();
    if (this._errQuiet.message === msg && now - this._errQuiet.at < ERROR_QUIET_MS) {
      this._errQuiet.suppressed += 1;
      return;
    }
    const swallowed = this._errQuiet.message === msg ? this._errQuiet.suppressed : 0;
    this._errQuiet = { message: msg, at: now, suppressed: 0 };
    this.log?.warn('mqtt', swallowed ? `${msg} (${swallowed} gleichartige Meldungen unterdrückt)` : msg);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Mode block of a snapshot: number, key, label, family, profile. */
function modeOf(s) {
  const m = (s && s.mode) || null;
  if (!m || typeof m !== 'object') return null;
  return {
    number: m.number == null ? null : m.number,
    key: m.key || null,
    label: m.label || null,
    family: m.family || null,
    profile: m.profile || null,
    known: m.known === true,
    source: m.source || null,
  };
}

/** Teams as a list — the map keys are the team ids of the stream. */
function teamsOf(s) {
  const t = (s && s.teams) || {};
  try {
    return Object.keys(t).map((id) => ({
      id,
      name: (t[id] && t[id].name) || null,
      color: (t[id] && t[id].color) || null,
    }));
  } catch { return []; }
}

function playerCount(s) {
  try { return Object.keys((s && s.players) || {}).length; } catch { return 0; }
}

/** Credentials, never cached, never stored on the instance. */
function safeCredentials() {
  try {
    const c = mqttCredentials();
    return { username: c.username || '', password: c.password || '' };
  } catch { return { username: '', password: '' }; }
}

/**
 * `mqtt://user:secret@host:1883` -> `mqtt://***@host:1883`. A broker URL may
 * carry credentials; the status endpoint and the log must never show them.
 */
function redactUrl(raw) {
  const s = String(raw || '');
  if (!s) return '';
  return s.replace(/^(\w+:\/\/)[^@/]*@/, '$1***@');
}

function clampInt(v, d, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
}

module.exports = { MqttOut, redactUrl };
