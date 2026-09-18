# API-Referenz

> **Du baust nur eine Anzeige** (Beamer-Scoreboard, Overlay, Turniersystem)?
> Dann brauchst du von hier nur zwei Dinge: das Kapitel
> **[Für Anzeige-Entwickler](#für-anzeige-entwickler)** ganz unten und die
> Kurzanleitung
> [„Anzeige auf einem zweiten Rechner anbinden"](SECURITY.md#anzeige-auf-einem-zweiten-rechner-anbinden).
> Der Rest dieser Seite richtet sich an jemanden, der den Dienst betreibt.

Basis: `http://<hallen-pc>:8080` (Port aus der Konfiguration).

Solange die Ersteinrichtung offen ist (kein Admin-Passwort gesetzt), antwortet
**alles außer** `/api/health`, `/api/access`, `/api/auth/session` und `/api/auth/setup` mit
`401` — siehe [SECURITY.md](SECURITY.md).

Danach braucht jede Route außer `/api/health` und `/api/auth/*` **eine** von zwei
Berechtigungen:

```
Cookie: lf_sess=…             Admin-Login (Browser, siehe /api/auth/login)
Authorization: Bearer <token> Zugriffs-Token (Programme)
?token=<token>                dasselbe Token für WebSocket und Download-Links
```

Ist weder ein Admin-Passwort noch ein Token gesetzt, ist alles offen (nur auf
einem geschlossenen Netz sinnvoll — siehe [SECURITY.md](SECURITY.md)).

Antworten sind JSON. Weitere Regeln (siehe [SECURITY.md](SECURITY.md)):

- **CORS**: nur Origins aus `config.cors` bekommen `Access-Control-Allow-Origin`
  (per Default **leer** = keine). Cross-Origin geht **nur GET**.
- **Rate-Limit**: `config.rateLimitPerMin` je IP → sonst `429` mit `Retry-After`.
  IP = Socket-Adresse, außer `http.trustProxy` ist an (dann der linkeste
  `X-Forwarded-For`-Eintrag).
- **Mutierende Anfrage ohne gültiges Token** (`POST/PUT/PATCH/DELETE`): braucht
  `Sec-Fetch-Site: same-origin` **oder** den Header `X-LF-Console: 1`, sonst
  `403 cross_origin_blocked`. Skripte/curl schicken also `X-LF-Console: 1`.

---

## REST

### `GET /api/health`  — immer offen

```json
{ "ok": true, "service": "lf-live", "matchActive": true, "ts": 1699999999999 }
```

### `GET /api/auth/session`  — immer offen

Was die Login-Seite wissen muss. Verrät keine Secrets.

```json
{ "data": {
  "loginRequired": true, "setupPending": false,
  "authenticated": false, "viaSession": false,
  "tokenRequired": false, "passwordSet": true, "passwordPinned": false,
  "lockedForMs": 0, "sessionHours": 12,
  "recoveryChannels": ["Discord"], "recoveryPending": false, "recoveryCooldownMs": 0
} }
```

### `POST /api/auth/setup`  — nur vor der Ersteinrichtung

`{ "next": "…" }` — vergibt das allererste Admin-Passwort und meldet direkt an
(gleicher Cookie wie beim Login). Nur erreichbar, solange keines gesetzt ist;
danach `409 already_set_up`, und `/setup` leitet auf `/login` um.

### `POST /api/auth/recover` · `POST /api/auth/recover/confirm`

„Passwort vergessen" für einen Rechner ohne Shell. `recover` erzeugt einen
einmaligen Code und schickt ihn **ausschließlich** über die eingerichteten
Benachrichtigungskanäle — die HTTP-Antwort enthält ihn nie:

```json
{ "data": { "ok": true, "sentTo": ["Discord"], "expiresAt": 1699999999999 } }
```

| Antwort | Bedeutung |
|---|---|
| `409 { "error": "no_channel" }` | kein Benachrichtigungskanal → kein Weg, einen Code zu schicken |
| `409 { "error": "pinned" }` | Passwort steht in der `.env` |
| `429 { "error": "cooldown", "retryAfterMs": … }` | höchstens alle 2 Minuten einer |
| `502 { "error": "send_failed" }` | kein Kanal hat ihn angenommen (der Code wird verworfen) |

`recover/confirm` nimmt `{ "code": "…", "next": "…" }`, setzt das neue Passwort,
verwirft **alle** Sessions und meldet den Aufrufer neu an. Der Code gilt 15
Minuten und genau einmal; bis dahin bleibt das alte Passwort gültig. Ein
falscher Code (`401 bad_code`) zählt in dieselbe IP-Sperre wie ein Fehl-Login.

### `POST /api/auth/login`

`{ "password": "…" }` → `200` mit
`Set-Cookie: lf_sess=…; HttpOnly; SameSite=Lax; Path=/; Max-Age=…`

| Antwort | Bedeutung |
|---|---|
| `200 { "data": { "ok": true, "expiresInSec": 43200 } }` | angemeldet |
| `401 { "error": "bad_password" }` | falsch (jeder Versuch kostet 400 ms) |
| `429 { "error": "locked_out", "retryAfterMs": … }` | zu viele Fehlversuche von dieser IP |
| `400 { "error": "login_disabled" }` | es ist gar kein Login eingerichtet |
| `403 { "error": "cross_origin_blocked" }` | ohne `X-LF-Console: 1` / `Sec-Fetch-Site: same-origin` |

### `POST /api/auth/logout`

Beendet die eigene Session und löscht den Cookie. Immer `200`.

### `POST /api/auth/password`

`{ "current": "…", "next": "…" }` — braucht eine gültige Session oder ein Token.
Mindestens 8 Zeichen. Bei Erfolg werden **alle anderen Sessions ungültig**; die
aufrufende bekommt einen frischen Cookie.

| Antwort | Bedeutung |
|---|---|
| `200 { "data": { "ok": true } }` | geändert |
| `400 { "error": "weak_password", "hint": … }` | zu kurz/leer |
| `401 { "error": "bad_password" }` | `current` stimmt nicht |
| `409 { "error": "pinned" }` | `LF_ADMIN_PASSWORD` steht in der `.env` |

### `GET /api/access` — immer offen

**„Warum komme ich nicht rein?"** — der Endpunkt für eine Anzeige auf einem
zweiten Rechner. Er beantwortet genau die zwei Fragen, an denen am Turniertag
alles scheitert: *ist mein Token angekommen* und *ist meine Herkunft
freigegeben*. Ohne diese Antwort blockt der Browser still, und niemand weiß
warum. Kurzanleitung: [SECURITY.md](SECURITY.md#anzeige-auf-einem-zweiten-rechner-anbinden).

```jsonc
{ "data": {
  "service": "lf-live",
  "origin": "http://anzeige-pc:5173",  // was der Aufrufer selbst geschickt hat
  "originAllowed": false,              // false => der Browser verwirft jede Antwort STILL
  "authenticated": true,               // würde genau diese Anfrage durchgelassen?
  "tokenRequired": true,
  "tokenSent": true,
  "tokenAccepted": true,               // null, wenn gar kein Token verlangt wird
  "loginRequired": false,
  "viaSession": false,
  "setupPending": false,
  "websocket": { "path": "/ws", "corsApplies": false, "tokenRequired": true },
  "problems": [                        // im Klartext, was zu tun ist; leer = alles gut
    "die Herkunft http://anzeige-pc:5173 steht nicht in cors[] — der Browser verwirft die Antwort still; Origin in LF_CORS_ORIGINS eintragen"
  ],
  "ts": 1699999999999
} }
```

Bewusst ohne Anmeldung erreichbar — wer **nicht** hereinkommt, ist genau der,
der die Antwort braucht. Verraten wird dabei nichts Neues: die eigene Herkunft
hat der Aufrufer selbst geschickt, ob sie freigegeben ist sagt schon das
Vorhandensein des `Access-Control-Allow-Origin`-Headers, und ob ein Token oder
ein Login verlangt wird steht bereits in `/api/auth/session`. Die **Liste** der
erlaubten Herkünfte gibt der Endpunkt nie heraus, und über das Token selbst sagt
er nichts. Das Rate-Limit gilt wie überall.

### `GET /api/network`

„Wo bin ich erreichbar?" — dieselben Daten, die auch in der
Start-Benachrichtigung stehen ([NOTIFY.md](NOTIFY.md)).

```jsonc
{ "data": {
  "hostname": "HALLEN-PC", "platform": "win32 10.0.22631", "node": "v22.…", "pid": 4711,
  "addresses": [ { "iface": "Ethernet", "address": "192.168.1.42", "netmask": "255.255.255.0", "mac": "…" } ],
  "primary": "192.168.1.42",
  "http": { "bind": "0.0.0.0", "port": 8080, "lanOpen": true },
  "urls":  [ "http://localhost:8080/", "http://192.168.1.42:8080/" ],
  "tcp":    { "bind": "0.0.0.0", "port": 9000 },
  "stream": { "enabled": false, "bind": "127.0.0.1", "port": 9100 },
  "notify": { "configured": [ { "id": "ntfy", "label": "ntfy", "target": "ntfy.sh/lf-live-halle1" } ],
              "last": [ { "id": "ntfy", "ok": true, "detail": "gesendet", "at": 1699999999999 } ],
              "lastAt": 1699999999999 }
} }
```

### `POST /api/notify/test`

Schickt die Startnachricht sofort an alle eingerichteten Kanäle.

```json
{ "data": { "sent": [ { "id": "ntfy", "label": "ntfy", "ok": true, "detail": "gesendet" } ],
            "configured": [ … ] } }
```

### `GET /api/state`

Kompletter Snapshot. Siehe [State-Objekt](#state-objekt).

### `GET /api/teams`

```json
{ "data": { "teams": { "0": { "name": "Rot", "color": "#ef4444" } },
            "scores": { "0": 3, "1": 2 }, "missionActive": true } }
```

### `GET /api/players`

```json
{ "data": [ { "id": "1001", "name": "Mara", "teamId": "0", "goals": 2, ... } ] }
```

### `GET /api/events?since=<id>&limit=<n>`

Strukturierte Events mit `id` **größer als** `since` (Default `0`), älteste zuerst,
`limit` ≤ 200 (Default 50). Es werden die letzten 50 Events pro Match vorgehalten.
Für Polling: den höchsten `id`-Wert merken und als `since` mitgeben.

```json
{ "data": [ { "id": 42, "type": "goal", "actorName": "Tim", ... } ] }
```

### `GET /api/status`

Dienst-Status: `lan` (LAN-IP), Ports (`http` inkl. `trustProxy`, `cors`,
`rateLimitPerMin`, `clients`, `tokenSet`), `stateTickMs`, Laserforce-Verbindung,
CSV-Status, Ausgangs-Zustände (`outputs[]` mit `last`/`connected`), `outputAllow`,
Stream-Server, `envPins`, Match-Kurzinfo. Für Monitoring.

#### `data.match`

```jsonc
{
  "active": true,
  "matchId": "m1a2b3c",
  "elapsedMs": 123000,
  "durationMs": 900000,
  // ---- seit der Modus-Adaptivität, rein additiv ----
  "durationKnown": true,        // false = die Anlage hat keine Dauer gemeldet
  "remainingMs": 777000,        // fertig gerechnet; null wenn !durationKnown
  "mode": {
    "number": 28,               // Modus-Nummer aus der TDF-Typ-1-Zeile, oder null
    "key": "laserball_ranked",  // stabiler Kurzname für CSV/API
    "label": "Laserball Ranked",// Anzeigename — kommt ggf. AUS DEM STREAM
    "family": "laserball",      // 'laserball' | 'sm5' — steuert die Zähler
    "known": true,              // false = Nummer nicht in der Registry
    "source": "tdf"             // 'tdf' | 'inferred' | 'default'
  },
  "scoreSource": "tdf",         // 'tdf' = Punkte von der Anlage | 'internal' = Eigenzählung
  "endReason": null,            // wie das letzte Match endete (siehe unten), sonst null
  "endedAt": null,              // Zeitpunkt des Endes (ms seit Epoche), sonst null
  "players": 8,
  "teams":  { "0": { "name": "Rot", "color": "#ef4444" } },
  "scores": { "0": 3, "1": 2 }
}
```

`mode` ist `null`, solange die Engine noch gar keinen Zustand hat. Alle vorher
vorhandenen Felder sind unverändert geblieben.

#### Matchende — `endReason` / `endedAt`

Rein additiv, und ebenso in `/api/state` (`gameState.endReason`,
`gameState.endedAt`). Solange ein Match läuft, sind beide `null`.

| `endReason` | Bedeutung | Anzeige der Konsole |
|---|---|---|
| `mission_end` | die Anlage hat das Ende selbst gemeldet (Code `0101`) | „regulär beendet" |
| `watchdog` | kein Ende im Stream — Zeit abgelaufen bzw. anhaltende Stille | „vom Spielleiter beendet bzw. Zeitüberschreitung" |
| `stream_lost` | die Verbindung zur Anlage brach während des Matches ab | „Verbindung zur Anlage verloren" |
| `next_match` | die Anlage startete ein neues Match, ohne das alte zu beenden | „durch ein neues Match abgelöst" |
| `shutdown` | der Dienst wurde beendet, während das Match lief | „Dienst beendet" |

**Eine Uhr darf nie über das Matchende hinaus weiterlaufen.** Ist
`active: false`, steht sie — auch dann, wenn danach gar nichts mehr
hereinkommt. Die mitgelieferte Konsole hält sie zusätzlich an, sobald der Dienst
länger als zwölf Sekunden nichts Frisches mehr geliefert hat.

> **`label` kommt aus dem Stream** (bereinigt, max. 64 Zeichen), ebenso wie Team-
> und Spielernamen. In einer Weboberfläche ausschließlich als Text einsetzen, nie
> als HTML.

Was `source` und `known` bedeuten und wann sich `family` zur Laufzeit ändert:
[GAMEMODES.md](GAMEMODES.md#das-mode-objekt).

#### Die adaptive Spieluhr — Kernregel für Integratoren

**`remainingMs` kommt fertig aus der Engine. Rechne nie selbst
`durationMs - elapsedMs`.**

Meldet die Anlage keine Missionsdauer, steht `durationMs` auf einem
Vorgabewert, der **nichts** mit dem laufenden Spiel zu tun hat. Eine
Eigenberechnung ergäbe dann einen frei erfundenen Countdown, der irgendwann
negativ wird.

| `durationKnown` | `remainingMs` | Was die Anzeige tun muss |
|---|---|---|
| `true` | Zahl ≥ 0 | **Restzeit**: `remainingMs` herunterzählen |
| `false` | `null` | **Laufzeit**: `elapsedMs` von 0 an hochzählen |

Kurz: ist `remainingMs` gleich `null`, wird aufwärts gezählt. Sonst abwärts.
So macht es auch die mitgelieferte Web-Konsole.

### `GET /api/display`

**Der Anzeige-Datensatz** — alles, was ein Scoreboard, ein Beamer-Overlay oder
ein Turniersystem braucht, und nichts sonst. Gebaut aus **demselben**
`engine.snapshot()` wie `/api/state`, kann also nie davon abweichen.

| Parameter | Wirkung |
|---|---|
| *(keiner)* | kompletter Datensatz inkl. Spielerliste |
| `?players=none` | ohne Spielerliste (`players: null`) — für eine reine Punkteanzeige |

Vollständiges kommentiertes Beispiel, was stabil ist und was nicht, und ein
lauffähiges Minimalbeispiel: **[Für Anzeige-Entwickler](#für-anzeige-entwickler)**
weiter unten. Über WebSocket heißt derselbe Datensatz `/ws?feed=display`.

**Warum es ihn gibt, gemessen bei 50 Spielern (SM5-Profil, 15 Spalten):**

| | eine Antwort | bei 5 Pushes/s je Verbraucher |
|---|---|---|
| `/api/state` (voller Snapshot) | 69,5 KiB | 348 KiB/s |
| `/api/display` | 31,3 KiB (−55 %) | 157 KiB/s |
| `/api/display?players=none` | 2,4 KiB (−97 %) | 12 KiB/s |

Eine Anzeige, die nur Punkte und Uhr zeigt, kommt also mit einem Dreißigstel
aus. Der Datensatz enthält **keine** Ereignisliste, keine Rohwerte der Anlage
und nur die Spalten des laufenden Modus.

### `GET /api/modes`

Die Modus-Registry und der gerade erkannte Modus. Read-only, dieselbe
Auth-, CORS-, Token- und Rate-Limit-Behandlung wie jeder andere GET-Endpunkt.

```jsonc
{
  "data": {
    "families": ["laserball", "sm5"],
    "defaultFamily": "sm5",          // Familie für unbekannte Modus-Nummern
    "profiles": [                     // die Anzeigeprofile — was GEZEIGT wird
      { "profile": "standard",  "label": "Standard",  "family": "sm5",       "sort": ["score", "shotsHit"] },
      { "profile": "sm5",       "label": "SM5",       "family": "sm5",       "sort": ["score", "deactivations"] },
      { "profile": "laserball", "label": "Laserball", "family": "laserball", "sort": ["goals", "assists"] }
    ],
    "defaultProfile": "sm5",
    "modes": [                        // die bekannten Modi der Registry
      { "number": 5,  "key": "sm5",              "label": "Space Marines 5",  "family": "sm5",       "profile": "sm5" },
      { "number": 28, "key": "laserball_ranked", "label": "Laserball Ranked", "family": "laserball", "profile": "laserball" }
    ],
    "current": { "number": 28, "key": "laserball_ranked", "label": "Laserball Ranked",
                 "family": "laserball", "profile": "laserball", "known": true, "source": "tdf" },
    "scoreboard": {
      // FAMILIEN-Schlüssel (unverändert) UND PROFIL-Schlüssel. "sm5" und
      // "laserball" heißen in beiden Namensräumen gleich und meinen dort
      // dasselbe; neu ist allein "standard".
      "laserball": [ { "key": "goals", "label": "Tore", "short": "T",
                       "help": "Erzielte Tore.", "format": "int" },
                     { "key": "stealsDone", "label": "Steals", "short": "St",
                       "help": "Dem Gegner den Ball abgenommen.", "format": "int",
                       "received": "stealsReceived" } ],
      "sm5":       [ { "key": "roleLabel", "label": "Rolle", "short": "Rolle",
                       "help": "SM5-Rolle aus der Typ-3-Zeile …", "format": "text" },
                     { "key": "accuracy", "label": "Trefferquote", "short": "Quote",
                       "help": "Treffer geteilt durch abgegebene Schüsse …", "format": "percent" },
                     { "key": "livesLeft", "label": "Leben übrig", "short": "Lb⌀",
                       "help": "… vor dem Matchende leer, nicht 0.", "format": "int" } ],
      "standard":  [ { "key": "score", "label": "Punkte", "short": "Pkt",
                       "help": "Punktestand dieses Spielers …", "format": "int" } ]
    },
    "metrics": {                      // die Beschriftungstabelle, doppelt verschlüsselt
      "shotsFired":  { "key": "shotsFired", "csv": "shots_fired", "label": "Schüsse",
                       "short": "Sch", "help": "Abgegebene Schüsse …", "format": "int" },
      "shots_fired": { "key": "shotsFired", "csv": "shots_fired", "label": "Schüsse",
                       "short": "Sch", "help": "Abgegebene Schüsse …", "format": "int" }
    }
  }
}
```

- `current` ist derselbe Wert wie `match.mode` aus `/api/status`, oder `null`.
- **Zwei getrennte Achsen:** die **Familie** (`laserball`/`sm5`) bestimmt, was
  überhaupt gezählt werden kann; das **Profil** (`standard`/`sm5`/`laserball`)
  bestimmt, was angezeigt wird. Ein Modus nennt sein Profil, sonst gilt das
  Standardprofil seiner Familie ([GAMEMODES.md](GAMEMODES.md)).
- **`scoreboard` liefert die Spaltendefinitionen gleich mit**, weil eine
  Weboberfläche Browser-Code ist und `src/gameModes.js` nicht laden kann. Damit
  gibt es genau eine Quelle für die Spaltenreihenfolge, und ein neuer Zähler
  taucht in jeder Anzeige auf, ohne dass jemand eine Spaltenliste nachpflegt.
  Die beiden Familien-Schlüssel bleiben erhalten — entfernt wurde nichts.
- Ein Eintrag hat `key` (Feld im Spielerobjekt), `label`, `short` (schmale
  Kopfzeile), `help` (ein Satz, taugt als Tooltip), `format` und optional
  `received` — das Gegenstück-Feld für eine „gemacht / kassiert"-Darstellung.
- **`format` sagt, wie zu rendern ist**, und ist bindend:

  | `format` | Wert | Darstellung |
  |---|---|---|
  | `int` | Zahl | Zahl, wie bisher |
  | `text` | Zeichenkette | Text (z. B. die Rolle „Commander") |
  | `percent` | Anteil 0…1 | Prozentwert (`0.43` → `43 %`) |
  | alle | `null` | **leer** — nie `0`, nie ein Strich |

  `null` heißt „noch nicht gemeldet", nicht „null gemessen": `livesLeft` und
  `shotsLeft` kommen erst mit dem Typ-7-Endblock der Anlage, und eine 0 sähe
  aus wie „keine Leben mehr".
- **`metrics` ist die komplette Beschriftungstabelle** (`metricLabels()` aus
  `src/gameModes.js`), verschlüsselt sowohl unter dem camelCase-Feldnamen als
  auch unter der snake_case-CSV-Spalte. Damit braucht kein Verbraucher — auch
  die mitgelieferte Konsole nicht — eine eigene Liste von Spaltennamen.
- Die Antwort enthält **nur** Registry-Daten: keine Pfade, keine Dateien, keine
  Konfiguration.

- **`config` (additiv)** — ein Urteil über die handgepflegten Dateien unter
  `modes/`: `{ "ok": true, "problems": 0, "loadedAt": "2026-09-18T08:48:30.288Z" }`.
  Ist `ok` falsch, steht in
  [`/api/modes/status`](#get-apimodesstatus), welche Datei was hat.
- Die Profile werden **je Anfrage** aufgelöst, nicht einmal beim Start: die
  Modus-Dateien werden bei jedem Speichern in der Konsole neu eingelesen, und
  eine nachgetragene Missionsnummer muss ohne Dienstneustart hier erscheinen.
  Zwischengespeichert wird gegen `loadedAt`, damit das nichts kostet
  (Neuaufbau 0,08 ms, Cache-Prüfung 0,008 ms — gemessen).

### `GET /api/modes/status`

Welche Dateien unter `modes/` gelesen wurden, was sie definieren, und alles, was
an ihnen falsch ist. Ohne diesen Endpunkt landet ein Tippfehler in einer
Modus-Datei nur im Log.

```jsonc
{ "data": {
  "dir": "C:\\lf-live\\modes",
  "files": ["modes/profile/laserball.json", "modes/sm5.json", …],
  "profiles": ["standard", "sm5", "laserball"],
  "modes": [ { "file": "modes/sm5.json", "key": "sm5", "label": "Space Marines 5",
               "family": "sm5", "profile": "sm5", "numbers": [5] } ],
  "problems": [ { "level": "error", "file": "modes/standard.json",
                  "message": "Die Datei ist kein gültiges JSON: …" } ],
  "ok": false,
  "loadedAt": "2026-09-18T08:48:30.288Z"
} }
```

`problems` ist leer, solange alles in Ordnung ist. Eine fehlerhafte Datei wird
**übersprungen** — es gelten dann die eingebauten Vorgaben, der Dienst läuft
weiter. Einzelheiten: [GAMEMODES.md](GAMEMODES.md).

Die Liste `modes` enthält nur die **bekannten** Nummern. Läuft gerade ein
unbekannter Modus, steht er in `current` mit `known: false`, aber nicht in
`modes`. Wie man ihn einträgt:
[GAMEMODES.md](GAMEMODES.md#eigene-modus-nummern-ermitteln-und-eintragen).

### `GET /api/config` · `POST /api/config`

`{ data: <config.json>, envPins: [...] }`. `envPins` sind die per `.env`
festgelegten Felder (in der Konsole nur lesbar). `POST` mit einem Teil-Objekt
ändert die Konfiguration und übernimmt sie sofort (CSV, Ausgänge, Namensliste,
TCP-Bind, Stream-Server, CORS, Rate-Limit, `outputAllow`, `trustProxy`). Ein
geänderter `http.port` oder `stateTickMs` greift **erst nach einem Neustart**.
Env-Pins bleiben unverändert.

**Secrets:** `GET` liefert nie Klartext — `apiToken` ist immer `""`, dazu kommt
`apiTokenSet: true|false`; jedes gesetzte `outputs[].secret` erscheint als
`"••••••"`. Beim `POST` gilt deshalb:

| gesendet | Wirkung |
|---|---|
| `apiToken: ""` | gespeicherter Token bleibt |
| `apiToken: ""` + `apiTokenClear: true` | Token wird gelöscht |
| `apiToken: "neu"` | Token wird gesetzt |
| `outputs[].secret: "••••••"` | gespeichertes Secret bleibt (Zuordnung über `id`, sonst Position) |
| `admin.passwordHash: …` | **wird verworfen** — Passwort nur über `/api/auth/*` |
| `notify.discordWebhook` u. a. Secrets: `"••••••"` | gespeicherter Wert bleibt |
| `notify.discordWebhook` u. a. Secrets: `""` | Kanal wird entfernt |

Jede angenommene Änderung erzeugt eine `warn`-Logzeile im Scope `audit` mit
Client-IP und den geänderten Top-Level-Schlüsseln (nie mit Werten).

### `POST /api/outputs/test`

`{ "output": { …Ziel-Objekt… } }` → sendet ein `test`-Event an genau dieses Ziel
und gibt `{ ok, detail }` zurück. Stört eine bestehende TCP-Verbindung nicht.

### `POST /api/roster/reload`

Liest die lokale Namensliste-CSV neu ein, gibt Anzahl + evtl. Fehler zurück.

### `GET /api/stats/totals` · `GET /api/stats/files` · `GET /api/stats/file?name=`

Gesamtwertung als JSON · Liste aller CSV-Dateien · eine Datei herunterladen.
Siehe [STATS.md](STATS.md).

Die CSV-Ablage ist seit der Modus-Adaptivität **nach Familie getrennt**
(`totals_laserball.csv`, `totals_sm5.csv`, dazu `matches.csv` und
`player_modes.csv`). `/api/stats/totals` liefert immer **eine** Familie.

| Aufruf | Was zurückkommt |
|---|---|
| `/api/stats/totals` | wie bisher: die Familie des zuletzt aufgezeichneten Matches, sonst die zuletzt geschriebene Gesamtwertung, sonst die alte `totals.csv` |
| `?family=sm5` | genau diese Familie |
| `?profile=sm5` | das **Anzeigeprofil**, aufgelöst auf seine Familie |

Beide Parameter werden gegen die Registry geprüft; alles andere fällt auf den
Standard zurück, `family` gewinnt bei beiden. Ein Aufruf **ohne** Parameter
verhält sich unverändert.

```jsonc
{
  "data": [ { "name": "Mara", "matches": "3", "score": "4200", … } ],
  "family": "sm5",              // null, wenn nichts ausgewählt wurde
  "families": ["sm5", "laserball"],
  "profile": "sm5",             // Profil, unter dem diese Zeilen gezeigt werden
  "profiles": [                 // je Familie mit Daten genau ein Eintrag
    { "profile": "sm5", "label": "SM5", "family": "sm5" },
    { "profile": "laserball", "label": "Laserball", "family": "laserball" }
  ]
}
```

Summiert wird weiter **je Familie** — eine Summe über die Zähler einer anderen
Familie wäre sinnlos. Profile derselben Familie (`standard` und `sm5`) teilen
sich deshalb eine Datei, und `profiles` nennt je Familie genau ein Profil. Die
Spaltenbeschriftungen der Gesamtwertung stehen in `metrics` aus `/api/modes`.
`/api/stats/files` listet alle neuen Dateien automatisch mit.

### `GET /api/stats/reset/plan`

Was ein Zurücksetzen löschen **würde** — ohne etwas zu löschen. Die Konsole
zeigt das, bevor sie nach dem Passwort fragt.

```jsonc
{
  "data": {
    "dir": "C:\\lf-live\\data\\stats",
    "files": 13, "bytes": 7082496,
    "groups": [
      { "key": "matches",  "label": "Einzelmatches (Ordner matches/)",        "files": 8, "bytes": 7077888 },
      { "key": "overview", "label": "Missionsübersicht (matches.csv)",        "files": 1, "bytes": 843 },
      { "key": "modes",    "label": "Modus-Historie (player_modes.csv)",      "files": 1, "bytes": 1113 },
      { "key": "totals",   "label": "Gesamtwertungen (totals_*, all_players_*)", "files": 3, "bytes": 2652 },
      { "key": "other",    "label": "Sonstige CSV-Dateien im Ordner",         "files": 0, "bytes": 0 }
    ]
  }
}
```

### `POST /api/stats/delete` · `POST /api/stats/reset`

Eine CSV-Datei löschen bzw. die ganze Statistik zurücksetzen.

```jsonc
POST /api/stats/delete   { "name": "totals_sm5.csv", "password": "…" }
POST /api/stats/reset    { "password": "…" }
```

**Beide verlangen das Admin-Passwort, erneut getippt** — eine angemeldete
Sitzung allein genügt nicht. Geprüft wird serverseitig gegen denselben
scrypt-Hash wie `/api/auth/login`, hinter derselben Fehlversuchs-Bremse je IP
(`401 bad_password`, bei zu vielen Versuchen `429 locked_out` mit
`retryAfterMs`). Ein Fehlversuch führt **keine** Datei-Operation aus. Ist auf
der Installation gar kein Passwort gesetzt (nur Token, oder Admin-Bereich aus),
gibt es nichts zu prüfen; der Vorgang läuft hinter dem normalen Zugangsschutz
und wird im Audit-Log ausdrücklich als „ohne Passwortbestätigung" vermerkt.

`name` wird wie bei `/api/stats/file` behandelt (Backslashes normalisiert, `..`
und absolute Pfade abgewiesen, der aufgelöste Pfad muss im Statistik-Ordner
bleiben) und muss zusätzlich auf `.csv` enden — sonst `400 bad_name`. Eine als
Namensliste konfigurierte `localRoster.file` im selben Ordner wird nie gelöscht
(`400 protected`).

> **`reset` leert auch den Arbeitsspeicher.** Gesamtwertungen und Modus-Historie
> stehen nicht nur in den Dateien, sondern im Statistik-Schreiber
> (`_totals` / `_playerModes`), und werden am Ende jedes Matches von dort neu
> geschrieben. Ohne das Leeren schriebe das nächste Matchende die alten Summen
> wieder hin. Beim Löschen **einer** Datei passiert dasselbe gezielt: eine
> gelöschte `totals_<familie>.csv` nimmt die Summen dieser Familie mit, eine
> gelöschte `player_modes.csv` die Modus-Historie. Siehe [STATS.md](STATS.md).

Antwort in beiden Fällen mit der frischen Dateiliste und dem neuen Plan:

```jsonc
{ "data": { "ok": true, "deleted": 13, "failed": [],
            "files": [ … ], "plan": { … } } }
```

### `GET /api/capture/files` · `GET /api/capture/file?name=` · `GET /api/capture/bundle` · `POST /api/capture/delete`

Die [Roh-Mitschnitte](CAPTURE.md) des TCP-Streams — Liste, einzelne Datei,
alles als ZIP, und Löschen. Standardmäßig ist der Mitschnitt aus, dann ist die
Liste leer.

```json
{ "data": [ { "name": "2026-09-16_143012_mode28_laserball-ranked_abc123.tdf",
              "size": 422400, "mtime": 1789567812000, "kind": "tdf",
              "mode": { "number": 28, "label": "laserball-ranked" },
              "recording": false } ],
  "status": { "enabled": true, "recording": false, "file": null, "lines": 0 } }
```

`name` muss ein reiner Dateiname nach dem Muster `[A-Za-z0-9._-]+.(tdf|txt)`
sein — `..`, Pfadtrenner oder absolute Pfade → `400`/`404`, genau wie bei
`/api/stats/file`. `bundle` liefert `413`, wenn der Ordner die 64-MB-Grenze des
im Speicher gebauten ZIPs überschreitet.

`?inline=1` liefert dieselben Bytes **ohne** `Content-Disposition`, damit die
Leseansicht der Konsole die Datei lesen kann, statt sie herunterzuladen. Typ und
Pfadprüfung sind identisch (`text/plain` mit `X-Content-Type-Options: nosniff`).

`POST /api/capture/delete` nimmt `{"name":"…"}` oder
`{"all":true,"password":"…"}`; es ist ein schreibender Vorgang und braucht
dieselbe Absicherung wie `/api/config` (Session/Token **und**
`Sec-Fetch-Site: same-origin` bzw. `X-LF-Console: 1`). **`all` verlangt
zusätzlich das Admin-Passwort**, genau wie `/api/stats/reset` — derselbe Hash,
dieselbe Fehlversuchs-Bremse. Eine gerade laufende Aufzeichnung wird nicht
gelöscht (`400 recording`).

### `GET /api/logs?limit=<n>`

Die letzten Logzeilen (Ringpuffer), wie sie die Konsole zeigt.

### `GET /api/logs/events`

Listet die [Event-Log-Dateien](LOGGING.md) im aufgelösten `eventLog.dir`
(nur Namen nach dem Muster `events*.log`), neueste zuerst:

```json
{ "ok": true,
  "dir": "C:\\…\\lf_live\\data\\logs",
  "current": "events-2026-09-10.log",
  "files": [ { "name": "events-2026-09-10.log", "size": 20480, "mtime": 1757500000000 } ] }
```

Ist die Event-Log-Datei abgeschaltet oder der Ordner fehlt:
`{ "ok": true, "dir": null, "current": null, "files": [] }`.

### `GET /api/logs/events/file?name=<name>`

Gibt genau eine Event-Log-Datei als `text/plain; charset=utf-8` aus. `name` muss
ein reiner Dateiname nach dem Muster `events*.log` sein — `..`, Pfadtrenner oder
absolute Pfade → `400`. Datei nicht vorhanden → `404`.

---

## WebSocket  `GET /ws`

```
ws://<hallen-pc>:8080/ws
ws://<hallen-pc>:8080/ws?token=<token>      (falls Token gesetzt)
```

Was der Dienst schickt:

```jsonc
{ "type": "hello", "service": "lf-live", "ts": 1699999999999 }
{ "type": "ready", "feed": "state", "batch": false, "batchMs": 100, "players": true, "ts": … }
{ "type": "state", "data": { …kompletter Snapshot… } }   // bei Verbindung + danach im Takt LF_STATE_TICK_MS (Default 200 ms ≈ 5/s), nur wenn sich etwas geändert hat
{ "type": "event", "data": { …ein Event… } }             // sofort pro Ereignis
{ "type": "raw",   "lines": ["4\t1000\t1107\t#1001", …], "dropped": 0, "ts": … }
// nur auf ausdrückliche Anforderung:
{ "type": "display", "data": { …Anzeige-Datensatz… } }   // statt/neben `state`, siehe ?feed=
{ "type": "events",  "data": [ {…}, {…} ], "dropped": 0, "ts": … }  // gebündelte Ereignisse, siehe ?events=batch
```

Bei Verbindungsabbruch mit kurzem Backoff neu verbinden; nach dem Reconnect kommt
zuerst wieder ein `state` bzw. `display`.

`ready` ist **additiv** und nennt, worauf der Client tatsächlich angemeldet
wurde. Damit fällt ein Tippfehler in der Verbindungs-URL sofort auf, statt still
zu wirken. Ältere Verbraucher ignorieren die Nachricht einfach.

### Was ein Client anfordern kann — `?feed=` · `?events=`

**Die Vorgaben sind unverändert:** ohne Parameter bekommt ein Client genau das,
was dieser Dienst immer geschickt hat — einen vollen `state`-Rahmen je Takt und
einen `event`-Rahmen je Ereignis. Alles andere muss ausdrücklich angefordert
werden, beim Verbindungsaufbau in der URL:

| Parameter | Werte | Wirkung |
|---|---|---|
| `feed` | `state` *(Vorgabe)* · `display` · `both` | voller Snapshot · [Anzeige-Datensatz](#für-anzeige-entwickler) · beides |
| `events` | `single` *(Vorgabe)* · `batch` | ein Rahmen je Ereignis · **gebündelte** Rahmen |
| `batchMs` | 20…1000, Vorgabe `100` | Bündelfenster |
| `players` | `full` *(Vorgabe)* · `none` | Spielerliste im `display`-Rahmen weglassen |

```
ws://<hallen-pc>:8080/ws?feed=display&events=batch&token=<token>
ws://<hallen-pc>:8080/ws?feed=display&players=none&token=<token>   # nur Punkte + Uhr
```

Dasselbe geht zur Laufzeit mit einer `subscribe`-Nachricht (siehe unten). Ein
unbekannter Wert wird **ignoriert**, der bisherige bleibt stehen — ein Tippfehler
schaltet nie versehentlich etwas ab. Was gilt, steht im `ready`-Rahmen.

### Gebündelte Ereignisse — `{"type":"events"}`

Bei hoher Ereignisrate wird **ein WebSocket-Rahmen je Ereignis** teuer: schon das
Auspacken kostet den Verbraucher je Rahmen einen `JSON.parse` und einen
Handler-Aufruf. Gemessen, 1200 Ereignisse so schnell wie die Anlage sie liefert:

| | WS-Rahmen | Ereignisse | `JSON.parse` gesamt beim Verbraucher |
|---|---|---|---|
| `events=single` (Vorgabe) | 1200 | 1200 | 11,5 ms |
| `events=batch&batchMs=100` | **6** | 1200 | **3,2 ms** |

Also 99,5 % weniger Rahmen und rund ein Drittel der Auspack-Kosten, bei
**gleicher** Ereigniszahl — es geht nichts verloren.

```jsonc
{ "type": "events", "data": [ { …Event… }, { …Event… } ], "dropped": 0, "ts": 1699999999999 }
```

- Die Warteschlange ist **je Client**: ein langsamer Verbraucher bremst keinen
  schnellen.
- Sie ist **begrenzt** (2000 Ereignisse). Läuft sie über, werden die
  **ältesten** verworfen und in `dropped` des nächsten Rahmens gezählt — der
  Dienst lässt lieber Ereignisse fallen, als für einen Verbraucher zu wachsen,
  der nicht mitkommt. `dropped: 0` ist der Normalfall.
- Ein Stau von 200 Ereignissen geht sofort raus, ohne das Fenster abzuwarten.
- `events`-Rahmen und `event`-Rahmen kommen **nie gemischt**: ein Client bekommt
  das eine oder das andere.

### Die Nachrichten, die ein Client senden darf

Bis auf **zwei** werden eingehende Nachrichten ignoriert — alles über 256 Bytes
wird verworfen, ohne überhaupt geparst zu werden.

```jsonc
{ "type": "rawtap", "on": true }    // "ich schaue auf die Rohzeilen"
{ "type": "rawtap", "on": false }   // "ich schaue nicht mehr hin"

// dieselben vier Schalter wie in der URL, jederzeit änderbar:
{ "type": "subscribe", "feed": "display", "events": "batch", "batchMs": 100, "players": "none" }
```

Auf `subscribe` antwortet der Dienst mit einem `ready`-Rahmen; hat sich die
Anmeldung wirklich geändert, kommt gleich darauf der passende Eröffnungsrahmen
(`state` bzw. `display`), damit der Client nicht auf den nächsten Takt warten
muss.

Zu `rawtap`: erst danach kommen `raw`-Rahmen, und nur an die Clients, die sich
gemeldet haben. **Ohne Anmeldung erzeugt der Dienst überhaupt keine Rohzeilen** — er
zerlegt den TCP-Strom dafür nicht einmal in Zeilen. Beim Schließen der
Verbindung meldet der Client sich automatisch ab; nach einem Reconnect muss er
sich neu melden.

Ein `raw`-Rahmen trägt **mehrere** Zeilen: einen je 250 ms, oder sofort ab 400
angesammelten Zeilen. Ein Rahmen je Zeile wäre bei über fünfzig Spielern
messbar teurer als die eigentliche Arbeit. `dropped` zählt die Zeilen, die der
Dienst seit dem letzten Rahmen verworfen hat, weil mehr ankam als abfließen
konnte (Grenze: 4000 wartende Zeilen). Einzelheiten in
[CAPTURE.md](CAPTURE.md#live-rohdaten).

### Wenn der Handshake abgelehnt wird

Eine abgewiesene WebSocket-Verbindung ist von außen sonst nicht vom falschen
Port, einer Firewall oder einem abgestürzten Dienst zu unterscheiden — der
schlimmste Fall am Turniertag. Deshalb trägt die Ablehnung einen Grund:

```
HTTP/1.1 401 Unauthorized
X-LF-Reason: unauthorized
Content-Type: application/json; charset=utf-8

{"error":"unauthorized","hint":"gültiges ?token=<token> anhängen"}
```

| Status | `X-LF-Reason` | Bedeutung |
|---|---|---|
| `401` | `unauthorized` | kein oder falsches `?token=`, und keine gültige Browser-Sitzung |
| `404` | `not_found` | ein anderer Pfad als `/ws` |

Zusätzlich schreibt der Dienst eine `warn`-Zeile im Scope `ws` mit Client-IP und
Herkunft. Der Rumpf verrät nichts, was ein Angreifer nicht ohnehin messen kann;
ob ein Token gesetzt ist oder wie nah das gesendete dran war, steht nicht drin.

> **Achtung, Browser:** JavaScript sieht vom abgelehnten Handshake nur ein
> `error`-Ereignis ohne Begründung — das ist eine Festlegung der WebSocket-API,
> nicht dieses Dienstes. Status, Header und Rumpf stehen im Netzwerk-Tab der
> Entwicklerwerkzeuge und im Dienst-Log. Zum Prüfen aus dem Programm heraus:
> [`GET /api/access`](#get-apiaccess--immer-offen).

> **Der WebSocket unterliegt NICHT der CORS-Liste.** Browser wenden CORS auf
> WebSocket-Verbindungen nicht an. Eine Anzeige auf einem zweiten Rechner kommt
> über `/ws` also allein mit dem Token durch, auch ohne Eintrag in `cors`. Für
> `fetch()` auf `/api/*` braucht dieselbe Seite den Eintrag sehr wohl — genau
> diese Asymmetrie kostet erfahrungsgemäß die meiste Zeit. Kurzanleitung:
> [SECURITY.md](SECURITY.md#anzeige-auf-einem-zweiten-rechner-anbinden).

---

## State-Objekt

```jsonc
{
  "missionActive": true,
  "duration": 720000,            // ms, aus Laserforce Log-Typ 1
  "elapsedTime": 123000,         // ms
  "teams":  { "0": { "name": "Rot", "color": "#ef4444" }, "1": { … } },
  "scores": { "0": 3, "1": 2 },
  "ballHolderId": "1001",        // id des aktuellen Ballträgers, oder null
  // ---- seit der Modus-Adaptivität, rein additiv ----
  "mode": { "number": 28, "key": "laserball_ranked", "label": "Laserball Ranked",
            "family": "laserball", "known": true, "source": "tdf" },
  "missionDesc": "Laserball Ranked",  // Beschreibung aus der Typ-1-Zeile, oder null
  "durationKnown": true,         // false => Uhr HOCHzählen
  "remainingMs": 597000,         // fertig gerechnet; null wenn !durationKnown
  "scoreSource": "tdf",          // 'tdf' | 'internal'
  "players": {
    "1001": {
      "id": "1001", "name": "Mara", "teamId": "0",
      "avatar": null,           // immer null (Avatar-Quelle entfernt)
      "status": 0,               // Laserforce-Hardware-Status (0 normal, 2 reset, 3 aus)
      // additiv, bei JEDEM Spieler:
      "score": 5,                // Punktestand dieses Spielers
      "level": 3, "category": 1, "roleLabel": "Commander",  // SM5-Rolle aus Typ 3
      "battlesuit": null, "memberId": null,  // nur wenn eine Schema-Zeile sie benennt
      "statsSource": "live",     // 'live' = Eigenzählung | 'tdf7' = offizielle Endzahlen
      // Laserball-Zähler — immer vorhanden, Namen unverändert:
      "goals": 2, "assists": 1,
      "stealsDone": 0, "stealsReceived": 1,
      "blocksDone": 3, "blocksReceived": 0,
      "resetsDone": 0, "resetsReceived": 0,
      "clearsDone": 4, "clearsReceived": 1,
      "passesDone": 12, "passesReceived": 9
      // bei family 'sm5' zusätzlich die 30 SM5-Zähler (shotsHit … rewards),
      // nach dem Typ-7-Endblock zusätzlich "official": { … Rohwerte der Anlage }
    }
  },
  "events": [ /* die letzten ~50, gleiche Form wie /api/events */ ],
  "updatedAt": 1699999999999
}
```

Alle vorher vorhandenen Felder sind unverändert geblieben; die neuen kommen rein
additiv dazu. Welche Zähler eine Familie hat und was jede Zahl bedeutet:
[GAMEMODES.md](GAMEMODES.md#die-zwei-familien).

Für die Spieluhr gilt auch hier: `remainingMs` ist bereits berechnet, und
`duration` ist bei `durationKnown: false` nur ein Vorgabewert ohne Bezug zum
laufenden Spiel — siehe
[die Kernregel oben](#die-adaptive-spieluhr--kernregel-für-integratoren).

---

## Event-Objekt

```jsonc
{
  "id": 42,                 // fortlaufend, für ?since=
  "ts": 1699999999999,      // Uhrzeit (ms)
  "elapsedMs": 123000,      // Spielzeit (ms)
  "type": "goal",
  "code": "1101",           // Laserforce-Rohcode, falls vorhanden
  "category": "score",      // additiv: match·score·possession·combat·player·special·other
  "label": "Tor",           // additiv: Kurzbezeichnung (aus eventCatalog / Title-Case des type)
  "phrase": "Tor für Team 1 (0:1)",   // additiv: deutscher Klartext-Satz; nutze `phrase || text`
  "actorId": "2002", "actorName": "Tim", "actorTeamId": "1",
  "targetId": null, "targetName": null, "targetTeamId": null,
  "assistId": "2001", "assistName": "Lea",   // nur bei goal
  "scores": { "0": 0, "1": 1 },              // nur bei goal
  "text": "Tim SCORED"      // Klartext, nie HTML
}
```

| `type` | Auslöser |
|---|---|
| `match_start` / `match_end` | Mission `0100` / `0101` |
| `player_join` | Spieler-Login (Log-Typ 3) |
| `pass` | Pass (`1100`) |
| `clear` | Clear (`1109`) |
| `steal` | Steal (`1103`) |
| `block` | Block auf aktiven Gegner (`1104`) |
| `reset` | Block auf Gegner in Reset (`1104`, Ziel-Status 2) |
| `failed_clear` | fehlgeschlagener Clear (`110A`) |
| `goal` | Tor (`1101` / `1102`) inkl. Assist-Berechnung + neuem Score |
| `status` | Hardware-Status eines Spielers (Log-Typ 9) |
| `round_start` | Laserball-Rundenstart (`1105`) |
| `reset` | zusätzlich: explizite Reset-Codes `110B` / `110C` (neben dem aus `1104`+Status abgeleiteten Reset) |
| `score` | Score-Zeile (Log-Typ 5): trägt `teamId`, `old`, `new`, `delta`. Das Event selbst ist unverändert — die Zeile setzt jetzt zusätzlich `gameState.scores` bzw. `players[id].score` und `scoreSource`. |
| `match_summary` | Entity-Ende / Abschluss-Zeile (Log-Typ 6): trägt `entityId`, `exitCode`, `score`, `cols` |
| `mode_change` | **neu.** Der Spielmodus wurde erkannt oder zur Laufzeit korrigiert. Trägt `mode` und `previousMode`. Kategorie `match` |
| `sm5_stats` | **neu.** Die offizielle SM5-Endstatistik eines Spielers (Log-Typ 7) traf ein. Trägt `actorId` und `stats` (die Rohwerte der Anlage). Kategorie `player`. Kommt **vor** `match_end` |
| `miss`, `player_hit`, `player_deactivate`, `target_hit`, `target_destroy`, `warbot_deactivate`, `missile_lock`, `missile_miss`, `missile_hit`, `missile_destroy` | bislang ignorierte SM5-`02xx`/`03xx`-Codes, jetzt als Event ausgegeben |
| `rapid_fire`, `nuke_activate`, `nuke_detonate`, `resupply`, `team_resupply`, `penalty`, `beacon_claim`, `base_award`, `achievement`, `reward` | die übrigen SM5-Codes (`04xx`–`06xx`, `0Bxx`, `09xx`), jetzt mit eigenem `type` |
| `lf_event` | Sammel-Typ für jeden weiteren Typ-4-Code, den der Parser nicht auswertet (abschaltbar über `LF_EMIT_UNKNOWN_EVENTS`). Trägt `code`, `category`, `label`. |

Die beschreibenden Events (`round_start`, `reset` via `110B`/`110C`,
`match_summary`, die SM5-Codes, `lf_event`) sind **rein additiv**: sie verändern
`gameState` nicht und lösen keinen State-Push aus. `mode_change` und `sm5_stats`
begleiten dagegen eine echte Zustandsänderung.

**Zusätzliche optionale Felder auf _jedem_ Event** (zentral in `engine._pushEvent`
gestempelt, nur wenn nicht schon gesetzt — die Parser-Logik ändert sich dadurch
nicht):

| Feld | Inhalt |
|---|---|
| `code` | Hex-TDF-Rohcode, sofern für den `type` bekannt (`match_start`→`0100`, `pass`→`1100`, `goal`→`1101`, `steal`→`1103`, `block`→`1104`, `clear`→`1109`, …); `player_join`/`status` haben keinen Typ-4-Code und tragen keins |
| `category` | `match`·`score`·`possession`·`combat`·`player`·`special`·`other` — aus `eventCatalog.describe(code)`, sonst aus einer `type`-Fallback-Tabelle |
| `label` | Kurzbezeichnung aus `eventCatalog`, sonst Title-Case des `type` |
| `phrase` | deutscher Klartext-Satz (`eventCatalog.phrase`); fällt auf `text` zurück, wenn kein besserer Satz ableitbar ist. Anzeige: `event.phrase \|\| event.text` |

Alle vier sind optional und additiv — ältere Consumer können sie ignorieren.

Die Assist-Logik: ein Pass/Clear an den Torschützen, der ≤ 10 s vor dem Tor lag,
gilt als Vorlage (genau wie im Originalsystem).

---

# Für Anzeige-Entwickler

Dieses Kapitel setzt **nichts** über lf_live voraus. Wer nur eine Anzeige baut —
Beamer-Scoreboard, Overlay, Turniersystem — braucht nur, was hier steht.

## In fünf Minuten

1. **Adresse** — `http://<hallen-pc>:8080`. Läuft die Anzeige auf einem **anderen
   Rechner**, müssen dort zwei Einstellungen gesetzt sein; Kurzanleitung:
   [SECURITY.md](SECURITY.md#anzeige-auf-einem-zweiten-rechner-anbinden).
2. **Prüfen, ob du hereinkommst** — `GET /api/access`. `problems: []` heißt: alles
   gut. Sonst steht dort im Klartext, was fehlt.
3. **Verbinden** — `ws://<hallen-pc>:8080/ws?feed=display&token=<token>`.
4. **Empfangen** — Rahmen vom Typ `display`. Darin steckt alles Folgende.
5. Einmalig dazu, wenn du Tooltips/Hilfetexte zu den Spalten willst:
   `GET /api/modes` (`metrics`, `scoreboard` → `help`, `group`, `groupLabel`).

Alternativ ohne WebSocket: `GET /api/display` alle 1–2 Sekunden pollen. Gleicher
Inhalt, gleiche Feldnamen.

## Ein vollständiger Datensatz, kommentiert

Echte Antwort eines laufenden Laserball-Matches mit zwei Teams und zwei
Spielern. **Nichts ist weggekürzt** — so viele Felder sind es, und nicht mehr.

```jsonc
{ "data": {
  "v": 1,                        // Version des Datensatzes; steigt nur bei einer BRECHENDEN Änderung
  "service": "lf-live",
  "ts": 1789721491583,           // wann dieser Datensatz gebaut wurde (ms seit Epoche)
  "updatedAt": 1789721490269,    // wann die Engine zuletzt etwas geändert hat
  "ageMs": 1314,                 // wie alt das ist. Groß und wachsend => die Anlage schickt nichts mehr

  "match": {
    "active": true,              // läuft gerade ein Match?
    "matchId": "mu6pys0q",       // wechselt bei jedem Matchstart; null vor dem ersten
    "mode": {
      "number": 28,              // Missionsnummer der Anlage, oder null
      "key": "laserball_ranked", // stabiler Kurzname — DAS ist der Schlüssel für eigene Logik
      "label": "Laserball Ranked",   // AUSGESCHRIEBENER Name. Kommt ggf. AUS DEM STREAM -> nur als Text ausgeben, nie als HTML
      "family": "laserball",     // 'laserball' | 'sm5' — was die Anlage überhaupt zählen kann
      "profile": "laserball",    // welche Spalten gezeigt werden (siehe "columns")
      "profileLabel": "Laserball",   // ausgeschriebener Name des Anzeigeprofils
      "known": true,             // false = diese Nummer steht nicht in der Registry
      "source": "tdf",           // 'tdf' = von der Anlage | 'inferred' = zur Laufzeit erkannt | 'default'
      "description": "Laserball Ranked"  // Beschreibung aus der Typ-1-Zeile, oder null
    },
    "clock": {
      "direction": "down",       // ---> 'down' = Restzeit, 'up' = Laufzeit. NIE selbst ausrechnen.
      "displayMs": 840000,       // ---> DIE Zahl, die auf den Bildschirm gehört
      "elapsedMs": 60000,        // verstrichene Spielzeit
      "remainingMs": 840000,     // Restzeit; null <=> es wird AUFWÄRTS gezählt
      "durationMs": 900000,      // Gesamtdauer — bei durationKnown:false ein VORGABEWERT ohne Bezug zum Spiel
      "durationKnown": true,     // hat die Anlage eine Dauer gemeldet?
      "running": true            // false => die Uhr muss STEHEN, egal was noch hereinkommt
    },
    "scoreSource": "internal",   // 'tdf' = Punkte von der Anlage | 'internal' = von der Bridge mitgezählt
    "scoreSourceLabel": "von der Bridge mitgezählt",
    "end": {                     // alles null, solange das Match läuft
      "reason": null,            // 'mission_end'|'watchdog'|'stream_lost'|'next_match'|'shutdown'
      "reasonLabel": null,       // derselbe Grund, ausgeschrieben auf Deutsch
      "source": null,            // WORAN das Ende erkannt wurde (siehe Tabelle unten)
      "sourceLabel": null,
      "at": null                 // Zeitpunkt des Endes (ms seit Epoche)
    }
  },

  // Immer ein ARRAY, nie eine Map — und immer nach Team-id sortiert, damit
  // "links/rechts" über das ganze Match gleich bleibt. Funktioniert mit 1 bis 7
  // Teams genauso wie mit einem einzigen.
  "teams": [
    { "id": "0", "name": "Rote Kugeln",  "color": "#ef4444", "score": 1, "players": 1, "rank": 1 },
    { "id": "1", "name": "Blaue Kugeln", "color": "#3b82f6", "score": 0, "players": 0, "rank": 2 }
  ],
  "teamCount": 2,                // Länge von teams[] — KANN Teams aus einem früheren Match enthalten
  "teamsWithPlayers": 2,         // davon die, in denen gerade jemand steht  <-- das ist meist die Zahl, die du willst
  "freeForAll": false,           // "Jeder gegen jeden": >= 3 bemannte Teams, in jedem genau ein Spieler
  "playerCount": 2,
  "ballHolderId": null,          // nur Laserball: wer den Ball hat, sonst null

  // Die Spalten, die für DIESEN Modus zählen — fertig beschriftet.
  // Pflege keine eigene Spaltenliste: ein neuer Zähler taucht hier von selbst auf.
  "columns": [
    { "key": "goals",   "label": "Tore",            "short": "Tore",   "format": "int",     "unit": null },
    { "key": "assists", "label": "Vorlagen",        "short": "Vorlagen","format": "int",    "unit": null },
    { "key": "stealsDone", "label": "Ball abgenommen", "short": "Ball abgenommen", "format": "int", "unit": null,
      "received": "stealsReceived", "receivedLabel": "Ball verloren" },   // Gegenstück für "gemacht / kassiert"
    { "key": "blocksDone", "label": "Gegner geblockt", "short": "Geblockt", "format": "int", "unit": null,
      "received": "blocksReceived", "receivedLabel": "Selbst geblockt worden" },
    { "key": "resetsDone", "label": "Gegner zurückgesetzt", "short": "Zurückgesetzt", "format": "int", "unit": null,
      "received": "resetsReceived", "receivedLabel": "Selbst zurückgesetzt worden" },
    { "key": "clearsDone", "label": "Befreiungspässe gespielt", "short": "Befreiungspässe", "format": "int", "unit": null,
      "received": "clearsReceived", "receivedLabel": "Befreiungspässe erhalten" },
    { "key": "passesDone", "label": "Pässe gespielt", "short": "Pässe", "format": "int", "unit": null,
      "received": "passesReceived", "receivedLabel": "Pässe erhalten" },
    { "key": "score",   "label": "Punkte",          "short": "Punkte", "format": "int",     "unit": null },
    { "key": "level",   "label": "Spielerlevel",    "short": "Level",  "format": "int",     "unit": null }
  ],

  // null (nicht []), wenn mit ?players=none / players:"none" abgefragt wurde.
  // Sortiert: bester zuerst, nach der Wertung des Modus. Gleichstand teilt den Rang.
  "players": [
    {
      "id": "1001", "name": "Mara",          // Name kommt AUS DEM STREAM -> nur als Text ausgeben
      "teamId": "0", "teamName": "Rote Kugeln", "teamColor": "#ef4444",
      "score": 0,                            // Punkte dieses Spielers
      "status": 0,                           // Hardware-Status (0 normal, 2 im Reset, 3 aus)
      "roleLabel": "Commander",              // SM5-Rolle, sonst null
      "rank": 1,
      "stats": {                             // EIN Eintrag je columns[].key (+ je received)
        "goals": 1, "assists": 0,
        "stealsDone": 1, "stealsReceived": 0,
        "blocksDone": 0, "blocksReceived": 0,
        "resetsDone": 0, "resetsReceived": 0,
        "clearsDone": 0, "clearsReceived": 0,
        "passesDone": 0, "passesReceived": 1,
        "score": 0, "level": 3
      },
      // ---- Herkunftskennzeichen ----
      "statsSource": "live",                 // 'live' = laufend mitgezählt | 'tdf7' = amtliche Endabrechnung
      "statsSourceLabel": "laufend mitgezählt (Untergrenze)",
      "accuracy": null,                      // Anteil 0…1, oder null
      "accuracyIsEstimate": null,            // true = GESCHÄTZT (zu hoch); null = für diesen Modus nicht gemeldet
      "accuracySource": null,                // 'live' | 'tdf7' | null
      "officialStats": false                 // true, sobald der Endblock der Anlage für diesen Spieler da ist
    },
    { "id": "2001", "name": "Lea", "teamId": "1", "teamName": "Blaue Kugeln", "teamColor": "#3b82f6",
      "score": 0, "status": 0, "roleLabel": "Commander", "rank": 2,
      "stats": { "goals": 0, "assists": 1, "stealsDone": 0, "stealsReceived": 1,
                 "blocksDone": 0, "blocksReceived": 0, "resetsDone": 0, "resetsReceived": 0,
                 "clearsDone": 0, "clearsReceived": 0, "passesDone": 1, "passesReceived": 0,
                 "score": 0, "level": 3 },
      "statsSource": "live", "statsSourceLabel": "laufend mitgezählt (Untergrenze)",
      "accuracy": null, "accuracyIsEstimate": null, "accuracySource": null, "officialStats": false }
  ]
} }
```

## Die Uhr — die eine Regel, an der alles hängt

> **Rechne niemals selbst `durationMs - elapsedMs`.**

Meldet die Anlage keine Missionsdauer, steht in `durationMs` ein **Vorgabewert,
der mit dem laufenden Spiel nichts zu tun hat**. Eine Eigenberechnung ergibt dann
einen frei erfundenen Countdown, der irgendwann negativ wird. Genau dieser Fehler
fällt im Test nie auf und am Turniertag sofort.

Der Dienst hat die Entscheidung schon getroffen:

| `clock.direction` | `clock.displayMs` | `remainingMs` | Anzeige |
|---|---|---|---|
| `"down"` | die Restzeit | Zahl ≥ 0 | **abwärts** zählen |
| `"up"` | die Laufzeit | `null` | **aufwärts** zählen, von 0 |

```js
const c = d.match.clock;
// zwischen zwei Rahmen lokal weiterlaufen lassen — aber nur, solange das Match läuft
const seit = c.running ? Date.now() - empfangenUm : 0;
const ms = c.direction === "down"
  ? Math.max(0, c.displayMs - seit)
  : c.displayMs + seit;
```

Zwei Dinge dazu:

- **`clock.running === false` ⇒ die Uhr steht.** Eine Uhr darf nie über das
  Matchende hinauslaufen, auch nicht, wenn danach nichts mehr hereinkommt.
- `elapsedMs` kommt **von der Anlage**, nicht aus einer lokalen Uhr. Zwischen
  zwei Zeilen steht der Wert still. Deshalb lokal interpolieren — aber die
  **Richtung** und den **Startwert** immer vom Dienst nehmen.

## Teams: eins bis sieben, und „Jeder gegen jeden"

`teams` ist **immer ein Array**, auch bei einem einzigen Team, und immer nach
`id` sortiert — die Reihenfolge ändert sich während eines Matches nicht, „links"
bleibt also links. `rank` ist der Platz nach Punkten (Gleichstand teilt sich
einen Platz: 1, 2, 2, 4).

- **`teamCount` ist nicht die Zahl der spielenden Teams.** Die Anlage meldet
  Teams einmal, und sie bleiben über Matchgrenzen hinweg bekannt. Nach einem
  Sieben-Team-Turnier stehen in `teams` weiter sieben Einträge, auch wenn gerade
  nur zwei spielen. Nimm **`teamsWithPlayers`**, oder filtere auf `players > 0`.
- **`freeForAll: true`** heißt: mindestens drei bemannte Teams, und in jedem
  steht genau ein Spieler. Dann ist eine Teamspalte sinnlos — zeig eine
  Einzelrangliste. Bei zwei Ein-Mann-Teams ist es ein Duell und bleibt `false`.
- `color` ist ein Hex-Wert mit `#` und ist nie `null`, solange die Anlage das
  Team gemeldet hat. Der Teamname kann sich **während** des Matches noch ändern
  (die Namensliste überschreibt ihn, sobald genug Spieler angemeldet sind) —
  also nicht beim ersten Rahmen einfrieren.

## Spieler und Spalten

`columns` ist die Spaltenliste für **genau diesen Modus**, fertig beschriftet.
Baue die Tabelle daraus, dann ändert sich nichts an deinem Code, wenn ein Modus
dazukommt.

| `format` | Wert | so rendern |
|---|---|---|
| `int` | Zahl | als Zahl |
| `text` | Zeichenkette | als Text (z. B. Rolle „Commander") |
| `percent` | Anteil `0…1` | als Prozent: `0.43` → `43 %` (`unit` ist dann `"%"`) |
| **alle** | `null` | **leer lassen** — nie `0`, nie ein Strich als Zahl |

`unit` ist die Einheit, die `format` mit sich bringt (`"%"` oder `null`) — damit
braucht der Renderer keine eigene Tabelle. Hat eine Spalte ein `received`, gehört
dazu ein Gegenstück-Wert unter diesem Schlüssel in `stats` („gemacht / kassiert",
z. B. `stealsDone` / `stealsReceived`); `receivedLabel` ist dessen Beschriftung.

**Hilfetexte** (`help`) und die Gruppierung (`group`, `groupLabel`) stehen
absichtlich **nicht** im Anzeige-Datensatz — sie ändern sich pro Modus nie und
würden fünfmal je Sekunde mitfahren. Sie kommen aus derselben Quelle über
[`GET /api/modes`](#get-apimodes), einmal beim Start abgeholt und über denselben
`key` zugeordnet.

## Herkunftskennzeichen — welche Zahl wie viel wert ist

Der Dienst schummelt nicht: jede Zahl sagt, woher sie kommt.

| Feld | Werte | Bedeutung für die Anzeige |
|---|---|---|
| `match.scoreSource` | `tdf` | die Punkte kommen **von der Anlage** — verlässlich |
| | `internal` | die Bridge hat **selbst mitgezählt**, weil die Anlage keine Punktezeilen schickt |
| `players[].statsSource` | `live` | laufend mitgezählt — eine **Untergrenze**, die Anlage meldet nicht jeden Schuss |
| | `tdf7` | die **amtliche Endabrechnung** der Anlage ist da |
| `players[].officialStats` | `true` | dito, als Boolean zum Abfragen |
| `players[].accuracyIsEstimate` | `true` | die Trefferquote ist **geschätzt** und systematisch **zu hoch** — als solche kennzeichnen |
| | `false` | amtlich |
| | `null` | für diesen Modus gar nicht gemeldet |

Eine ehrliche Anzeige markiert Live-Zahlen erkennbar (z. B. mit `~`) und nimmt
die Markierung weg, sobald `statsSource` auf `tdf7` springt — das passiert
**vor** dem Matchende.

## Wie und warum ein Match endete

`match.end.reason` ist `null`, solange eines läuft oder noch keines lief. Erst
dann darf eine Anzeige die Uhr weiterlaufen lassen.

| `reason` | `reasonLabel` | wann |
|---|---|---|
| `mission_end` | regulär beendet | die Anlage hat das Ende selbst gemeldet (`0101`) |
| `watchdog` | vom Spielleiter beendet bzw. Zeitüberschreitung | **kein `0101`** — Endabrechnung erkannt oder anhaltende Stille |
| `stream_lost` | Verbindung zur Anlage verloren | die TCP-Verbindung brach während des Matches ab |
| `next_match` | durch ein neues Match abgelöst | die Anlage startete ein neues, ohne das alte zu beenden |
| `shutdown` | Dienst beendet | der Dienst wurde beendet, während das Match lief |

`match.end.source` sagt **woran** es erkannt wurde und trennt die beiden sehr
verschiedenen `watchdog`-Fälle: `0101` · `summary_type6` (alle Abschluss-Zeilen
da) · `summary_type7` (SM5-Endblock da) · `silence` (nichts mehr gekommen) ·
`stream_lost` · `next_match` · `shutdown`. Ein Match, das mit `summary_type6`
endet, hat vollständige Zahlen; eines mit `silence` womöglich nicht.

## Fehlende und leere Werte

Es gibt drei verschiedene Dinge, und sie bedeuten nicht dasselbe:

| | heißt | so behandeln |
|---|---|---|
| `null` | **noch nicht gemeldet** | Feld **leer** lassen |
| `0` | gemessene Null | `0` anzeigen |
| Feld fehlt ganz | dieser Dienst ist älter als das Feld | wie `null` behandeln |

Der häufigste Fall: `livesLeft`, `shotsLeft` und die übrigen Endblock-Zahlen
kommen erst mit der Endabrechnung. Eine `0` dort sähe aus wie „keine Leben mehr".
Deshalb sind sie bis dahin `null` — und darum bitte niemals `?? 0` oder
`|| 0` darüberschreiben.

```js
const v = p.stats[c.key];
const txt = v === null ? "" : (c.format === "percent" ? `${Math.round(v * 100)} %` : String(v));
```

Umgekehrt gilt: **lies nie ein Feld, das nicht in `columns` steht.** Die
Spaltenliste ist die Erlaubnis; alles andere kann je nach Modus fehlen.

## Was stabil ist und was sich noch ändern kann

**Stabil** — darauf darf man bauen; eine Änderung daran erhöht `v`:

- `v`, `ts`, `updatedAt`, `ageMs`
- `match.active`, `match.matchId`
- `match.mode.{number,key,label,family,profile,known,source}`
- `match.clock.{direction,displayMs,elapsedMs,remainingMs,durationMs,durationKnown,running}`
- `match.scoreSource`, `match.end.{reason,source,at}`
- `teams[].{id,name,color,score,players,rank}`, `teamCount`, `playerCount`
- `columns[].{key,label,short,format}`
- `players[].{id,name,teamId,score,rank,stats,statsSource}`
- die Werte von `reason`, `source`, `scoreSource`, `statsSource`, `format`

**Kann sich noch ändern** — benutzbar, aber bitte nicht tragend:

- alle `*Label`-Felder (`reasonLabel`, `sourceLabel`, `scoreSourceLabel`,
  `statsSourceLabel`, `profileLabel`) — das sind **deutsche Anzeigetexte**, der
  Wortlaut darf sich bessern. Logik immer am unübersetzten Feld festmachen.
- `columns[].unit` und `columns[].receivedLabel`
- `freeForAll` und `teamsWithPlayers` — die Herleitung kann sich verfeinern
- `players[].status` — die Bedeutung der Hardware-Codes ist nicht vollständig belegt
- `match.mode.description` — kommt roh aus dem Stream

**Verlass dich nie auf:** die Reihenfolge der Schlüssel in `stats`, den genauen
Wortlaut von `label`/`short` (die stehen in JSON-Dateien und darf der Betreiber
ändern), oder darauf, dass `mode.number` gesetzt ist.

> **Alle Namen und Beschriftungen, die aus dem Stream kommen** — `mode.label`,
> `mode.description`, Team- und Spielernamen — sind **Text**, niemals HTML.
> In einer Weboberfläche über `textContent` ausgeben, nie über `innerHTML`.

## Verbindungsabbruch, und wenn die Anlage nichts sendet

Das sind **zwei verschiedene Fälle**, und eine gute Anzeige unterscheidet sie:

| Lage | woran erkennbar | was die Anzeige tun sollte |
|---|---|---|
| **WebSocket weg** | `onclose` / `onerror` | letzten Stand stehen lassen, sichtbar als „getrennt" markieren, alle 2 s neu verbinden |
| **Dienst läuft, Anlage schweigt** | `ageMs` wächst über ~12 000 | Uhr anhalten, Zahlen stehen lassen, „keine Daten von der Anlage" zeigen |
| **Match zu Ende** | `clock.running === false` | Uhr anhalten, Endstand mit `end.reasonLabel` zeigen |

Weiteres, worauf man sich verlassen darf:

- Nach jedem Reconnect kommt **sofort** wieder ein voller `display`-Rahmen — es
  gibt keinen Zustand, den der Client über die Trennung hinweg halten müsste.
- Der Dienst sendet nur, wenn sich etwas **geändert** hat. Ein ausbleibender
  Rahmen ist also normal und kein Fehler — dafür ist `ageMs` da.
- Tote Verbindungen werden alle 30 s per Ping/Pong erkannt und getrennt; die
  Gegenseite sieht ein sauberes `onclose`.
- **Backoff einbauen.** Ein Reconnect-Sturm gegen den Hallen-PC läuft ins
  Rate-Limit (`429`).

## Lauffähiges Minimalbeispiel

Verbindet sich, empfängt den Zustand, zeigt Punktestand und Uhr — **beide
Laufrichtungen** — und die modusrelevanten Spielerzahlen. Läuft unverändert
gegen Laserball, SM5, 7 Teams, „Jeder gegen jeden" und ein Match ohne `0101`.

```bash
npm i ws
node anzeige.js ws://192.168.1.10:8080/ws <token>
```

```js
'use strict';
// Im Browser entfällt die nächste Zeile — dort ist WebSocket eingebaut,
// der Rest des Codes ist identisch.
const WebSocket = require('ws');

const BASE = process.argv[2] || 'ws://127.0.0.1:8080/ws';
const TOKEN = process.argv[3] || '';
// feed=display -> der schlanke Anzeige-Datensatz statt des vollen Snapshots.
const URL = `${BASE}?feed=display${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;

let letzte = null;          // zuletzt empfangener Datensatz
let tickAb = 0;             // Date.now() beim Empfang — für die Uhr zwischen den Rahmen

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Die Uhr. Die Richtung kommt vom Dienst — niemals selbst dauer-minus-verstrichen rechnen. */
function uhr(d) {
  const c = d.match.clock;
  // Zwischen zwei Rahmen lokal weiterlaufen lassen, aber NUR solange das Match läuft.
  const seit = c.running ? Date.now() - tickAb : 0;
  const ms = c.direction === 'down'
    ? Math.max(0, c.displayMs - seit)      // Restzeit: herunter
    : c.displayMs + seit;                  // Laufzeit: hoch (remainingMs war null)
  return (c.direction === 'up' ? '+' : '') + mmss(ms);
}

function zeichnen() {
  const d = letzte;
  if (!d) return;
  const kopf = d.match.active
    ? `LÄUFT  ${d.match.mode.label}`
    : `ENDE   ${d.match.mode.label}` + (d.match.end.reasonLabel ? `  (${d.match.end.reasonLabel})` : '');
  const zeilen = [];
  zeilen.push(`${kopf}   ${uhr(d)}   Punkte: ${d.match.scoreSourceLabel}`);
  zeilen.push(d.freeForAll
    ? `Jeder gegen jeden — ${d.teamsWithPlayers} Spieler`
    : `${d.teamsWithPlayers} Team(s), ${d.playerCount} Spieler`);
  for (const t of d.teams) {
    if (t.players === 0 && d.teams.length > 2) continue;   // leere Teams früherer Matches nicht zeigen
    zeilen.push(`  #${t.rank} ${t.name.padEnd(16)} ${String(t.score).padStart(5)}  ${t.color || ''}`);
  }
  // Die Spalten kommen mit dem Datensatz — keine eigene Spaltenliste pflegen.
  if (d.players && d.players.length) {
    const kopfz = ['#', 'Spieler', 'Team'].concat(d.columns.map((c) => c.short));
    zeilen.push('  ' + kopfz.join(' | '));
    for (const p of d.players.slice(0, 8)) {
      const werte = d.columns.map((c) => {
        const v = p.stats[c.key];
        if (v === null) return '—';                        // leer, NICHT 0
        if (c.format === 'percent') return `${Math.round(v * 100)}${c.unit}`;
        return String(v);
      });
      zeilen.push('  ' + [p.rank, p.name, p.teamName || '?'].concat(werte).join(' | '));
    }
  }
  process.stdout.write(zeilen.join('\n') + '\n\n');
}

function verbinden() {
  const ws = new WebSocket(URL);
  ws.on('open', () => console.log('verbunden'));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'display') { letzte = m.data; tickAb = Date.now(); zeichnen(); }
  });
  ws.on('close', () => { console.log('Verbindung weg — neuer Versuch in 2 s'); setTimeout(verbinden, 2000); });
  ws.on('error', (e) => console.log('Fehler:', e.message));
}

verbinden();
setInterval(zeichnen, 1000);   // Uhr läuft weiter, auch wenn gerade nichts kommt
```

Ausgabe gegen ein Laserball-Match ohne gemeldete Dauer, nach dem Ende ohne
`0101` — man sieht die aufwärts zählende Uhr am `+` und den Endgrund:

```
ENDE   Laserball ohne Dauer  (vom Spielleiter beendet bzw. Zeitüberschreitung)   +00:20   Punkte: von der Bridge mitgezählt
2 Team(s), 2 Spieler
  #1 Rot                  1  #ef4444
  #2 Blau                 0  #3b82f6
  # | Spieler | Team | Tore | Vorlagen | Ball abgenommen | Geblockt | Zurückgesetzt | Befreiungspässe | Pässe | Punkte | Level
  1 | Pia | Rot | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3
  2 | Ron | Blau | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 3
```

---

## Fehlercodes

| Status | Bedeutung |
|---|---|
| `401` | Token fehlt oder falsch; bei den passwortbestätigten Routen `{"error":"bad_password"}` |
| `403` | mutierende Anfrage ohne Token und ohne `Sec-Fetch-Site: same-origin` / `X-LF-Console: 1` |
| `429` | Rate-Limit erreicht, oder zu viele falsche Passwörter (`locked_out`, mit `Retry-After`) |
| `404` | unbekannte Route oder Datei |
| `400` | ungültiges JSON im POST-Body, oder ein abgewiesener Dateiname (`bad_name`, `protected`) |
| `500` | interner Fehler (wird geloggt) |

Der `401`-Rumpf nennt seit Neuestem zusätzlich `tokenRequired`, `tokenSent`,
`originAllowed` und `see: "/api/access"` — alles rein additiv, und alles
Angaben, die der Aufrufer ohnehin selbst messen kann. Beim WebSocket steht der
Grund im Header `X-LF-Reason` (siehe
[Wenn der Handshake abgelehnt wird](#wenn-der-handshake-abgelehnt-wird)).

**Der Fall ohne Statuscode:** eine Anfrage aus einem Browser, deren Herkunft
nicht in `cors` steht, wird mit `200` beantwortet — und vom **Browser** still
verworfen. Erkennbar am fehlenden `Access-Control-Allow-Origin` und am
zusätzlichen Header `X-LF-Origin-Allowed: 0`, dazu eine `warn`-Zeile im Log.
Nachfragen lässt es sich über [`GET /api/access`](#get-apiaccess--immer-offen).
