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
| Zugriffs-Token | keiner | `LF_API_TOKEN=<lang & zufällig>` |
| CORS | `*` (nur GET aus dem Browser) | `LF_CORS_ORIGINS=` (leer) oder feste Liste |
| Rate-Limit | 600 / Min / IP | niedriger via `LF_RATE_LIMIT_PER_MIN` |

## Was geschützt ist

- **Zugriffs-Token** (`LF_API_TOKEN` / Konsole): wenn gesetzt, brauchen **jede**
  `/api/*`-Anfrage (außer `/api/health`), der WebSocket und die Konsole ein
  `Authorization: Bearer <token>` bzw. `?token=<token>`. Zeitkonstanter Vergleich.
- **CORS**: nur Origins aus `cors` bekommen `Access-Control-Allow-Origin`.
  Cross-Origin-Anfragen können **nur GET** sein (`Allow-Methods: GET, OPTIONS`) —
  eine fremde Website kann die Konfiguration also nicht per POST ändern.
- **CSRF**: läuft die Instanz **ohne Token**, werden mutierende POSTs nur von
  **gleicher Herkunft** akzeptiert (`Sec-Fetch-Site` / `Origin`). Eine Website,
  die der Operator besucht, kann den Hallen-PC nicht umkonfigurieren.
- **Rate-Limit** pro IP auf der HTTP-API (`rateLimitPerMin`, 0 = aus).
- **Konsole**: strikte CSP, `X-Frame-Options: DENY`, `nosniff`, kein Framing,
  keine externen Ressourcen.
- **Dateien**: Request-Body auf 512 KiB begrenzt; Statik- und CSV-Download-Pfade
  sind gegen Directory-Traversal abgesichert.
- **config.json** wird mit Dateirechten `0600` geschrieben. Secrets stehen dort
  im Klartext (lokaler Einzel-PC) — für Ports/Token besser `.env` nutzen.

## Was NICHT geschützt ist (bewusst)

- Der **Laserforce-Eingang** (`:9000`) hat keine Anmeldung — Laserforce liefert
  seinen Stream so. Wer auf diesen Port kommt, kann Spielereignisse fälschen.
  → gehört in ein vertrauenswürdiges Netz; `LF_TCP_HOST` einengen.
- Der **Raw-TCP-Stream** (falls aktiviert) hat keine Anmeldung — daher bindet er
  per Default nur an `127.0.0.1`.
- Ohne Token ist die Konsole für **jeden im LAN** offen. Auf einem geschlossenen
  Event-Netz ist das ok; sonst Token setzen.

## Empfehlung für ein nicht-vertrauenswürdiges Netz

```ini
LF_HTTP_HOST=0.0.0.0
LF_API_TOKEN=<mind. 24 zufällige Zeichen>
LF_CORS_ORIGINS=
LF_TCP_HOST=192.168.10.0     # nur das Segment, in dem Laserforce hängt (Beispiel)
```

Wenn die Konsole über HTTPS erreichbar sein soll: einen TLS-Reverse-Proxy
(Caddy/nginx) davorstellen und `LF_HTTP_HOST=127.0.0.1` setzen.
