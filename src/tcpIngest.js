'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const MAX_LINE_BYTES = 1 << 20; // 1 MiB guard against a peer that never sends a newline

/**
 * Laserforce TCP log-stream listener. Laserforce connects here and streams
 * newline-delimited log lines. Line framing is identical to the original
 * (split on \r?\n, keep the trailing partial in a buffer). Hardened with
 * per-socket error handling and a buffer-size guard so nothing can crash the
 * service mid-event.
 *
 * ADDITIVE: besides the parsed `line` events it emits the UNTOUCHED bytes as
 * `data` and a `stream-end` when the peer goes away. The raw recorder
 * (src/capture.js) hangs off those two — nothing else listens, and with no
 * listener attached the emit is free.
 */
class TcpIngest extends EventEmitter {
  constructor({ logger, getConfig }) {
    super();
    this.log = logger;
    this.getConfig = getConfig;
    this.server = null;
    this.stats = { listening: false, host: null, port: null, connections: 0, bytes: 0, lines: 0, lastLineAt: null, connected: 0, lastDisconnectAt: null };
  }

  start() {
    return new Promise((resolve, reject) => {
      const { host, port } = this.getConfig().tcp;
      this.stop();

      const server = net.createServer((socket) => {
        this.stats.connections++;
        this.stats.connected++;
        const peer = `${socket.remoteAddress}:${socket.remotePort}`;
        this.log.info('tcp', `Laserforce connected (${peer})`);
        // ADDITIVE: counterpart of `stream-end`. A reconnect inside the grace
        // period must call off a pending `stream_lost` (src/index.js).
        try { this.emit('stream-start', { peer }); }
        catch (err) { this.log.warn('tcp', `connect handler threw: ${err.message}`); }
        let buffer = '';

        socket.on('data', (data) => {
          this.stats.bytes += data.length;
          // Raw bytes first and unchanged — a recorder must see exactly what the
          // arena sent, including tabs, \r\n and the `;` schema lines. It can
          // never disturb the parsing below.
          try { this.emit('data', data); }
          catch (err) { this.log.warn('tcp', `raw handler threw: ${err.message}`); }
          buffer += data.toString('utf8');
          if (buffer.length > MAX_LINE_BYTES) {
            this.log.warn('tcp', `line buffer over ${MAX_LINE_BYTES} bytes without a newline; dropping`);
            buffer = '';
            return;
          }
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t) continue;
            this.stats.lines++;
            this.stats.lastLineAt = Date.now();
            try { this.emit('line', t); }
            catch (err) { this.log.error('tcp', `line handler threw: ${err.message}`); }
          }
        });

        socket.on('error', (err) => this.log.warn('tcp', `socket error (${peer}): ${err.message}`));
        socket.on('close', () => {
          this.stats.connected--;
          this.stats.lastDisconnectAt = Date.now();
          this.log.info('tcp', `Laserforce disconnected (${peer})`);
          try { this.emit('stream-end'); }
          catch (err) { this.log.warn('tcp', `raw handler threw: ${err.message}`); }
        });
      });

      server.on('error', (err) => {
        this.stats.listening = false;
        this.log.error('tcp', `server error: ${err.message}`);
        reject(err);
      });

      server.listen(port, host, () => {
        this.server = server;
        Object.assign(this.stats, { listening: true, host, port });
        this.log.info('tcp', `listening for Laserforce on ${host}:${port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
    this.stats.listening = false;
  }
}

module.exports = { TcpIngest };
