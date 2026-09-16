'use strict';

const os = require('os');

/**
 * „Wo bin ich erreichbar?" — alles, was man ohne Monitor am Hallen-PC wissen muss.
 *
 * Wird an zwei Stellen gebraucht: beim Start für die Benachrichtigung
 * (src/notify.js) und laufend für /api/status bzw. die Konsole.
 */

/** Alle nicht-internen IPv4-Adressen dieses Rechners, Docker/VM-Bridges hinten. */
function ipv4Addresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [iface, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal) continue;
      out.push({ iface, address: n.address, netmask: n.netmask, mac: n.mac });
    }
  }
  out.sort((a, b) => rank(a) - rank(b));
  return out;
}

/** Kleiner = wahrscheinlicher die echte LAN-Karte. */
function rank(a) {
  const n = `${a.iface}`.toLowerCase();
  if (/(docker|veth|vmnet|virtualbox|hyper-v|vethernet|wsl|tailscale|zerotier|loopback)/.test(n)) return 30;
  if (/^(127\.|169\.254\.)/.test(a.address)) return 40;
  if (/^(10\.|192\.168\.)/.test(a.address)) return 0;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(a.address)) return 10;
  return 20;
}

/** Die eine Adresse, die man jemandem nennen würde. Kann null sein. */
function primaryAddress() {
  const list = ipv4Addresses();
  return list.length ? list[0].address : null;
}

/**
 * Vollständiges Erreichbarkeits-Bild.
 * @param {object} cfg  die laufende Konfiguration (config.data)
 */
function reachability(cfg) {
  const port = cfg?.http?.port ?? 8080;
  const bind = cfg?.http?.host ?? '0.0.0.0';
  const addresses = ipv4Addresses();
  const lanOpen = bind === '0.0.0.0' || bind === '::';
  const urls = [`http://localhost:${port}/`];
  if (lanOpen) for (const a of addresses) urls.push(`http://${a.address}:${port}/`);
  else if (bind !== '127.0.0.1' && bind !== 'localhost') urls.push(`http://${bind}:${port}/`);

  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    pid: process.pid,
    addresses,
    primary: lanOpen ? (addresses[0]?.address ?? null) : (bind === '127.0.0.1' ? '127.0.0.1' : bind),
    http: { bind, port, lanOpen },
    urls,
    tcp: { bind: cfg?.tcp?.host ?? '0.0.0.0', port: cfg?.tcp?.port ?? 9000 },
    stream: {
      enabled: !!cfg?.streamServer?.enabled,
      bind: cfg?.streamServer?.host ?? '127.0.0.1',
      port: cfg?.streamServer?.port ?? 9100,
    },
  };
}

/** Kurzform der Adressliste für Log-Zeilen: "192.168.1.20 (Ethernet), 10.0.0.5 (WLAN)". */
function addressSummary(addresses) {
  if (!addresses || !addresses.length) return 'keine LAN-Adresse gefunden';
  return addresses.map((a) => `${a.address} (${a.iface})`).join(', ');
}

module.exports = { ipv4Addresses, primaryAddress, reachability, addressSummary };
