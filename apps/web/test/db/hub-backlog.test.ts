import "./setup-env";
import { DEMO_COMPANIES, OutboxReader, sql, withTenant } from "@loadline/db";
import { createPool, testUrls } from "@loadline/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { EventHub, type StreamClient } from "@/server/stream/hub";

// A client that cannot keep up is closed, never skipped: frames are not
// dropped on the floor while it is replaying, and a reconnect from its last
// id gets everything it missed.

const ACME = DEMO_COMPANIES[0]!;
const urls = testUrls();
const appPool = createPool(urls.app, { max: 4 });
const hubs: EventHub[] = [];
afterAll(async () => {
  for (const h of hubs) await h.stop();
  await appPool.end();
});

function makeHub(): EventHub {
  const hub = new EventHub(new OutboxReader({ connectionString: urls.stream }));
  hubs.push(hub);
  return hub;
}

function client(backlogAfter: number): StreamClient & { chunks: string[]; closed: boolean } {
  const c = {
    id: Math.floor(Math.random() * 1e9),
    companyId: ACME.id,
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
    // A consumer that stops reading after `backlogAfter` frames.
    backlog: () => Math.max(0, c.chunks.length - backlogAfter),
  };
  return c;
}

const rowIds = (chunks: string[]) =>
  chunks
    .map((ch) => /data: (\{.*\})/.exec(ch)?.[1])
    .filter((d): d is string => !!d)
    .map((d) => JSON.parse(d) as { id?: string; type?: string })
    .filter((d) => d.type?.startsWith("backlog."))
    .map((d) => d.id as string);

describe("EventHub backlog during replay", () => {
  it("closes a client that falls too far behind while replaying, instead of skipping frames, and a reconnect gets the rest", async () => {
    const hub = makeHub();
    // A cursor from before the writes.
    const probe = client(10_000);
    await hub.subscribe(probe, null);
    const hello = /id: ([^\n]+)/.exec(probe.chunks[0] ?? "")?.[1] ?? null;
    hub.unsubscribe(probe);
    const ids: string[] = [];
    for (let i = 0; i < 2_300; i++) {
      ids.push(
        await withTenant(
          { companyId: ACME.id, role: "dispatcher" },
          async (tx) =>
            (
              await tx.execute<{ id: string }>(
                sql`SELECT app.emit(${`backlog.${i}`}, NULL)::text AS id`,
              )
            ).rows[0]!.id,
          { pool: appPool },
        ),
      );
    }
    // Replays from the old cursor but stops consuming after 100 frames: it must be closed, not fed with gaps.
    const slow = client(100);
    await hub.subscribe(slow, hello);
    expect(slow.closed).toBe(true);
    expect(hub.stats().clients).toBe(0);
    const got = rowIds(slow.chunks);
    // Whatever it did receive is a prefix in order, with no holes.
    expect(got).toEqual(ids.slice(0, got.length));
    // Its last frame id is a complete resume point: a healthy reconnect from it gets every remaining row.
    const lastId =
      [...slow.chunks]
        .reverse()
        .map((ch) => /id: ([^\n]+)/.exec(ch)?.[1])
        .find((x) => x) ?? hello;
    const fresh = client(10_000);
    await hub.subscribe(fresh, lastId ?? null);
    const rest = rowIds(fresh.chunks);
    for (const id of ids.slice(got.length)) expect(rest).toContain(id);
  }, 120_000);
});
