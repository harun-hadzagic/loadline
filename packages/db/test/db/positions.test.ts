import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  ACME,
  asCompany,
  BLUERIDGE,
  closePools,
  hoursFromNow,
  insertLoad,
  superPool,
} from "./helpers.ts";

afterAll(closePools);

type Row = {
  applied: boolean;
  arrived_stop_id: string | null;
  arrived_load_id: string | null;
  arrived_seq: number | null;
};

async function record(truckId: string, lng: number, lat: number, at = new Date()): Promise<Row[]> {
  return asCompany(
    ACME.id,
    async (tx) =>
      (
        await tx.execute<Row>(
          sql`SELECT * FROM app.record_position(${truckId}, ${lng}, ${lat}, 90, 55, ${at.toISOString()}::timestamptz)`,
        )
      ).rows,
    { role: "system" },
  );
}
const arrivals = (rows: Row[]) => rows.filter((r) => r.arrived_stop_id !== null);

async function setup(opts: { pickupAt?: Date; status?: string } = {}) {
  // A fresh truck and driver on a load whose window has opened; stops in Dallas then Houston.
  const load = await insertLoad(ACME.id, opts.status ?? "assigned", {
    pickupAt: opts.pickupAt ?? hoursFromNow(-1),
    hours: 30,
  });
  const ids = await asCompany(ACME.id, async (tx) => {
    const d = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.drivers (company_id, name) VALUES (${ACME.id}, 'Arrival Tester') RETURNING id`,
    );
    const t = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.trucks (company_id, unit_number, equipment) VALUES (${ACME.id}, ${`AR-${Math.random().toString(36).slice(2, 7)}`}, 'dry_van') RETURNING id`,
    );
    await tx.execute(sql`
      INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period)
      VALUES (${ACME.id}, ${load.id}, ${d.rows[0]!.id}, ${t.rows[0]!.id}, app.load_window(${load.id}))`);
    return { truckId: t.rows[0]!.id, loadId: load.id };
  });
  const stops = await superPool().query<{ id: string; seq: number; lng: number; lat: number }>(
    "SELECT id, seq, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM app.stops WHERE load_id = $1 ORDER BY seq",
    [ids.loadId],
  );
  return { ...ids, stops: stops.rows };
}

describe("app.record_position", () => {
  it("upserts the latest position; a report older than the stored one is ignored and runs no arrival check", async () => {
    const { truckId, stops } = await setup();
    const pickup = stops[0]!;
    const t1 = new Date();
    const t0 = new Date(t1.getTime() - 60_000);
    expect((await record(truckId, -96.0, 32.0, t1))[0]?.applied).toBe(true);
    // Stale, and placed right at the pickup: must neither move the truck nor arrive.
    const stale = await record(truckId, pickup.lng, pickup.lat, t0);
    expect(stale).toEqual([
      { applied: false, arrived_stop_id: null, arrived_load_id: null, arrived_seq: null },
    ]);
    const r = await superPool().query<{ lng: number; n: string; arrived: string }>(
      `SELECT ST_X(location::geometry) AS lng, (SELECT count(*)::text FROM app.truck_positions WHERE truck_id = $1) AS n,
              (SELECT count(*)::text FROM app.stops WHERE id = $2 AND arrived_at IS NOT NULL) AS arrived
         FROM app.truck_positions WHERE truck_id = $1`,
      [truckId, pickup.id],
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
    expect(r.rows[0]?.lng).toBeCloseTo(-96.0, 5);
    expect(Number(r.rows[0]?.arrived)).toBe(0);
  });

  it("clamps a report dated in the future to now, so tomorrow's pickup cannot be arrived early", async () => {
    const { truckId, stops } = await setup();
    const pickup = stops[0]!;
    const future = new Date(Date.now() + 36 * 3_600_000);
    const rows = await record(truckId, pickup.lng, pickup.lat, future);
    expect(rows[0]?.applied).toBe(true);
    const r = await superPool().query<{ recorded: Date; arrived: Date | null }>(
      "SELECT p.recorded_at AS recorded, s.arrived_at AS arrived FROM app.truck_positions p, app.stops s WHERE p.truck_id = $1 AND s.id = $2",
      [truckId, pickup.id],
    );
    expect(r.rows[0]!.recorded.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    // The arrival itself is legitimate (the truck is at the pickup now); its time is now, not tomorrow.
    expect(r.rows[0]!.arrived?.getTime() ?? 0).toBeLessThanOrEqual(Date.now() + 5_000);
    // And a real report a moment later is not treated as stale.
    expect((await record(truckId, pickup.lng + 0.01, pickup.lat))[0]?.applied).toBe(true);
  });

  it("marks the next open stop as arrived inside the radius, in order, and never the load's status", async () => {
    const { truckId, loadId, stops } = await setup();
    const pickup = stops[0]!;
    const delivery = stops[1]!;
    // 5 miles from the pickup: nothing.
    expect(arrivals(await record(truckId, pickup.lng + 0.085, pickup.lat))).toEqual([]);
    // Near the delivery first: still nothing, the next stop is the pickup.
    expect(arrivals(await record(truckId, delivery.lng + 0.001, delivery.lat))).toEqual([]);
    // Within a mile of the pickup: arrival on the pickup, seq 1.
    const a = arrivals(await record(truckId, pickup.lng + 0.005, pickup.lat));
    expect(a).toHaveLength(1);
    expect(a[0]?.arrived_stop_id).toBe(pickup.id);
    expect(a[0]?.arrived_seq).toBe(1);
    // Reporting there again does not arrive twice.
    expect(arrivals(await record(truckId, pickup.lng + 0.004, pickup.lat))).toEqual([]);
    // Then the delivery.
    const b = arrivals(await record(truckId, delivery.lng, delivery.lat + 0.002));
    expect(b[0]?.arrived_stop_id).toBe(delivery.id);
    const load = await superPool().query<{ status: string; arrived: string }>(
      "SELECT status, (SELECT count(*)::text FROM app.stops WHERE load_id = $1 AND arrived_at IS NOT NULL) AS arrived FROM app.loads WHERE id = $1",
      [loadId],
    );
    expect(load.rows[0]?.status).toBe("assigned"); // arrival never changes status
    expect(Number(load.rows[0]?.arrived)).toBe(2);
  });

  it("still arrives after the planned window has closed (late deliveries happen)", async () => {
    // Window opened two days ago and closed yesterday; the truck finally gets there.
    const { truckId, stops } = await setup({ pickupAt: hoursFromNow(-48) });
    const pickup = stops[0]!;
    const delivery = stops[1]!;
    expect(arrivals(await record(truckId, pickup.lng, pickup.lat))).toHaveLength(1);
    expect(arrivals(await record(truckId, delivery.lng, delivery.lat))).toHaveLength(1);
  });

  it("uses the company's arrival radius", async () => {
    const { truckId, stops } = await setup();
    const pickup = stops[0]!;
    await superPool().query("UPDATE app.companies SET arrival_radius_miles = 10 WHERE id = $1", [
      ACME.id,
    ]);
    try {
      expect(arrivals(await record(truckId, pickup.lng + 0.1, pickup.lat))).toHaveLength(1); // ~6 miles
    } finally {
      await superPool().query("UPDATE app.companies SET arrival_radius_miles = 1 WHERE id = $1", [
        ACME.id,
      ]);
    }
  });

  it("cannot change another company's truck position", async () => {
    const theirs = await superPool().query<{ id: string; lng: number; at: string }>(
      "SELECT t.id, ST_X(p.location::geometry) AS lng, p.recorded_at::text AS at FROM app.trucks t JOIN app.truck_positions p ON p.truck_id = t.id WHERE t.company_id = $1 LIMIT 1",
      [BLUERIDGE.id],
    );
    const truck = theirs.rows[0]!;
    const outcome = await record(truck.id, -80, 35).then(
      (rows) => ({ rows, error: null as string | null }),
      (e: { code?: string; cause?: { code?: string } }) => ({
        rows: [],
        error: e.code ?? e.cause?.code ?? "error",
      }),
    );
    if (outcome.error) expect(["23503", "42501"]).toContain(outcome.error);
    const after = await superPool().query<{ lng: number; at: string }>(
      "SELECT ST_X(location::geometry) AS lng, recorded_at::text AS at FROM app.truck_positions WHERE truck_id = $1",
      [truck.id],
    );
    expect(after.rows[0]).toEqual({ lng: truck.lng, at: truck.at });
    const stray = await superPool().query(
      "SELECT 1 FROM app.truck_positions WHERE truck_id = $1 AND company_id = $2",
      [truck.id, ACME.id],
    );
    expect(stray.rowCount).toBe(0);
  });

  it("does nothing for a truck without an active assignment", async () => {
    const t = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.trucks (company_id, unit_number, equipment) VALUES (${ACME.id}, ${`ID-${Math.random().toString(36).slice(2, 7)}`}, 'reefer') RETURNING id`,
      );
      return r.rows[0]!.id;
    });
    const rows = await record(t, -96.7665, 32.7933);
    expect(rows[0]?.applied).toBe(true);
    expect(arrivals(rows)).toEqual([]);
  });

  it("app.load_window never inverts when every appointment is in the past", async () => {
    const load = await insertLoad(ACME.id, "open", { pickupAt: hoursFromNow(-72), hours: 24 });
    const r = await asCompany(
      ACME.id,
      async (tx) =>
        (
          await tx.execute<{ ok: boolean }>(
            sql`SELECT lower(app.load_window(${load.id})) < upper(app.load_window(${load.id})) AS ok`,
          )
        ).rows[0],
    );
    expect(r?.ok).toBe(true);
  });
});
