# Start-Benachrichtigung — „auf welcher IP läuft die Kiste?"

Der Hallen-PC hat oft keinen Monitor — und manchmal auch keine Tastatur, keinen
SSH-Zugang, gar nichts. Damit du trotzdem weißt, unter welcher Adresse die
Konsole erreichbar ist, schickt lf_live beim Start **eine kurze Nachricht** an
einen Kanal deiner Wahl — und noch einmal, wenn sich die IP-Adresse ändert
(neuer DHCP-Lease, Kabel umgesteckt).

Eingerichtet wird ein Kanal entweder mit **einer Zeile in der `.env`** oder
direkt in der Konsole unter *Einstellungen → Start-Benachrichtigung → Kanäle
einrichten*.

## Was wann gesendet wird

| Anlass | Inhalt |
|---|---|
| **Allererster Start** (noch kein Passwort) | IP, Ports **und das erzeugte Admin-Passwort** |
| jeder weitere Start | nur IP, Ports, Zugangsart |
| IP-Adresse ändert sich | die neue Adresse |
| „Passwort vergessen" in der Konsole | ein Wiederherstellungs-Code, 15 Minuten gültig |
| Knopf *Testnachricht senden* | wie ein normaler Start |

### Erster Start

```
LF Live gestartet — Halle 1

Konsole:  http://192.168.1.42:8080/
weitere:  http://localhost:8080/

Rechner:      HALLEN-PC  (win32 10.0.22631)
IP-Adressen:  192.168.1.42 (Ethernet), 10.8.0.3 (WLAN)
Web/API:      0.0.0.0:8080  (im ganzen LAN)
Laserforce:   0.0.0.0:9000  (Log-Stream rein)
Zugang:       Admin-Passwort erforderlich

── Erster Start ──
Admin-Passwort:  dJAo-8KYi-dxU8-T9wJ
Bitte nach dem ersten Login in der Konsole ändern.
```

Jeder weitere Start schickt denselben Block **ohne** die letzten drei Zeilen.

> Das Passwort steht damit in deinem Discord-Kanal bzw. Postfach. Es ist genau
> dafür gedacht, einmal benutzt und dann geändert zu werden — auf einem Rechner
> ohne Bildschirm gibt es keinen anderen Weg, es je zu erfahren. Wer das nicht
> will, setzt `LF_NOTIFY_INCLUDE_INITIAL_PASSWORD=false`; dann steht in der
> Nachricht nur, in welcher Datei auf dem Rechner es liegt.

### Ohne eingerichteten Kanal

Dann erzeugt lf_live **kein** Passwort — sonst gäbe es eins, das niemand kennt.
Stattdessen zeigt die Konsole beim ersten Aufruf die Seite `/setup`, auf der du
es selbst vergibst. Bis dahin ist alles andere gesperrt.

---

## Kanäle

Alle sind optional, mehrere gleichzeitig sind erlaubt. Ein Kanal ohne Eintrag
wird stillschweigend übersprungen. Die `.env`-Zeilen unten haben jeweils ein
Gegenstück in der Konsole (*Einstellungen → Start-Benachrichtigung → Kanäle
einrichten*) — nimm das eine **oder** das andere.

### ntfy — am wenigsten Aufwand

Kein Konto, keine Anmeldung. App „ntfy" installieren (Android/iOS/Web), ein
Thema abonnieren, denselben Namen hier eintragen:

```ini
LF_NOTIFY_NTFY_TOPIC=lf-live-halle1
```

> Das Thema ist auf ntfy.sh **öffentlich** — wer den Namen errät, liest mit.
> Nimm etwas Unrätselhaftes (`lf-live-halle1-x7f3q2`) oder einen eigenen
> ntfy-Server mit `LF_NOTIFY_NTFY_SERVER` + `LF_NOTIFY_NTFY_TOKEN`.

### Discord

Im Zielkanal: *Kanal bearbeiten → Integrationen → Webhooks → Neuer Webhook →
Webhook-URL kopieren*.

```ini
LF_NOTIFY_DISCORD_WEBHOOK=https://discord.com/api/webhooks/…/…
```

### Slack

Incoming-Webhook der Slack-App anlegen, URL eintragen:

```ini
LF_NOTIFY_SLACK_WEBHOOK=https://hooks.slack.com/services/…
```

### Telegram

Bot bei `@BotFather` anlegen, dem Bot einmal schreiben, Chat-ID über
`https://api.telegram.org/bot<TOKEN>/getUpdates` ablesen:

```ini
LF_NOTIFY_TELEGRAM_TOKEN=123456:ABC-DEF…
LF_NOTIFY_TELEGRAM_CHAT_ID=987654321
```

### E-Mail

Direkt per SMTP, ohne Zusatzpaket. Port `587` = STARTTLS (Normalfall),
Port `465` = sofortiges TLS, dann zusätzlich `LF_NOTIFY_SMTP_SECURE=true`.

```ini
LF_NOTIFY_EMAIL_TO=technik@beispiel.de
LF_NOTIFY_SMTP_HOST=smtp.beispiel.de
LF_NOTIFY_SMTP_PORT=587
LF_NOTIFY_SMTP_USER=lf-live@beispiel.de
LF_NOTIFY_SMTP_PASS=…
LF_NOTIFY_SMTP_FROM=lf-live@beispiel.de
```

Mehrere Empfänger: durch Komma trennen. Bei Gmail/Outlook braucht es ein
**App-Passwort**, nicht das Kontopasswort.

### Eigener Webhook

Bekommt alles als JSON — inklusive der vollständigen Netzwerk-Infos unter
`info`, so wie sie auch `GET /api/network` liefert:

```ini
LF_NOTIFY_WEBHOOK_URL=https://regie.beispiel.de/lf-live
LF_NOTIFY_WEBHOOK_SECRET=…        # optional
```

```jsonc
{
  "service": "lf-live", "event": "status", "ts": 1767200000000,
  "title": "LF Live gestartet — Halle 1",
  "text":  "Konsole:  http://192.168.1.42:8080/\n…",
  "info":  { "hostname": "…", "addresses": [ … ], "urls": [ … ], "http": { … }, "tcp": { … } }
}
```

Mit `secret` wird wie bei den Ausgängen signiert:
`X-LFB-Signature: sha256=HMAC_SHA256(secret, "<X-LFB-Timestamp>.<body>")`.

---

## Schalter

| Variable | Standard | Bedeutung |
|---|---|---|
| `LF_NOTIFY_ENABLED` | `true` | Hauptschalter |
| `LF_NOTIFY_NAME` | *(Rechnername)* | Name der Anlage in Titel/Betreff, z. B. `Halle 1` |
| `LF_NOTIFY_ON_START` | `true` | einmal beim Start senden |
| `LF_NOTIFY_ON_IP_CHANGE` | `true` | senden, wenn sich die IP-Adressen ändern (Prüfung jede Minute) |
| `LF_NOTIFY_INCLUDE_INITIAL_PASSWORD` | `true` | das beim ersten Start erzeugte Admin-Passwort mit in die Nachricht schreiben. `false` → nur der Dateipfad auf dem Rechner |

**Alles davon** — Schalter, Name und die Kanäle selbst — lässt sich auch in der
Konsole unter *Einstellungen → Start-Benachrichtigung* pflegen, inklusive einem
Knopf **„Testnachricht senden"**. Ein in der `.env` gesetzter Wert ist wie
überall **gepinnt** und wird in der Konsole nur lesbar angezeigt.

Secrets (Webhook-URLs, Bot-Token, Mail-Passwort) werden nie zurück ausgeliefert:
das Feld zeigt dann `••••••`. So lassen behält den Wert, leeren entfernt den
Kanal.

---

## Ausgesperrt: „Passwort vergessen"

Auf einem Rechner ohne Shell ist der Benachrichtigungskanal auch der Weg zurück.
Auf der Anmeldeseite **„Passwort vergessen?" → „Code senden"**:

```
LF Live — Wiederherstellungs-Code für Halle 1

Code:     7KQR-M2XT-P9WD
gültig:   15 Minuten
Konsole:  http://192.168.1.42:8080/
```

Code auf der Seite eintragen, neues Passwort setzen, fertig. Wichtig:

- Der Code geht **nur** über den Kanal raus, nie über die HTTP-Antwort — wer den
  Knopf drückt, aber deinen Discord nicht liest, erfährt nichts.
- Das **alte Passwort bleibt gültig**, bis der Code eingelöst wird. Jemand, der
  den Knopf aus Spaß drückt, sperrt dich also nicht aus.
- Ein Code gilt einmal, höchstens einer ist offen, und es geht höchstens alle
  2 Minuten einer raus.
- Ohne eingerichteten Kanal geht das nicht — dann hilft nur `npm run setpw` am
  Rechner. Deshalb: **gleich nach der Einrichtung einen Kanal anlegen.**

---

## Fehlersuche

- **Nichts kommt an** → Konsole → *Einstellungen → Start-Benachrichtigung →
  „Testnachricht senden"*. Das Ergebnis je Kanal steht direkt daneben; Details
  stehen im Log (Scope `notify`).
- **Kein Kanal aufgeführt** → die `.env` wurde nicht gelesen (liegt sie im
  Arbeitsverzeichnis des Dienstes?) oder die Zeile ist noch auskommentiert.
- **E-Mail: „Server bietet weder AUTH PLAIN noch AUTH LOGIN an"** → meist der
  falsche Port: `587` statt `465` (oder umgekehrt mit `…_SECURE=true`).
- **Ein Fehler beim Senden hält den Dienst nie auf** — er wird geloggt, das
  Match läuft weiter.

## Ohne Benachrichtigung

Auch ohne jeden Kanal stehen die Adressen beim Start im Log:

```
INFO lf-live: console: http://localhost:8080/   ·   http://192.168.1.42:8080/
INFO lf-live: this PC: HALLEN-PC — 192.168.1.42 (Ethernet)
```

und laufend unter `GET /api/network` bzw. in der Konsole oben in
*Einstellungen → Netzwerk · Ports*.
