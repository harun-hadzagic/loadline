import "./setup-env";
import { DEMO_COMPANIES } from "@loadline/db";
import { appPool, createPool, testUrls } from "@loadline/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@/server/context";
import { listTrucks } from "@/server/fleet";
import { assignmentCandidates, createLoad } from "@/server/loads";
import { recordPositions, systemContext } from "@/server/positions";

const ACME = DEMO_COMPANIES[0]!;
const superPool = createPool(testUrls().superuser, { max: 2 });
afterAll(async () => {
  await appPool().end();
  await superPool.end();
});

const dispatcher: RequestContext = {
  ...systemContext(ACME.id),
  userId: "test-dispatcher",
  role: "dispatcher",
};

describe("nearest free trucks", () => {
  it("orders trucks by straight-line distance from their last position to the pickup", async () => {
    const trucks = (await listTrucks(dispatcher)).filter((t) => t.active).slice(0, 4);
    const dallas = { lat: 32.7933, lng: -96.7665 };
    // Known positions: 2, 50, 10 and 200 miles east of Dallas (1° longitude ≈ 58 mi at this latitude).
    const offsets = [2, 50, 10, 200];
    const at = new Date().toISOString();
    await recordPositions(
      ACME.id,
      trucks.map((t, i) => ({
        truckId: t.id,
        lat: dallas.lat,
        lng: dallas.lng + (offsets[i] as number) / 58,
        heading: 90,
        speedMph: 0,
        recordedAt: at,
      })),
    );
    const cities = await superPool.query<{ id: number }>(
      "SELECT id FROM app.cities WHERE (name, state) IN (('Dallas','TX'), ('Houston','TX')) ORDER BY name",
    );
    const [dallasId, houstonId] = cities.rows.map((r) => r.id);
    const h = (n: number) => new Date(Date.now() + (24 * 500 + n) * 3_600_000).toISOString(); // far-future window: everyone is free
    const load = await createLoad(dispatcher, {
      reference: `NEAR-${Date.now()}`,
      brokerName: null,
      commodity: null,
      weightLbs: null,
      rateCents: null,
      equipment: null,
      notes: null,
      stops: [
        {
          kind: "pickup",
          cityId: dallasId as number,
          facilityName: null,
          appointmentStart: h(0),
          appointmentEnd: h(2),
        },
        {
          kind: "delivery",
          cityId: houstonId as number,
          facilityName: null,
          appointmentStart: h(10),
          appointmentEnd: h(14),
        },
      ],
    });
    const { trucks: candidates } = await assignmentCandidates(dispatcher, load.id);
    const ours = candidates.filter((c) => trucks.some((t) => t.id === c.id));
    expect(ours.map((c) => c.id)).toEqual([
      trucks[0]!.id,
      trucks[2]!.id,
      trucks[1]!.id,
      trucks[3]!.id,
    ]);
    const miles = ours.map((c) => c.distanceMiles ?? -1);
    for (const [i, expected] of [2, 10, 50, 200].entries())
      expect(Math.abs((miles[i] as number) - expected)).toBeLessThan(2);
    expect(ours.every((c) => c.free)).toBe(true);
    // Free trucks come before busy ones overall.
    const firstBusy = candidates.findIndex((c) => !c.free);
    const lastFree = candidates.map((c) => c.free).lastIndexOf(true);
    if (firstBusy !== -1) expect(lastFree).toBeLessThan(firstBusy);
  });
});

describe("recordPositions", () => {
  it("writes one position.updated per truck and a stop.arrived when a truck reaches its next stop", async () => {
    const before = await superPool.query<{ n: string }>(
      "SELECT coalesce(max(id), 0)::text AS n FROM app.outbox",
    );
    // A truck on an active (in transit) seeded load, placed at its next open stop.
    const target = await superPool.query<{
      truck_id: string;
      lng: number;
      lat: number;
      load_id: string;
      driver_id: string;
    }>(
      `SELECT a.truck_id, a.load_id, a.driver_id, ST_X(s.location::geometry) AS lng, ST_Y(s.location::geometry) AS lat
         FROM app.assignments a JOIN app.loads l ON l.id = a.load_id
         JOIN app.stops s ON s.load_id = a.load_id AND s.arrived_at IS NULL
        WHERE a.company_id = $1 AND a.ended_reason IS NULL AND l.status = 'in_transit' AND a.period @> now()
        ORDER BY a.load_id, s.seq LIMIT 1`,
      [ACME.id],
    );
    const t = target.rows[0]!;
    const result = await recordPositions(ACME.id, [
      { truckId: t.truck_id, lat: t.lat, lng: t.lng, heading: 0, speedMph: 0 },
    ]);
    expect(result).toEqual({ written: 1, ignored: 0, arrivals: 1 });
    const events = await superPool.query<{
      type: string;
      entity_id: string;
      audience: string[] | null;
    }>("SELECT type, entity_id, audience FROM app.outbox WHERE id > $1 ORDER BY id", [
      Number(before.rows[0]?.n ?? 0),
    ]);
    const types = events.rows.map((e) => e.type);
    expect(types.filter((x) => x === "position.updated")).toHaveLength(1);
    expect(types.filter((x) => x === "stop.arrived")).toHaveLength(1);
    const arrived = events.rows.find((e) => e.type === "stop.arrived")!;
    expect(arrived.entity_id).toBe(t.load_id);
    expect(arrived.audience).toEqual([t.driver_id]); // the driver hears about their own stop
  });
});

describe("the five nearest free trucks (the spec's query, under row security)", () => {
  it("returns at most five, the closest free trucks in order, and leaves out one booked in the window", async () => {
    const { listDrivers } = await import("@/server/fleet");
    const { assignLoad } = await import("@/server/loads");
    // A pickup city with no seeded truck within 80 km, so only this test's trucks are near it.
    const cities = await superPool.query<{ id: number; lng: number; lat: number }>(
      `SELECT c.id, ST_X(c.location::geometry) AS lng, ST_Y(c.location::geometry) AS lat
         FROM app.cities c
        WHERE NOT EXISTS (SELECT 1 FROM app.truck_positions p WHERE ST_DWithin(p.location, c.location, 80000))
        ORDER BY c.id LIMIT 1`,
    );
    const pickup = cities.rows[0]!;
    const houston = await superPool.query<{ id: number }>(
      "SELECT id FROM app.cities WHERE name = 'Houston' AND state = 'TX'",
    );
    const tag = Date.now().toString(36);
    const inserted = await superPool.query<{ id: string }>(
      `INSERT INTO app.trucks (company_id, unit_number, equipment)
       SELECT $1, 'N5-' || $2 || '-' || g, 'dry_van' FROM generate_series(1, 7) g RETURNING id`,
      [ACME.id, tag],
    );
    const ours = inserted.rows.map((r) => r.id);
    const at = new Date().toISOString();
    // Truck k sits k miles east of the pickup (1° of longitude ≈ 69 × cos(lat) miles).
    const perDegree = 69.17 * Math.cos((pickup.lat * Math.PI) / 180);
    await recordPositions(
      ACME.id,
      ours.map((truckId, i) => ({
        truckId,
        lat: pickup.lat,
        lng: pickup.lng + (i + 1) / perDegree,
        heading: 90,
        speedMph: 0,
        recordedAt: at,
      })),
    );
    const h = (n: number) => new Date(Date.now() + (24 * 600 + n) * 3_600_000).toISOString();
    const stops = [
      {
        kind: "pickup" as const,
        cityId: pickup.id,
        facilityName: null,
        appointmentStart: h(0),
        appointmentEnd: h(2),
      },
      {
        kind: "delivery" as const,
        cityId: houston.rows[0]!.id,
        facilityName: null,
        appointmentStart: h(10),
        appointmentEnd: h(14),
      },
    ];
    const blank = {
      brokerName: null,
      commodity: null,
      weightLbs: null,
      rateCents: null,
      equipment: null,
      notes: null,
    };
    const load = await createLoad(dispatcher, { ...blank, reference: `N5A-${tag}`, stops });
    const first = await assignmentCandidates(dispatcher, load.id);
    expect(first.nearestTruckIds).toEqual(ours.slice(0, 5));
    // The pickers' full list agrees with the nearest-neighbour scan.
    expect(
      first.trucks
        .filter((t) => t.free && t.distanceMiles !== null)
        .slice(0, 5)
        .map((t) => t.id),
    ).toEqual(ours.slice(0, 5));

    // Book the second-nearest truck on another load in the same window: it drops out, the sixth moves in.
    const other = await createLoad(dispatcher, { ...blank, reference: `N5B-${tag}`, stops });
    const driver = (await listDrivers(dispatcher)).find((d) => d.active)!;
    await assignLoad(dispatcher, {
      loadId: other.id,
      version: other.version,
      driverId: driver.id,
      truckId: ours[1]!,
    });
    const second = await assignmentCandidates(dispatcher, load.id);
    expect(second.nearestTruckIds).toEqual([ours[0], ours[2], ours[3], ours[4], ours[5]]);
    expect(second.trucks.find((t) => t.id === ours[1])?.free).toBe(false);
  });
});
