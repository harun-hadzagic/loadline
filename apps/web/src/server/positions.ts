import { createHash, timingSafeEqual } from "node:crypto";
import { type AppRole, emit, sql, withTenant } from "@loadline/db";
import { z } from "zod";
import type { RequestContext } from "./context";
import { tenant } from "./context";
import { AppError } from "./errors";

export const positionReportSchema = z.object({
  truckId: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullish(),
  speedMph: z.number().min(0).max(120).nullish(),
  recordedAt: z.iso.datetime({ offset: true }).or(z.iso.datetime()).optional(),
});
export const positionsBodySchema = z.object({
  companyId: z.uuid(),
  positions: z.array(positionReportSchema).min(1).max(500),
});
export type PositionReport = z.infer<typeof positionReportSchema>;

/** Reports dated further ahead than this are refused; the database clamps anything smaller to now(). */
const MAX_FUTURE_MS = 2 * 60_000;

export type TruckPositionView = {
  truckId: string;
  unitNumber: string;
  equipment: string;
  lat: number;
  lng: number;
  heading: number | null;
  speedMph: number | null;
  recordedAt: string;
  driverName: string | null;
  loadId: string | null;
  loadReference: string | null;
  loadStatus: string | null;
};

/** A service context for writes that have no person behind them (the simulator). */
export function systemContext(companyId: string): RequestContext {
  return {
    userId: "system",
    userName: "system",
    email: "",
    orgId: "",
    companyId,
    companyName: "",
    companyTimezone: "UTC",
    role: "dispatcher",
    driverId: null,
  };
}

const SYSTEM: AppRole = "system";

/**
 * Record positions through the same write path as everything else: one
 * transaction per batch, app.record_position() for the upsert and the arrival
 * check, one event per changed entity (position.updated per truck whose
 * report was applied, and stop.arrived with its load when a truck reaches a
 * stop). A report older than the stored one changes nothing and emits nothing.
 */
export async function recordPositions(
  companyId: string,
  reports: PositionReport[],
): Promise<{ written: number; ignored: number; arrivals: number }> {
  const now = Date.now();
  for (const p of reports) {
    if (p.recordedAt && new Date(p.recordedAt).getTime() > now + MAX_FUTURE_MS) {
      throw new AppError(400, `recordedAt for truck ${p.truckId} is in the future.`);
    }
  }
  return withTenant({ companyId, role: SYSTEM }, async (tx) => {
    let arrivals = 0;
    let written = 0;
    let ignored = 0;
    for (const p of reports) {
      const recordedAt = p.recordedAt ?? new Date().toISOString();
      const r = await tx.execute<{
        applied: boolean;
        arrived_stop_id: string | null;
        arrived_load_id: string | null;
        arrived_seq: number | null;
      }>(sql`
        SELECT * FROM app.record_position(${p.truckId}, ${p.lng}, ${p.lat}, ${p.heading ?? null}, ${p.speedMph ?? null},
                                          ${recordedAt}::timestamptz)`);
      const first = r.rows[0];
      if (!first?.applied) {
        ignored++;
        continue;
      }
      written++;
      await emit(tx, {
        type: "position.updated",
        entityId: p.truckId,
        payload: {
          lat: p.lat,
          lng: p.lng,
          heading: p.heading ?? null,
          speedMph: p.speedMph ?? null,
          recordedAt,
        },
      });
      for (const row of r.rows) {
        if (!row.arrived_stop_id || !row.arrived_load_id) continue;
        arrivals++;
        const load = await tx.execute<{
          version: number;
          status: string;
          driver_id: string | null;
        }>(sql`
          SELECT l.version, l.status,
                 (SELECT a.driver_id FROM app.assignments a WHERE a.load_id = l.id AND a.ended_reason IS NULL LIMIT 1) AS driver_id
            FROM app.loads l WHERE l.id = ${row.arrived_load_id}`);
        const l = load.rows[0];
        await emit(tx, {
          type: "stop.arrived",
          entityId: row.arrived_load_id,
          payload: {
            stopId: row.arrived_stop_id,
            seq: row.arrived_seq,
            truckId: p.truckId,
            version: l?.version ?? null,
          },
          audience: l?.driver_id ? [l.driver_id] : null,
        });
      }
    }
    return { written, ignored, arrivals };
  });
}

/** Latest position of every truck with its driver and load, for the map. */
export async function listPositions(ctx: RequestContext): Promise<TruckPositionView[]> {
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<TruckPositionView>(sql`
      SELECT t.id AS "truckId", t.unit_number AS "unitNumber", t.equipment,
             ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
             p.heading, p.speed_mph AS "speedMph", to_json(p.recorded_at)#>>'{}' AS "recordedAt",
             d.name AS "driverName", l.id AS "loadId", l.reference AS "loadReference", l.status::text AS "loadStatus"
        FROM app.trucks t
        JOIN app.truck_positions p ON p.truck_id = t.id
        LEFT JOIN LATERAL (
          SELECT a.load_id, a.driver_id FROM app.assignments a JOIN app.loads l2 ON l2.id = a.load_id
           WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND l2.status IN ('assigned', 'in_transit')
           ORDER BY lower(a.period) LIMIT 1
        ) a ON true
        LEFT JOIN app.loads l ON l.id = a.load_id
        LEFT JOIN app.drivers d ON d.id = a.driver_id
       WHERE t.active
       ORDER BY t.unit_number`);
    return r.rows;
  });
}

export type SimulatorTruck = {
  truckId: string;
  unitNumber: string;
  home: { lat: number; lng: number };
  position: { lat: number; lng: number; recordedAt: string } | null;
  /** The next stop without an arrival on the truck's current load, if any. */
  target: { stopId: string; lat: number; lng: number; seq: number; loadReference: string } | null;
};

/**
 * What the simulator needs for one company: trucks, where they are, and where
 * they should head. The current load is the earliest open assignment on a
 * load that is assigned or in transit, the same rule app.record_position uses.
 */
export async function simulatorState(companyId: string): Promise<SimulatorTruck[]> {
  return withTenant({ companyId, role: SYSTEM }, async (tx) => {
    const r = await tx.execute<SimulatorTruck>(sql`
      SELECT t.id AS "truckId", t.unit_number AS "unitNumber",
             json_build_object('lat', ST_Y(c.location::geometry), 'lng', ST_X(c.location::geometry)) AS home,
             CASE WHEN p.truck_id IS NULL THEN NULL ELSE json_build_object(
               'lat', ST_Y(p.location::geometry), 'lng', ST_X(p.location::geometry), 'recordedAt', p.recorded_at) END AS position,
             (
               SELECT json_build_object('stopId', s.id, 'lat', ST_Y(s.location::geometry), 'lng', ST_X(s.location::geometry),
                                        'seq', s.seq, 'loadReference', l.reference)
                 FROM app.assignments a
                 JOIN app.loads l ON l.id = a.load_id
                 JOIN app.stops s ON s.load_id = a.load_id AND s.arrived_at IS NULL
                WHERE a.truck_id = t.id AND a.ended_reason IS NULL
                  AND l.status IN ('assigned', 'in_transit')
                ORDER BY lower(a.period), s.seq LIMIT 1
             ) AS target
        FROM app.trucks t
        LEFT JOIN app.cities c ON c.id = t.home_city_id
        LEFT JOIN app.truck_positions p ON p.truck_id = t.id
       WHERE t.active
       ORDER BY t.unit_number`);
    return r.rows.map((row) => ({ ...row, home: row.home ?? { lat: 32.78, lng: -96.8 } }));
  });
}

/** Constant-time check of the simulator's bearer token; hashing first hides the token's length. */
export function assertServiceToken(request: Request): void {
  const expected = process.env.SIMULATOR_TOKEN;
  if (!expected || expected.length < 8)
    throw new AppError(503, "SIMULATOR_TOKEN is not configured.");
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  if (!timingSafeEqual(a, b)) throw new AppError(401, "Bad service token.");
}
