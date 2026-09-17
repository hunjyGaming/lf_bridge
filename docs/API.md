# API-Referenz

Basis: `http://<hallen-pc>:8080` (Port aus der Konfiguration).

Solange die Ersteinrichtung offen ist (kein Admin-Passwort gesetzt), antwortet
**alles außer** `/api/health`, `/api/auth/session` und `/api/auth/setup` mit
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
| `stream_lost` | die Verbindung zur Anlage brach während des Matches ab | „Verbindung verloren" |
| `next_match` | die Anlage startete ein neues Match, ohne das alte zu beenden | „durch neues Match abgelöst" |
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
{ "type": "state", "data": { …kompletter Snapshot… } }   // bei Verbindung + danach im Takt LF_STATE_TICK_MS (Default 200 ms ≈ 5/s), nur wenn sich etwas geändert hat
{ "type": "event", "data": { …ein Event… } }             // sofort pro Ereignis
{ "type": "raw",   "lines": ["4\t1000\t1107\t#1001", …], "dropped": 0, "ts": … }
```

Bei Verbindungsabbruch mit kurzem Backoff neu verbinden; nach dem Reconnect kommt
zuerst wieder ein `state`.

### Die eine Nachricht, die ein Client senden darf

Bis auf **eine** werden eingehende Nachrichten ignoriert — alles über 256 Bytes
wird verworfen, ohne überhaupt geparst zu werden.

```jsonc
{ "type": "rawtap", "on": true }    // "ich schaue auf die Rohzeilen"
{ "type": "rawtap", "on": false }   // "ich schaue nicht mehr hin"
```

Erst danach kommen `raw`-Rahmen, und nur an die Clients, die sich gemeldet
haben. **Ohne Anmeldung erzeugt der Dienst überhaupt keine Rohzeilen** — er
zerlegt den TCP-Strom dafür nicht einmal in Zeilen. Beim Schließen der
Verbindung meldet der Client sich automatisch ab; nach einem Reconnect muss er
sich neu melden.

Ein `raw`-Rahmen trägt **mehrere** Zeilen: einen je 250 ms, oder sofort ab 400
angesammelten Zeilen. Ein Rahmen je Zeile wäre bei über fünfzig Spielern
messbar teurer als die eigentliche Arbeit. `dropped` zählt die Zeilen, die der
Dienst seit dem letzten Rahmen verworfen hat, weil mehr ankam als abfließen
konnte (Grenze: 4000 wartende Zeilen). Einzelheiten in
[CAPTURE.md](CAPTURE.md#live-rohdaten).

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

## Fehlercodes

| Status | Bedeutung |
|---|---|
| `401` | Token fehlt oder falsch; bei den passwortbestätigten Routen `{"error":"bad_password"}` |
| `403` | mutierende Anfrage ohne Token und ohne `Sec-Fetch-Site: same-origin` / `X-LF-Console: 1` |
| `429` | Rate-Limit erreicht, oder zu viele falsche Passwörter (`locked_out`, mit `Retry-After`) |
| `404` | unbekannte Route oder Datei |
| `400` | ungültiges JSON im POST-Body, oder ein abgewiesener Dateiname (`bad_name`, `protected`) |
| `500` | interner Fehler (wird geloggt) |
