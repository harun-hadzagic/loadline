import "./setup-env";
import {
  DEMO_COMPANIES,
  decodeCursor,
  encodeCursor,
  OutboxReader,
  pruneOutbox,
  sql,
  withTenant,
} from "@loadline/db";
import { createPool, testUrls } from "@loadline/db/testing";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EventHub, type StreamClient } from "@/server/stream/hub";

// The hub against the real database, with fake SSE clients. These are the
// cases the Phase 3 review proved could lose or repeat events.

const ACME = DEMO_COMPANIES[0]!;
const urls = testUrls();
const appPool = createPool(urls.app, { max: 4 });
const superPool = createPool(urls.superuser, { max: 2 });
const hubs: EventHub[] = [];

afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
});
afterAll(async () => {
  await appPool.end();
  await superPool.end();
});

interface Frame {
  id: string; // SSE id (resume cursor)
  event: string;
  rowId: string;
  type: string;
}

function parseFrames(chunks: string[]): Frame[] {
  const out: Frame[] = [];
  for (const chunk of chunks) {
    if (chunk.startsWith(":")) continue;
    const lines = chunk.split("\n");
    const get = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2) ?? "";
    const data = get("data") ? (JSON.parse(get("data")) as { id?: string; type?: string }) : {};
    out.push({ id: get("id"), event: get("event"), rowId: data.id ?? "", type: data.type ?? "" });
  }
  return out;
}

function fakeClient(companyId = ACME.id): StreamClient & { chunks: string[]; closed: boolean } {
  const c = {
    id: Math.floor(Math.random() * 1e9),
    companyId,
    role: "dispatcher",
    driverId: null,
    chunks: [] as string[],
    closed: false,
    send: (chunk: string) => {
      c.chunks.push(chunk);
    },
    close: () => {
      c.closed = true;
    },
  };
  return c;
}

/** A hub whose reader is driven by hand: no LISTEN, no timers; we call drain through a poll-free path. */
function makeHub(): EventHub & { drainNow: () => Promise<void> } {
  const hub = new EventHub(new OutboxReader({ connectionString: urls.stream })) as EventHub & {
    drainNow: () => Promise<void>;
  };
  // schedule() is private; a notification would call it. For deterministic tests we call it directly.
  hub.drainNow = async () => {
    (hub as unknown as { schedule: () => void }).schedule();
    // wait for the drain to settle
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      if (!(hub as unknown as { draining: boolean }).draining) break;
    }
  };
  hubs.push(hub);
  return hub;
}

async function emitAs(type: string, companyId = ACME.id): Promise<string> {
  return withTenant(
    { companyId, role: "dispatcher" },
    async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`SELECT app.emit(${type}, NULL)::text AS id`);
      return r.rows[0]!.id;
    },
    { pool: appPool },
  );
}

async function openTx(companyId = ACME.id) {
  const client = await appPool.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
    [companyId],
  );
  return {
    emit: async (type: string) =>
      (await client.query<{ id: string }>("SELECT app.emit($1, NULL)::text AS id", [type])).rows[0]!
        .id,
    commit: async () => {
      await client.query("COMMIT");
      client.release();
    },
  };
}

describe("EventHub", () => {
  it("delivers a row whose transaction commits between an empty drain and the next one (no second snapshot)", async () => {
    const hub = makeHub();
    const client = fakeClient();
    await hub.subscribe(client, null);
    const t = await openTx();
    const id = await t.emit("hub.empty-drain"); // in progress: invisible, holds the horizon back
    await hub.drainNow(); // empty read; must not take its horizon from a later snapshot
    await t.commit();
    await hub.drainNow();
    const frames = parseFrames(client.chunks);
    expect(frames.map((f) => f.rowId)).toContain(id);
  });

  it("survives a drain of more than one page with an old transaction committing between pages, and sends nothing twice", async () => {
    const hub = makeHub();
    const client = fakeClient();
    await hub.subscribe(client, null);
    const old = await openTx();
    const oldId = await old.emit("hub.old");
    // 600 rows above the horizon (the old transaction keeps the horizon below them).
    const ids: string[] = [];
    for (let i = 0; i < 600; i++) ids.push(await emitAs(`hub.page.${i}`));
    // Commit the old transaction right when the first page has been read: simulate by committing
    // before the drain; the point is that its row sorts before the 600 and must still arrive.
    await old.commit();
    await hub.drainNow();
    const got = parseFrames(client.chunks).filter((f) => f.event.startsWith("hub."));
    const rowIds = got.map((f) => f.rowId);
    expect(rowIds).toContain(oldId);
    for (const id of ids) expect(rowIds).toContain(id);
    expect(new Set(rowIds).size).toBe(rowIds.length); // the server never repeats a row to one client
    // A second drain repeats nothing either.
    const before = client.chunks.length;
    await hub.drainNow();
    expect(client.chunks.length).toBe(before);
  });

  it("every frame's id is a complete resume point: replaying from it yields every later row", async () => {
    const hub = makeHub();
    const client = fakeClient();
    await hub.subscribe(client, null);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await emitAs(`hub.resume.${i}`));
    await hub.drainNow();
    const frames = parseFrames(client.chunks).filter((f) => f.event.startsWith("hub.resume"));
    expect(frames).toHaveLength(8);
    for (let i = 0; i < frames.length; i++) {
      const resumed = fakeClient();
      await hub.subscribe(resumed, frames[i]!.id);
      const replayed = parseFrames(resumed.chunks)
        .filter((f) => f.event.startsWith("hub.resume"))
        .map((f) => f.rowId);
      // Everything after frame i must be there (frame i itself may repeat).
      for (const later of frames.slice(i + 1)) expect(replayed).toContain(later.rowId);
      hub.unsubscribe(resumed);
    }
  });

  it("tells a client whose cursor is at or below the prune watermark to resync, even when the outbox is empty", async () => {
    const hub = makeHub();
    const client = fakeClient();
    await hub.subscribe(client, null);
    const id = await emitAs("hub.prune");
    await hub.drainNow();
    const frame = parseFrames(client.chunks).find((f) => f.rowId === id)!;
    // Age everything and prune, as a quiet day would.
    await superPool.query("UPDATE app.outbox SET created_at = now() - interval '25 hours'");
    expect(await pruneOutbox()).toBeGreaterThan(0);
    const late = fakeClient();
    await hub.subscribe(late, frame.id);
    const events = parseFrames(late.chunks).map((f) => f.event);
    expect(events).toContain("resync");
  });

  it("closes a client whose subscribe fails instead of leaving a silent stream", async () => {
    const hub = makeHub();
    const client = fakeClient();
    // A cursor outside the xid8 range makes the replay query fail.
    await expect(hub.subscribe(client, "18446744073709551616:1")).rejects.toThrow();
    // The route calls close() on rejection; here we assert the hub did not keep it.
    expect(hub.stats().clients).toBe(0);
  });

  it("gives drivers only events addressed to them, and never another company's events", async () => {
    const hub = makeHub();
    const staff = fakeClient();
    const driverId = "00000000-0000-4000-8000-000000000d01";
    const driver = { ...fakeClient(), role: "driver", driverId };
    const other = fakeClient(DEMO_COMPANIES[1]!.id);
    await hub.subscribe(staff, null);
    await hub.subscribe(driver, null);
    await hub.subscribe(other, null);
    const forAll = await emitAs("hub.aud.all");
    const forDriver = await withTenant(
      { companyId: ACME.id, role: "dispatcher" },
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`SELECT app.emit('hub.aud.driver', NULL, '{}'::jsonb, ${`{${driverId}}`}::uuid[])::text AS id`,
          )
        ).rows[0]!.id,
      { pool: appPool },
    );
    await hub.drainNow();
    const rows = (c: { chunks: string[] }) =>
      parseFrames(c.chunks)
        .filter((f) => f.event.startsWith("hub.aud"))
        .map((f) => f.rowId);
    expect(rows(staff)).toEqual(expect.arrayContaining([forAll, forDriver]));
    expect(rows(driver)).toEqual([forDriver]);
    expect(rows(other)).toEqual([]);
    expect(decodeCursor(encodeCursor({ txid: 1n, id: 2n }))).toEqual({ txid: 1n, id: 2n });
  });
});
