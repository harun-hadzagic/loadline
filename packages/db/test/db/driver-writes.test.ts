import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ACME, asCompany, closePools, hoursFromNow, insertLoad, superPool } from "./helpers.ts";

afterAll(closePools);

// What a driver may write is a trigger (migration 0010), not an application
// habit: a load's status forward, a stop's arrival and departure times, and
// closing their own assignment as delivered. Everything else is refused in
// SQL with 42501, whatever code path tries it.

const code = (e: unknown) =>
  (e as { code?: string; cause?: { code?: string } }).code ??
  (e as { cause?: { code?: string } }).cause?.code;

async function setup() {
  const load = await insertLoad(ACME.id, "assigned", { pickupAt: hoursFromNow(-1), hours: 30 });
  const ids = await asCompany(ACME.id, async (tx) => {
    const d = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.drivers (company_id, name) VALUES (${ACME.id}, 'Write Tester') RETURNING id`,
    );
    const t = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.trucks (company_id, unit_number, equipment) VALUES (${ACME.id}, ${`DW-${Math.random().toString(36).slice(2, 7)}`}, 'dry_van') RETURNING id`,
    );
    await tx.execute(sql`
      INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period)
      VALUES (${ACME.id}, ${load.id}, ${d.rows[0]!.id}, ${t.rows[0]!.id}, app.load_window(${load.id}))`);
    return { driverId: d.rows[0]!.id };
  });
  const stop = await superPool().query<{ id: string }>(
    "SELECT id FROM app.stops WHERE load_id = $1 ORDER BY seq LIMIT 1",
    [load.id],
  );
  return { loadId: load.id, driverId: ids.driverId, stopId: stop.rows[0]!.id };
}

const asDriver = <T>(driverId: string, fn: Parameters<typeof asCompany<T>>[1]) =>
  asCompany(ACME.id, fn, { role: "driver", driverId, userId: "driver-user" });

describe("what a driver may write (migration 0010)", () => {
  it("may move their load forward and stamp a stop, and nothing else on those rows", async () => {
    const { loadId, driverId, stopId } = await setup();
    await asDriver(driverId, async (tx) => {
      const r = await tx.execute(
        sql`UPDATE app.loads SET status = 'in_transit' WHERE id = ${loadId}`,
      );
      expect(r.rowCount).toBe(1);
      const s = await tx.execute(
        sql`UPDATE app.stops SET arrived_at = now(), departed_at = now() WHERE id = ${stopId}`,
      );
      expect(s.rowCount).toBe(1);
    });
    const refused: Array<[string, ReturnType<typeof sql>]> = [
      ["rate", sql`UPDATE app.loads SET rate_cents = 1 WHERE id = ${loadId}`],
      ["broker", sql`UPDATE app.loads SET broker_name = 'driver-edit' WHERE id = ${loadId}`],
      ["cancel", sql`UPDATE app.loads SET status = 'cancelled' WHERE id = ${loadId}`],
      [
        "appointment",
        sql`UPDATE app.stops SET appointment = tstzrange(now(), now() + interval '1 hour', '[)') WHERE id = ${stopId}`,
      ],
      [
        "location",
        sql`UPDATE app.stops SET location = ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography WHERE id = ${stopId}`,
      ],
      ["unassign", sql`SELECT app.end_assignment(${loadId}, 'unassigned')`],
      ["cancel via helper", sql`SELECT app.end_assignment(${loadId}, 'cancelled')`],
    ];
    for (const [what, statement] of refused) {
      const outcome = await asDriver(driverId, (tx) => tx.execute(statement)).then(
        () => "allowed",
        (e) => code(e),
      );
      expect(outcome, what).toBe("42501");
    }
    const after = await superPool().query<{ status: string; rate_cents: number | null }>(
      "SELECT status, rate_cents FROM app.loads WHERE id = $1",
      [loadId],
    );
    expect(after.rows[0]).toMatchObject({ status: "in_transit", rate_cents: null });
  });

  it("may close their own assignment as delivered, and the load is then out of their sight", async () => {
    const { loadId, driverId } = await setup();
    await asDriver(driverId, async (tx) => {
      await tx.execute(sql`UPDATE app.loads SET status = 'in_transit' WHERE id = ${loadId}`);
      await tx.execute(sql`UPDATE app.loads SET status = 'delivered' WHERE id = ${loadId}`);
      const n = await tx.execute<{ n: number }>(
        sql`SELECT app.end_assignment(${loadId}, 'delivered') AS n`,
      );
      expect(Number(n.rows[0]?.n)).toBe(1);
    });
    const visible = await asDriver(
      driverId,
      async (tx) => (await tx.execute(sql`SELECT 1 FROM app.loads WHERE id = ${loadId}`)).rowCount,
    );
    expect(visible).toBe(0);
  });

  it("staff are not limited by the trigger", async () => {
    const { loadId } = await setup();
    const r = await asCompany(ACME.id, (tx) =>
      tx.execute(
        sql`UPDATE app.loads SET rate_cents = 123400, status = 'cancelled' WHERE id = ${loadId}`,
      ),
    );
    expect(r.rowCount).toBe(1);
  });
});
