import type { ExtractTablesWithRelations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { z } from "zod";
import { appPool, createDb, type Pool } from "./pool.ts";
import type * as schema from "./schema/index.ts";

/**
 * Roles the database knows about. The four app roles come from Better Auth;
 * `system` is for the app's own service writes (the positions endpoint, jobs,
 * the seed). Policies treat every non-driver role alike; who may do what is
 * decided in the application, in one module.
 */
export const APP_ROLES = ["owner", "admin", "dispatcher", "driver", "system"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const tenantContextSchema = z
  .object({
    companyId: z.uuid(),
    role: z.enum(APP_ROLES),
    userId: z.string().min(1).nullish(),
    driverId: z.uuid().nullish(),
  })
  .refine((c) => c.role !== "driver" || !!c.driverId, {
    message: "a driver context needs a driverId",
  });

export type TenantContext = z.input<typeof tenantContextSchema>;

export type Tx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export interface WithTenantOptions {
  /** Defaults to the process-wide loadline_app pool. Tests pass their own. */
  pool?: Pool;
}

/**
 * The only way the app touches tenant data. Opens a transaction, sets the four
 * request settings with the transaction-local form of set_config, runs the
 * callback and commits. Because the settings are transaction-local, a pooled
 * connection never carries them into the next request, and with no company
 * set every policy sees nothing.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (tx: Tx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const ctx = tenantContextSchema.parse(context);
  const db = createDb(options.pool ?? appPool());
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT set_config('app.company_id', ${ctx.companyId}, true),
             set_config('app.role',       ${ctx.role}, true),
             set_config('app.user_id',    ${ctx.userId ?? ""}, true),
             set_config('app.driver_id',  ${ctx.driverId ?? ""}, true)
    `);
    return fn(tx);
  });
}

/**
 * Map a Better Auth organization id to its company id through the SECURITY
 * DEFINER resolver. Cached per process: the mapping never changes.
 */
const orgCache = new Map<string, string>();

export async function companyIdForOrg(
  orgId: string,
  pool: Pool = appPool(),
): Promise<string | null> {
  const cached = orgCache.get(orgId);
  if (cached) return cached;
  const result = await pool.query<{ id: string | null }>("SELECT app.company_for_org($1) AS id", [
    orgId,
  ]);
  const id = result.rows[0]?.id ?? null;
  if (id) orgCache.set(orgId, id);
  return id;
}

export function clearOrgCache(): void {
  orgCache.clear();
}
