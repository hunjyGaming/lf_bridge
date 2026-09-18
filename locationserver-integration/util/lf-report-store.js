//  Ablage für Missionsberichte bis zur Zustellung
//
//  Ein Missionsbericht entsteht genau einmal je Match. Ist der Broker in dem
//  Moment nicht da, darf der Bericht nicht verloren gehen — er liegt bis zur
//  Zustellung auf der Platte und wird nach einem Neustart weiter versucht.
//
//  Die Ablage nutzt util/persistence.js (storage/, atomarer Schreibvorgang),
//  damit im Locationserver nicht eine zweite Ablage neben der bestehenden steht.
//  Geschrieben wird höchstens einmal je Match und einmal je Zustellversuch,
//  NIE im Datenpfad des TCP-Sockets.

const { readJson, writeJson } = require('./persistence');

const STORE_FILE = 'lf-bridge-reports.json';

//  Grenzen. Der Prozess läuft tagelang ohne Neustart; alles hier ist gedeckelt.
const MAX_PENDING = 50; //  Berichte in der Warteschlange
const MAX_BYTES = 2 * 1024 * 1024; //  Gesamtgröße der Warteschlange
const RETRY_MS = 30 * 1000; //  Abstand zwischen zwei Zustellversuchen

let pending = [];
let deliver = null;
let timer = null;
let started = false;
let seq = 0;
const counters = { delivered: 0, dropped: 0, lastError: null, lastOkAt: null };

//  Wie groß die Warteschlange auf der Platte wäre. Nie werfend.
const sizeOf = list => {
  try {
    return Buffer.byteLength(JSON.stringify(list), 'utf8');
  } catch (_) {
    return 0;
  }
};

//  Ältestes zuerst wegwerfen, bis beide Grenzen wieder eingehalten sind.
const trim = () => {
  while (pending.length > MAX_PENDING) {
    pending.shift();
    counters.dropped++;
  }
  while (pending.length > 1 && sizeOf(pending) > MAX_BYTES) {
    pending.shift();
    counters.dropped++;
  }
  if (counters.dropped) {
    console.warn(
      `LF bridge (Bericht): Warteschlange voll — ${counters.dropped} Bericht(e) verworfen (Grenze: ${MAX_PENDING} Stück / ${MAX_BYTES} Byte).`
    );
  }
};

const persist = () => {
  try {
    writeJson(STORE_FILE, { version: 1, pending });
  } catch (err) {
    counters.lastError = err.message;
    console.error('LF bridge (Bericht): Warteschlange konnte nicht gespeichert werden:', err.message);
  }
};

const clearTimer = () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

//  Ein Durchlauf über die Warteschlange. Fängt alles ab: ein Fehler hier darf
//  weder den Locationserver noch die Bridge mitnehmen.
const drain = () => {
  timer = null;
  if (!started || typeof deliver !== 'function') {
    return;
  }
  let changed = false;
  const keep = [];
  for (const entry of pending) {
    let ok = false;
    try {
      ok = deliver(entry.report) === true;
    } catch (err) {
      counters.lastError = err.message;
      console.error('LF bridge (Bericht): Zustellung warf einen Fehler:', err.message);
      ok = false;
    }
    if (ok) {
      counters.delivered++;
      counters.lastOkAt = new Date().toISOString();
      changed = true;
    } else {
      keep.push(entry);
    }
  }
  if (changed) {
    pending = keep;
    persist();
  }
  if (pending.length) {
    schedule(RETRY_MS);
  }
};

const schedule = delayMs => {
  if (timer || !started) {
    return;
  }
  timer = setTimeout(() => {
    try {
      drain();
    } catch (err) {
      timer = null;
      console.error('LF bridge (Bericht): Warteschlange konnte nicht abgearbeitet werden:', err.message);
    }
  }, delayMs);
  timer.unref && timer.unref();
};

//  Einen fertigen Bericht in die Warteschlange legen. Nie werfend.
const enqueueReport = report => {
  if (!started || !report || typeof report !== 'object') {
    return false;
  }
  try {
    pending.push({ id: ++seq, queuedAt: new Date().toISOString(), report });
    trim();
    persist();
    schedule(0);
    return true;
  } catch (err) {
    counters.lastError = err.message;
    console.error('LF bridge (Bericht): Bericht konnte nicht eingereiht werden:', err.message);
    return false;
  }
};

//  Warteschlange hochfahren und aufnehmen, was ein früherer Lauf hinterlassen hat.
const startReportStore = deliverFn => {
  if (started) {
    return;
  }
  deliver = typeof deliverFn === 'function' ? deliverFn : null;
  started = true;
  try {
    const stored = readJson(STORE_FILE);
    if (stored && Array.isArray(stored.pending)) {
      pending = stored.pending.filter(e => e && typeof e === 'object' && e.report);
      for (const e of pending) {
        const n = Number(e.id);
        if (Number.isFinite(n) && n > seq) seq = n;
      }
      trim();
    }
  } catch (err) {
    console.error('LF bridge (Bericht): frühere Warteschlange nicht lesbar:', err.message);
    pending = [];
  }
  if (pending.length) {
    console.warn(
      `LF bridge (Bericht): ${pending.length} Bericht(e) aus einem früheren Lauf werden jetzt zugestellt.`
    );
  }
  schedule(1000);
};

const stopReportStore = () => {
  started = false;
  clearTimer();
  deliver = null;
};

const reportStoreStatus = () => ({
  pending: pending.length,
  delivered: counters.delivered,
  dropped: counters.dropped,
  lastOkAt: counters.lastOkAt,
  lastError: counters.lastError,
  maxPending: MAX_PENDING,
  maxBytes: MAX_BYTES,
});

module.exports = {
  startReportStore,
  stopReportStore,
  enqueueReport,
  reportStoreStatus,
  MAX_PENDING,
  MAX_BYTES,
  RETRY_MS,
};
