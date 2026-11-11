import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OVERLAP_SQLSTATE } from "../../src/errors.ts";
import {
  ACME,
  asCompany,
  closePools,
  expectPgError,
  hoursFromNow,
  rangeLiteral,
  superPool,
  urls,
} from "./helpers.ts";

afterAll(closePools);

let driverId: string;
let truckA: string;
let truckB: string;

async function newLoad(): Promise<string> {
  return asCompany(ACME.id, async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.loads (company_id, reference) VALUES (${ACME.id}, ${`OVL-${randomUUID().slice(0, 8)}`}) RETURNING id`,
    );
    return r.rows[0]!.id;
  });
}

function assign(loadId: string, driver: string, truck: string, lower: Date, upper: Date) {
  return asCompany(ACME.id, async (tx) => {
    const r = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period)
          VALUES (${ACME.id}, ${loadId}, ${driver}, ${truck}, ${rangeLiteral(lower, upper)}::tstzrange) RETURNING id`,
    );
    return r.rows[0]!.id;
  });
}

beforeAll(async () => {
  // A fresh driver and two fresh trucks, so the seed's assignments cannot interfere.
  const ids = await asCompany(ACME.id, async (tx) => {
    const d = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.drivers (company_id, name) VALUES (${ACME.id}, 'Overlap Tester') RETURNING id`,
    );
    const t = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.trucks (company_id, unit_number, equipment) VALUES (${ACME.id}, ${`OV-${randomUUID().slice(0, 6)}`}, 'dry_van'), (${ACME.id}, ${`OV-${randomUUID().slice(0, 6)}`}, 'reefer') RETURNING id`,
    );
    return { driver: d.rows[0]!.id, trucks: t.rows.map((r) => r.id) };
  });
  driverId = ids.driver;
  truckA = ids.trucks[0]!;
  truckB = ids.trucks[1]!;
});

describe("no double-booking (WITHOUT OVERLAPS)", () => {
  const T = hoursFromNow(24 * 30); // far from the seed's windows

  it("rejects a second assignment for the same driver in an overlapping window, naming the constraint", async () => {
    const load1 = await newLoad();
    const load2 = await newLoad();
    await assign(load1, driverId, truckA, T, new Date(T.getTime() + 10 * 3_600_000));
    const err = await expectPgError(() =>
      assign(
        load2,
        driverId,
        truckB,
        new Date(T.getTime() + 5 * 3_600_000),
        new Date(T.getTime() + 15 * 3_600_000),
      ),
    );
    // Measured, not assumed: this is the SQLSTATE PostgreSQL 18 raises for a
    // WITHOUT OVERLAPS violation. The app maps it to 409 Conflict.
    expect(err.code).toBe(OVERLAP_SQLSTATE);
    expect(err.constraint).toBe("assignments_driver_no_overlap");
    expect(err.detail).toMatch(/conflicts with existing key/);
  });

  it("allows adjacent windows for the same driver (half-open ranges touch without overlapping)", async () => {
    const base = hoursFromNow(24 * 31);
    const load1 = await newLoad();
    const load2 = await newLoad();
    const mid = new Date(base.getTime() + 10 * 3_600_000);
    await assign(load1, driverId, truckA, base, mid);
    await expect(
      assign(load2, driverId, truckB, mid, new Date(mid.getTime() + 10 * 3_600_000)),
    ).resolves.toBeDefined();
  });

  it("rejects the same truck for two drivers in overlapping windows", async () => {
    const base = hoursFromNow(24 * 32);
    const other = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.drivers (company_id, name) VALUES (${ACME.id}, 'Second Driver') RETURNING id`,
      );
      return r.rows[0]!.id;
    });
    const load1 = await newLoad();
    const load2 = await newLoad();
    await assign(load1, driverId, truckA, base, new Date(base.getTime() + 8 * 3_600_000));
    const err = await expectPgError(() =>
      assign(
        load2,
        other,
        truckA,
        new Date(base.getTime() + 1 * 3_600_000),
        new Date(base.getTime() + 2 * 3_600_000),
      ),
    );
    expect(err.code).toBe(OVERLAP_SQLSTATE);
    expect(err.constraint).toBe("assignments_truck_no_overlap");
  });

  it("rejects two overlapping assignments for the same load", async () => {
    const base = hoursFromNow(24 * 33);
    const other = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.drivers (company_id, name) VALUES (${ACME.id}, 'Third Driver') RETURNING id`,
      );
      return r.rows[0]!.id;
    });
    const load = await newLoad();
    await assign(load, driverId, truckA, base, new Date(base.getTime() + 8 * 3_600_000));
    const err = await expectPgError(() =>
      assign(load, other, truckB, base, new Date(base.getTime() + 8 * 3_600_000)),
    );
    expect(err.code).toBe(OVERLAP_SQLSTATE);
    expect(err.constraint).toBe("assignments_load_no_overlap");
  });

  it("rejects an empty period", async () => {
    const base = hoursFromNow(24 * 34);
    const load = await newLoad();
    const err = await expectPgError(() => assign(load, driverId, truckA, base, base));
    expect(err.message).toMatch(/empty/i);
  });

  it("ending an assignment early frees the driver from that moment", async () => {
    const base = hoursFromNow(-2); // started two hours ago, planned for 10 more
    const load1 = await newLoad();
    const load2 = await newLoad();
    const first = await assign(load1, driverId, truckA, base, hoursFromNow(10));
    const beforeEnd = await expectPgError(() =>
      assign(load2, driverId, truckB, hoursFromNow(1), hoursFromNow(3)),
    );
    expect(beforeEnd.code).toBe(OVERLAP_SQLSTATE);
    await asCompany(ACME.id, (tx) =>
      tx.execute(
        sql`UPDATE app.assignments SET period = tstzrange(lower(period), now(), '[)'), ended_reason = 'unassigned' WHERE id = ${first}`,
      ),
    );
    await expect(
      assign(load2, driverId, truckB, hoursFromNow(1), hoursFromNow(3)),
    ).resolves.toBeDefined();
  });

  it("two concurrent transactions: one commits, the other fails on the constraint", async () => {
    const base = hoursFromNow(24 * 35);
    const end = new Date(base.getTime() + 6 * 3_600_000);
    const load1 = await newLoad();
    const load2 = await newLoad();
    const c1 = new pg.Client({ connectionString: urls.app });
    const c2 = new pg.Client({ connectionString: urls.app });
    await c1.connect();
    await c2.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
          [ACME.id],
        );
      }
      await c1.query(
        "INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period) VALUES ($1, $2, $3, $4, $5::tstzrange)",
        [ACME.id, load1, driverId, truckA, rangeLiteral(base, end)],
      );
      // c2 blocks on the index entry until c1 decides.
      const second = c2
        .query(
          "INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period) VALUES ($1, $2, $3, $4, $5::tstzrange)",
          [ACME.id, load2, driverId, truckB, rangeLiteral(base, end)],
        )
        .then(() => null as null | { code?: string })
        .catch((e: { code?: string }) => e);
      await new Promise((r) => setTimeout(r, 200));
      await c1.query("COMMIT");
      const err = await second;
      expect(err?.code).toBe(OVERLAP_SQLSTATE);
      await c2.query("ROLLBACK");
      const rows = await superPool().query(
        "SELECT load_id FROM app.assignments WHERE load_id IN ($1, $2)",
        [load1, load2],
      );
      expect(rows.rows.map((r) => r.load_id)).toEqual([load1]);
    } finally {
      await c1.end();
      await c2.end();
    }
  });
});
