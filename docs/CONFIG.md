# Konfiguration

Zwei Ebenen, die spätere gewinnt:

| | Wo | Wofür | Ändern |
|---|---|---|---|
| 1 | **`.env`** | Ports, Binds, Secrets — pro Rechner einmal | Texteditor, dann Neustart |
| 2 | **`config.json`** | Match-Tag-Einstellungen | **Web-Konsole → Einstellungen** |

Reihenfolge beim Start: **Defaults → `config.json` → `.env`**.

**Env-Pins:** Ein in `.env` gesetzter Wert ist gepinnt — die Konsole zeigt das
Feld dann nur lesbar mit der Markierung *„aus .env"*. Ein Speichern in der
Konsole kann ihn nicht überschreiben. Lass einen Wert also entweder nur in
`.env` **oder** nur in der Konsole.

`config.json` wird beim ersten Start angelegt, ist `.gitignore`-t und wird mit
Dateirechten `0600` geschrieben.

---

## `.env` — alle Variablen

| Variable | Standard | Config-Feld | Bedeutung |
|---|---|---|---|
| `LF_HTTP_HOST` | `0.0.0.0` | `http.host` | Bind der Konsole/API · `127.0.0.1` = nur dieser PC |
| `LF_HTTP_PORT` | `8080` | `http.port` | Konsole + API. Änderung wirkt **erst nach Neustart**. |
| `LF_API_TOKEN` | *(leer)* | `apiToken` | gesetzt → Bearer-Token für **jede** `/api/*` (außer `/api/health`), den WebSocket und die Konsole |
| `LF_CORS_ORIGINS` | `*` | `cors` | Browser-Origins, die die Lese-API aufrufen dürfen (Komma-Liste). `*` = beliebige (nur GET). Leer = keine. Für curl/Server irrelevant. |
| `LF_RATE_LIMIT_PER_MIN` | `600` | `rateLimitPerMin` | Anfragen/Minute je IP auf der HTTP-API. `0` = aus. |
| `LF_TCP_HOST` | `0.0.0.0` | `tcp.host` | Bind des Laserforce-Eingangs |
| `LF_TCP_PORT` | `9000` | `tcp.port` | Laserforce verbindet sich hierher. Änderung wird im Betrieb übernommen (Neu-Bind). |
| `LF_STREAM_ENABLED` | `false` | `streamServer.enabled` | roher TCP-Stream-Server an/aus |
| `LF_STREAM_HOST` | `127.0.0.1` | `streamServer.host` | dessen Bind. Für LAN-Zugriff `0.0.0.0`. |
| `LF_STREAM_PORT` | `9100` | `streamServer.port` | dessen Port |
| `LF_CSV_ENABLED` | `true` | `csv.enabled` | Statistik-CSV schreiben |
| `LF_CSV_DIR` | `data/stats` | `csv.dir` | Zielordner (relativ zum Programm) |
| `LF_CSV_DELIMITER` | `;` | `csv.delimiter` | `;` Excel DE · `,` pandas · Tab |
| `LF_CSV_BOM` | `true` | `csv.bom` | BOM voranstellen (Excel + Umlaute) |
| `LF_CSV_EVENTS` | `true` | `csv.writeEvents` | zusätzlich Event-Log pro Match |
| `LF_CSV_LIVE` | `false` | `csv.writeLive` | Match-CSV schon während des Matches aktualisieren |
| `LF_LOCAL_ROSTER_ENABLED` | `false` | `localRoster.enabled` | Namensliste nutzen |
| `LF_LOCAL_ROSTER_FILE` | `data/roster.csv` | `localRoster.file` | deren Pfad (setzt automatisch `enabled=true`) |
| `LF_MATCH_DURATION_MS` | `720000` | `match.defaultDurationMs` | Fallback bis Laserforce die Dauer meldet (Log-Typ 1) |
| `LF_LOG_LEVEL` | `info` | `logLevel` | `debug` \| `info` \| `warn` \| `error` |
| `LF_CONFIG_FILE` | `config.json` | – | wo die Konsolen-Konfiguration liegt |
| `LF_ENV_FILE` | `.env` | – | alternative .env-Datei |

Leere Werte (`LF_API_TOKEN=`) zählen als „nicht gesetzt".

---

## `config.json` — Struktur

```jsonc
{
  "logLevel": "info",
  "http": { "host": "0.0.0.0", "port": 8080 },
  "apiToken": "",
  "cors": ["*"],
  "rateLimitPerMin": 600,
  "tcp": { "host": "0.0.0.0", "port": 9000 },
  "streamServer": { "enabled": false, "host": "127.0.0.1", "port": 9100 },
  "match": { "defaultDurationMs": 720000 },
  "csv": {
    "enabled": true, "dir": "data/stats", "delimiter": ";",
    "bom": true, "writeEvents": true, "writeLive": false
  },
  "localRoster": { "enabled": false, "file": "data/roster.csv" },
  "outputs": [
    {
      "id": "out_…",              // automatisch
      "name": "Regie-Trigger",
      "kind": "webhook",          // "webhook" | "tcp" | "udp"
      "enabled": true,
      "events": ["goal", "match_start"],   // oder ["*"]
      "sendEvents": true,
      "sendState": false,

      // kind = "webhook":
      "url": "https://…",         // nur http/https
      "secret": "geheim",         // optional → HMAC-Signatur (X-LFB-Signature)
      "includeState": false,      // Snapshot an jeden POST hängen

      // kind = "tcp" / "udp":
      "host": "192.168.1.50",
      "port": 7000
    }
  ]
}
```

`outputs` verwaltest du am besten in der Konsole (Tab „Ausgänge"). Eine alte
`webhooks: […]`-Datei wird beim Start automatisch nach `outputs` migriert.
Details zu Ausgängen: [INTEGRATION.md](INTEGRATION.md).

---

## Namensliste (optional)

Spielernamen kommen direkt aus dem Laserforce-Stream (Log-Typ 3). Wer eigene
Namen/Teams anzeigen will, pflegt eine **eigene CSV** (`localRoster.file`):

```
id,name,team
1234,Mara,Rot
5678,Jonas,Rot
@91,Gast 1,
```

- `id` = Laserforce-ID aus einer Typ-3-Zeile, mit oder ohne `@`/`#`
- `name` überschreibt den Stream-Namen
- `team` (optional) überschreibt den Teamnamen für das Team dieses Spielers
- Header-Zeile optional, `;` oder `,` als Trenner

Aktivieren: Konsole → „Einstellungen → Namensliste", oder `LF_LOCAL_ROSTER_FILE`.
„Liste neu laden" liest sofort neu ein. Ohne Liste → Stream-Namen.

---

## Als Dienst

### Windows (NSSM)

```
nssm install LF-Live "C:\Program Files\nodejs\node.exe" "C:\pfad\zu\lf_live\src\index.js"
nssm set LF-Live AppDirectory "C:\pfad\zu\lf_live"
nssm start LF-Live
```

### Linux (systemd) — `/etc/systemd/system/lf-live.service`

```ini
[Unit]
Description=LF Live
After=network.target

[Service]
WorkingDirectory=/opt/lf_live
ExecStart=/usr/bin/node src/index.js
Restart=always
User=lflive
# Environment=LF_HTTP_PORT=8080
# Environment=LF_API_TOKEN=…

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lf-live && journalctl -u lf-live -f
```

---

## Windows-Firewall

Beim ersten Start fragt Windows, ob `node.exe` im Netzwerk kommunizieren darf →
**für „Privates Netzwerk" erlauben**, sonst erreicht weder Laserforce Port 9000
noch ein anderer Rechner die Konsole auf 8080.

---

## Sicherheit

Eigene Seite: [SECURITY.md](SECURITY.md).
