import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { type Cursor, compareCursor, OutboxReader } from "../../src/stream.ts";
import { ACME, asCompany, closePools, urls } from "./helpers.ts";

// readCommitted is what the hub actually calls. These cases mirror the cursor
// test but through the production read path, plus the ones the Phase 3 review
// asked for: an empty read keeps the horizon honest, a transaction that takes
// its xid early and inserts late, and the skip list.

afterAll(closePools);
const reader = new OutboxReader({ connectionString: urls.stream });
afterAll(() => reader.stop());

async function begin(company = ACME.id): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urls.app });
  await c.connect();
  await c.query("BEGIN");
  await c.query(
    "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
    [company],
  );
  return c;
}
const emitIn = async (c: pg.Client, type: string) =>
  (await c.query<{ id: string }>("SELECT app.emit($1, NULL)::text AS id", [type])).rows[0]!.id;

async function all(after: Cursor | null): Promise<string[]> {
  const out: string[] = [];
  let cursor = after;
  for (;;) {
    const b = await reader.readCommitted(cursor, 100);
    out.push(...b.rows.map((r) => r.id));
    if (b.rows.length < 100) return out;
    cursor = b.rows[b.rows.length - 1]!.cursor;
  }
}

describe("readCommitted", () => {
  it("returns the snapshot even for an empty read, and its horizon never passes a running transaction", async () => {
    const start = await reader.currentHorizon();
    const t = await begin();
    const id = await emitIn(t, "rc.empty");
    const empty = await reader.readCommitted(start, 100);
    expect(empty.rows).toEqual([]);
    // The running transaction's xid is at or above the snapshot xmin, so the
    // horizon (xmin - 1) sits below it: a later read from that horizon finds the row.
    const txid = BigInt(
      (await t.query<{ x: string }>("SELECT pg_current_xact_id()::text AS x")).rows[0]!.x,
    );
    expect(empty.horizon.txid).toBeLessThan(txid);
    // In progress means: listed in xip, or at/above xmax (started after the last completed one).
    expect(txid >= empty.snapshot.xmax || empty.snapshot.xip.includes(txid)).toBe(true);
    await t.query("COMMIT");
    await t.end();
    const after = await reader.readCommitted(empty.horizon, 100);
    expect(after.rows.map((r) => r.id)).toContain(id);
  });

  it("orders by (txid, id) when a transaction takes its xid early and inserts late", async () => {
    const start = await reader.currentHorizon();
    const early = await begin();
    await early.query("SELECT pg_current_xact_id()"); // xid assigned now, outbox row much later
    const laterIds: string[] = [];
    for (let i = 0; i < 3; i++)
      laterIds.push(
        await asCompany(
          ACME.id,
          async (tx) =>
            (
              await tx.execute<{ id: string }>(
                sql`SELECT app.emit(${`rc.later.${i}`}, NULL)::text AS id`,
              )
            ).rows[0]!.id,
        ),
      );
    const earlyId = await emitIn(early, "rc.early"); // highest id, lowest txid
    expect(BigInt(earlyId)).toBeGreaterThan(BigInt(laterIds[2] as string));
    // Before the early transaction commits, the later rows are delivered (eagerly) and the horizon stays below it.
    const b1 = await reader.readCommitted(start, 100);
    expect(b1.rows.map((r) => r.id)).toEqual(expect.arrayContaining(laterIds));
    expect(b1.rows.map((r) => r.id)).not.toContain(earlyId);
    await early.query("COMMIT");
    await early.end();
    const b2 = await reader.readCommitted(start, 100);
    const ids = b2.rows.map((r) => r.id);
    expect(ids.indexOf(earlyId)).toBeLessThan(ids.indexOf(laterIds[0] as string)); // txid order, not id order
    for (let i = 1; i < b2.rows.length; i++)
      expect(compareCursor(b2.rows[i - 1]!.cursor, b2.rows[i]!.cursor)).toBe(-1);
    // A replay from b1's horizon (what a client would hold) includes the early row.
    expect((await all(b1.horizon)).includes(earlyId)).toBe(true);
  });

  it("with a skip snapshot, returns only rows that were in progress then or are newer", async () => {
    const start = await reader.currentHorizon();
    const stuck = await begin();
    await stuck.query("SELECT pg_current_xact_id()");
    const a = await asCompany(
      ACME.id,
      async (tx) =>
        (await tx.execute<{ id: string }>(sql`SELECT app.emit('rc.skip.a', NULL)::text AS id`))
          .rows[0]!.id,
    );
    const first = await reader.readCommitted(start, 100);
    expect(first.rows.map((r) => r.id)).toContain(a);
    const b = await asCompany(
      ACME.id,
      async (tx) =>
        (await tx.execute<{ id: string }>(sql`SELECT app.emit('rc.skip.b', NULL)::text AS id`))
          .rows[0]!.id,
    );
    const stuckId = await emitIn(stuck, "rc.skip.stuck");
    await stuck.query("COMMIT");
    await stuck.end();
    // Same horizon (still held back by nothing newer than `stuck` was), but with the skip list:
    const second = await reader.readCommitted(start, 100, first.snapshot);
    const ids = second.rows.map((r) => r.id);
    expect(ids).toContain(b); // newer than the first snapshot's xmax
    expect(ids).toContain(stuckId); // was in progress at the first snapshot
    expect(ids).not.toContain(a); // already visible then: not read again
  });
});
