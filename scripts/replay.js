'use strict';

/**
 * replay.js — play a raw capture (src/capture.js) back into a running bridge.
 *
 *   node scripts/replay.js <datei.tdf> [--host 127.0.0.1] [--port 9000]
 *                                      [--speed 8] [--realtime] [--quiet]
 *
 * The file is sent line by line, BYTE FOR BYTE as it was recorded — tabs,
 * `\r\n`, the `;` schema-comment lines, everything. That is the whole point:
 * only an identical feed reproduces an identical end state.
 *
 * Timing:
 *   default      as fast as the socket takes it
 *   --realtime   the `time` column of the in-game lines (ms since 0100) sets
 *                the gaps, so the match runs at its real pace
 *   --speed N    divides those gaps by N (default 1). Only meaningful with
 *                --realtime; on its own it changes nothing.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const LF = 0x0a;
/** Line types whose column 1 is the play clock (docs/LASERFORCE.md). */
const TIMED = new Set(['3', '4', '5', '6', '9']);
/** Never sleep longer than this between two lines, whatever the file says. */
const MAX_GAP_MS = 30000;

function usage(msg) {
  if (msg) console.error(`replay: ${msg}\n`);
  console.error('Aufruf:  node scripts/replay.js <datei.tdf> [--host 127.0.0.1] [--port 9000] [--speed 8] [--realtime]');
  console.error('');
  console.error('  --host      Ziel-Adresse der laufenden Bridge      (Standard 127.0.0.1)');
  console.error('  --port      Laserforce-Port der Bridge             (Standard 9000)');
  console.error('  --speed N   Beschleunigung für --realtime          (Standard 1)');
  console.error('  --realtime  echte Abstände aus der time-Spalte statt so schnell wie möglich');
  console.error('  --quiet     kein Fortschritt auf der Konsole');
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const o = { file: null, host: '127.0.0.1', port: 9000, speed: 1, realtime: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage();
    else if (a === '--realtime') o.realtime = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--port') o.port = parseInt(argv[++i], 10);
    else if (a === '--speed') o.speed = parseFloat(argv[++i]);
    else if (a.startsWith('--')) usage(`unbekannte Option ${a}`);
    else if (!o.file) o.file = a;
    else usage('mehr als eine Datei angegeben');
  }
  if (!o.file) usage('keine Datei angegeben');
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) usage('--port muss 1–65535 sein');
  if (!Number.isFinite(o.speed) || o.speed <= 0) usage('--speed muss größer als 0 sein');
  return o;
}

/** Split into raw lines, each INCLUDING its terminator — nothing is rewritten. */
function rawLines(buf) {
  const out = [];
  let start = 0;
  for (;;) {
    const i = buf.indexOf(LF, start);
    if (i < 0) break;
    out.push(buf.subarray(start, i + 1));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

/** The play clock of a line, or null when it carries none. */
function timeOf(raw) {
  const body = raw.toString('utf8').replace(/[\r\n]+$/, '');
  if (!body.trim() || body.startsWith(';')) return null;
  const cols = body.trim().split(/\s+/);
  if (!TIMED.has(cols[0])) return null;
  const n = parseInt(cols[1], 10);
  return Number.isFinite(n) ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Respect backpressure so a fast replay cannot outrun the socket. */
function write(sock, buf) {
  return new Promise((resolve, reject) => {
    if (sock.write(buf)) return resolve();
    sock.once('drain', resolve);
    sock.once('error', reject);
  });
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const file = path.resolve(process.cwd(), o.file);
  let data;
  try { data = fs.readFileSync(file); }
  catch (err) { console.error(`replay: ${file} nicht lesbar — ${err.message}`); process.exit(1); }

  const lines = rawLines(data);
  if (!o.quiet) {
    console.log(`Datei     ${file}`);
    console.log(`Umfang    ${data.length} Bytes · ${lines.length} Zeilen`);
    console.log(`Ziel      ${o.host}:${o.port}`);
    console.log(`Tempo     ${o.realtime ? `echt, Faktor ${o.speed}` : 'so schnell wie möglich'}`);
  }

  const sock = net.connect(o.port, o.host);
  sock.on('error', (err) => { console.error(`replay: Verbindung fehlgeschlagen — ${err.message}`); process.exit(1); });
  await new Promise((r) => sock.once('connect', r));

  let sent = 0;
  let prev = null;
  for (const raw of lines) {
    if (o.realtime) {
      const t = timeOf(raw);
      if (t != null) {
        if (prev != null && t > prev) {
          const gap = Math.min(MAX_GAP_MS, (t - prev) / o.speed);
          if (gap >= 1) await sleep(gap);
        }
        prev = t;
      }
    }
    await write(sock, raw);
    sent += raw.length;
    if (!o.quiet && lines.length > 200 && sent % 4096 < raw.length) {
      process.stdout.write(`\r  gesendet ${sent}/${data.length} Bytes`);
    }
  }

  if (!o.quiet && lines.length > 200) process.stdout.write('\r');
  // Give the bridge a moment to finish the last match before the FIN arrives.
  await new Promise((r) => sock.end(r));
  await sleep(300);
  if (!o.quiet) console.log(`fertig — ${sent} Bytes gesendet (${sent === data.length ? 'vollständig' : 'UNVOLLSTÄNDIG!'})`);
  process.exit(sent === data.length ? 0 : 1);
})();
