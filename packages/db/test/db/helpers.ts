import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { DEMO_COMPANIES } from "../../src/seed/data.ts";
import { testUrls } from "../../src/testing.ts";
import { type TenantContext, type Tx, withTenant } from "../../src/with-tenant.ts";

export const urls = testUrls();

export const ACME = DEMO_COMPANIES[0]!;
export const BLUERIDGE = DEMO_COMPANIES[1]!;

const pools = new Map<string, pg.Pool>();

export function poolFor(url: string, max = 4): pg.Pool {
  let p = pools.get(url);
  if (!p) {
    p = new pg.Pool({ connectionString: url, max });
    pools.set(url, p);
  }
  return p;
}

export const superPool = () => poolFor(urls.superuser);
export const appPool = () => poolFor(urls.app);
export const streamPool = () => poolFor(urls.stream);
export const authPool = () => poolFor(urls.auth);
export const ownerPool = () => poolFor(urls.owner);

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

export function asCompany<T>(
  companyId: string,
  fn: (tx: Tx) => Promise<T>,
  extra: Partial<TenantContext> = {},
): Promise<T> {
  return withTenant({ companyId, role: "dispatcher", userId: "test-user", ...extra }, fn, {
    pool: appPool(),
  });
}

export interface PgError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
}

/** Run fn and return the PostgreSQL error it throws (fails the test if it does not throw). */
export async function expectPgError(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn();
  } catch (err) {
    const e = (err as { cause?: unknown }).cause ?? err;
    return e as PgError;
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

export function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 3_600_000);
}

export function rangeLiteral(lower: Date, upper: Date): string {
  return `["${lower.toISOString()}","${upper.toISOString()}")`;
}

/** Superuser snapshot of a table's rows for one company, for "nothing changed" assertions. */
export async function snapshot(table: string, companyId: string): Promise<string> {
  const r = await superPool().query<{ h: string | null }>(
    `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM app.${table} t WHERE company_id = $1`,
    [companyId],
  );
  return r.rows[0]?.h ?? "";
}

/**
 * Insert a load with one pickup and one delivery stop (the deferred constraint
 * trigger requires both). Runs as `system` because only that role may insert a
 * load in a state other than open.
 */
export async function insertLoad(
  companyId: string,
  status = "open",
  opts: { reference?: string; pickupAt?: Date; hours?: number } = {},
): Promise<{ id: string; version: number }> {
  const reference = opts.reference ?? `T-${randomUUID().slice(0, 8)}`;
  const start = opts.pickupAt ?? hoursFromNow(24 * 60);
  const end = new Date(start.getTime() + (opts.hours ?? 24) * 3_600_000);
  return asCompany(
    companyId,
    async (tx) => {
      const r = await tx.execute<{ id: string; version: number }>(
        sql`INSERT INTO app.loads (company_id, reference, status) VALUES (${companyId}, ${reference}, ${status}::app.load_status) RETURNING id, version`,
      );
      const load = r.rows[0]!;
      await tx.execute(sql`
        INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
        SELECT ${companyId}, ${load.id}, 1, 'pickup', c.id, c.location,
               tstzrange(${start.toISOString()}::timestamptz, ${start.toISOString()}::timestamptz + interval '2 hours', '[)')
          FROM app.cities c WHERE c.name = 'Dallas' AND c.state = 'TX'`);
      await tx.execute(sql`
        INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
        SELECT ${companyId}, ${load.id}, 2, 'delivery', c.id, c.location,
               tstzrange(${end.toISOString()}::timestamptz - interval '4 hours', ${end.toISOString()}::timestamptz, '[)')
          FROM app.cities c WHERE c.name = 'Houston' AND c.state = 'TX'`);
      return load;
    },
    { role: "system" },
  );
}
