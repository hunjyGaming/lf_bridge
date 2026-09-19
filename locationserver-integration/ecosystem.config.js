//  PM2-Konfiguration für den Locationserver mit eingebauter Laserforce-Bridge
//
//  ACHTUNG: `ecosystem.config.js` steht in der `.gitignore` des Locationservers
//  — jeder Standort pflegt seine eigene. Diese Datei ist deshalb eine VORLAGE
//  zum Vergleichen, keine Datei zum blinden Überschreiben. Wer schon eine hat,
//  übernimmt daraus nur die Zeilen, die er braucht (siehe env.additions.md).
//
//  Der Name muss `locationserver` bleiben: util/fleet-agent.js sucht den
//  PM2-Prozess unter genau diesem Namen (`pm2 jlist` -> `p.name === appName`)
//  und liest die verfügbaren Umgebungen aus den `env_*`-Schlüsseln hier.

module.exports = {
  apps: [
    {
      name: 'locationserver',
      script: 'app.js',
      cwd: __dirname,
      instances: 1,
      //  Genau EINE Instanz. Der TCP-Port der Bridge kann nur einmal geöffnet
      //  werden; im Cluster-Modus würde die zweite Instanz beim Start scheitern
      //  und sich selbst abschalten.
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      //  Der Prozess läuft tagelang durch. Kommt er trotzdem über diese Grenze,
      //  stimmt etwas nicht — dann ist ein Neustart besser als ein voller Speicher.
      max_memory_restart: '512M',
      //  Ein Absturz in schneller Folge soll nicht zur Endlosschleife werden.
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 5000,
      merge_logs: true,
      time: true,
      env_production: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
