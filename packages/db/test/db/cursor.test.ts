import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Cursor,
  compareCursor,
  decodeCursor,
  encodeCursor,
  OutboxReader,
} from "../../src/stream.ts";
import { ACME, asCompany, closePools, urls } from "./helpers.ts";

afterAll(closePools);

const reader = new OutboxReader({ connectionString: urls.stream });
afterAll(() => reader.stop());

async function tail(): Promise<Cursor | null> {
  return reader.latestCursor();
}

async function emitIn(client: pg.Client, type: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    "SELECT app.emit($1, NULL, '{}'::jsonb)::text AS id",
    [type],
  );
  return r.rows[0]!.id;
}

async function begin(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urls.app });
  await c.connect();
  await c.query("BEGIN");
  await c.query(
    "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
    [ACME.id],
  );
  return c;
}

describe("the visibility-safe cursor", () => {
  it("encodes and decodes, and compares by (txid, id)", () => {
    const c = { txid: 123n, id: 456n };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("nope")).toBeNull();
    expect(compareCursor({ txid: 1n, id: 9n }, { txid: 2n, id: 1n })).toBe(-1);
    expect(compareCursor({ txid: 2n, id: 1n }, { txid: 2n, id: 2n })).toBe(-1);
  });

  it("delivers both rows in a stable order when the later transaction commits first, and never skips the earlier one", async () => {
    const start = await tail();
    const t1 = await begin();
    const t2 = await begin();
    const id1 = await emitIn(t1, "cursor.t1"); // lower id, commits last
    const id2 = await emitIn(t2, "cursor.t2"); // higher id, commits first
    expect(BigInt(id2)).toBeGreaterThan(BigInt(id1));

    await t2.query("COMMIT");
    // A naive `id > last` reader would now hand out id2 and later skip id1.
    // The visibility-safe reader hands out nothing while t1 is still running
    // (t1's txid is the snapshot xmin and t2's txid is above it).
    const whileOpen = await reader.readVisible(start);
    expect(whileOpen.map((r) => r.id)).not.toContain(id1);
    expect(whileOpen.map((r) => r.id)).not.toContain(id2);

    await t1.query("COMMIT");
    const after = await reader.readVisible(start);
    const ids = after.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids.indexOf(id1)).toBeLessThan(ids.indexOf(id2)); // by txid: t1 began first
    for (let i = 1; i < after.length; i++)
      expect(compareCursor(after[i - 1]!.cursor, after[i]!.cursor)).toBe(-1);
    await t1.end();
    await t2.end();
  });

  it("readCommitted hands out a committed row while an older transaction is still open, and the horizon stays below it", async () => {
    const start = await tail();
    const t1 = await begin();
    const t2 = await begin();
    const id1 = await emitIn(t1, "eager.t1");
    const id2 = await emitIn(t2, "eager.t2");
    await t2.query("COMMIT");

    const whileOpen = await reader.readCommitted(start);
    const ids = whileOpen.rows.map((r) => r.id);
    expect(ids).toContain(id2); // delivered now, not held back by t1
    expect(ids).not.toContain(id1);
    // t1's txid is the snapshot xmin, so the horizon sits just below it:
    // a replay from the horizon will include both rows once t1 commits.
    const t1Row = whileOpen.rows.find((r) => r.id === id2)!;
    expect(whileOpen.horizon.txid).toBeLessThan(t1Row.cursor.txid);

    await t1.query("COMMIT");
    const after = await reader.readCommitted(whileOpen.horizon);
    expect(after.rows.map((r) => r.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(after.rows.findIndex((r) => r.id === id1)).toBeLessThan(
      after.rows.findIndex((r) => r.id === id2),
    );
    // Once nothing older runs, the horizon moves past both.
    expect(
      compareCursor(after.horizon, after.rows[after.rows.length - 1]!.cursor),
    ).toBeGreaterThanOrEqual(0);
    await t1.end();
    await t2.end();
  });

  it("replays from any cursor exactly once", async () => {
    const start = await tail();
    for (let i = 0; i < 5; i++) {
      await asCompany(ACME.id, (tx) =>
        tx.execute(sql`SELECT app.emit(${`cursor.replay.${i}`}, NULL)`),
      );
    }
    const all = await reader.readVisible(start);
    const mine = all.filter((r) => r.type.startsWith("cursor.replay."));
    expect(mine).toHaveLength(5);
    // From every intermediate cursor, the remainder is exactly the suffix, with no repeats or gaps.
    for (let i = 0; i < all.length; i++) {
      const rest = await reader.readVisible(all[i]!.cursor);
      expect(rest.map((r) => r.id)).toEqual(all.slice(i + 1).map((r) => r.id));
    }
    // Page boundaries do not lose or repeat rows either.
    const paged: string[] = [];
    let cursor: Cursor | null = start;
    for (;;) {
      const page = await reader.readVisible(cursor, 2);
      if (!page.length) break;
      paged.push(...page.map((r) => r.id));
      cursor = page[page.length - 1]!.cursor;
    }
    expect(paged).toEqual(all.map((r) => r.id));
  });

  it("wakes the listener on app.emit through NOTIFY", async () => {
    let wakes = 0;
    const r = new OutboxReader({ connectionString: urls.stream });
    await r.start(() => {
      wakes++;
    });
    const before = wakes; // start() fires one wake on connect
    await asCompany(ACME.id, (tx) => tx.execute(sql`SELECT app.emit('cursor.notify', NULL)`));
    await new Promise((res) => setTimeout(res, 300));
    expect(wakes).toBeGreaterThan(before);
    await r.stop();
  });
});
