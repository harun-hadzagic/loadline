// Sync latency: N SSE clients in one company, M writes through the API at a
// steady rate, time from each write's response to each client's receipt of
// its event. One machine, one clock. Writes JSON to results/sync-latency.json.
//
//   BENCH_BASE_URL=http://localhost:3000 pnpm bench:sync
//   CLIENTS=50 WRITES=200 RATE=5 (writes per second)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventSource } from "eventsource";
import { BASE_URL, machineInfo, percentile, signInCookie } from "./env.ts";

const CLIENTS = Number(process.env.CLIENTS ?? 50);
const WRITES = Number(process.env.WRITES ?? 200);
const RATE = Number(process.env.RATE ?? 5);
const GRACE_MS = Number(process.env.GRACE_MS ?? 5_000);

interface LoadJson {
  id: string;
  reference: string;
  version: number;
  status: string;
}

interface Pending {
  /** Set when the write's HTTP response arrives; receipts before that are kept until then. */
  responseAt: number | null;
  receivedBy: Set<number>;
  receivedAt: number[];
}

async function main(): Promise<void> {
  const cookie = await signInCookie();
  const headers = { cookie };

  const loadsRes = await fetch(`${BASE_URL}/api/loads?status=open`, { headers });
  if (!loadsRes.ok) throw new Error(`loads: ${loadsRes.status}`);
  const { loads } = (await loadsRes.json()) as { loads: LoadJson[] };
  if (!loads.length) throw new Error("no open loads to write to; seed the database");

  // Track each write by (entityId, version): clients report the pair they received.
  const pending = new Map<string, Pending>();
  const key = (id: string, version: number) => `${id}:${version}`;
  let stray = 0;

  const clients: EventSource[] = [];
  let ready = 0;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`only ${ready}/${CLIENTS} clients connected`)),
      30_000,
    );
    for (let i = 0; i < CLIENTS; i++) {
      const es = new EventSource(`${BASE_URL}/api/events`, {
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), cookie },
          }),
      });
      es.addEventListener("hello", () => {
        ready++;
        if (ready === CLIENTS) {
          clearTimeout(timer);
          resolve();
        }
      });
      es.addEventListener("load.updated", (ev) => {
        const now = performance.now();
        const data = JSON.parse((ev as MessageEvent<string>).data) as {
          entityId: string;
          payload: { version: number };
        };
        const p = pending.get(key(data.entityId, data.payload.version));
        if (!p) {
          stray++;
          return;
        }
        if (p.receivedBy.has(i)) return;
        p.receivedBy.add(i);
        p.receivedAt.push(now);
      });
      es.onerror = (e) => console.error(`client ${i} error`, e);
      clients.push(es);
    }
  });
  console.log(`${CLIENTS} clients connected; ${WRITES} writes at ${RATE}/s`);

  const interval = 1000 / RATE;
  const versions = new Map(loads.map((l) => [l.id, l.version]));
  const started = performance.now();
  for (let n = 0; n < WRITES; n++) {
    const target = loads[n % loads.length] as LoadJson;
    const version = versions.get(target.id) as number;
    // Register the expected event before the write goes out: the stream can
    // deliver it before the HTTP response has been read.
    const entry: Pending = { responseAt: null, receivedBy: new Set(), receivedAt: [] };
    pending.set(key(target.id, version + 1), entry);
    const t0 = performance.now();
    const res = await fetch(`${BASE_URL}/api/loads/${target.id}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ version, notes: `bench ${n} ${Date.now()}` }),
    });
    entry.responseAt = performance.now();
    if (!res.ok) throw new Error(`write ${n} failed: ${res.status} ${await res.text()}`);
    const { load } = (await res.json()) as { load: LoadJson };
    if (load.version !== version + 1)
      throw new Error(`write ${n}: unexpected version ${load.version}`);
    versions.set(load.id, load.version);
    const elapsed = performance.now() - t0;
    if (elapsed < interval) await new Promise((r) => setTimeout(r, interval - elapsed));
  }
  const writeSeconds = (performance.now() - started) / 1000;
  await new Promise((r) => setTimeout(r, GRACE_MS));
  for (const es of clients) es.close();

  const all: number[] = [];
  let lost = 0;
  let beforeResponse = 0;
  for (const p of pending.values()) {
    const responseAt = p.responseAt ?? Number.NaN;
    for (const t of p.receivedAt) {
      const latency = t - responseAt;
      if (latency < 0) beforeResponse++;
      all.push(latency);
    }
    lost += CLIENTS - p.receivedBy.size;
  }
  all.sort((a, b) => a - b);
  const result = {
    benchmark: "sync-latency",
    date: new Date().toISOString(),
    machine: machineInfo(),
    config: { clients: CLIENTS, writes: WRITES, targetWritesPerSecond: RATE, baseUrl: BASE_URL },
    achievedWritesPerSecond: Number((WRITES / writeSeconds).toFixed(2)),
    expectedDeliveries: CLIENTS * WRITES,
    deliveries: all.length,
    lost,
    stray,
    /** Receipts that beat the write's own HTTP response; their latency is negative. */
    beforeResponse,
    latencyMs: {
      p50: Number(percentile(all, 50).toFixed(1)),
      p95: Number(percentile(all, 95).toFixed(1)),
      p99: Number(percentile(all, 99).toFixed(1)),
      max: Number((all[all.length - 1] ?? Number.NaN).toFixed(1)),
      min: Number((all[0] ?? Number.NaN).toFixed(1)),
      mean: Number((all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)).toFixed(1)),
    },
    note: "Latency is measured from the HTTP response of the write to the SSE receipt on each client, all on one machine and one clock, so it includes no network distance. A negative value means the event reached the client before the writer had read its own response.",
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(here, "../results/sync-latency.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`wrote ${out}`);
  if (lost > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
