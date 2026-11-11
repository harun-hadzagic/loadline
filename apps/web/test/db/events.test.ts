import "./setup-env";
import { DEMO_COMPANIES } from "@loadline/db";
import { appPool, createPool, testUrls } from "@loadline/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@/server/context";
import { saveDriver, saveTruck, searchCities } from "@/server/fleet";
import {
  assignLoad,
  assignmentCandidates,
  createLoad,
  transitionLoad,
  updateLoad,
} from "@/server/loads";
import { systemContext } from "@/server/positions";

// Spec: every mutation writes exactly one event per changed entity, through
// the shared write path, in the same transaction.

const ACME = DEMO_COMPANIES[0]!;
const superPool = createPool(testUrls().superuser, { max: 2 });
afterAll(async () => {
  await appPool().end();
  await superPool.end();
});

const admin: RequestContext = { ...systemContext(ACME.id), userId: "events-admin", role: "admin" };

async function eventsSince(id: number): Promise<Array<{ type: string; entity_id: string | null }>> {
  const r = await superPool.query<{ type: string; entity_id: string | null }>(
    "SELECT type, entity_id FROM app.outbox WHERE id > $1 ORDER BY id",
    [id],
  );
  return r.rows;
}
async function lastId(): Promise<number> {
  return Number(
    (await superPool.query<{ m: string }>("SELECT coalesce(max(id), 0)::text AS m FROM app.outbox"))
      .rows[0]?.m ?? 0,
  );
}
const h = (n: number) => new Date(Date.now() + (24 * 300 + n) * 3_600_000).toISOString();

describe("one event per changed entity", () => {
  it("createLoad, updateLoad, assignLoad and each transition write exactly one load event; fleet writes one each", async () => {
    const [a, b] = await searchCities(admin, "", 2);
    let mark = await lastId();
    const load = await createLoad(admin, {
      reference: `EV-${Date.now()}`,
      brokerName: null,
      commodity: null,
      weightLbs: null,
      rateCents: null,
      equipment: null,
      notes: null,
      stops: [
        {
          kind: "pickup",
          cityId: a!.id,
          facilityName: null,
          appointmentStart: h(0),
          appointmentEnd: h(2),
        },
        {
          kind: "delivery",
          cityId: b!.id,
          facilityName: null,
          appointmentStart: h(10),
          appointmentEnd: h(14),
        },
      ],
    });
    expect(await eventsSince(mark)).toEqual([{ type: "load.created", entity_id: load.id }]);

    mark = await lastId();
    const edited = await updateLoad(admin, { id: load.id, version: load.version, notes: "edited" });
    expect(await eventsSince(mark)).toEqual([{ type: "load.updated", entity_id: load.id }]);

    mark = await lastId();
    const c = await assignmentCandidates(admin, load.id);
    const assigned = await assignLoad(admin, {
      loadId: load.id,
      version: edited.version,
      driverId: c.drivers.find((d) => d.free)!.id,
      truckId: c.trucks.find((t) => t.free)!.id,
    });
    expect(await eventsSince(mark)).toEqual([{ type: "load.updated", entity_id: load.id }]);

    mark = await lastId();
    const moving = await transitionLoad(admin, {
      loadId: load.id,
      version: assigned.version,
      to: "in_transit",
    });
    expect(await eventsSince(mark)).toEqual([{ type: "load.updated", entity_id: load.id }]);

    mark = await lastId();
    await transitionLoad(admin, { loadId: load.id, version: moving.version, to: "delivered" });
    expect(await eventsSince(mark)).toEqual([{ type: "load.updated", entity_id: load.id }]);

    mark = await lastId();
    const driverId = await saveDriver(admin, {
      name: "Event Driver",
      phone: null,
      homeCityId: null,
      active: true,
    });
    expect(await eventsSince(mark)).toEqual([{ type: "driver.created", entity_id: driverId }]);

    mark = await lastId();
    const truckId = await saveTruck(admin, {
      unitNumber: `EV${Date.now() % 100000}`,
      equipment: "flatbed",
      homeCityId: null,
      active: true,
    });
    expect(await eventsSince(mark)).toEqual([{ type: "truck.created", entity_id: truckId }]);
  });

  it("a failed mutation writes no event at all (the event commits with the write or not at all)", async () => {
    const mark = await lastId();
    await expect(
      updateLoad(admin, { id: "00000000-0000-0000-0000-000000000000", version: 1, notes: "ghost" }),
    ).rejects.toThrow();
    expect(await eventsSince(mark)).toEqual([]);
  });
});
