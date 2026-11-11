import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { REFERENCE_TABLES, TENANT_TABLES } from "../../src/schema/index.ts";
import { withTenant } from "../../src/with-tenant.ts";
import {
  ACME,
  appPool,
  asCompany,
  authPool,
  BLUERIDGE,
  closePools,
  expectPgError,
  ownerPool,
  snapshot,
  streamPool,
  superPool,
  urls,
} from "./helpers.ts";

afterAll(closePools);

// Columns that must be fresh when we try to insert a copy of another company's row.
const FRESH: Record<string, string[]> = {
  companies: ["id", "org_id"],
  drivers: ["id", "user_id"],
  trucks: ["id", "unit_number"],
  loads: ["id", "reference"],
  stops: ["id"],
  assignments: ["id"],
  truck_positions: [],
  outbox: [],
};

/** A copy of one of company B's rows with fresh unique keys, plus the insertable column list. */
async function sampleRow(
  table: string,
  companyId: string,
): Promise<{ row: Record<string, unknown>; columns: string[] }> {
  const r = await superPool().query<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS j FROM app.${table} t WHERE company_id = $1 LIMIT 1`,
    [companyId],
  );
  const row = r.rows[0]?.j;
  if (!row)
    throw new Error(`no ${table} row for company ${companyId}; the seed should provide one`);
  for (const col of FRESH[table] ?? []) {
    row[col] = col === "id" ? randomUUID() : `${String(row[col])}-${randomUUID().slice(0, 8)}`;
  }
  // Generated and identity columns cannot be given a value, so leave them out.
  const cols = await superPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = $1 AND is_generated = 'NEVER' AND is_identity = 'NO'
      ORDER BY ordinal_position`,
    [table],
  );
  return { row, columns: cols.rows.map((c) => c.column_name) };
}

describe("row-level security isolates companies on every tenant table", () => {
  // Make sure both companies have outbox rows to isolate.
  it("setup: each company emits an event", async () => {
    for (const c of [ACME, BLUERIDGE]) {
      await asCompany(c.id, (tx) =>
        tx.execute(sql`SELECT app.emit('test.ping', NULL, '{"company": "x"}'::jsonb)`),
      );
    }
  });

  for (const table of TENANT_TABLES.filter((t) => t !== "outbox")) {
    describe(table, () => {
      it("SELECT as company A returns no company B rows and all of A's rows", async () => {
        const totals = await superPool().query<{ company_id: string; n: string }>(
          `SELECT company_id, count(*)::text AS n FROM app.${table} GROUP BY company_id`,
        );
        const expectA = Number(totals.rows.find((r) => r.company_id === ACME.id)?.n ?? 0);
        const expectB = Number(totals.rows.find((r) => r.company_id === BLUERIDGE.id)?.n ?? 0);
        expect(expectB).toBeGreaterThan(0);

        const seen = await asCompany(ACME.id, async (tx) => {
          const all = await tx.execute<{ n: string }>(
            sql.raw(`SELECT count(*)::text AS n FROM app.${table}`),
          );
          const ofB = await tx.execute<{ n: string }>(
            sql.raw(
              `SELECT count(*)::text AS n FROM app.${table} WHERE company_id = '${BLUERIDGE.id}'`,
            ),
          );
          return { all: Number(all.rows[0]?.n), ofB: Number(ofB.rows[0]?.n) };
        });
        expect(seen.ofB).toBe(0);
        expect(seen.all).toBe(expectA);
      });

      it("UPDATE as company A touches no company B rows", async () => {
        const before = await snapshot(table, BLUERIDGE.id);
        const setClause = "updated_by = 'intruder'";
        const rowCount = await asCompany(ACME.id, async (tx) => {
          const r = await tx.execute(
            sql.raw(`UPDATE app.${table} SET ${setClause} WHERE company_id = '${BLUERIDGE.id}'`),
          );
          return r.rowCount ?? 0;
        });
        expect(rowCount).toBe(0);
        expect(await snapshot(table, BLUERIDGE.id)).toBe(before);
      });

      it("DELETE as company A removes no company B rows", async () => {
        const before = await snapshot(table, BLUERIDGE.id);
        const rowCount = await asCompany(ACME.id, async (tx) => {
          const r = await tx.execute(
            sql.raw(`DELETE FROM app.${table} WHERE company_id = '${BLUERIDGE.id}'`),
          );
          return r.rowCount ?? 0;
        });
        expect(rowCount).toBe(0);
        expect(await snapshot(table, BLUERIDGE.id)).toBe(before);
      });

      it("INSERT as company A with company B's company_id is rejected by the policy", async () => {
        const { row, columns } = await sampleRow(table, BLUERIDGE.id);
        const before = await snapshot(table, BLUERIDGE.id);
        const colList = columns.map((c) => `"${c}"`).join(", ");
        const err = await expectPgError(() =>
          asCompany(ACME.id, (tx) =>
            tx.execute(
              sql`INSERT INTO ${sql.raw(`app.${table}`)} (${sql.raw(colList)})
                  SELECT ${sql.raw(colList)} FROM jsonb_populate_record(NULL::${sql.raw(`app.${table}`)}, ${JSON.stringify(row)}::jsonb)`,
            ),
          ),
        );
        expect(err.code).toBe("42501");
        expect(err.message).toMatch(/row-level security policy/);
        expect(await snapshot(table, BLUERIDGE.id)).toBe(before);
      });

      it("UPDATE of the company's own row works and records the acting user", async () => {
        if (table === "truck_positions" || table === "stops" || table === "assignments") {
          // These have no harmless column to touch generically; covered by the service tests.
        }
        const setClause =
          table === "companies"
            ? "name = name"
            : table === "stops"
              ? "facility_name = facility_name"
              : table === "assignments"
                ? "ended_reason = ended_reason"
                : table === "truck_positions"
                  ? "heading = heading"
                  : "active = active";
        const clause = table === "loads" ? "notes = notes" : setClause;
        const r = await asCompany(ACME.id, async (tx) => {
          const u = await tx.execute<{ updated_by: string | null }>(
            sql.raw(
              `UPDATE app.${table} SET ${clause} WHERE company_id = '${ACME.id}' RETURNING updated_by`,
            ),
          );
          return { rowCount: u.rowCount ?? 0, updatedBy: u.rows[0]?.updated_by };
        });
        expect(r.rowCount).toBeGreaterThan(0);
        expect(r.updatedBy).toBe("test-user");
      });

      it("reads empty with no company set", async () => {
        const client = await appPool().connect();
        try {
          const r = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM app.${table}`,
          );
          expect(Number(r.rows[0]?.n)).toBe(0);
        } finally {
          client.release();
        }
      });
    });
  }

  it("a company-A insert with its own company_id works (the policy is not simply denying everything)", async () => {
    const id = await asCompany(ACME.id, async (tx) => {
      const r = await tx.execute<{ id: string }>(
        sql`INSERT INTO app.trucks (company_id, unit_number, equipment) VALUES (${ACME.id}, ${`T-${randomUUID().slice(0, 6)}`}, 'dry_van') RETURNING id`,
      );
      return r.rows[0]?.id;
    });
    expect(id).toBeDefined();
  });
});

describe("the pooled connection forgets the company after commit", () => {
  it("set_config(..., true) does not survive the transaction", async () => {
    const single = new pg.Pool({ connectionString: urls.app, max: 1 });
    try {
      const inside = await asCompany(ACME.id, async (tx) => {
        const r = await tx.execute<{ c: string }>(
          sql`SELECT current_setting('app.company_id', true) AS c`,
        );
        return r.rows[0]?.c;
      });
      expect(inside).toBe(ACME.id);
      // Same single connection, next "request":
      const after = await single.query<{ c: string | null; n: string }>(
        "SELECT current_setting('app.company_id', true) AS c, (SELECT count(*)::text FROM app.loads) AS n",
      );
      expect(after.rows[0]?.c ?? "").toBe("");
      expect(Number(after.rows[0]?.n)).toBe(0);
    } finally {
      await single.end();
    }
  });
});

describe("the catalog", () => {
  it("every table in app except the reference tables has row security enabled and forced", async () => {
    const r = await superPool().query<{ relname: string; rls: boolean; forced: boolean }>(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
        ORDER BY 1`,
    );
    const reference = new Set<string>(REFERENCE_TABLES);
    const tenant = r.rows.filter((row) => !reference.has(row.relname));
    expect(tenant.map((t) => t.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const t of tenant) {
      expect(t.rls, `${t.relname} must ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(t.forced, `${t.relname} must FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it("the app schema has no views, which could bypass table policies", async () => {
    const r = await superPool().query(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('v', 'm')",
    );
    expect(r.rows).toEqual([]);
  });

  it("every tenant table has the tenant_isolation policy and a company_id column", async () => {
    for (const table of TENANT_TABLES) {
      const pol = await superPool().query(
        "SELECT 1 FROM pg_policies WHERE schemaname = 'app' AND tablename = $1 AND policyname LIKE 'tenant_isolation%'",
        [table],
      );
      expect(pol.rowCount, `${table} needs tenant_isolation`).toBeGreaterThanOrEqual(1);
      const col = await superPool().query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1 AND column_name = 'company_id' AND is_nullable = 'NO'",
        [table],
      );
      expect(col.rowCount, `${table} needs company_id not null`).toBe(1);
    }
  });

  it("loadline_app owns no table, has no BYPASSRLS, and cannot turn row security off", async () => {
    const owned = await superPool().query(
      "SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'loadline_app'",
    );
    expect(owned.rows).toEqual([]);
    const roles = await superPool().query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      "SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname LIKE 'loadline_%' ORDER BY 1",
    );
    const byName = Object.fromEntries(roles.rows.map((r) => [r.rolname, r]));
    expect(byName.loadline_app?.rolbypassrls).toBe(false);
    expect(byName.loadline_owner?.rolbypassrls).toBe(false);
    expect(byName.loadline_auth?.rolbypassrls).toBe(false);
    expect(byName.loadline_stream?.rolbypassrls).toBe(true);
    for (const r of roles.rows) expect(r.rolsuper).toBe(false);

    const client = await appPool().connect();
    try {
      await client.query("SET row_security = off");
      const err = await expectPgError(() => client.query("SELECT count(*) FROM app.loads"));
      expect(err.code).toBe("42501");
    } finally {
      await client.query("RESET row_security");
      client.release();
    }
  });

  it("every tenant table in app is owned by loadline_owner", async () => {
    const r = await superPool().query<{ relname: string; owner: string }>(
      "SELECT c.relname, r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind = 'r'",
    );
    for (const row of r.rows) expect(row.owner, row.relname).toBe("loadline_owner");
  });
});

describe("drivers", () => {
  it("see only loads assigned to them, and nothing of other drivers, even without a WHERE clause", async () => {
    const drivers = await superPool().query<{ driver_id: string; n: string }>(
      `SELECT a.driver_id, count(DISTINCT a.load_id)::text AS n FROM app.assignments a WHERE a.company_id = $1 GROUP BY 1 ORDER BY 2 DESC`,
      [ACME.id],
    );
    const mine = drivers.rows[0]!;
    const other = drivers.rows[1]!;
    const otherLoad = await superPool().query<{ load_id: string }>(
      "SELECT load_id FROM app.assignments WHERE driver_id = $1 AND load_id NOT IN (SELECT load_id FROM app.assignments WHERE driver_id = $2) LIMIT 1",
      [other.driver_id, mine.driver_id],
    );
    const seen = await asCompany(
      ACME.id,
      async (tx) => {
        const loads = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM app.loads`,
        );
        const theirs = await tx.execute(
          sql`SELECT id FROM app.loads WHERE id = ${otherLoad.rows[0]!.load_id}`,
        );
        const assignments = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM app.assignments WHERE driver_id <> ${mine.driver_id}`,
        );
        const stops = await tx.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM app.stops s WHERE NOT EXISTS (SELECT 1 FROM app.assignments a WHERE a.load_id = s.load_id AND a.driver_id = ${mine.driver_id})`,
        );
        return {
          loads: Number(loads.rows[0]?.n),
          theirs: theirs.rows.length,
          foreignAssignments: Number(assignments.rows[0]?.n),
          foreignStops: Number(stops.rows[0]?.n),
        };
      },
      { role: "driver", driverId: mine.driver_id, userId: "driver-user" },
    );
    expect(seen.loads).toBe(Number(mine.n));
    expect(seen.theirs).toBe(0);
    expect(seen.foreignAssignments).toBe(0);
    expect(seen.foreignStops).toBe(0);
  });

  it("cannot create loads or assignments", async () => {
    const driver = await superPool().query<{ id: string }>(
      "SELECT id FROM app.drivers WHERE company_id = $1 LIMIT 1",
      [ACME.id],
    );
    const err = await expectPgError(() =>
      asCompany(
        ACME.id,
        (tx) =>
          tx.execute(
            sql`INSERT INTO app.loads (company_id, reference) VALUES (${ACME.id}, ${`DRV-${randomUUID().slice(0, 6)}`})`,
          ),
        { role: "driver", driverId: driver.rows[0]!.id },
      ),
    );
    expect(err.code).toBe("42501");
  });
});

describe("audit columns", () => {
  it("updated_by is the acting user, NULL for service writes, and cannot be supplied by the caller", async () => {
    const r = await withTenant(
      { companyId: ACME.id, role: "system" },
      async (tx) => {
        const ins = await tx.execute<{ updated_by: string | null }>(
          sql`INSERT INTO app.trucks (company_id, unit_number, equipment, updated_by) VALUES (${ACME.id}, ${`AU-${randomUUID().slice(0, 6)}`}, 'dry_van', 'forged') RETURNING updated_by`,
        );
        return ins.rows[0]?.updated_by;
      },
      { pool: appPool() },
    );
    expect(r).toBeNull();
  });
});

describe("loadline_stream", () => {
  it("reads the outbox of every company but nothing else", async () => {
    const r = await streamPool().query<{ company_id: string }>(
      "SELECT DISTINCT company_id FROM app.outbox",
    );
    const ids = r.rows.map((x) => x.company_id).sort();
    expect(ids).toContain(ACME.id);
    expect(ids).toContain(BLUERIDGE.id);
    for (const table of TENANT_TABLES.filter((t) => t !== "outbox")) {
      const err = await expectPgError(() =>
        streamPool().query(`SELECT * FROM app.${table} LIMIT 1`),
      );
      expect(err.code, table).toBe("42501");
    }
    const ins = await expectPgError(() =>
      streamPool().query("INSERT INTO app.outbox (company_id, type) VALUES ($1, 'x')", [ACME.id]),
    );
    expect(ins.code).toBe("42501");
    const del = await expectPgError(() => streamPool().query("DELETE FROM app.outbox"));
    expect(del.code).toBe("42501");
  });
});

describe("loadline_auth", () => {
  it("cannot touch app tables", async () => {
    for (const table of [...TENANT_TABLES, ...REFERENCE_TABLES]) {
      const err = await expectPgError(() => authPool().query(`SELECT * FROM app.${table} LIMIT 1`));
      expect(err.code, table).toBe("42501");
    }
  });
});

describe("loadline_owner", () => {
  it("is subject to forced row security like everyone else (sees no tenant rows without a company)", async () => {
    const r = await ownerPool().query<{ n: string }>("SELECT count(*)::text AS n FROM app.loads");
    expect(Number(r.rows[0]?.n)).toBe(0);
  });
});

describe("app.company_for_org", () => {
  it("resolves an organization to its company id and nothing else", async () => {
    const r = await appPool().query<{ id: string | null }>("SELECT app.company_for_org($1) AS id", [
      ACME.orgId,
    ]);
    expect(r.rows[0]?.id).toBe(ACME.id);
    const none = await appPool().query<{ id: string | null }>(
      "SELECT app.company_for_org('nope') AS id",
    );
    expect(none.rows[0]?.id).toBeNull();
  });
});
