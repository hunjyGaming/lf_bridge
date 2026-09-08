# Sicherheit

lf_live läuft auf **einem PC in einem Hallen-LAN**. Es kontaktiert **keine
externen Dienste**. Das Sicherheitsmodell ist auf genau diese Situation
zugeschnitten.

## Auf einen Blick

| | Standard | Härter |
|---|---|---|
| Web/API-Bind | `0.0.0.0` (ganzes LAN) | `LF_HTTP_HOST=127.0.0.1` — nur dieser PC |
| Laserforce-Bind | `0.0.0.0` | `LF_TCP_HOST=<Hallen-Subnetz>` |
| Raw-TCP-Stream | **aus**, Bind `127.0.0.1` | so lassen; für LAN gezielt `LF_STREAM_HOST=0.0.0.0` |
| Zugriffs-Token | keiner | `LF_API_TOKEN=<lang & zufällig>` — schützt auch den Raw-Stream |
| CORS | **keine** (leer) | so lassen; nur bei Bedarf feste Liste in `LF_CORS_ORIGINS` |
| Rate-Limit | 600 / Min / IP | niedriger via `LF_RATE_LIMIT_PER_MIN` |
| Ausgangs-Ziele | beliebig | `LF_OUTPUT_ALLOW=host1,\*.beispiel.de:443` |
| `X-Forwarded-For` | wird **ignoriert** | nur hinter eigenem Reverse-Proxy: `LF_TRUST_PROXY=true` |

## Was geschützt ist

- **Zugriffs-Token** (`LF_API_TOKEN` / Konsole): wenn gesetzt, brauchen **jede**
  `/api/*`-Anfrage (außer `/api/health`), der WebSocket und die Konsole ein
  `Authorization: Bearer <token>` bzw. `?token=<token>`. Zeitkonstanter Vergleich.
- **Raw-TCP-Stream**: ist ein Token gesetzt, muss ein neuer Client als **erste
  Zeile** `{"token":"<token>"}\n` schicken — innerhalb von 2 Sekunden, sonst wird
  die Verbindung getrennt (zeitkonstanter Vergleich, Warnung im Log). Ohne Token
  verhält sich der Stream wie bisher.
- **Secrets werden nie ausgeliefert**: `GET /api/config` liefert `apiToken: ""`
  plus `apiTokenSet: true|false`, und jedes gesetzte `outputs[].secret` als Maske
  `••••••`. Beim Speichern gilt: leerer `apiToken` = **unverändert** (löschen nur
  mit `apiTokenClear: true`), zurückgeschickte Maske = **gespeichertes Secret
  behalten**. Die Konsole kann die Konfiguration also gefahrlos zurückschreiben.
- **Audit-Log**: jede angenommene Änderung an `/api/config` und jeder
  `/api/outputs/test` erzeugt eine `warn`-Zeile (Scope `audit`) mit Client-IP und
  den geänderten Top-Level-Schlüsseln — **nie** mit Werten von Secrets.
- **CORS**: nur Origins aus `cors` bekommen `Access-Control-Allow-Origin`
  (Standard: **leer** = keine). Cross-Origin-Anfragen können **nur GET** sein
  (`Allow-Methods: GET, OPTIONS`). Die Konsole selbst ist same-origin und braucht
  kein CORS.
- **CSRF**: eine mutierende Anfrage (`POST/PUT/PATCH/DELETE`) **ohne gültiges
  Bearer-Token** wird mit 403 abgelehnt, außer sie bringt `Sec-Fetch-Site:
  same-origin` (vom Browser gesetzt, nicht fälschbar) **oder** den Header
  `X-LF-Console: 1` mit. `same-site` und `none` reichen **nicht**. Eine Website,
  die der Operator besucht, kann den Hallen-PC damit nicht umkonfigurieren.
  Skripte/curl gegen eine tokenlose Instanz müssen `X-LF-Console: 1` senden.
- **Client-IP**: standardmäßig immer die Socket-Adresse; `X-Forwarded-For` wird
  ignoriert. Erst `http.trustProxy` / `LF_TRUST_PROXY=true` lässt den
  **linkesten** XFF-Eintrag zu (Rate-Limit + Audit-Log). Nur einschalten, wenn
  wirklich ein eigener Reverse-Proxy davorsteht — sonst kann jeder Client das
  Rate-Limit und den Audit-Eintrag fälschen.
- **Ausgangs-Ziele**: `outputAllow` / `LF_OUTPUT_ALLOW` (Komma-Liste aus `host`
  oder `host:port`, `*.suffix` erlaubt) begrenzt, wohin Webhook/TCP/UDP-Ausgänge
  senden dürfen. Nicht gelistete Ziele werden mit einer Warnung übersprungen —
  auch beim „Test"-Knopf und beim Verbindungsaufbau. Leere Liste = alles erlaubt.
- **Rate-Limit** pro IP auf der HTTP-API (`rateLimitPerMin`, 0 = aus).
- **Konsole**: feste Datei-Allowlist (`/`, `/index.html`, `/styles.css`,
  `/app.js` — alles andere 404), strikte CSP, `X-Frame-Options: DENY`, `nosniff`,
  kein Framing, keine externen Ressourcen.
- **Timeouts**: `requestTimeout` 15 s, `headersTimeout` 10 s, `keepAliveTimeout`
  5 s — hängende Verbindungen binden keine Ressourcen. Tote WebSocket-Clients
  werden per Ping/Pong alle 30 s erkannt und getrennt.
- **Dateien**: Request-Body auf 512 KiB begrenzt; der CSV-Download-Pfad ist gegen
  Directory-Traversal abgesichert.
- **config.json** wird mit Dateirechten `0600` geschrieben. Secrets stehen dort
  im Klartext (lokaler Einzel-PC) — für Ports/Token besser `.env` nutzen.

## Was NICHT geschützt ist (bewusst)

- Der **Laserforce-Eingang** (`:9000`) hat keine Anmeldung — Laserforce liefert
  seinen Stream so. Wer auf diesen Port kommt, kann Spielereignisse fälschen.
  → gehört in ein vertrauenswürdiges Netz; `LF_TCP_HOST` einengen. (Der Parser
  ist gegen unbegrenztes Wachstum abgesichert: Team-Indizes außerhalb 0–31 werden
  verworfen; echte Laserforce-Feeds nutzen 0–7.)
- Der **Raw-TCP-Stream** ohne gesetztes `LF_API_TOKEN` hat keine Anmeldung —
  daher bindet er per Default nur an `127.0.0.1`.
- Ohne Token ist die Konsole für **jeden im LAN** offen. Auf einem geschlossenen
  Event-Netz ist das ok; sonst Token setzen.

## Empfehlung für ein nicht-vertrauenswürdiges Netz

```ini
LF_HTTP_HOST=0.0.0.0
LF_API_TOKEN=<mind. 24 zufällige Zeichen>
LF_CORS_ORIGINS=
LF_TCP_HOST=192.168.10.0     # nur das Segment, in dem Laserforce hängt (Beispiel)
LF_OUTPUT_ALLOW=192.168.10.50:7000,regie.hallen.lan
```

Wenn die Konsole über HTTPS erreichbar sein soll: einen TLS-Reverse-Proxy
(Caddy/nginx) davorstellen, `LF_HTTP_HOST=127.0.0.1` **und** — damit Rate-Limit
und Audit-Log die echte Client-IP sehen — `LF_TRUST_PROXY=true` setzen. Ohne
eigenen Proxy davor bleibt `LF_TRUST_PROXY` aus.
