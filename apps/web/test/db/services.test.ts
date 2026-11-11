import "./setup-env";
import { DEMO_COMPANIES } from "@loadline/db";
import { appPool, createPool, testUrls } from "@loadline/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { RoleName } from "@/lib/permissions";
import type { RequestContext } from "@/server/context";
import { AppError, ConflictError } from "@/server/errors";
import { listDrivers, listTrucks, saveDriver, saveTruck } from "@/server/fleet";
import {
  assignLoad,
  assignmentCandidates,
  createLoad,
  getLoad,
  type LoadStatus,
  listLoads,
  transitionLoad,
  updateLoad,
} from "@/server/loads";

const ACME = DEMO_COMPANIES[0]!;

const superPool = createPool(testUrls().superuser, { max: 2 });
afterAll(async () => {
  await appPool().end();
  await superPool.end();
});

function ctxFor(role: RoleName, driverId: string | null = null): RequestContext {
  return {
    userId: `test-${role}`,
    userName: role,
    email: `${role}@test.example`,
    orgId: ACME.orgId,
    companyId: ACME.id,
    companyName: ACME.name,
    companyTimezone: ACME.timezone,
    role,
    driverId,
  };
}

const dispatcher = ctxFor("dispatcher");
const dispatcherAdmin = ctxFor("admin");
let counter = 0;
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function freshLoad(ctx = dispatcher, offsetHours?: number) {
  const cities = await (await import("@/server/fleet")).searchCities(ctx, "", 5);
  const [a, b] = cities;
  counter++;
  // Each load gets its own window, so a driver assigned in one test is free in the next.
  offsetHours ??= 24 * 40 + counter * 48;
  return createLoad(ctx, {
    reference: `SVC-${Date.now()}-${counter}`,
    brokerName: "Test Broker",
    commodity: "Widgets",
    weightLbs: 1000,
    rateCents: 100_000,
    equipment: "dry_van",
    notes: null,
    stops: [
      {
        kind: "pickup",
        cityId: a!.id,
        facilityName: null,
        appointmentStart: hours(offsetHours),
        appointmentEnd: hours(offsetHours + 2),
      },
      {
        kind: "delivery",
        cityId: b!.id,
        facilityName: null,
        appointmentStart: hours(offsetHours + 20),
        appointmentEnd: hours(offsetHours + 24),
      },
    ],
  });
}

/** A driver and truck free for the load's window (or any active pair when no load is given). */
async function freeDriverAndTruck(
  exclude: { drivers?: string[]; trucks?: string[]; loadId?: string } = {},
) {
  if (exclude.loadId) {
    const c = await assignmentCandidates(dispatcher, exclude.loadId);
    const d = c.drivers.find((x) => x.free && !exclude.drivers?.includes(x.id))!;
    const t = c.trucks.find((x) => x.free && !exclude.trucks?.includes(x.id))!;
    return { driverId: d.id, truckId: t.id };
  }
  const drivers = await listDrivers(dispatcher);
  const trucks = await listTrucks(dispatcher);
  const d = drivers.find((x) => x.active && !exclude.drivers?.includes(x.id))!;
  const t = trucks.find((x) => x.active && !exclude.trucks?.includes(x.id))!;
  return { driverId: d.id, truckId: t.id };
}

describe("assignment", () => {
  it("assigns an open load, bumps the version and records the driver and truck", async () => {
    const load = await freshLoad();
    const { driverId, truckId } = await freeDriverAndTruck();
    const after = await assignLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      driverId,
      truckId,
    });
    expect(after.status).toBe("assigned");
    expect(after.version).toBe(load.version + 1);
    expect(after.assignment?.driverId).toBe(driverId);
    expect(after.assignment?.unitNumber).toBeDefined();
  });

  it("two dispatchers assign the same load in the same second: one wins, the other gets a 409", async () => {
    const load = await freshLoad();
    const first = await freeDriverAndTruck();
    const second = await freeDriverAndTruck({ drivers: [first.driverId], trucks: [first.truckId] });
    const results = await Promise.allSettled([
      assignLoad(ctxFor("dispatcher"), { loadId: load.id, version: load.version, ...first }),
      assignLoad(ctxFor("dispatcher"), { loadId: load.id, version: load.version, ...second }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const err = failed[0]!.reason as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    // Either the database's load constraint or the version check decided; both are 409s.
    expect(["overlap", "stale"]).toContain(err.kind);
    if (err.kind === "overlap") expect(err.details?.constraint).toBe("assignments_load_no_overlap");
    const final = await getLoad(dispatcher, load.id);
    expect(final.status).toBe("assigned");
    expect(final.version).toBe(load.version + 1);
  });

  it("the database, not a pre-check, refuses the second assignment when both read the load as open", async () => {
    // Hold a competing assignment open in a transaction so the service's read
    // still sees the load as open, then let the constraint decide.
    const load = await freshLoad();
    const first = await freeDriverAndTruck();
    const second = await freeDriverAndTruck({ drivers: [first.driverId], trucks: [first.truckId] });
    const competitor = createPool(testUrls().app, { max: 1 });
    const c = await competitor.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
        [ACME.id],
      );
      await c.query(
        "INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period) VALUES ($1, $2, $3, $4, app.load_window($2))",
        [ACME.id, load.id, first.driverId, first.truckId],
      );
      const attempt = assignLoad(dispatcher, {
        loadId: load.id,
        version: load.version,
        ...second,
      }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 300)); // the service is now blocked on the index entry
      await c.query("COMMIT");
      const err = await attempt;
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.kind).toBe("overlap");
      expect(err.details?.constraint).toBe("assignments_load_no_overlap");
    } finally {
      c.release();
      await competitor.end();
    }
  });

  it("refuses an inactive driver or truck", async () => {
    const load = await freshLoad();
    const { driverId, truckId } = await freeDriverAndTruck();
    const inactiveTruck = await saveTruck(dispatcherAdmin, {
      unitNumber: `X-${Date.now()}`,
      equipment: "dry_van",
      homeCityId: null,
      active: false,
    });
    const err = await assignLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      driverId,
      truckId: inactiveTruck,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/inactive/);
    // and a booked driver cannot be deactivated
    const assigned = await assignLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      driverId,
      truckId,
    });
    const driver = (await listDrivers(dispatcher)).find((d) => d.id === driverId)!;
    const deact = await saveDriver(
      dispatcherAdmin,
      { name: driver.name, phone: driver.phone, homeCityId: driver.homeCityId, active: false },
      driverId,
    ).catch((e: unknown) => e as AppError);
    expect(deact).toBeInstanceOf(AppError);
    expect((deact as AppError).status).toBe(409);
    await transitionLoad(dispatcher, {
      loadId: load.id,
      version: assigned.version,
      to: "cancelled",
    });
  });

  it("a load whose window has already opened can be unassigned and reassigned", async () => {
    const load = await freshLoad(dispatcher, -1); // pickup window opened an hour ago
    const a = await freeDriverAndTruck({ loadId: load.id });
    const b = await freeDriverAndTruck({
      loadId: load.id,
      drivers: [a.driverId],
      trucks: [a.truckId],
    });
    const assigned = await assignLoad(dispatcher, { loadId: load.id, version: load.version, ...a });
    const reopened = await transitionLoad(dispatcher, {
      loadId: load.id,
      version: assigned.version,
      to: "open",
    });
    const again = await assignLoad(dispatcher, {
      loadId: load.id,
      version: reopened.version,
      ...b,
    });
    expect(again.assignment?.driverId).toBe(b.driverId);
    await transitionLoad(dispatcher, { loadId: load.id, version: again.version, to: "cancelled" });
  });

  it("names the clashing load when a driver is double-booked", async () => {
    const a = await freshLoad(dispatcher, 24 * 200);
    const b = await freshLoad(dispatcher, 24 * 200 + 5);
    const { driverId, truckId } = await freeDriverAndTruck();
    const other = await freeDriverAndTruck({ drivers: [driverId], trucks: [truckId] });
    await assignLoad(dispatcher, { loadId: a.id, version: a.version, driverId, truckId });
    const err = await assignLoad(dispatcher, {
      loadId: b.id,
      version: b.version,
      driverId,
      truckId: other.truckId,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.kind).toBe("overlap");
    expect(err.message).toContain(a.reference);
    expect(err.details?.constraint).toBe("assignments_driver_no_overlap");
  });

  it("a stale version is refused with the current state attached", async () => {
    const load = await freshLoad();
    const { driverId, truckId } = await freeDriverAndTruck();
    const assigned = await assignLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      driverId,
      truckId,
    });
    const err = await transitionLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      to: "cancelled",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.kind).toBe("stale");
    expect(err.details?.current?.version).toBe(assigned.version);
  });

  it("unassigning frees the driver and truck for an overlapping load", async () => {
    const a = await freshLoad(dispatcher, 24 * 210);
    const b = await freshLoad(dispatcher, 24 * 210 + 3);
    const { driverId, truckId } = await freeDriverAndTruck();
    const assigned = await assignLoad(dispatcher, {
      loadId: a.id,
      version: a.version,
      driverId,
      truckId,
    });
    const reopened = await transitionLoad(dispatcher, {
      loadId: a.id,
      version: assigned.version,
      to: "open",
    });
    expect(reopened.status).toBe("open");
    expect(reopened.assignment).toBeNull();
    const again = await assignLoad(dispatcher, {
      loadId: b.id,
      version: b.version,
      driverId,
      truckId,
    });
    expect(again.status).toBe("assigned");
  });
});

describe("transitions by role", () => {
  const roles: RoleName[] = ["owner", "admin", "dispatcher", "driver"];
  const cases: Array<{
    to: LoadStatus;
    from: "open" | "assigned" | "in_transit";
    allowed: RoleName[];
  }> = [
    { to: "cancelled", from: "open", allowed: ["owner", "admin", "dispatcher"] },
    { to: "in_transit", from: "assigned", allowed: ["owner", "admin", "dispatcher", "driver"] },
    { to: "delivered", from: "in_transit", allowed: ["owner", "admin", "dispatcher", "driver"] },
    { to: "open", from: "assigned", allowed: ["owner", "admin", "dispatcher"] },
    { to: "cancelled", from: "assigned", allowed: ["owner", "admin", "dispatcher"] },
  ];

  async function loadIn(
    from: "open" | "assigned" | "in_transit",
    driverId: string,
    truckId: string,
  ) {
    let load = await freshLoad(dispatcher, 24 * 60 + counter * 30);
    if (from === "open") return load;
    load = await assignLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      driverId,
      truckId,
    });
    if (from === "assigned") return load;
    return transitionLoad(dispatcher, { loadId: load.id, version: load.version, to: "in_transit" });
  }

  for (const c of cases) {
    for (const role of roles) {
      const allowed = c.allowed.includes(role);
      it(`${role}: ${c.from} -> ${c.to} is ${allowed ? "allowed" : "forbidden"}`, async () => {
        const { driverId, truckId } = await freeDriverAndTruck();
        const load = await loadIn(c.from, driverId, truckId);
        const ctx = role === "driver" ? ctxFor("driver", driverId) : ctxFor(role);
        const attempt = transitionLoad(ctx, { loadId: load.id, version: load.version, to: c.to });
        if (allowed) {
          const after = await attempt;
          expect(after.status).toBe(c.to);
        } else {
          const err = await attempt.catch((e) => e);
          expect(err).toBeInstanceOf(AppError);
          expect(err.status).toBe(403);
        }
        // Leave the driver and truck free for the next case.
        const now = await getLoad(dispatcher, load.id);
        if (now.status === "assigned")
          await transitionLoad(dispatcher, {
            loadId: load.id,
            version: now.version,
            to: "cancelled",
          });
        if (now.status === "in_transit")
          await transitionLoad(dispatcher, {
            loadId: load.id,
            version: now.version,
            to: "delivered",
          });
      });
    }
  }

  it("a driver's Delivered closes the assignment and frees the driver and truck at once", async () => {
    // A window that has already opened, so the assignment is cut to now() rather than deleted.
    const open = await freshLoad(dispatcher, -1);
    const { driverId, truckId } = await freeDriverAndTruck({ loadId: open.id });
    const load = await assignLoad(dispatcher, {
      loadId: open.id,
      version: open.version,
      driverId,
      truckId,
    });
    const me = ctxFor("driver", driverId);
    const moving = await transitionLoad(me, {
      loadId: load.id,
      version: load.version,
      to: "in_transit",
    });
    const done = await transitionLoad(me, {
      loadId: load.id,
      version: moving.version,
      to: "delivered",
    });
    expect(done.status).toBe("delivered");
    const row = await superPool.query<{ ended_reason: string; closed: boolean }>(
      "SELECT ended_reason, upper(period) <= now() AS closed FROM app.assignments WHERE load_id = $1",
      [load.id],
    );
    expect(row.rows[0]).toEqual({ ended_reason: "delivered", closed: true });
    // The load is no longer the driver's, and the same pair can take another load right now.
    expect((await listLoads(me)).map((l) => l.id)).not.toContain(load.id);
    const next = await freshLoad(dispatcher, 0.5);
    const taken = await assignLoad(dispatcher, {
      loadId: next.id,
      version: next.version,
      driverId,
      truckId,
    });
    expect(taken.status).toBe("assigned");
    await transitionLoad(dispatcher, { loadId: next.id, version: taken.version, to: "cancelled" });
  });

  it("a same-state transition is a 409, not a silent edit", async () => {
    const load = await freshLoad();
    const cancelled = await transitionLoad(dispatcher, {
      loadId: load.id,
      version: load.version,
      to: "cancelled",
    });
    const err = await transitionLoad(dispatcher, {
      loadId: load.id,
      version: cancelled.version,
      to: "cancelled",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.kind).toBe("transition");
    expect((await getLoad(dispatcher, load.id)).version).toBe(cancelled.version);
  });

  it("a driver cannot pick up a load assigned to someone else (the row is invisible, so 409 with no current state)", async () => {
    const { driverId, truckId } = await freeDriverAndTruck();
    const load = await loadIn("assigned", driverId, truckId);
    const other = (await listDrivers(dispatcher)).find((d) => d.id !== driverId)!;
    const err = await transitionLoad(ctxFor("driver", other.id), {
      loadId: load.id,
      version: load.version,
      to: "in_transit",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(404);
    await transitionLoad(dispatcher, { loadId: load.id, version: load.version, to: "cancelled" });
  });

  it("a driver's load list holds only loads with an open assignment for them", async () => {
    const { driverId, truckId } = await freeDriverAndTruck();
    const load = await loadIn("assigned", driverId, truckId);
    const mine = await listLoads(ctxFor("driver", driverId));
    expect(mine.map((l) => l.id)).toContain(load.id);
    for (const l of mine) expect(l.assignment?.driverId).toBe(driverId);
    await transitionLoad(dispatcher, { loadId: load.id, version: load.version, to: "cancelled" });
    const after = await listLoads(ctxFor("driver", driverId));
    expect(after.map((l) => l.id)).not.toContain(load.id);
  });
});

describe("services enforce the role table (not only the pure can() check)", () => {
  const cases: Array<{
    name: string;
    call: (ctx: RequestContext) => Promise<unknown>;
    allowed: RoleName[];
  }> = [
    {
      name: "createLoad",
      call: (ctx) => freshLoad(ctx),
      allowed: ["owner", "admin", "dispatcher"],
    },
    {
      name: "updateLoad",
      call: async (ctx) => {
        const l = await freshLoad();
        return updateLoad(ctx, { id: l.id, version: l.version, notes: "x" });
      },
      allowed: ["owner", "admin", "dispatcher"],
    },
    {
      name: "assignLoad",
      call: async (ctx) => {
        const l = await freshLoad();
        const { driverId, truckId } = await freeDriverAndTruck();
        const r = await assignLoad(ctx, { loadId: l.id, version: l.version, driverId, truckId });
        await transitionLoad(dispatcher, { loadId: l.id, version: r.version, to: "cancelled" });
        return r;
      },
      allowed: ["owner", "admin", "dispatcher"],
    },
    {
      name: "saveDriver",
      call: (ctx) =>
        saveDriver(ctx, { name: `R ${Date.now()}`, phone: null, homeCityId: null, active: true }),
      allowed: ["owner", "admin"],
    },
    {
      name: "saveTruck",
      call: (ctx) =>
        saveTruck(ctx, {
          unitNumber: `R${Date.now()}${Math.random()}`.slice(0, 20),
          equipment: "reefer",
          homeCityId: null,
          active: true,
        }),
      allowed: ["owner", "admin"],
    },
  ];
  for (const c of cases) {
    for (const role of ["owner", "admin", "dispatcher", "driver"] as RoleName[]) {
      const allowed = c.allowed.includes(role);
      it(`${role}: ${c.name} is ${allowed ? "allowed" : "forbidden"}`, async () => {
        const someDriver = (await listDrivers(dispatcher))[0]!.id;
        const ctx = role === "driver" ? ctxFor("driver", someDriver) : ctxFor(role);
        if (allowed) await expect(c.call(ctx)).resolves.toBeDefined();
        else {
          const err = (await c.call(ctx).catch((e: unknown) => e)) as AppError;
          expect(err).toBeInstanceOf(AppError);
          expect(err.status).toBe(403);
        }
      });
    }
  }
});
