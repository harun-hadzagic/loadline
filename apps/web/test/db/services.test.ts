import "./setup-env";
import { DEMO_COMPANIES } from "@loadline/db";
import { appPool } from "@loadline/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { RoleName } from "@/lib/permissions";
import type { RequestContext } from "@/server/context";
import { AppError, ConflictError } from "@/server/errors";
import { listDrivers, listTrucks } from "@/server/fleet";
import {
  assignLoad,
  createLoad,
  getLoad,
  type LoadStatus,
  listLoads,
  transitionLoad,
} from "@/server/loads";

const ACME = DEMO_COMPANIES[0]!;

afterAll(async () => {
  await appPool().end();
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

async function freeDriverAndTruck(exclude: { drivers?: string[]; trucks?: string[] } = {}) {
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
    const err = failed[0]!.reason;
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as AppError).status).toBe(409);
    const final = await getLoad(dispatcher, load.id);
    expect(final.status).toBe("assigned");
    expect(final.version).toBe(load.version + 1);
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
