# Regie-Software anbinden (Next.js)

So verbindest du eine **Next.js-Regie-Anwendung im selben Netzwerk** mit lf_live —
Live-Scoreboard, Torgrafiken, Einblendungen, Replays auslösen.

Alles hier ist copy-paste-fertig (App Router, TypeScript).

---

## 1. Das Bild

```
┌─────────────────────────┐         LAN          ┌──────────────────────────┐
│  Hallen-PC              │   192.168.x.x:8080   │  Regie-Laptop            │
│  ┌───────────────────┐  │◀────────────────────▶│  ┌────────────────────┐  │
│  │  lf_live          │  │   WebSocket / REST   │  │  Next.js  :3000     │  │
│  │  Laserforce ─▶ …  │  │                      │  │  ┌──────────────┐  │  │
│  └───────────────────┘  │                      │  │  │ /api/live/*  │  │  │
│  Laserforce ─TCP─▶ :9000│                      │  │  │  (Bridge)    │  │  │
└─────────────────────────┘                      │  │  └──────┬───────┘  │  │
                                                 │  │   EventSource      │  │
                                                 │  │  ┌──────▼───────┐  │  │
                                                 │  │  │ Regie-UI     │  │  │
                                                 │  │  └──────────────┘  │  │
                                                 │  └────────────────────┘  │
                                                 └──────────────────────────┘
```

**Empfohlen:** Die Next.js-App macht die Verbindung zu lf_live **serverseitig** auf
(Route Handler) und reicht die Daten per **SSE** an den Browser weiter. Vorteile:

- Das lf_live-Token bleibt auf dem Server, nie im Browser.
- Kein CORS, kein Mixed-Content-Problem (auch wenn die Regie-UI über HTTPS läuft).
- `EventSource` reconnectet von selbst.

---

## 2. Netzwerk & Zugang

| | |
|---|---|
| **lf_live-Adresse** | `http://<Hallen-PC-IP>:8080` — IP steht oben in der lf_live-Konsole, sonst `ipconfig` |
| **Erreichbarkeit** | lf_live muss auf `0.0.0.0` binden (Standard) und die Windows-Firewall muss `node.exe` im privaten Netz erlauben |
| **Token** | Nur nötig, wenn in lf_live gesetzt. Dann als `Authorization: Bearer <token>` bzw. `?token=` |
| **Ports** | `8080` HTTP + WebSocket · `9000` Laserforce-Eingang (geht die Regie nichts an) |

### `.env.local` (Next.js)

```ini
# Serverseitig — landet NIE im Browser
LF_LIVE_URL=http://192.168.1.10:8080
LF_LIVE_TOKEN=

# Falls du zusätzlich direkt aus dem Browser verbinden willst (Abschnitt 6)
NEXT_PUBLIC_LF_LIVE_HOST=192.168.1.10:8080
```

---

## 3. Die Bridge: ein Route Handler + ein Hook

### `lib/lf-live.ts` — serverseitige Helfer

```ts
const BASE = process.env.LF_LIVE_URL!;
const TOKEN = process.env.LF_LIVE_TOKEN ?? "";
const auth = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

export type Player = {
  id: string; name: string; teamId: string; avatar: null;
  status: number; goals: number; assists: number;
  stealsDone: number; stealsReceived: number;
  blocksDone: number; blocksReceived: number;
  resetsDone: number; resetsReceived: number;
  clearsDone: number; clearsReceived: number;
  passesDone: number; passesReceived: number;
};

export type MatchState = {
  missionActive: boolean;
  matchId: string | null;
  duration: number;      // ms
  elapsedTime: number;   // ms
  teams: Record<string, { name: string; color: string }>;
  scores: Record<string, number>;
  ballHolderId: string | null;
  players: Record<string, Player>;
  events: LiveEvent[];
  updatedAt: number | null;
};

export type LiveEvent = {
  id: number; ts: number; elapsedMs: number; matchId: string | null;
  type: "match_start" | "match_end" | "player_join" | "pass" | "clear"
      | "steal" | "block" | "reset" | "failed_clear" | "goal" | "status";
  code?: string;
  actorId?: string; actorName?: string; actorTeamId?: string;
  targetId?: string | null; targetName?: string | null; targetTeamId?: string | null;
  assistId?: string | null; assistName?: string | null;
  scores?: Record<string, number>;   // bei "goal"
  text: string;                      // Klartext, nie HTML
};

export async function getState(): Promise<MatchState> {
  const r = await fetch(`${BASE}/api/state`, { headers: auth, cache: "no-store" });
  if (!r.ok) throw new Error(`lf_live ${r.status}`);
  return (await r.json()).data;
}

export async function getEvents(since = 0, limit = 50): Promise<LiveEvent[]> {
  const r = await fetch(`${BASE}/api/events?since=${since}&limit=${limit}`, { headers: auth, cache: "no-store" });
  return (await r.json()).data;
}
```

### `app/api/live/stream/route.ts` — SSE-Bridge

```ts
import WebSocket from "ws";           // npm i ws   (oder das globale WebSocket in Node ≥ 22)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WS_URL =
  process.env.LF_LIVE_URL!.replace(/^http/, "ws") + "/ws" +
  (process.env.LF_LIVE_TOKEN ? `?token=${encodeURIComponent(process.env.LF_LIVE_TOKEN)}` : "");

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let ws: WebSocket | null = null;
  let ping: ReturnType<typeof setInterval>;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      const connect = () => {
        if (closed) return;
        ws = new WebSocket(WS_URL);
        ws.on("message", (buf) => {
          try {
            const m = JSON.parse(buf.toString());   // { type: "hello" | "state" | "event", data }
            send(m.type, m.data ?? null);
          } catch {}
        });
        ws.on("close", () => { if (!closed) setTimeout(connect, 2000); });
        ws.on("error", () => ws?.close());
      };
      connect();

      // Kommentar-Ping, damit Proxies die SSE nicht kappen
      ping = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 15000);

      req.signal.addEventListener("abort", () => {
        closed = true; clearInterval(ping); ws?.close();
        try { controller.close(); } catch {}
      });
    },
    cancel() { closed = true; clearInterval(ping); ws?.close(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

### `hooks/useLiveMatch.ts` — der Client-Hook

```ts
"use client";
import { useEffect, useRef, useState } from "react";
import type { MatchState, LiveEvent } from "@/lib/lf-live";

export function useLiveMatch(onEvent?: (e: LiveEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<MatchState | null>(null);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    const es = new EventSource("/api/live/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);   // EventSource reconnectet selbst
    es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("event", (e) => {
      const ev: LiveEvent = JSON.parse((e as MessageEvent).data);
      setLastEvent(ev);
      cb.current?.(ev);
    });
    return () => es.close();
  }, []);

  return { connected, state, lastEvent };
}
```

### Benutzen

```tsx
"use client";
import { useLiveMatch } from "@/hooks/useLiveMatch";

export default function RegieBoard() {
  const { connected, state } = useLiveMatch((ev) => {
    switch (ev.type) {
      case "goal":        triggerGoalGraphic(ev.actorName!, ev.scores!); break;
      case "match_start": cutTo("scoreboard"); break;
      case "match_end":   cutTo("abspann"); break;
      case "steal":       ticker(`${ev.actorName} — Steal`); break;
    }
  });

  if (!state) return <div>Warte auf lf_live… {connected ? "" : "(getrennt)"}</div>;

  const [a, b] = Object.keys(state.teams);
  return (
    <div className="scoreboard">
      <Team meta={state.teams[a]} score={state.scores[a] ?? 0} />
      <Clock remainingMs={state.duration - state.elapsedTime} running={state.missionActive} />
      <Team meta={state.teams[b]} score={state.scores[b] ?? 0} />
    </div>
  );
}
```

---

## 4. Events: was die Regie damit macht

Jedes `event` ist ein flaches Objekt (Feld-Liste siehe `LiveEvent` oben). `text`
ist immer reiner Klartext (`"Tim SCORED"`), nie HTML.

| `type` | ausgelöst durch | typische Regie-Reaktion |
|---|---|---|
| `match_start` | Mission-Start (`0100`) | Scoreboard einblenden, Uhr starten, `matchId` merken |
| `match_end` | Mission-Ende (`0101`) | Endstand-Grafik / Abspann, `event.scores` ist final |
| `player_join` | Spieler-Login | Aufstellung aktualisieren |
| `goal` | Tor (`1101`/`1102`) | Torgrafik mit `actorName`, ggf. `assistName`, neuer Stand in `event.scores` |
| `steal` | Steal (`1103`) | kurzer Ticker / Sound |
| `block` / `reset` | Block bzw. Reset (`1104`) | optional Ticker |
| `pass` / `clear` | Pass / Clear (`1100`/`1109`) | meist ignorieren (hohe Frequenz) — für Ballbesitz-Heatmap nutzbar |
| `failed_clear` | `110A` | optional |
| `status` | Hardware-Status (`0` aktiv · `2` in Reset · `3` aus) | Spieler ausgrauen etc. |

Event-Router als eigene Funktion (leichter testbar):

```ts
export function handleRegieEvent(ev: LiveEvent, api: RegieApi) {
  switch (ev.type) {
    case "match_start": api.showScoreboard(); api.startClock(); break;
    case "match_end":   api.showFinal(ev.scores!); break;
    case "goal":
      api.goalGraphic({ scorer: ev.actorName!, assist: ev.assistName ?? undefined, scores: ev.scores! });
      api.bumpScoreboard(ev.scores!);
      break;
    case "steal":  api.ticker(`${ev.actorName} steal`); break;
    case "status": api.setPlayerState(ev.actorId!, ev.status as number); break;
  }
}
```

---

## 5. Realtime-Muster (wichtig)

**Uhr lokal weiterlaufen lassen.** `state` kommt gedrosselt (Takt `LF_STATE_TICK_MS`, Default ~5×/s). Für eine
flüssige Sekundenanzeige die Restzeit aus dem letzten `state` nehmen und lokal
per `setInterval` runterzählen; bei jedem neuen `state` resynchronisieren.

```ts
const [remaining, setRemaining] = useState(0);
useEffect(() => {
  if (!state) return;
  setRemaining(state.duration - state.elapsedTime);
  if (!state.missionActive) return;
  const t = setInterval(() => setRemaining((r) => Math.max(0, r - 1000)), 1000);
  return () => clearInterval(t);
}, [state?.updatedAt, state?.missionActive]);
```

**Reconnect-Lücken schließen.** Nach einem Verbindungsabbruch schickt lf_live
zuerst wieder einen vollen `state` — die Anzeige ist also automatisch korrekt.
Verpasste *Events* (Tore) sind nicht rückwirkend als Trigger nötig, weil der
neue `state` die Scores schon enthält. Willst du die Event-Historie lückenlos,
poll einmalig `GET /api/events?since=<letzte id>` nach dem Reconnect.

**`matchId` als Wechsel-Signal.** Ändert sich `state.matchId`, hat ein neues
Match begonnen — alte Einblendungen/Timer zurücksetzen.

**Team-Reihenfolge ist stabil** (aufsteigend nach Team-ID). „Links/rechts" bleibt
das ganze Match konsistent.

---

## 6. Alternative: direkt aus dem Browser

Einfachster Weg, **wenn die Regie-UI über `http://` läuft** (nicht HTTPS) und im
selben LAN ist. Kein Route Handler nötig.

```ts
"use client";
import { useEffect, useRef, useState } from "react";

const HOST = process.env.NEXT_PUBLIC_LF_LIVE_HOST!;      // "192.168.1.10:8080"
const TOKEN = "";                                        // nur wenn in lf_live gesetzt

export function useLiveMatchDirect() {
  const [state, setState] = useState<any>(null);
  useEffect(() => {
    let ws: WebSocket, dead = false;
    const open = () => {
      ws = new WebSocket(`ws://${HOST}/ws${TOKEN ? `?token=${TOKEN}` : ""}`);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "state") setState(m.data);
        // m.type === "event" -> hier Trigger
      };
      ws.onclose = () => { if (!dead) setTimeout(open, 2000); };
    };
    open();
    return () => { dead = true; ws.close(); };
  }, []);
  return state;
}
```

> ⚠️ Läuft die Regie-Seite über **HTTPS**, blockiert der Browser `ws://` (Mixed
> Content). Dann zwingend die SSE-Bridge aus Abschnitt 3 nehmen — oder lf_live
> hinter einen TLS-Reverse-Proxy setzen.

---

## 7. Alternative: lf_live pusht (Webhook)

Wenn die Regie lieber *empfängt* statt zu verbinden. In der lf_live-Konsole
**Ausgänge → Ziel hinzufügen → Webhook**, URL `http://<regie-laptop>:3000/api/live/hook`,
Secret setzen.

```ts
// app/api/live/hook/route.ts
import crypto from "crypto";

const SECRET = process.env.LF_HOOK_SECRET ?? "";

export async function POST(req: Request) {
  const raw = await req.text();
  if (SECRET) {
    const ts = req.headers.get("x-lfb-timestamp");
    const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
    if (req.headers.get("x-lfb-signature") !== expected) return new Response("bad signature", { status: 401 });
  }
  const { event, data } = JSON.parse(raw);   // data = LiveEvent
  // -> an die UI verteilen (z. B. über einen In-Memory-Emitter + eigener SSE-Route,
  //    Redis Pub/Sub, oder revalidateTag(...) bei Server-Component-Anzeigen)
  return Response.json({ ok: true });
}
```

Für reine Trigger (Tor → Grafik) ist der Webhook super. Für eine dauerhaft
korrekte Anzeige ist die WebSocket/SSE-Verbindung besser, weil sie den vollen
`state` mitliefert.

---

## 8. REST für Einzelabfragen

Server Component, die den aktuellen Stand rendert:

```tsx
import { getState } from "@/lib/lf-live";

export default async function Page() {
  const state = await getState();   // cache: "no-store"
  return <pre>{JSON.stringify(state.scores, null, 2)}</pre>;
}
```

Endpunkte: `/api/state` · `/api/teams` · `/api/players` · `/api/events?since=&limit=`
· `/api/status`. Volle Referenz: [API.md](API.md).

---

## 9. Nicht-Web-Teile (vMix, Companion …)

Der **rohe TCP-Stream** von lf_live (Konsole → Ausgänge → Raw TCP einschalten)
liefert dieselben Nachrichten als JSON-Zeilen an jeden, der sich auf den Port
verbindet. Oder ein **TCP/UDP-Ausgang**, der aktiv an `host:port` schickt.
Details: [INTEGRATION.md](INTEGRATION.md).

---

## 10. Testen ohne Anlage

```bash
cd lf_live && npm start
# in einem zweiten Terminal — echte Matches mit Laufzeit + Spielerzahl:
node ../lf_simulate/simulate.js --rounds 8 --players 10 --duration 300 --speed 8
```

Die Regie-App gegen dieses lf_live richten — Scoreboard, Tor-Trigger,
Match-Start/Ende laufen alle durch. Ob die Events wirklich ankommen, zeigt
`node ../lf_simulate/monitor.js`.

---

## 11. Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| `EventSource` verbindet, aber nie `state` | lf_live-Token fehlt/falsch in `.env.local` (`LF_LIVE_TOKEN`) → die serverseitige WS wird mit `401` abgewiesen |
| Browser-Konsole: „Mixed Content: ws:// blocked" | Regie-Seite läuft über HTTPS → SSE-Bridge (Abschnitt 3) statt Direktverbindung |
| Nichts kommt an, `curl http://<ip>:8080/api/health` von der Regie schlägt fehl | Windows-Firewall: `node.exe` fürs private Netz freigeben; gleiches Subnetz? |
| Uhr springt / ruckelt | Restzeit lokal runterzählen, nur bei neuem `state` resyncen (Abschnitt 5) |
| Nach lf_live-Neustart bleibt die Anzeige leer | `EventSource` reconnectet automatisch; bei der Direktverbindung eigenen Reconnect einbauen (im Beispiel enthalten) |
| Doppelte Tor-Trigger | Events sind idempotent über `event.id` — pro `id` nur einmal auslösen |
| `ws`-Import wirft im Route Handler | `export const runtime = "nodejs"` gesetzt? Edge Runtime kann kein TCP/`ws` |
