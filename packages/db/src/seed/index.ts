import { sql } from "drizzle-orm";
import pg from "pg";
import { createPool } from "../pool.ts";
import * as schema from "../schema/index.ts";
import type { GeoPoint, TimeRange } from "../schema/types.ts";
import { type Tx, withTenant } from "../with-tenant.ts";
import { BROKERS, COMMODITIES, DEMO, DEMO_COMPANIES, type DemoCompany } from "./data.ts";

export { DEMO, DEMO_COMPANIES };

export interface SeedOptions {
  appUrl: string;
  ownerUrl: string;
  /** Anchor time for the relative appointment windows. Defaults to now, rounded to the hour. */
  now?: Date;
}

export interface SeedResult {
  companies: Array<{ key: string; id: string; skipped: boolean }>;
}

interface City {
  id: number;
  name: string;
  state: string;
  location: GeoPoint;
  timezone: string;
}

const HOUR = 3_600_000;

function hours(base: Date, h: number): Date {
  return new Date(base.getTime() + h * HOUR);
}

function range(lower: Date, upper: Date): TimeRange {
  return { lower, upper };
}

/** Point a fraction of the way along the great circle from a to b. */
export function interpolate(a: GeoPoint, b: GeoPoint, f: number): GeoPoint {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lng);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lng);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2,
      ),
    );
  if (d === 0) return a;
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lng: toDeg(Math.atan2(y, x)) };
}

interface LoadPlan {
  n: number;
  status: schema.LoadStatus;
  /** Indices into the company's lane list. */
  route: number[];
  /** Pickup window start, in hours from the anchor. */
  pickupAt: number;
  /** Hours from pickup start to delivery window start. */
  transit: number;
  driver?: number;
  truck?: number;
}

// 20 loads per company across all five states. Driver/truck pairs are chosen so
// no driver or truck has two overlapping periods (the database would refuse).
const PLAN: LoadPlan[] = [
  // in transit: picked up hours ago, delivering within a day
  { n: 1, status: "in_transit", route: [0, 2], pickupAt: -6, transit: 20, driver: 0, truck: 0 },
  { n: 2, status: "in_transit", route: [0, 5], pickupAt: -4, transit: 22, driver: 1, truck: 1 },
  { n: 3, status: "in_transit", route: [1, 7], pickupAt: -8, transit: 26, driver: 2, truck: 2 },
  // assigned: pickup later today or tomorrow
  { n: 4, status: "assigned", route: [0, 3], pickupAt: 20, transit: 10, driver: 3, truck: 3 },
  { n: 5, status: "assigned", route: [2, 0], pickupAt: 22, transit: 8, driver: 4, truck: 4 },
  { n: 6, status: "assigned", route: [0, 8, 11], pickupAt: 26, transit: 30, driver: 5, truck: 5 },
  { n: 7, status: "assigned", route: [4, 0], pickupAt: 28, transit: 9, driver: 6, truck: 6 },
  { n: 8, status: "assigned", route: [0, 12], pickupAt: 30, transit: 36, driver: 7, truck: 7 },
  { n: 9, status: "assigned", route: [2, 9], pickupAt: 40, transit: 12, driver: 0, truck: 0 },
  // delivered: last week
  { n: 10, status: "delivered", route: [0, 6], pickupAt: -72, transit: 14, driver: 1, truck: 1 },
  { n: 11, status: "delivered", route: [3, 0], pickupAt: -70, transit: 11, driver: 2, truck: 2 },
  { n: 12, status: "delivered", route: [0, 14], pickupAt: -96, transit: 40, driver: 3, truck: 3 },
  // open: unassigned work for the board
  { n: 13, status: "open", route: [0, 4], pickupAt: 24, transit: 10 },
  { n: 14, status: "open", route: [1, 2], pickupAt: 30, transit: 12 },
  { n: 15, status: "open", route: [0, 10, 14], pickupAt: 48, transit: 40 },
  { n: 16, status: "open", route: [5, 0], pickupAt: 52, transit: 12 },
  { n: 17, status: "open", route: [0, 13], pickupAt: 72, transit: 44 },
  { n: 18, status: "open", route: [2, 15], pickupAt: 76, transit: 30 },
  // cancelled
  { n: 19, status: "cancelled", route: [0, 16], pickupAt: 36, transit: 28 },
  { n: 20, status: "cancelled", route: [3, 17], pickupAt: 60, transit: 16 },
];

async function cityMap(tx: Tx, lanes: Array<[string, string]>): Promise<Map<string, City>> {
  const rows = await tx.select().from(schema.cities);
  const byKey = new Map<string, City>();
  for (const r of rows) byKey.set(`${r.name.toLowerCase()}|${r.state}`, r);
  const map = new Map<string, City>();
  for (const [name, state] of lanes) {
    const c = byKey.get(`${name.toLowerCase()}|${state}`);
    if (!c) throw new Error(`seed: city ${name}, ${state} is not in app.cities`);
    map.set(`${name}|${state}`, c);
  }
  return map;
}

async function seedCompany(tx: Tx, company: DemoCompany, now: Date): Promise<void> {
  await tx.insert(schema.companies).values({
    id: company.id,
    orgId: company.orgId,
    name: company.name,
    timezone: company.timezone,
  });

  const cities = await cityMap(tx, company.lanes);
  const laneCity = (i: number): City => {
    const lane = company.lanes[i];
    if (!lane) throw new Error(`seed: lane ${i} missing`);
    const c = cities.get(`${lane[0]}|${lane[1]}`);
    if (!c) throw new Error(`seed: city ${lane.join(", ")} missing`);
    return c;
  };
  const hq = laneCity(0);

  const driverUsers = company.users.filter((u) => u.role === "driver");
  const driverRows = await tx
    .insert(schema.drivers)
    .values(
      driverUsers.map((u, i) => ({
        companyId: company.id,
        userId: u.id,
        name: u.name,
        phone: `555-01${String(10 + i).padStart(2, "0")}`,
        homeCityId: i < 6 ? hq.id : laneCity(i - 4).id,
      })),
    )
    .returning({ id: schema.drivers.id, homeCityId: schema.drivers.homeCityId });

  const equipmentFor = (i: number): schema.Equipment =>
    i < 5 ? "dry_van" : i < 8 ? "reefer" : "flatbed";
  const truckRows = await tx
    .insert(schema.trucks)
    .values(
      Array.from({ length: 10 }, (_, i) => ({
        companyId: company.id,
        unitNumber: String(101 + i),
        equipment: equipmentFor(i),
        homeCityId: i < 7 ? hq.id : laneCity(i - 5).id,
      })),
    )
    .returning({
      id: schema.trucks.id,
      homeCityId: schema.trucks.homeCityId,
      equipment: schema.trucks.equipment,
    });

  const truckPositions: Array<{
    truckId: string;
    location: GeoPoint;
    heading: number | null;
    speedMph: number;
  }> = [];
  const cityById = new Map<number, City>();
  for (const c of cities.values()) cityById.set(c.id, c);

  for (const plan of PLAN) {
    const idx = plan.n - 1;
    const commodity = COMMODITIES[idx % COMMODITIES.length];
    if (!commodity) throw new Error("seed: commodity missing");
    const [commodityName, equipment, weight, rate] = commodity;
    const broker = BROKERS[idx % BROKERS.length] ?? BROKERS[0] ?? "Northwind Logistics";
    const reference = `${company.refPrefix}-${1000 + plan.n}`;

    const [load] = await tx
      .insert(schema.loads)
      .values({
        companyId: company.id,
        reference,
        brokerName: broker,
        commodity: commodityName,
        weightLbs: weight,
        rateCents: rate + (idx % 4) * 12_500,
        equipment,
        status: plan.status,
        notes: plan.status === "cancelled" ? "Broker cancelled; freight did not ship." : null,
      })
      .returning({ id: schema.loads.id });
    if (!load) throw new Error("seed: load insert returned nothing");

    const pickupStart = hours(now, plan.pickupAt);
    const stopsToInsert = plan.route.map((laneIdx, seq) => {
      const city = laneCity(laneIdx);
      const isPickup = seq === 0;
      const start = isPickup ? pickupStart : hours(pickupStart, plan.transit + (seq - 1) * 6);
      const end = hours(start, isPickup ? 2 : 4);
      const done = plan.status === "delivered" || (plan.status === "in_transit" && isPickup);
      return {
        companyId: company.id,
        loadId: load.id,
        seq: seq + 1,
        kind: (isPickup ? "pickup" : "delivery") as schema.StopKind,
        cityId: city.id,
        location: city.location,
        facilityName: `${isPickup ? "Shipper" : "Receiver"} ${city.name} DC ${plan.n}`,
        appointment: range(start, end),
        arrivedAt: done ? hours(start, 0.25) : null,
        departedAt: done ? hours(start, 1.5) : null,
      };
    });
    await tx.insert(schema.stops).values(stopsToInsert);

    if (plan.driver !== undefined && plan.truck !== undefined) {
      const driver = driverRows[plan.driver];
      const truck = truckRows[plan.truck];
      if (!driver || !truck) throw new Error("seed: driver or truck index out of range");
      const first = stopsToInsert[0];
      const last = stopsToInsert[stopsToInsert.length - 1];
      if (!first?.appointment.lower || !last?.appointment.upper)
        throw new Error("seed: bad stop windows");
      const period: TimeRange = { lower: first.appointment.lower, upper: last.appointment.upper };
      await tx.insert(schema.assignments).values({
        companyId: company.id,
        loadId: load.id,
        driverId: driver.id,
        truckId: truck.id,
        period,
        endedReason: plan.status === "delivered" ? "delivered" : null,
      });
      if (plan.status === "in_transit") {
        const from = laneCity(plan.route[0] ?? 0).location;
        const to = laneCity(plan.route[1] ?? 0).location;
        truckPositions.push({
          truckId: truck.id,
          location: interpolate(from, to, 0.35),
          heading: null,
          speedMph: 55,
        });
      }
    }
  }

  // Trucks without a live load sit near their home city.
  const placed = new Set(truckPositions.map((p) => p.truckId));
  truckRows.forEach((t, i) => {
    if (placed.has(t.id)) return;
    const home = (t.homeCityId !== null ? cityById.get(t.homeCityId) : undefined) ?? hq;
    truckPositions.push({
      truckId: t.id,
      location: {
        lat: home.location.lat + 0.01 * ((i % 3) - 1),
        lng: home.location.lng + 0.012 * ((i % 4) - 1.5),
      },
      heading: null,
      speedMph: 0,
    });
  });
  await tx.insert(schema.truckPositions).values(
    truckPositions.map((p) => ({
      truckId: p.truckId,
      companyId: company.id,
      location: p.location,
      heading: p.heading,
      speedMph: p.speedMph,
      recordedAt: now,
    })),
  );
}

/**
 * Seed the two demo companies through withTenant as loadline_app, so the seed
 * passes the same policies as the application. Idempotent: a company that
 * already exists is left alone.
 */
export async function seed(
  opts: SeedOptions,
  log: (m: string) => void = () => {},
): Promise<SeedResult> {
  const now = opts.now ?? new Date(Math.ceil(Date.now() / HOUR) * HOUR);
  const pool = createPool(opts.appUrl, { max: 2, applicationName: "loadline-seed" });
  const result: SeedResult = { companies: [] };
  try {
    for (const company of DEMO_COMPANIES) {
      const exists = await withTenant(
        { companyId: company.id, role: "system" },
        async (tx) => {
          const rows = await tx.execute(sql`SELECT 1 FROM app.companies WHERE id = ${company.id}`);
          return rows.rows.length > 0;
        },
        { pool },
      );
      if (exists) {
        log(`${company.name}: already seeded`);
        result.companies.push({ key: company.key, id: company.id, skipped: true });
        continue;
      }
      await withTenant(
        { companyId: company.id, role: "system", userId: `user_${company.key}_owner` },
        (tx) => seedCompany(tx, company, now),
        { pool },
      );
      log(`${company.name}: seeded`);
      result.companies.push({ key: company.key, id: company.id, skipped: false });
    }
  } finally {
    await pool.end();
  }
  void pg;
  return result;
}
