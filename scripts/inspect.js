'use strict';

/**
 * Laserforce feed inspector.
 *
 *   node scripts/inspect.js [port]        (default 9100)
 *
 * A bare TCP server that does NOT interpret anything — it just catalogs every
 * line type and every type-4 event code it sees, with a count and one sample
 * line each. Point the Laserforce log export at this port temporarily, play a
 * match, then Ctrl+C. It prints a table and writes inspect-report.json.
 *
 * Use it to verify docs/LASERFORCE.md against your actual hardware.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const port = parseInt(process.argv[2] || '9100', 10);
const report = {
  startedAt: new Date().toISOString(),
  port,
  lineTypes: {},   // "4" -> { count, sample }
  type4Codes: {},  // "1101" -> { count, sample, actorSample, targetSample }
  unknownShapes: [],
  totalLines: 0,
};

function note(map, key, line) {
  if (!map[key]) map[key] = { count: 0, sample: line };
  map[key].count++;
}

const server = net.createServer((sock) => {
  console.log(`[inspect] Laserforce connected: ${sock.remoteAddress}:${sock.remotePort}`);
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(';')) continue;
      report.totalLines++;
      const cols = line.split(/\s+/).filter(Boolean);
      const type = cols[0];
      note(report.lineTypes, type, line);

      if (type === '4') {
        const code = cols[2] || '(none)';
        const e = report.type4Codes[code] || { count: 0, sample: line, cols: cols.length, idTokens: new Set() };
        e.count++;
        // note the shape of id tokens after the code (@hardware vs #ipl), for actor/target insight
        cols.slice(3).forEach((c) => { if (c.startsWith('@')) e.idTokens.add('@'); else if (c.startsWith('#')) e.idTokens.add('#'); });
        report.type4Codes[code] = e;
      }
    }
  });
  sock.on('error', (err) => console.log(`[inspect] socket error: ${err.message}`));
  sock.on('close', () => { console.log('[inspect] Laserforce disconnected'); dump(); });
});

// keep the report file fresh even if the process is killed hard
setInterval(() => { try { writeReport(); } catch {} }, 10000).unref();

server.on('error', (err) => { console.error(`[inspect] cannot listen on ${port}: ${err.message}`); process.exit(1); });
server.listen(port, '0.0.0.0', () => {
  console.log(`[inspect] listening on 0.0.0.0:${port}`);
  console.log('[inspect] point the Laserforce export here, play a match, then Ctrl+C\n');
});

function writeReport() {
  const out = {
    ...report,
    finishedAt: new Date().toISOString(),
    type4Codes: Object.fromEntries(Object.entries(report.type4Codes).map(([k, v]) => [k, { count: v.count, sample: v.sample, idTokens: [...v.idTokens] }])),
  };
  const file = path.resolve(process.cwd(), 'inspect-report.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  return file;
}

function dump() {
  const line = '─'.repeat(72);
  console.log(`\n${line}\nLINE TYPES  (total lines: ${report.totalLines})\n${line}`);
  for (const [t, v] of Object.entries(report.lineTypes).sort()) {
    console.log(`  type ${t.padEnd(3)}  ${String(v.count).padStart(6)}×   e.g.  ${v.sample.slice(0, 90)}`);
  }
  console.log(`\n${line}\nTYPE-4 EVENT CODES\n${line}`);
  const rows = Object.entries(report.type4Codes).sort((a, b) => b[1].count - a[1].count);
  for (const [code, v] of rows) {
    const tt = [...v.idTokens].join(' ') || '–';
    console.log(`  ${code.padEnd(6)} ${String(v.count).padStart(6)}×   id-tokens: ${tt}`);
    console.log(`         e.g.  ${v.sample.slice(0, 100)}`);
  }

  console.log(`\nwritten: ${writeReport()}`);
}

process.on('SIGINT', () => { dump(); process.exit(0); });
process.on('SIGTERM', () => { dump(); process.exit(0); });
