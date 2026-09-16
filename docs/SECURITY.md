# Sicherheit

lf_live läuft auf **einem PC in einem Hallen-LAN**. Es kontaktiert **keine
externen Dienste**. Das Sicherheitsmodell ist auf genau diese Situation
zugeschnitten.

## Auf einen Blick

| | Standard | Härter |
|---|---|---|
| **Konsolen-Login** | **an** — Passwort beim ersten Start erzeugt | eigenes Passwort setzen (Konsole oder `npm run setpw`) |
| Web/API-Bind | `0.0.0.0` (ganzes LAN) | `LF_HTTP_HOST=127.0.0.1` — nur dieser PC |
| Laserforce-Bind | `0.0.0.0` | `LF_TCP_HOST=<Hallen-Subnetz>` |
| Raw-TCP-Stream | **aus**, Bind `127.0.0.1` | so lassen; für LAN gezielt `LF_STREAM_HOST=0.0.0.0` |
| Zugriffs-Token | keiner | `LF_API_TOKEN=<lang & zufällig>` — für Programme; schützt auch den Raw-Stream |
| CORS | **keine** (leer) | so lassen; nur bei Bedarf feste Liste in `LF_CORS_ORIGINS` |
| Rate-Limit | 600 / Min / IP | niedriger via `LF_RATE_LIMIT_PER_MIN` |
| Ausgangs-Ziele | beliebig | `LF_OUTPUT_ALLOW=host1,\*.beispiel.de:443` |
| `X-Forwarded-For` | wird **ignoriert** | nur hinter eigenem Reverse-Proxy: `LF_TRUST_PROXY=true` |

## Zwei Arten von Zugang

| | für | wie |
|---|---|---|
| **Admin-Login** | Menschen an der Konsole | Passwort auf `/login`, danach ein Session-Cookie |
| **Zugriffs-Token** | Programme (Overlays, Regie-Tools, curl) | `Authorization: Bearer <token>` bzw. `?token=` |

Beides ist unabhängig: eins von beidem reicht, um an die API zu kommen. Die
Konsole (HTML/JS) gibt es nur gegen ein gültiges Login **oder** Token.

## Der Konsolen-Login

### Der erste Start

Es gibt nie einen Zustand, in dem die Konsole offen ist — und nie einen, in dem
ein Passwort existiert, das niemand kennt. Welcher der beiden Wege greift, hängt
nur daran, ob ein Benachrichtigungskanal eingerichtet ist ([NOTIFY.md](NOTIFY.md)):

| | Ablauf |
|---|---|
| **mit Kanal** | Ein zufälliges Passwort wird erzeugt und geht mit der Startnachricht raus (Discord/ntfy/Mail). Zusätzlich im Log und in `data/initial-admin-password.txt` (`0600`). |
| **ohne Kanal** | Es wird **keines** erzeugt. Die Konsole liefert nur `/setup` aus — dort vergibst du es im Browser. Alles andere antwortet `401`, bis das erledigt ist. |

Beides braucht keinen Monitor und keine Shell auf dem Hallen-PC. Nach dem ersten
Login: Passwort ändern und die Datei löschen.
- **Gespeichert** wird nur ein **scrypt**-Hash (N=16384, r=8, p=1, 16-Byte-Salt)
  in `config.json` (`0600`). Der Vergleich ist zeitkonstant und läuft
  asynchron — ein Anmeldeversuch blockiert kein laufendes Match.
- **Session**: `Set-Cookie: lf_sess=…; HttpOnly; SameSite=Lax; Path=/`
  (zusätzlich `Secure`, wenn die Anfrage wirklich über TLS kam). Gültig
  `admin.sessionHours` Stunden (Standard 12), Laufzeit **absolut**, keine
  Verlängerung. Gespeichert wird serverseitig nur der SHA-256 des Cookie-Werts;
  ein Neustart meldet alle ab.
- **Brute-Force-Bremse**: nach `admin.maxFailedLogins` Fehlversuchen (Standard 8)
  ist die **IP** für `admin.lockoutMinutes` (Standard 10) gesperrt; jeder weitere
  Versuch in der Sperre verlängert sie (max. 8-fach). Jeder Fehlversuch kostet
  zusätzlich 400 ms und erzeugt eine `warn`-Zeile im Audit-Log.
- **Passwort ändern**: Konsole → *Einstellungen → Konsolen-Login*. Verlangt das
  aktuelle Passwort und **meldet danach alle anderen Browser ab**. Das Passwort
  läuft nie über `POST /api/config`, sondern nur über `POST /api/auth/password`.
- **Ausgesperrt, ohne Zugriff auf den Rechner?** Auf der Anmeldeseite
  *„Passwort vergessen?"*: ein einmaliger Code geht über den
  Benachrichtigungskanal raus (15 Minuten gültig, höchstens alle 2 Minuten
  einer). Der Code steht **nur** in dieser Nachricht, nie in einer
  HTTP-Antwort, und das **alte Passwort bleibt gültig, bis er eingelöst wird** —
  wer den Knopf drückt, sperrt damit niemanden aus. Ein falscher Code zählt als
  Fehlversuch und geht in dieselbe IP-Sperre.
- **Ausgesperrt, mit Zugriff auf den Rechner?** Im Programmordner — **Dienst vorher stoppen**,
  danach wieder starten (der laufende Dienst hält seine Konfiguration im
  Speicher und würde die Datei beim nächsten Konsolen-Speichern überschreiben):
  ```
  npm run setpw              # neues Passwort eingeben
  npm run setpw -- --random  # zufälliges erzeugen und anzeigen
  npm run setpw -- --show    # nur nachsehen, ob/woher ein Passwort gesetzt ist
  ```
- **Fest verdrahten**: `LF_ADMIN_PASSWORD=…` (oder `LF_ADMIN_PASSWORD_HASH=…`)
  in der `.env`. Dann ist es gepinnt — Konsole und `setpw` können es nicht mehr
  ändern, nur die `.env`.
- **Abschalten**: `LF_ADMIN_ENABLED=false` bzw. der Schalter in der Konsole.
  Dann ist die Konsole für jeden im LAN offen — nur auf einem geschlossenen
  Testnetz sinnvoll. Der Dienst warnt beim Start darüber.

## Was sonst geschützt ist

- **Zugriffs-Token** (`LF_API_TOKEN` / Konsole): wenn gesetzt, kommt man damit an
  **jede** `/api/*`-Anfrage (außer `/api/health` und `/api/auth/*`), den
  WebSocket und den Raw-TCP-Stream — auch ohne Login. Zeitkonstanter Vergleich.
- **Raw-TCP-Stream**: ist ein Token gesetzt, muss ein neuer Client als **erste
  Zeile** `{"token":"<token>"}\n` schicken — innerhalb von 2 Sekunden, sonst wird
  die Verbindung getrennt (zeitkonstanter Vergleich, Warnung im Log). Ohne Token
  verhält sich der Stream wie bisher.
- **Secrets werden nie ausgeliefert**: `GET /api/config` liefert `apiToken: ""`
  plus `apiTokenSet: true|false`, `admin.passwordHash: ""` plus
  `adminPasswordSet: true|false`, jeden eingerichteten Benachrichtigungs-Kanal
  (Webhook-URLs, Bot-Token, Mail-Passwort) und jedes gesetzte
  `outputs[].secret` als Maske `••••••`. Zurückgeschickte Maske = gespeicherten
  Wert behalten; leeres Feld = entfernen. Ein `admin.passwordHash` im Patch wird
  **immer verworfen** — Passwörter laufen nur über `/api/auth/*`. Beim Speichern gilt: leerer `apiToken` = **unverändert** (löschen nur
  mit `apiTokenClear: true`), zurückgeschickte Maske = **gespeichertes Secret
  behalten**. Die Konsole kann die Konfiguration also gefahrlos zurückschreiben.
- **Audit-Log**: jede angenommene Änderung an `/api/config`, jeder
  `/api/outputs/test`, jeder `/api/notify/test`, jeder **erfolgreiche und
  fehlgeschlagene Login**, die Ersteinrichtung, jede angeforderte
  Wiederherstellung und jede Passwortänderung erzeugen eine `warn`-Zeile
  (Scope `audit`) mit Client-IP — **nie** mit Werten von Secrets.
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
- **CSRF**: der Session-Cookie ist `SameSite=Lax`, und **zusätzlich** verlangt
  jede mutierende Anfrage ohne Token `Sec-Fetch-Site: same-origin` oder
  `X-LF-Console: 1` (siehe unten). Auch der Login selbst geht durch diese Prüfung.
- **Konsole**: feste Datei-Allowlist (`/`, `/index.html`, `/styles.css`,
  `/app.js`, `/login`, `/login.js`, `/setup`, `/setup.js` — alles andere 404),
  strikte CSP, `X-Frame-Options: DENY`, `nosniff`, kein Framing, keine externen
  Ressourcen. Ohne Anmeldung liefern `/` und `/app.js` nur eine Umleitung auf
  `/login` bzw. `/setup`; öffentlich sind ausschließlich diese beiden Seiten,
  ihre Skripte und das Stylesheet.
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
  daher bindet er per Default nur an `127.0.0.1`. Der Konsolen-Login schützt ihn
  **nicht**.
- **Kein HTTPS**: Passwort und Session-Cookie gehen im Klartext über das LAN.
  Gegen einen Mitleser im selben Netz hilft nur ein TLS-Reverse-Proxy davor
  (siehe unten). Auf einem geschlossenen Hallen-Netz ist das vertretbar.
- Mit `LF_ADMIN_ENABLED=false` ist die Konsole für **jeden im LAN** offen.
- **Das Einrichtungsfenster**: solange `/setup` offen steht (kein Passwort, kein
  Benachrichtigungskanal), kann **jeder im LAN**, der die Seite zuerst aufruft,
  das Passwort vergeben. Anders geht es auf einem Rechner ohne Bildschirm nicht.
  Deshalb: gleich nach der Installation einrichten — oder vorher
  `LF_ADMIN_PASSWORD` in die `.env` schreiben, dann gibt es das Fenster nie.
  Der Dienst warnt bei jedem Start, solange noch nichts eingerichtet ist, und
  schickt es über einen eingerichteten Kanal auch heraus.
- `/api/health` und `/api/auth/session` bleiben immer ohne Anmeldung erreichbar
  (für Monitoring bzw. die Login-Seite). Sie verraten nur, ob der Dienst läuft,
  ob gerade ein Match aktiv ist und ob ein Login verlangt wird.

## Empfehlung für ein nicht-vertrauenswürdiges Netz

```ini
LF_HTTP_HOST=0.0.0.0
LF_ADMIN_PASSWORD=<mind. 12 zufällige Zeichen>   # oder in der Konsole setzen
LF_ADMIN_SESSION_HOURS=8
LF_API_TOKEN=<mind. 24 zufällige Zeichen>        # nur wenn Programme die API nutzen
LF_CORS_ORIGINS=
LF_TCP_HOST=192.168.10.0     # nur das Segment, in dem Laserforce hängt (Beispiel)
LF_OUTPUT_ALLOW=192.168.10.50:7000,regie.hallen.lan
```

Wenn die Konsole über HTTPS erreichbar sein soll: einen TLS-Reverse-Proxy
(Caddy/nginx) davorstellen, `LF_HTTP_HOST=127.0.0.1` **und** — damit Rate-Limit
und Audit-Log die echte Client-IP sehen — `LF_TRUST_PROXY=true` setzen. Ohne
eigenen Proxy davor bleibt `LF_TRUST_PROXY` aus.
