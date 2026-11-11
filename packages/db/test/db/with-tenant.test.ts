import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withTenant } from "../../src/with-tenant.ts";
import { ACME, appPool, asCompany, closePools, superPool } from "./helpers.ts";

afterAll(closePools);

describe("withTenant", () => {
  it("sets all four settings for the transaction", async () => {
    const seen = await withTenant(
      {
        companyId: ACME.id,
        role: "driver",
        userId: "u1",
        driverId: "01930000-0000-7000-8000-00000000d001",
      },
      async (tx) => {
        const r = await tx.execute<{ c: string; r: string; u: string; d: string }>(
          sql`SELECT app.current_company()::text AS c, app.current_role_name() AS r, app.current_user_id() AS u, app.current_driver()::text AS d`,
        );
        return r.rows[0];
      },
      { pool: appPool() },
    );
    expect(seen).toEqual({
      c: ACME.id,
      r: "driver",
      u: "u1",
      d: "01930000-0000-7000-8000-00000000d001",
    });
  });

  it("rejects a malformed context before touching the database", async () => {
    await expect(
      withTenant({ companyId: "not-a-uuid", role: "dispatcher" }, async () => 1, {
        pool: appPool(),
      }),
    ).rejects.toThrow();
    await expect(
      withTenant({ companyId: ACME.id, role: "driver" }, async () => 1, { pool: appPool() }),
    ).rejects.toThrow(/driverId/);
    await expect(
      // @ts-expect-error unknown role
      withTenant({ companyId: ACME.id, role: "superuser" }, async () => 1, { pool: appPool() }),
    ).rejects.toThrow();
  });

  it("rolls back everything when the callback throws", async () => {
    const reference = `RB-${randomUUID().slice(0, 8)}`;
    await expect(
      asCompany(ACME.id, async (tx) => {
        await tx.execute(
          sql`INSERT INTO app.loads (company_id, reference) VALUES (${ACME.id}, ${reference})`,
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const r = await superPool().query("SELECT 1 FROM app.loads WHERE reference = $1", [reference]);
    expect(r.rowCount).toBe(0);
  });

  it("records the acting user in updated_by through the trigger", async () => {
    const reference = `UB-${randomUUID().slice(0, 8)}`;
    await withTenant(
      { companyId: ACME.id, role: "dispatcher", userId: "user_acme_dispatcher_1" },
      (tx) =>
        tx.execute(
          sql`INSERT INTO app.loads (company_id, reference) VALUES (${ACME.id}, ${reference})`,
        ),
      { pool: appPool() },
    );
    const r = await superPool().query<{ updated_by: string }>(
      "SELECT updated_by FROM app.loads WHERE reference = $1",
      [reference],
    );
    expect(r.rows[0]?.updated_by).toBe("user_acme_dispatcher_1");
  });
});
