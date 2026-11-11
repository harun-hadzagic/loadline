import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { requireEnv } from "./env.ts";
import * as schema from "./schema/index.ts";

const { Pool, types } = pg;

// Return timestamptz as Date (default), but keep numeric/bigint/xid8 as strings so
// nothing silently loses precision. Ranges and geography are parsed by the custom
// column types in src/schema/types.ts.
types.setTypeParser(20, (v) => v); // int8
types.setTypeParser(1700, (v) => v); // numeric

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Db = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): Pool {
  return new Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "loadline",
    // Fail fast rather than hang when the database is down.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema, casing: "snake_case" });
}

type Globals = typeof globalThis & { __loadlineAppPool?: Pool; __loadlineAuthPool?: Pool };

/**
 * The process-wide pool for loadline_app. Guarded on globalThis so Next.js
 * development reloads do not open a new pool per module instance.
 */
export function appPool(): Pool {
  const g = globalThis as Globals;
  if (!g.__loadlineAppPool) {
    g.__loadlineAppPool = createPool(requireEnv("DATABASE_URL_APP"), {
      applicationName: "loadline-app",
    });
  }
  return g.__loadlineAppPool;
}

/**
 * The pool Better Auth uses, as loadline_auth. Its search_path is the auth
 * schema, so Better Auth's unqualified table names land there and nowhere
 * else; the role has no privileges on app at all.
 */
export function authPool(): Pool {
  const g = globalThis as Globals;
  if (!g.__loadlineAuthPool) {
    g.__loadlineAuthPool = new Pool({
      connectionString: requireEnv("DATABASE_URL_AUTH"),
      max: 5,
      application_name: "loadline-auth",
      options: "-c search_path=auth",
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return g.__loadlineAuthPool;
}

export async function closeAppPool(): Promise<void> {
  const g = globalThis as Globals;
  if (g.__loadlineAppPool) {
    await g.__loadlineAppPool.end();
    delete g.__loadlineAppPool;
  }
}
