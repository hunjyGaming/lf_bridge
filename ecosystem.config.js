// ─────────────────────────────────────────────────────────────────────────────
//  LF Live — PM2-Konfiguration für den Standortserver
//
//  Starten:     pm2 start ecosystem.config.js
//  Neu laden:   pm2 restart lf-live
//  Log ansehen: pm2 logs lf-live
//  Nach Neustart des Rechners automatisch mitstarten:
//               pm2 save && pm2 startup     (die ausgegebene Zeile ausführen)
//
//  WO DIE EINSTELLUNGEN HERKOMMEN. Diese Datei steuert NUR den Prozess: wann er
//  neu startet, wie viel Speicher er haben darf, wohin das Log geht. Was der
//  Dienst tut, steht weiterhin in der `.env` (Ports, Zugangsdaten — gepinnt),
//  in `config.json` (Match-Tag-Einstellungen, Web-Konsole) und in `modes/`
//  (Spielmodi). Die Rangfolge ist unverändert: Vorgaben → config.json → .env.
//  Vollständige Übersicht: docs/CONFIG.md.
//
//  DIE .ENV WIRD AUTOMATISCH GELESEN — von lf_live selbst (src/config.js ruft
//  `process.loadEnvFile()` auf), nicht von PM2. Deshalb steht unten KEIN
//  `env_file`: PM2 kennt so etwas gar nicht, und ein zweiter Leseweg würde nur
//  die Frage aufwerfen, welcher gewinnt. Entscheidend ist `cwd` — von dort aus
//  werden `.env`, `config.json` und `data/` gesucht.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

// Alles relativ zu DIESER Datei, damit `pm2 start` aus jedem Verzeichnis
// funktioniert und die Pfade auf Windows wie auf Linux stimmen.
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'lf-live',
      script: path.join(ROOT, 'src', 'index.js'),

      // Arbeitsverzeichnis. Hier liegen .env, config.json, modes/ und data/ —
      // lf_live löst jeden relativen Pfad von hier aus auf.
      cwd: ROOT,

      // ── Prozessmodell ──────────────────────────────────────────────────
      // GENAU EINE INSTANZ, kein Cluster. Der Dienst hält den Matchzustand im
      // Arbeitsspeicher und nimmt den Laserforce-Strom auf EINEM TCP-Port
      // entgegen; eine zweite Instanz hätte einen zweiten, anderen Zustand und
      // könnte den Port nicht binden.
      instances: 1,
      exec_mode: 'fork',

      // ── Neustartverhalten ──────────────────────────────────────────────
      autorestart: true,
      // Nicht in einer Schleife neu starten, wenn der Port dauerhaft belegt ist:
      // erst nach 5 s wieder, und nach 10 Fehlstarts in Folge gibt PM2 auf und
      // meldet den Dienst als `errored`, statt den Rechner zu beschäftigen.
      restart_delay: 5000,
      max_restarts: 10,
      // Ein Start gilt erst nach 30 s als geglückt. Darunter zählt PM2 ihn als
      // Fehlstart — sonst wäre ein sofort abstürzender Prozess „stabil".
      min_uptime: 30000,
      exp_backoff_restart_delay: 0,

      // NICHT automatisch bei Dateiänderungen neu starten. Der Dienst schreibt
      // selbst nach data/ und liest modes/ ohne Neustart neu; ein Watcher würde
      // ihn mitten in einem Match abwürgen.
      watch: false,

      // ── Sauberes Beenden ───────────────────────────────────────────────
      // src/index.js fängt SIGINT/SIGTERM ab, rechnet ein noch laufendes Match
      // ab (die CSV-Dateien werden synchron geschrieben), leert die
      // Ereignis-Logdatei und beendet sich dann nach 200 ms selbst. 8 s sind
      // reichlich Luft auch bei großer Statistik-Historie.
      kill_timeout: 8000,
      listen_timeout: 10000,
      wait_ready: false,

      // ── Speichergrenze ─────────────────────────────────────────────────
      // Gemessener Bedarf: rund 8–9 MB Heap und ~120 MB RSS bei 50 Spielern,
      // stabil über 60 Matches (docs/PERFORMANCE.md). Dazu wächst die
      // Gesamtwertung um rund 1,6 KB je jemals gesehenem Spieler — 30 000
      // Spieler sind ~48 MB. 512 MB ist deshalb keine Betriebsgrenze, sondern
      // eine Reißleine: wird sie erreicht, stimmt etwas nicht, und ein Neustart
      // ist besser als ein vollgelaufener Standortserver.
      max_memory_restart: '512M',

      // ── Log ────────────────────────────────────────────────────────────
      // Das ist das PROZESS-Log (stdout/stderr, dieselben Zeilen wie in der
      // Konsole unter „Log"). Die lesbare Ereignis-Logdatei je Match und die
      // CSV-Statistik schreibt der Dienst getrennt davon nach data/
      // (docs/LOGGING.md, docs/STATS.md).
      out_file: path.join(ROOT, 'data', 'pm2', 'lf-live.out.log'),
      error_file: path.join(ROOT, 'data', 'pm2', 'lf-live.err.log'),
      merge_logs: true,
      time: false,   // lf_live stempelt jede Zeile bereits selbst mit ISO-Zeit
      log_date_format: '',

      // PM2 dreht Logdateien NICHT von sich aus. Ohne das Modul unten wächst
      // lf-live.out.log unbegrenzt:
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 20M
      //   pm2 set pm2-logrotate:retain 14

      // ── Umgebung ───────────────────────────────────────────────────────
      // Bewusst schmal gehalten: alles LF_* gehört in die `.env`, damit es nur
      // EINE Stelle gibt, an der man nachsieht (docs/CONFIG.md). Hier steht nur
      // das, was den Node-Prozess selbst betrifft.
      env: {
        NODE_ENV: 'production',
        // Node soll nicht mehr Heap nehmen als die Reißleine oben erlaubt —
        // sonst startet PM2 bei 512 MB neu, während Node noch fröhlich wächst.
        NODE_OPTIONS: '--max-old-space-size=384',
      },
      // `pm2 start ecosystem.config.js --env test` — gleiche Datei, anderes
      // Arbeitsverzeichnis wäre nötig; hier nur ein lauteres Log zum Einrichten.
      env_test: {
        NODE_ENV: 'production',
        LF_LOG_LEVEL: 'debug',
      },
    },
  ],
};
