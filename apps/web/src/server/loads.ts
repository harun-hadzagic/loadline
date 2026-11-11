import { emit, sql, type Tx, withTenant } from "@loadline/db";
import type { AssignInput, LoadInput, LoadPatch, StopInput } from "@/lib/schemas";
import { assertCan } from "./authorize";
import type { RequestContext } from "./context";
import { tenant } from "./context";
import { AppError, ConflictError, fromDbError, NotFoundError } from "./errors";

export type LoadStatus = "open" | "assigned" | "in_transit" | "delivered" | "cancelled";
export type Equipment = "dry_van" | "reefer" | "flatbed";

export type StopView = {
  id: string;
  seq: number;
  kind: "pickup" | "delivery";
  cityId: number;
  city: string;
  state: string;
  timezone: string;
  lat: number;
  lng: number;
  facilityName: string | null;
  appointmentStart: string;
  appointmentEnd: string;
  arrivedAt: string | null;
  departedAt: string | null;
};

export type AssignmentView = {
  id: string;
  driverId: string;
  driverName: string;
  truckId: string;
  unitNumber: string;
  periodStart: string;
  periodEnd: string;
};

export type LoadView = {
  id: string;
  reference: string;
  brokerName: string | null;
  commodity: string | null;
  weightLbs: number | null;
  rateCents: number | null;
  equipment: Equipment | null;
  status: LoadStatus;
  version: number;
  notes: string | null;
  updatedAt: string;
  stops: StopView[];
  assignment: AssignmentView | null;
};

const LOAD_SELECT = sql`
  SELECT l.id, l.reference, l.broker_name AS "brokerName", l.commodity, l.weight_lbs AS "weightLbs",
         l.rate_cents AS "rateCents", l.equipment, l.status, l.version, l.notes,
         to_json(l.updated_at)#>>'{}' AS "updatedAt",
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', s.id, 'seq', s.seq, 'kind', s.kind, 'cityId', s.city_id,
                    'city', c.name, 'state', c.state, 'timezone', c.timezone,
                    'lat', ST_Y(s.location::geometry), 'lng', ST_X(s.location::geometry),
                    'facilityName', s.facility_name,
                    'appointmentStart', lower(s.appointment), 'appointmentEnd', upper(s.appointment),
                    'arrivedAt', s.arrived_at, 'departedAt', s.departed_at
                  ) ORDER BY s.seq)
           FROM app.stops s JOIN app.cities c ON c.id = s.city_id WHERE s.load_id = l.id
         ), '[]'::json) AS stops,
         (
           SELECT json_build_object(
                    'id', a.id, 'driverId', a.driver_id, 'driverName', d.name,
                    'truckId', a.truck_id, 'unitNumber', t.unit_number,
                    'periodStart', lower(a.period), 'periodEnd', upper(a.period))
           FROM app.assignments a
           JOIN app.drivers d ON d.id = a.driver_id
           JOIN app.trucks t ON t.id = a.truck_id
           WHERE a.load_id = l.id AND a.ended_reason IS NULL
           ORDER BY lower(a.period) DESC LIMIT 1
         ) AS assignment
  FROM app.loads l
`;

async function selectLoads(tx: Tx, where: ReturnType<typeof sql>): Promise<LoadView[]> {
  const r = await tx.execute<LoadView>(sql`${LOAD_SELECT} ${where}`);
  return r.rows;
}

const BY_FIRST_PICKUP = sql`ORDER BY (SELECT min(lower(appointment)) FROM app.stops s WHERE s.load_id = l.id) NULLS LAST, l.reference`;

/** Loads visible to this request. Drivers get only their own through row-level security. */
export async function listLoads(
  ctx: RequestContext,
  opts: { statuses?: LoadStatus[] } = {},
): Promise<LoadView[]> {
  // drizzle expands a JS array into a tuple; a PostgreSQL array literal is what ANY() wants.
  const statuses = opts.statuses ? `{${opts.statuses.join(",")}}` : null;
  return withTenant(tenant(ctx), (tx) =>
    selectLoads(
      tx,
      statuses
        ? sql`WHERE l.status = ANY(${statuses}::app.load_status[]) ${BY_FIRST_PICKUP}`
        : BY_FIRST_PICKUP,
    ),
  );
}

export async function getLoad(ctx: RequestContext, id: string): Promise<LoadView> {
  const rows = await withTenant(tenant(ctx), (tx) => selectLoads(tx, sql`WHERE l.id = ${id}`));
  const load = rows[0];
  if (!load) throw new NotFoundError("Load not found.");
  return load;
}

async function getLoadTx(tx: Tx, id: string): Promise<LoadView | null> {
  return (await selectLoads(tx, sql`WHERE l.id = ${id}`))[0] ?? null;
}

async function requireLoadTx(tx: Tx, id: string): Promise<LoadView> {
  const load = await getLoadTx(tx, id);
  if (!load) throw new NotFoundError("Load not found.");
  return load;
}

function audienceOf(load: LoadView | null, extra: string[] = []): string[] | null {
  const ids = [...extra];
  if (load?.assignment) ids.push(load.assignment.driverId);
  return ids.length ? [...new Set(ids)] : null;
}

async function insertStops(
  tx: Tx,
  companyId: string,
  loadId: string,
  stops: StopInput[],
): Promise<void> {
  let seq = 1;
  for (const s of stops) {
    const r = await tx.execute(sql`
      INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, facility_name, appointment)
      SELECT ${companyId}, ${loadId}, ${seq}, ${s.kind}::app.stop_kind, c.id, c.location, ${s.facilityName ?? null},
             tstzrange(${s.appointmentStart}::timestamptz, ${s.appointmentEnd}::timestamptz, '[)')
      FROM app.cities c WHERE c.id = ${s.cityId}`);
    if ((r.rowCount ?? 0) !== 1) throw new AppError(400, `Unknown city id ${s.cityId}.`);
    seq++;
  }
}

export async function createLoad(ctx: RequestContext, input: LoadInput): Promise<LoadView> {
  assertCan(ctx, "load", "create");
  return withTenant(tenant(ctx), async (tx) => {
    const r = await tx.execute<{ id: string; version: number }>(sql`
      INSERT INTO app.loads (company_id, reference, broker_name, commodity, weight_lbs, rate_cents, equipment, notes)
      VALUES (${ctx.companyId}, ${input.reference}, ${input.brokerName ?? null}, ${input.commodity ?? null},
              ${input.weightLbs ?? null}, ${input.rateCents ?? null}, ${input.equipment ?? null}::app.equipment, ${input.notes ?? null})
      RETURNING id, version`);
    const row = r.rows[0];
    if (!row) throw new AppError(500, "Insert returned nothing.");
    await insertStops(tx, ctx.companyId, row.id, input.stops);
    const load = await requireLoadTx(tx, row.id);
    await emit(tx, {
      type: "load.created",
      entityId: row.id,
      payload: { version: row.version, status: "open" },
    });
    return load;
  }).catch(rethrow);
}

export async function updateLoad(ctx: RequestContext, patch: LoadPatch): Promise<LoadView> {
  assertCan(ctx, "load", "update");
  return withTenant(tenant(ctx), async (tx) => {
    const current = await requireLoadTx(tx, patch.id);
    if (current.status === "delivered" || current.status === "cancelled") {
      throw new ConflictError("transition", `A ${current.status} load cannot be edited.`, {
        current,
      });
    }
    if (patch.stops && current.status === "in_transit") {
      throw new ConflictError(
        "transition",
        "Stops cannot be replaced while the load is in transit.",
        { current },
      );
    }
    const r = await tx.execute<{ version: number }>(sql`
      UPDATE app.loads SET
        reference   = COALESCE(${patch.reference ?? null}, reference),
        broker_name = ${patch.brokerName === undefined ? sql`broker_name` : (patch.brokerName ?? null)},
        commodity   = ${patch.commodity === undefined ? sql`commodity` : (patch.commodity ?? null)},
        weight_lbs  = ${patch.weightLbs === undefined ? sql`weight_lbs` : (patch.weightLbs ?? null)},
        rate_cents  = ${patch.rateCents === undefined ? sql`rate_cents` : (patch.rateCents ?? null)},
        equipment   = ${patch.equipment === undefined ? sql`equipment` : sql`${patch.equipment ?? null}::app.equipment`},
        notes       = ${patch.notes === undefined ? sql`notes` : (patch.notes ?? null)}
      WHERE id = ${patch.id} AND version = ${patch.version}
      RETURNING version`);
    if ((r.rowCount ?? 0) === 0) {
      const latest = await requireLoadTx(tx, patch.id);
      throw new ConflictError(
        "stale",
        "Someone else changed this load. Review the latest version and try again.",
        {
          current: latest,
        },
      );
    }
    if (patch.stops) {
      await tx.execute(sql`DELETE FROM app.stops WHERE load_id = ${patch.id}`);
      await insertStops(tx, ctx.companyId, patch.id, patch.stops);
      if (current.assignment) {
        // Keep the assignment's period in step with the new windows, from the
        // same definition assign uses; the database rejects a new overlap.
        await tx.execute(sql`
          UPDATE app.assignments a
             SET period = tstzrange(LEAST(lower(a.period), lower(app.load_window(${patch.id}))), upper(app.load_window(${patch.id})), '[)')
           WHERE a.id = ${current.assignment.id}`);
      }
    }
    const load = await requireLoadTx(tx, patch.id);
    await emit(tx, {
      type: "load.updated",
      entityId: patch.id,
      payload: { version: load.version, status: load.status },
      audience: audienceOf(load),
    });
    return load;
  }).catch(rethrow);
}

type Transition = {
  to: LoadStatus;
  from: LoadStatus[];
  permission: "pickup" | "deliver" | "cancel" | "assign";
};
const TRANSITIONS: Transition[] = [
  { to: "in_transit", from: ["assigned"], permission: "pickup" },
  { to: "delivered", from: ["in_transit"], permission: "deliver" },
  { to: "cancelled", from: ["open", "assigned"], permission: "cancel" },
  { to: "open", from: ["assigned"], permission: "assign" },
];

/**
 * Move a load along app.load_transitions. Who may do it is decided here, in
 * one place, from the permission table; whether the move is legal is decided
 * by the database trigger (and checked here too, so a same-state request is a
 * 409 rather than a silent edit). Ending states close the open assignment,
 * which frees the driver and truck from now on.
 */
export async function transitionLoad(
  ctx: RequestContext,
  input: { loadId: string; version: number; to: LoadStatus },
): Promise<LoadView> {
  const t = TRANSITIONS.find((x) => x.to === input.to);
  if (!t) throw new AppError(400, `Loads become ${input.to} through assignment, not directly.`);
  assertCan(ctx, "load", t.permission);
  return withTenant(tenant(ctx), async (tx) => {
    const before = await requireLoadTx(tx, input.loadId);
    if (!t.from.includes(before.status)) {
      throw new ConflictError(
        "transition",
        `A ${before.status.replace("_", " ")} load cannot become ${input.to.replace("_", " ")}.`,
        {
          current: before,
        },
      );
    }
    const r = await tx.execute(sql`
      UPDATE app.loads SET status = ${input.to}::app.load_status
      WHERE id = ${input.loadId} AND version = ${input.version} AND status = ${before.status}::app.load_status`);
    if ((r.rowCount ?? 0) === 0) {
      const latest = await requireLoadTx(tx, input.loadId);
      throw new ConflictError("stale", "This load changed under you. Showing the current state.", {
        current: latest,
      });
    }
    if (input.to === "in_transit") {
      await tx.execute(sql`
        UPDATE app.stops SET arrived_at = COALESCE(arrived_at, now()), departed_at = COALESCE(departed_at, now())
        WHERE load_id = ${input.loadId} AND kind = 'pickup'`);
    }
    if (input.to === "delivered") {
      await tx.execute(sql`
        UPDATE app.stops SET arrived_at = COALESCE(arrived_at, now()), departed_at = COALESCE(departed_at, now())
        WHERE load_id = ${input.loadId} AND departed_at IS NULL`);
    }
    if (input.to === "delivered" || input.to === "cancelled" || input.to === "open") {
      const reason = input.to === "open" ? "unassigned" : input.to;
      // SECURITY DEFINER: a driver may close only the assignment they hold.
      await tx.execute(sql`SELECT app.end_assignment(${input.loadId}, ${reason})`);
    }
    // After a driver delivers, the load is no longer theirs to see: build the
    // result from what we know rather than re-reading an invisible row.
    const after =
      (await getLoadTx(tx, input.loadId)) ??
      ({
        ...before,
        status: input.to,
        version: before.version + 1,
        assignment: null,
      } satisfies LoadView);
    await emit(tx, {
      type: "load.updated",
      entityId: input.loadId,
      payload: { version: after.version, status: after.status, previous: before.status },
      audience: audienceOf(after, before.assignment ? [before.assignment.driverId] : []),
    });
    return after;
  }).catch(rethrow);
}

export async function assignLoad(ctx: RequestContext, input: AssignInput): Promise<LoadView> {
  assertCan(ctx, "load", "assign");
  return withTenant(tenant(ctx), async (tx) => {
    const before = await requireLoadTx(tx, input.loadId);
    if (before.status !== "open") {
      throw new ConflictError("stale", `This load is already ${before.status.replace("_", " ")}.`, {
        current: before,
      });
    }
    if (!before.stops.length) throw new AppError(400, "The load has no stops.");
    try {
      // A nested transaction is a savepoint: if the constraint rejects the row,
      // the outer transaction stays usable so the clash can be described.
      // Only active drivers and trucks qualify (the SELECT yields no row otherwise).
      const inserted = await tx.transaction((sp) =>
        sp.execute(sql`
          INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period)
          SELECT ${ctx.companyId}, ${input.loadId}, d.id, t.id, app.load_window(${input.loadId})
            FROM app.drivers d, app.trucks t
           WHERE d.id = ${input.driverId} AND d.active AND t.id = ${input.truckId} AND t.active`),
      );
      if ((inserted.rowCount ?? 0) === 0) {
        throw new AppError(409, "That driver or truck is inactive or does not exist.");
      }
    } catch (err) {
      const app = err instanceof AppError ? err : fromDbError(err);
      if (app instanceof ConflictError && app.kind === "overlap") {
        throw await describeOverlap(tx, app, input);
      }
      if (app) throw app;
      throw err;
    }
    const r = await tx.execute(sql`
      UPDATE app.loads SET status = 'assigned' WHERE id = ${input.loadId} AND version = ${input.version} AND status = 'open'`);
    if ((r.rowCount ?? 0) === 0) {
      const latest = await requireLoadTx(tx, input.loadId);
      throw new ConflictError("stale", "Another dispatcher changed this load first.", {
        current: latest,
      });
    }
    const after = await requireLoadTx(tx, input.loadId);
    await emit(tx, {
      type: "load.updated",
      entityId: input.loadId,
      payload: { version: after.version, status: "assigned", previous: "open" },
      audience: audienceOf(after),
    });
    return after;
  }).catch(rethrow);
}

/** Name the clashing assignment in the 409, since RLS hides the key values from the constraint error. */
async function describeOverlap(
  tx: Tx,
  err: ConflictError,
  input: AssignInput,
): Promise<ConflictError> {
  const constraint = String(err.details?.constraint ?? "");
  // The current row goes with every 409, so the client can show the truth instead of guessing.
  const current = await getLoadTx(tx, input.loadId).catch(() => null);
  if (constraint === "assignments_load_no_overlap") {
    return new ConflictError("overlap", "This load was assigned by someone else just now.", {
      current,
      constraint,
    });
  }
  const byTruck = constraint === "assignments_truck_no_overlap";
  const column = byTruck
    ? sql`a.truck_id = ${input.truckId}`
    : sql`a.driver_id = ${input.driverId}`;
  const clash = await tx
    .execute<{ reference: string; lower: string; upper: string; name: string }>(sql`
      SELECT l.reference, lower(a.period) AS lower, upper(a.period) AS upper,
             CASE WHEN ${byTruck} THEN t.unit_number ELSE d.name END AS name
        FROM app.assignments a
        JOIN app.loads l ON l.id = a.load_id
        JOIN app.drivers d ON d.id = a.driver_id
        JOIN app.trucks t ON t.id = a.truck_id
       WHERE ${column} AND a.period && app.load_window(${input.loadId})
       ORDER BY lower(a.period) LIMIT 1`)
    .catch(() => null);
  const c = clash?.rows[0];
  if (!c) return new ConflictError("overlap", err.message, { constraint, current });
  const what = byTruck ? `Truck #${c.name}` : c.name;
  return new ConflictError(
    "overlap",
    `${what} is already on ${c.reference} from ${c.lower} to ${c.upper}.`,
    {
      current,
      constraint,
      clash: c,
    },
  );
}

export type Candidate = {
  id: string;
  label: string;
  /** Free for this load's window (no open assignment overlapping it). */
  free: boolean;
  /** Straight-line miles from the truck's last position to the first pickup, when known. */
  distanceMiles: number | null;
  equipment?: Equipment;
};

/**
 * Drivers and trucks for the assign dialog: free ones first. Trucks are
 * ordered by straight-line distance from their last reported position to the
 * load's first pickup, which the GiST index on truck_positions serves
 * (ORDER BY location <-> pickup), so the five nearest free trucks lead.
 */
export async function assignmentCandidates(
  ctx: RequestContext,
  loadId: string,
): Promise<{ drivers: Candidate[]; trucks: Candidate[]; nearestTruckIds: string[] }> {
  assertCan(ctx, "load", "assign");
  return withTenant(tenant(ctx), async (tx) => {
    await requireLoadTx(tx, loadId);
    // The pickup point and the load's window are read once and passed back in
    // as constants. The shape matters under row-level security: PostGIS
    // functions are not LEAKPROOF, so on a policy-protected table the planner
    // will not use them as index conditions, and an ORDER BY on a distance
    // to a joined column cannot be served by the GiST index either. With a
    // constant point, ORDER BY location <-> $point is an index-ordered scan
    // that stops after five rows (decision 0018; the geo benchmark runs this
    // exact query as the app role).
    const target = await tx.execute<{ pickup: string | null; window: string | null }>(sql`
      SELECT (SELECT s.location::text FROM app.stops s WHERE s.load_id = ${loadId} ORDER BY s.seq LIMIT 1) AS pickup,
             app.load_window(${loadId})::text AS window`);
    const pickup = target.rows[0]?.pickup ?? null;
    const window = target.rows[0]?.window ?? null;
    const drivers = await tx.execute<Candidate>(sql`
      SELECT d.id, d.name AS label, NULL::float AS "distanceMiles",
             NOT EXISTS (SELECT 1 FROM app.assignments a
                          WHERE a.driver_id = d.id AND a.ended_reason IS NULL AND a.period && ${window}::tstzrange) AS free
        FROM app.drivers d WHERE d.active
       ORDER BY free DESC, d.name`);
    const trucks = await tx.execute<Candidate>(sql`
      SELECT t.id, '#' || t.unit_number AS label, t.equipment,
             ROUND((ST_Distance(p.location, ${pickup}::geography) / 1609.344)::numeric, 1)::float AS "distanceMiles",
             NOT EXISTS (SELECT 1 FROM app.assignments a
                          WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND a.period && ${window}::tstzrange) AS free
        FROM app.trucks t
        LEFT JOIN app.truck_positions p ON p.truck_id = t.id
       WHERE t.active
       ORDER BY free DESC, p.location <-> ${pickup}::geography NULLS LAST, t.unit_number`);
    // The spec's query: the five closest active trucks with no overlapping
    // assignment, ORDER BY location <-> pickup LIMIT 5, served by the GiST
    // index. (The full list above sorts everything for the pickers.)
    const nearest =
      pickup === null
        ? { rows: [] as Array<{ id: string }> }
        : await tx.execute<{ id: string }>(sql`
      SELECT t.id
        FROM app.truck_positions p
        JOIN app.trucks t ON t.id = p.truck_id
       WHERE t.active
         AND NOT EXISTS (SELECT 1 FROM app.assignments a
                          WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND a.period && ${window}::tstzrange)
       ORDER BY p.location <-> ${pickup}::geography
       LIMIT 5`);
    return {
      drivers: drivers.rows,
      trucks: trucks.rows,
      nearestTruckIds: nearest.rows.map((r) => r.id),
    };
  });
}

function rethrow(err: unknown): never {
  if (err instanceof AppError) throw err;
  const app = fromDbError(err);
  if (app) throw app;
  throw err;
}
