import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ILLEGAL_TRANSITION_SQLSTATE } from "../../src/errors.ts";
import { loadStatusEnum } from "../../src/schema/index.ts";
import { ACME, asCompany, BLUERIDGE, closePools, expectPgError, superPool } from "./helpers.ts";

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

async function loadIn(status: string): Promise<{ id: string; version: number }> {
  return asCompany(ACME.id, async (tx) => {
    const r = await tx.execute<{ id: string; version: number }>(
      sql`INSERT INTO app.loads (company_id, reference, status) VALUES (${ACME.id}, ${`TR-${randomUUID().slice(0, 8)}`}, ${status}::app.load_status) RETURNING id, version`,
    );
    return r.rows[0]!;
  });
}

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
