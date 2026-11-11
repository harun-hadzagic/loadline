import { sql } from "drizzle-orm";
import { withTenant } from "./with-tenant.ts";

/** The nil uuid: app.prune_outbox() ignores the company, but withTenant needs one. */
const NO_COMPANY = "00000000-0000-0000-0000-000000000000";

/** Delete outbox rows older than 24 hours for every company. Returns the count. */
export async function pruneOutbox(): Promise<number> {
  return withTenant({ companyId: NO_COMPANY, role: "system" }, async (tx) => {
    const r = await tx.execute<{ n: string }>(sql`SELECT app.prune_outbox()::text AS n`);
    return Number(r.rows[0]?.n ?? 0);
  });
}
