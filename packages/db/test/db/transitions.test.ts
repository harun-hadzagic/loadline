import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ILLEGAL_TRANSITION_SQLSTATE } from "../../src/errors.ts";
import { loadStatusEnum } from "../../src/schema/index.ts";
import {
  ACME,
  asCompany,
  BLUERIDGE,
  closePools,
  expectPgError,
  insertLoad,
  superPool,
} from "./helpers.ts";

afterAll(closePools);

const STATES = loadStatusEnum.enumValues;
const LEGAL = new Set([
  "open>assigned",
  "assigned>open",
  "assigned>in_transit",
  "in_transit>delivered",
  "open>cancelled",
  "assigned>cancelled",
]);

const loadIn = (status: string) => insertLoad(ACME.id, status);

describe("load transitions are enforced by the trigger", () => {
  it("app.load_transitions holds exactly the six legal moves", async () => {
    const r = await superPool().query<{ from_status: string; to_status: string }>(
      "SELECT from_status, to_status FROM app.load_transitions ORDER BY 1, 2",
    );
    expect(new Set(r.rows.map((x) => `${x.from_status}>${x.to_status}`))).toEqual(LEGAL);
  });

  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;
      const legal = LEGAL.has(`${from}>${to}`);
      it(`${from} -> ${to} is ${legal ? "allowed" : "rejected"}`, async () => {
        const load = await loadIn(from);
        const attempt = () =>
          asCompany(ACME.id, async (tx) => {
            const r = await tx.execute<{ status: string; version: number }>(
              sql`UPDATE app.loads SET status = ${to}::app.load_status WHERE id = ${load.id} AND version = ${load.version} RETURNING status, version`,
            );
            return r.rows[0];
          });
        if (legal) {
          const row = await attempt();
          expect(row?.status).toBe(to);
          expect(row?.version).toBe(load.version + 1);
        } else {
          const err = await expectPgError(attempt);
          expect(err.code).toBe(ILLEGAL_TRANSITION_SQLSTATE);
          expect(err.message).toContain(`from ${from} to ${to}`);
          const after = await superPool().query<{ status: string; version: number }>(
            "SELECT status, version FROM app.loads WHERE id = $1",
            [load.id],
          );
          expect(after.rows[0]).toEqual({ status: from, version: load.version });
        }
      });
    }
  }

  it("a same-status update is allowed and still bumps the version", async () => {
    const load = await loadIn("open");
    const row = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ version: number }>(
        sql`UPDATE app.loads SET notes = 'edited' WHERE id = ${load.id} RETURNING version`,
      );
      return r.rows[0];
    });
    expect(row?.version).toBe(load.version + 1);
  });

  it("an optimistic update with a stale version changes nothing", async () => {
    const load = await loadIn("open");
    await asCompany(ACME.id, (tx) =>
      tx.execute(sql`UPDATE app.loads SET notes = 'first' WHERE id = ${load.id}`),
    );
    const count = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute(
        sql`UPDATE app.loads SET notes = 'second' WHERE id = ${load.id} AND version = ${load.version}`,
      );
      return r.rowCount;
    });
    expect(count).toBe(0);
    const after = await superPool().query<{ notes: string }>(
      "SELECT notes FROM app.loads WHERE id = $1",
      [load.id],
    );
    expect(after.rows[0]?.notes).toBe("first");
  });

  it("the trigger cannot be sidestepped by setting version by hand", async () => {
    const load = await loadIn("delivered");
    const err = await expectPgError(() =>
      asCompany(ACME.id, (tx) =>
        tx.execute(sql`UPDATE app.loads SET status = 'open', version = 99 WHERE id = ${load.id}`),
      ),
    );
    expect(err.code).toBe(ILLEGAL_TRANSITION_SQLSTATE);
  });

  it("a dispatcher cannot insert a load in any state but open, and version always starts at 1", async () => {
    const err = await expectPgError(() =>
      asCompany(ACME.id, (tx) =>
        tx.execute(
          sql`INSERT INTO app.loads (company_id, reference, status) VALUES (${ACME.id}, ${`NO-${Math.random()}`}, 'delivered')`,
        ),
      ),
    );
    expect(err.code).toBe("42501");
    const forged = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ version: number }>(
        sql`INSERT INTO app.loads (company_id, reference, version) VALUES (${ACME.id}, ${`V-${Math.random()}`}, 2147483647) RETURNING version`,
      );
      await tx.execute(sql`DELETE FROM app.loads WHERE reference LIKE 'V-%'`); // keep the deferred stop check quiet
      return r.rows[0]?.version;
    });
    expect(forged).toBe(1);
  });

  it("a load needs a pickup and a delivery by the time the transaction commits", async () => {
    const err = await expectPgError(() =>
      asCompany(ACME.id, (tx) =>
        tx.execute(
          sql`INSERT INTO app.loads (company_id, reference) VALUES (${ACME.id}, ${`NS-${Math.random()}`})`,
        ),
      ),
    );
    expect(err.code).toBe("LL003");
  });

  it("only open or cancelled loads can be deleted, so delete-and-reinsert cannot reset a delivered load", async () => {
    const delivered = await loadIn("delivered");
    const open = await loadIn("open");
    const counts = await asCompany(ACME.id, async (tx) => {
      const a = await tx.execute(sql`DELETE FROM app.loads WHERE id = ${delivered.id}`);
      const b = await tx.execute(sql`DELETE FROM app.loads WHERE id = ${open.id}`);
      return [a.rowCount, b.rowCount];
    });
    expect(counts).toEqual([0, 1]);
  });

  it("company_id cannot be changed", async () => {
    const load = await loadIn("open");
    const err = await expectPgError(() =>
      asCompany(ACME.id, (tx) =>
        tx.execute(sql`UPDATE app.loads SET company_id = ${BLUERIDGE.id} WHERE id = ${load.id}`),
      ),
    );
    // Either the policy's WITH CHECK (42501) or the trigger (LL002) stops it; both are in SQL.
    expect(["42501", "LL002"]).toContain(err.code);
  });
});
