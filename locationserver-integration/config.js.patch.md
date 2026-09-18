# `util/config.js` — der neue Abschnitt

Alle neuen Werte kommen wie im Locationserver üblich ausschließlich aus
Umgebungsvariablen, tragen die Vorsilbe `LF_BRIDGE_` und hängen an einem
Funktionsschalter `LF_BRIDGE_ENABLED`, der **standardmäßig aus** ist — genau wie
`LASERFORCE_MSSQL_ENABLED`.

## Zeilenkontext

Der Abschnitt gehört ans **Ende des `config`-Objekts**, direkt hinter den
bestehenden Laserforce-Passthrough-Block und vor die schließende Klammer:

```js
  //  laserforce passthrough broker (local) -> online bridge
  lf_passthrough_enabled: process.env.LF_PASSTHROUGH_ENABLED !== 'false',
  lf_passthrough_mqtt_url: process.env.LF_PASSTHROUGH_MQTT_URL || 'mqtt://localhost:1883',
  lf_passthrough_events: process.env.LF_PASSTHROUGH_EVENTS
    ? process.env.LF_PASSTHROUGH_EVENTS.split(',')
        .map(e => e.trim())
        .filter(Boolean)
    : [],
// ---------------------------- HIER EINFÜGEN ----------------------------
};

module.exports = config;
```

## Einzufügen

```js
  //  laserforce tdf bridge (die Anlage verbindet sich per TCP zu uns)
  //  Aus per Vorgabe — ohne LF_BRIDGE_ENABLED=true wird kein Port geöffnet und
  //  kein Modul der Auswertung angefasst.
  lf_bridge_enabled: process.env.LF_BRIDGE_ENABLED === 'true',
  lf_bridge_host: process.env.LF_BRIDGE_HOST || '0.0.0.0',
  lf_bridge_port:
    process.env.LF_BRIDGE_PORT && !Number.isNaN(parseInt(process.env.LF_BRIDGE_PORT, 10))
      ? parseInt(process.env.LF_BRIDGE_PORT, 10)
      : 9000,
  //  Basis-Topic auf dem LOKALEN Broker (MQTT_URL). Bewusst NICHT
  //  /decs/lfpassthrough — das abonniert die bestehende Passthrough-Bridge.
  lf_bridge_mqtt_topic: process.env.LF_BRIDGE_MQTT_TOPIC || 'funzone/lasertag',
  //  Platzhalter-Rundenlänge in Sekunden, solange die Anlage keine meldet
  lf_bridge_default_duration_seconds:
    process.env.LF_BRIDGE_DEFAULT_DURATION_SECONDS &&
    !Number.isNaN(parseInt(process.env.LF_BRIDGE_DEFAULT_DURATION_SECONDS, 10))
      ? parseInt(process.env.LF_BRIDGE_DEFAULT_DURATION_SECONDS, 10)
      : 720,
  //  Matchende erkennen, alles in Sekunden; 0 schaltet den jeweiligen Weg ab
  lf_bridge_watchdog_seconds:
    process.env.LF_BRIDGE_WATCHDOG_SECONDS &&
    !Number.isNaN(parseInt(process.env.LF_BRIDGE_WATCHDOG_SECONDS, 10))
      ? parseInt(process.env.LF_BRIDGE_WATCHDOG_SECONDS, 10)
      : 120,
  lf_bridge_stream_lost_seconds:
    process.env.LF_BRIDGE_STREAM_LOST_SECONDS &&
    !Number.isNaN(parseInt(process.env.LF_BRIDGE_STREAM_LOST_SECONDS, 10))
      ? parseInt(process.env.LF_BRIDGE_STREAM_LOST_SECONDS, 10)
      : 30,
  lf_bridge_end_block_seconds:
    process.env.LF_BRIDGE_END_BLOCK_SECONDS &&
    !Number.isNaN(parseInt(process.env.LF_BRIDGE_END_BLOCK_SECONDS, 10))
      ? parseInt(process.env.LF_BRIDGE_END_BLOCK_SECONDS, 10)
      : 10,
  //  Missionsbericht: an per Vorgabe. Namen wandern nur mit, wenn erlaubt.
  lf_bridge_report_enabled: process.env.LF_BRIDGE_REPORT_ENABLED !== 'false',
  lf_bridge_report_names: process.env.LF_BRIDGE_REPORT_NAMES !== 'false',
```

Zugangsdaten kommen hier keine dazu: die Bridge veröffentlicht über
`util/mqtt-client.js` und nutzt damit `MQTT_URL`, `MQTT_USERNAME` und
`MQTT_PASSWORD`, die bereits gesetzt sind. Sie liest sie nie selbst und zeigt sie
weder im Log noch in `lfBridgeStatus()`.
