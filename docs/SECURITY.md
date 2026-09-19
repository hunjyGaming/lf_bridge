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
| CORS | **keine** (leer) | so lassen; nur bei Bedarf feste Liste in `LF_CORS_ORIGINS` — [Anzeige auf einem zweiten Rechner](#anzeige-auf-einem-zweiten-rechner-anbinden) |
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

## Passwort noch einmal — für löschende Eingriffe

Drei Vorgänge nehmen Daten **unwiederbringlich** weg, und für die genügt eine
angemeldete Sitzung ausdrücklich **nicht**:

| Vorgang | wo |
|---|---|
| eine Statistik-Datei löschen | Konsole → Statistik → Dateien |
| die Statistik zurücksetzen | Konsole → Statistik → *Alles zurücksetzen…* |
| alle Roh-Mitschnitte löschen | Konsole → Rohdaten → *Alle löschen…* |

Der Grund ist unspektakulär: eine Konsole in der Halle steht offen, während der
Betrieb läuft. Wer davorsteht, hat die Sitzung — eine Ja/Nein-Rückfrage im
Browser hält niemanden auf, und sie liegt ohnehin auf der Seite des Clients.

Deshalb wird das Admin-Passwort **erneut getippt** und **serverseitig** geprüft
(`_passwordOk` in `src/apiServer.js`):

- gegen denselben scrypt-Hash wie `/api/auth/login` (`verifyPassword`,
  zeitkonstant),
- hinter **derselben** Fehlversuchs-Bremse je IP (`LoginGuard`) — ein
  Fehlversuch zählt genauso wie am Login, und die Sperre gilt für beides. Diese
  Routen sind also kein schnellerer Weg zum Durchprobieren,
- mit derselben absichtlichen Verzögerung von 400 ms je Fehlversuch,
- jeder Versuch, erfolgreich oder nicht, steht im Audit-Log mit IP und Vorgang.

Ein falsches Passwort führt **keinen Teil** der Aktion aus: erst wird geprüft,
dann gelöscht. Ist auf der Installation gar kein Passwort gesetzt (nur Token,
oder Admin-Bereich abgeschaltet), gibt es nichts zu prüfen — der Vorgang läuft
hinter dem normalen Zugangsschutz und das Audit-Log vermerkt ausdrücklich „ohne
Passwortbestätigung".

Das Zurücksetzen der Statistik leert außerdem die Summen im Arbeitsspeicher des
Statistik-Schreibers, nicht nur die Dateien — siehe [STATS.md](STATS.md).

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
- **Broker-URL mit Zugangsdaten**: trägt `mqtt.url` ein `benutzer:passwort@`,
  wird es **überall** zu `mqtt://***@host` — im Log, in `GET /api/status` und
  in `GET /api/config`. Schickt die Konsole die maskierte Form zurück, bleibt
  der gespeicherte Wert unverändert. Besser ist trotzdem `LF_MQTT_USERNAME` /
  `LF_MQTT_PASSWORD`: die stehen nur in der Umgebung, haben kein Gegenstück in
  `config.json` und werden erst im Moment des Verbindungsaufbaus gelesen
  ([CONFIG.md](CONFIG.md#was-es-nur-in-der-umgebung-gibt)).
- **Zugangsdaten in Fehlermeldungen**: eine abgelehnte SMTP-Anmeldung meldet den
  **Schritt**, der scheiterte (`AUTH LOGIN (Passwort) -> 535 …`), niemals die
  gesendete Zeile. Bei `AUTH LOGIN` ist diese Zeile das base64-kodierte
  Passwort, und die Fehlermeldung landet über `notify.last` im Log, in
  `GET /api/status` und in `GET /api/network`.
- **Audit-Log**: jede angenommene Änderung an `/api/config`, jeder
  `/api/outputs/test`, jeder `/api/notify/test`, jeder **erfolgreiche und
  fehlgeschlagene Login**, die Ersteinrichtung, jede angeforderte
  Wiederherstellung, jede Passwortänderung und jeder löschende Eingriff in
  Statistik oder Mitschnitte (auch der **abgelehnte**) erzeugen eine
  `warn`-Zeile (Scope `audit`) mit Client-IP — **nie** mit Werten von Secrets.
- **CORS**: nur Origins aus `cors` bekommen `Access-Control-Allow-Origin`
  (Standard: **leer** = keine). Cross-Origin-Anfragen können **nur GET** sein
  (`Allow-Methods: GET, OPTIONS`). Die Konsole selbst ist same-origin und braucht
  kein CORS. Eine abgewiesene Herkunft ist **nicht mehr stumm**: die Antwort
  trägt `X-LF-Origin-Allowed: 0`, der Dienst schreibt eine `warn`-Zeile (Scope
  `http`, gedrosselt auf eine je Herkunft und Minute), und
  [`GET /api/access`](API.md#get-apiaccess--immer-offen) sagt es dem Aufrufer direkt.
  Ausgeliefert wird die **Liste** der erlaubten Herkünfte dabei nie.
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
  `/app.js`, `/login`, `/login.html`, `/login.js`, `/setup`, `/setup.html`,
  `/setup.js` — alles andere 404),
  strikte CSP, `X-Frame-Options: DENY`, `nosniff`, kein Framing, keine externen
  Ressourcen. Ohne Anmeldung liefern `/` und `/app.js` nur eine Umleitung auf
  `/login` bzw. `/setup`; öffentlich sind ausschließlich diese beiden Seiten,
  ihre Skripte und das Stylesheet.
- **Herkunft der eigenen Konsole**: eine Anfrage, deren `Origin` genau die
  Adresse ist, unter der sie hier ankam, gilt immer als erlaubt. Ein Browser
  schickt `Origin` auch bei einer same-origin-POST — ohne diese Regel meldete
  jeder Login und jedes Speichern eine CORS-Warnung, die sachlich falsch ist.
  Gefälscht werden kann damit nichts: den `Host`-Kopf setzt der Browser selbst,
  und wer kein Browser ist, unterliegt CORS ohnehin nicht.
- **Timeouts**: `requestTimeout` 15 s, `headersTimeout` 10 s, `keepAliveTimeout`
  5 s — hängende Verbindungen binden keine Ressourcen. Tote WebSocket-Clients
  werden per Ping/Pong alle 30 s erkannt und getrennt.
- **Dateien**: Request-Body auf 512 KiB begrenzt; die CSV- und
  Mitschnitt-Pfade sind gegen Directory-Traversal abgesichert — Backslashes
  normalisiert, `..` und absolute Pfade abgewiesen, der aufgelöste Pfad muss im
  jeweiligen Ordner bleiben, und der Name muss zum erlaubten Muster passen
  (`.csv` bzw. `[A-Za-z0-9._-]+.(tdf|txt)`). **Löschen benutzt dieselbe Prüfung
  wie Lesen**, nicht eine zweite eigene.
- **Rohdaten auf dem Bildschirm**: die Zeilen aus dem TCP-Feed sind beliebige
  Bytes und werden in der Konsole **ausschließlich** über Textknoten ausgegeben
  (`rawRow()` in `src/web/app.js`) — nirgends `innerHTML`. Der Tabulator-Pfeil
  ist ein leerer Knoten, dessen Zeichen aus dem Stylesheet kommt. Zeilen über
  4096 Bytes werden für die Live-Ansicht mit einem sichtbaren Vermerk gekürzt;
  die aufgezeichnete Datei bleibt davon unberührt byteweise vollständig.
- **Namen aus dem Strom sind Fremdeingabe**: ein Spieler wählt seinen Codenamen
  selbst, und nichts am TCP-Feed ist beglaubigt. Spieler- und Teamnamen werden
  deshalb beim Einlesen von Steuerzeichen (C0 **und** C1) befreit und auf 64
  Zeichen gekürzt, bevor sie irgendwo landen — sonst stünde ein NUL oder eine
  ANSI-Fluchtsequenz in der lesbaren Ereignis-Logdatei und auf der Standardausgabe
  des Dienstes. Eine Entität, die sich `__proto__` nennt, wird abgewiesen, statt
  den Prototyp der Spielerliste zu ersetzen.
- **CSV-Formeln**: eine Zelle, die mit `=`, `+`, `-`, `@`, Tabulator oder CR
  beginnt, führt Excel, LibreOffice und Google Sheets als **Formel** aus — auch
  `=cmd|'…'!A0`, das nach einem externen Programm fragt. Da ein Spielername in
  jeder Statistikdatei landet und die Dateien für deutsches Excel geschrieben
  werden (`;`, BOM), markiert `csvCell()` solche Zellen mit einem
  vorangestellten Apostroph als Text. Eine echte Zahl — auch eine negative —
  bleibt unangetastet.
- **WebSocket**: Clients dürfen genau **zwei** Nachrichten senden —
  `{"type":"rawtap","on":…}` und `{"type":"subscribe",…}` (Auswahl des Feeds und
  der Ereignis-Bündelung, [API.md](API.md#die-nachrichten-die-ein-client-senden-darf)).
  Alles über 256 Bytes wird verworfen, ohne geparst zu werden, und alles andere
  ignoriert. Beide Nachrichten sind read-only — sie ändern nur, **was** dieser
  eine Client bekommt, nie etwas am Dienst. Ein abgelehnter Handshake nennt
  seinen Grund in `X-LF-Reason` und im Log, statt stumm zu schließen.
- **config.json** wird mit Dateirechten `0600` geschrieben. Secrets stehen dort
  im Klartext (lokaler Einzel-PC) — für Ports/Token besser `.env` nutzen.

## Anzeige auf einem zweiten Rechner anbinden

Der häufigste Fall: die Bridge läuft auf dem Hallen-PC, die Beamer-Anzeige auf
einem **anderen** Rechner im selben Netz. Das scheitert erfahrungsgemäß genau
hier — der Browser blockt still, die Anzeige bleibt leer, und nichts sagt warum.

### Die zwei Einstellungen

```ini
# .env auf dem HALLEN-PC (dem mit lf_live), danach Dienst neu starten
LF_API_TOKEN=<mind. 24 zufällige Zeichen>
LF_CORS_ORIGINS=http://anzeige-pc:5173
```

| | wofür | wo eintragen |
|---|---|---|
| **Zugriffs-Token** | lässt das Programm überhaupt an die Daten | `LF_API_TOKEN` oder Konsole → Einstellungen |
| **Herkunftsfreigabe** | erlaubt dem **Browser**, die Antwort zu benutzen | `LF_CORS_ORIGINS` oder Konsole → Einstellungen |

`LF_CORS_ORIGINS` ist eine Komma-Liste von **Origins**, nicht von URLs: Schema +
Host + Port, ohne Pfad und ohne Schrägstrich am Ende. `http://anzeige-pc:5173`
ist etwas anderes als `http://192.168.1.77:5173` und etwas anderes als
`http://anzeige-pc` — eingetragen werden muss **genau das**, was im
Adressfeld des Anzeige-Browsers vor dem Pfad steht.

> **Der WebSocket braucht die Herkunftsfreigabe NICHT.** Browser wenden CORS auf
> WebSocket-Verbindungen nicht an. `ws://hallen-pc:8080/ws?token=…` funktioniert
> also allein mit dem Token. Erst ein `fetch()` auf `/api/*` von derselben Seite
> braucht den `cors`-Eintrag. Wer nur den WebSocket nutzt, kommt mit **einer**
> Einstellung aus — wer beides nutzt, braucht beide. Diese Asymmetrie kostet die
> meiste Zeit bei der Fehlersuche.

### Prüfen, ob es geht

Vom **Anzeige-Rechner** aus, nicht vom Hallen-PC:

```bash
# 1. Ist der Dienst überhaupt da?
curl -i http://hallen-pc:8080/api/health

# 2. Kommt genau MEINE Kombination aus Token und Herkunft durch?
curl -i -H "Origin: http://anzeige-pc:5173" \
        -H "Authorization: Bearer $LF_API_TOKEN" \
        http://hallen-pc:8080/api/access
```

`/api/access` ist der Prüfstein und braucht selbst keine Anmeldung. Gut ist:

```jsonc
{ "data": { "authenticated": true, "originAllowed": true,
            "tokenAccepted": true, "problems": [] } }
```

Steht in `problems` etwas, steht dort im Klartext, was zu tun ist. Im Browser
derselbe Test aus der Konsole der Entwicklerwerkzeuge der Anzeigeseite:

```js
fetch("http://hallen-pc:8080/api/access", { headers: { Authorization: "Bearer <token>" } })
  .then(r => r.json()).then(x => console.log(x.data.problems));
```

### Die typischen Fehler, und woran man sie erkennt

| Symptom | Ursache | Abhilfe |
|---|---|---|
| Browser-Konsole: *„blocked by CORS policy"*; Antwort hat **kein** `Access-Control-Allow-Origin`, dafür `X-LF-Origin-Allowed: 0` | Herkunft nicht in `cors` | Origin in `LF_CORS_ORIGINS` eintragen — **genau** so, wie er im Adressfeld steht |
| `401 {"error":"unauthorized","tokenSent":false}` | kein Token mitgeschickt | `Authorization: Bearer <token>`, beim WebSocket `?token=<token>` |
| `401 … "tokenSent":true` | falsches Token | Token abgleichen (Groß-/Kleinschreibung, Leerzeichen am Ende) |
| WebSocket schließt sofort, JS meldet nur ein nacktes `error` | Handshake abgelehnt | Netzwerk-Tab: Status + Header `X-LF-Reason` (`unauthorized` / `not_found`). Im Dienst-Log steht dieselbe Ablehnung mit IP und Herkunft |
| `/api/health` von außen nicht erreichbar | Dienst hört nur lokal, oder Firewall | `LF_HTTP_HOST=0.0.0.0`; Windows-Firewall für den Port freigeben |
| Alles geht, aber nach einer Weile `429` | Rate-Limit | seltener pollen, besser den WebSocket nutzen; notfalls `LF_RATE_LIMIT_PER_MIN` anheben |
| Anzeige zeigt Daten, aber die Uhr läuft falsch | Restzeit selbst gerechnet | `clock.direction` / `clock.displayMs` verwenden — [API.md](API.md#die-uhr--die-eine-regel-an-der-alles-hängt) |

Zusätzlich schreibt der Dienst bei jeder abgewiesenen Herkunft eine `warn`-Zeile
(Scope `http`, höchstens eine je Herkunft und Minute) und bei jedem abgelehnten
WebSocket-Handshake eine im Scope `ws`. **Eine stumme Abweisung gibt es nicht
mehr** — sie steht entweder in der Antwort, im Header oder im Log.

Verraten wird dabei nichts Neues: `/api/access` sagt nur, was der Aufrufer
ohnehin selbst messen kann (seine eigene Herkunft, ob sein Token akzeptiert
wurde, ob ein Login verlangt wird). Die **Liste** der erlaubten Herkünfte und
alles über das Token selbst bleiben drin.

### Und wenn die Anzeige schreiben können soll?

Soll sie nicht. Alles Neue für Anzeigen ist **read-only** (`GET`). Für
mutierende Anfragen gilt unverändert: Cross-Origin geht nur `GET`
(`Allow-Methods: GET, OPTIONS`), und ohne gültiges Bearer-Token braucht ein
`POST` zusätzlich `Sec-Fetch-Site: same-origin` oder `X-LF-Console: 1`.

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
- `/api/health`, `/api/auth/session` und `/api/access` bleiben immer ohne
  Anmeldung erreichbar (für Monitoring, die Login-Seite und die Fehlersuche an
  einer Anzeige auf einem zweiten Rechner). Sie verraten nur, ob der Dienst
  läuft, ob gerade ein Match aktiv ist, ob ein Login verlangt wird — und, bei
  `/api/access`, was der Aufrufer über **sich selbst** ohnehin messen kann: die
  eigene Herkunft, ob sie freigegeben ist (das sagt schon der fehlende
  `Access-Control-Allow-Origin`-Header), und ob das eigene Token angenommen
  wurde. Die Liste der erlaubten Herkünfte und alles über das Token selbst
  bleiben drin. `/api/access` liegt **hinter** dem Rate-Limit.
- **Der WebSocket unterliegt nicht der `cors`-Liste** — Browser wenden CORS auf
  WebSocket-Verbindungen schlicht nicht an. Für `/ws` ist also **allein das
  Zugriffs-Token** (bzw. das Sitzungs-Cookie) die Schranke. Wer den Live-Zustand
  im LAN nicht jedem zeigen will, muss `LF_API_TOKEN` setzen; eine leere
  `cors`-Liste schützt `/ws` nicht. Das ist bewusst so gelassen: eine Anzeige
  auf einem zweiten Rechner ist genau so ein Cross-Origin-Browser-Client, und
  eine Sperre hier würde den vorgesehenen Fall unmöglich machen.

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
