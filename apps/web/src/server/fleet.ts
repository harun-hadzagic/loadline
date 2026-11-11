import { emit, withTenant } from "@loadline/db";
import { sql } from "drizzle-orm";
import type { DriverInput, TruckInput } from "@/lib/schemas";
import { assertCan } from "./authorize";
import type { RequestContext } from "./context";
import { tenant } from "./context";
import { AppError, NotFoundError } from "./errors";

export type DriverView = {
  id: string;
  name: string;
  phone: string | null;
  userId: string | null;
  homeCityId: number | null;
  homeCity: string | null;
  active: boolean;
  currentLoad: string | null;
};

export type TruckView = {
  id: string;
  unitNumber: string;
  equipment: "dry_van" | "reefer" | "flatbed";
  homeCityId: number | null;
  homeCity: string | null;
  active: boolean;
  currentLoad: string | null;
};

export async function listDrivers(ctx: RequestContext): Promise<DriverView[]> {
  assertCan(ctx, "fleet", "read");
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<DriverView>(sql`
      SELECT d.id, d.name, d.phone, d.user_id AS "userId", d.home_city_id AS "homeCityId",
             c.name || ', ' || c.state AS "homeCity", d.active,
             (SELECT l.reference FROM app.assignments a JOIN app.loads l ON l.id = a.load_id
               WHERE a.driver_id = d.id AND a.ended_reason IS NULL AND a.period @> now() LIMIT 1) AS "currentLoad"
      FROM app.drivers d LEFT JOIN app.cities c ON c.id = d.home_city_id
      ORDER BY d.active DESC, d.name`);
    return r.rows;
  });
}

export async function listTrucks(ctx: RequestContext): Promise<TruckView[]> {
  assertCan(ctx, "fleet", "read");
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<TruckView>(sql`
      SELECT t.id, t.unit_number AS "unitNumber", t.equipment, t.home_city_id AS "homeCityId",
             c.name || ', ' || c.state AS "homeCity", t.active,
             (SELECT l.reference FROM app.assignments a JOIN app.loads l ON l.id = a.load_id
               WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND a.period @> now() LIMIT 1) AS "currentLoad"
      FROM app.trucks t LEFT JOIN app.cities c ON c.id = t.home_city_id
      ORDER BY t.active DESC, t.unit_number`);
    return r.rows;
  });
}

export async function saveDriver(
  ctx: RequestContext,
  input: DriverInput,
  id?: string,
): Promise<string> {
  assertCan(ctx, "fleet", "manage");
  return withTenant(tenant(ctx), async (tx) => {
    const userId: string | null = null;
    if (input.userEmail) {
      // Linking happens by email through the auth schema's user table, which
      // loadline_app cannot read. The admin page passes the resolved id instead.
      throw new AppError(400, "Link drivers to accounts by user id.");
    }
    void userId;
    if (id) {
      if (!input.active) await refuseIfBooked(tx, "driver_id", id, "driver");
      const r = await tx.execute(sql`
        UPDATE app.drivers SET name = ${input.name}, phone = ${input.phone ?? null},
               home_city_id = ${input.homeCityId ?? null}, active = ${input.active}
        WHERE id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new NotFoundError("Driver not found.");
      await emit(tx, { type: "driver.updated", entityId: id, payload: {} });
      return id;
    }
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.drivers (company_id, name, phone, home_city_id, active)
      VALUES (${ctx.companyId}, ${input.name}, ${input.phone ?? null}, ${input.homeCityId ?? null}, ${input.active})
      RETURNING id`);
    const newId = r.rows[0]?.id as string;
    await emit(tx, { type: "driver.created", entityId: newId, payload: {} });
    return newId;
  });
}

export async function saveTruck(
  ctx: RequestContext,
  input: TruckInput,
  id?: string,
): Promise<string> {
  assertCan(ctx, "fleet", "manage");
  return withTenant(tenant(ctx), async (tx) => {
    if (id) {
      if (!input.active) await refuseIfBooked(tx, "truck_id", id, "truck");
      const r = await tx.execute(sql`
        UPDATE app.trucks SET unit_number = ${input.unitNumber}, equipment = ${input.equipment}::app.equipment,
               home_city_id = ${input.homeCityId ?? null}, active = ${input.active}
        WHERE id = ${id}`);
      if ((r.rowCount ?? 0) === 0) throw new NotFoundError("Truck not found.");
      await emit(tx, { type: "truck.updated", entityId: id, payload: {} });
      return id;
    }
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO app.trucks (company_id, unit_number, equipment, home_city_id, active)
      VALUES (${ctx.companyId}, ${input.unitNumber}, ${input.equipment}::app.equipment, ${input.homeCityId ?? null}, ${input.active})
      RETURNING id`);
    const newId = r.rows[0]?.id as string;
    await emit(tx, { type: "truck.created", entityId: newId, payload: {} });
    return newId;
  });
}

/** A driver or truck with an open assignment stays active until it is unassigned. */
async function refuseIfBooked(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  column: "driver_id" | "truck_id",
  id: string,
  what: string,
): Promise<void> {
  const r = await tx.execute<{ reference: string }>(sql`
    SELECT l.reference FROM app.assignments a JOIN app.loads l ON l.id = a.load_id
     WHERE ${sql.raw(`a.${column}`)} = ${id} AND a.ended_reason IS NULL AND upper(a.period) > now()
     ORDER BY lower(a.period) LIMIT 1`);
  const ref = r.rows[0]?.reference;
  if (ref) throw new AppError(409, `This ${what} is still assigned to ${ref}. Unassign it first.`);
}

export type CityOption = {
  id: number;
  name: string;
  state: string;
  timezone: string;
};

/** Cities for pickers. Reference data, still read inside withTenant like everything else. */
export async function searchCities(
  ctx: RequestContext,
  q: string,
  limit = 12,
): Promise<CityOption[]> {
  const term = q.trim().toLowerCase();
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<CityOption>(sql`
      SELECT id, name, state, timezone FROM app.cities
      WHERE ${term} = '' OR lower(name) LIKE ${`${term}%`} OR lower(name || ', ' || state) LIKE ${`${term}%`}
      ORDER BY population DESC LIMIT ${limit}`);
    return r.rows;
  });
}

export async function listCities(ctx: RequestContext): Promise<CityOption[]> {
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<CityOption>(
      sql`SELECT id, name, state, timezone FROM app.cities ORDER BY name, state`,
    );
    return r.rows;
  });
}
