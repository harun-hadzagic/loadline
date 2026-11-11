// Drizzle mirror of migrations/*.sql, for typed queries. The SQL files are the
// source of truth; a database test checks that this mirror matches the catalog.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { geographyPoint, tstzrange, uuidArray, xid8 } from "./types.ts";

export * from "./types.ts";

export const app = pgSchema("app");

export const equipmentEnum = app.enum("equipment", ["dry_van", "reefer", "flatbed"]);
export const loadStatusEnum = app.enum("load_status", [
  "open",
  "assigned",
  "in_transit",
  "delivered",
  "cancelled",
]);
export const stopKindEnum = app.enum("stop_kind", ["pickup", "delivery"]);

export type Equipment = (typeof equipmentEnum.enumValues)[number];
export type LoadStatus = (typeof loadStatusEnum.enumValues)[number];
export type StopKind = (typeof stopKindEnum.enumValues)[number];

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
};

export const cities = app.table("cities", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  state: char("state", { length: 2 }).notNull(),
  location: geographyPoint("location").notNull(),
  timezone: text("timezone").notNull(),
  population: integer("population").notNull(),
});

export const loadTransitions = app.table(
  "load_transitions",
  {
    fromStatus: loadStatusEnum("from_status").notNull(),
    toStatus: loadStatusEnum("to_status").notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);

export const companies = app.table("companies", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id").notNull().generatedAlwaysAs(sql`id`),
  orgId: text("org_id").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/Chicago"),
  arrivalRadiusMiles: numeric("arrival_radius_miles", { precision: 6, scale: 2 })
    .notNull()
    .default("1.00"),
  ...timestamps,
});

export const drivers = app.table("drivers", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  userId: text("user_id").unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  homeCityId: integer("home_city_id").references(() => cities.id),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const trucks = app.table("trucks", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  unitNumber: text("unit_number").notNull(),
  equipment: equipmentEnum("equipment").notNull(),
  homeCityId: integer("home_city_id").references(() => cities.id),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const loads = app.table("loads", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  reference: text("reference").notNull(),
  brokerName: text("broker_name"),
  commodity: text("commodity"),
  weightLbs: integer("weight_lbs"),
  rateCents: integer("rate_cents"),
  equipment: equipmentEnum("equipment"),
  status: loadStatusEnum("status").notNull().default("open"),
  version: integer("version").notNull().default(1),
  notes: text("notes"),
  ...timestamps,
});

export const stops = app.table("stops", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  loadId: uuid("load_id").notNull(),
  seq: integer("seq").notNull(),
  kind: stopKindEnum("kind").notNull(),
  cityId: integer("city_id")
    .notNull()
    .references(() => cities.id),
  location: geographyPoint("location").notNull(),
  facilityName: text("facility_name"),
  appointment: tstzrange("appointment").notNull(),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  departedAt: timestamp("departed_at", { withTimezone: true }),
  ...timestamps,
});

export const assignments = app.table("assignments", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  loadId: uuid("load_id").notNull(),
  driverId: uuid("driver_id").notNull(),
  truckId: uuid("truck_id").notNull(),
  period: tstzrange("period").notNull(),
  endedReason: text("ended_reason", { enum: ["unassigned", "cancelled", "delivered"] }),
  ...timestamps,
});

export const truckPositions = app.table("truck_positions", {
  truckId: uuid("truck_id").primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  location: geographyPoint("location").notNull(),
  heading: real("heading"),
  speedMph: real("speed_mph"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

export const outbox = app.table("outbox", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  txid: xid8("txid").notNull(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  type: text("type").notNull(),
  entityId: uuid("entity_id"),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  audience: uuidArray("audience"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Tenant tables: every one has forced row-level security. Reference tables are listed separately. */
export const TENANT_TABLES = [
  "companies",
  "drivers",
  "trucks",
  "loads",
  "stops",
  "assignments",
  "truck_positions",
  "outbox",
] as const;
export const REFERENCE_TABLES = ["cities", "load_transitions", "outbox_watermark"] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];
