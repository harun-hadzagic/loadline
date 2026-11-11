import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_SQL = path.resolve(here, "../sql/bootstrap.sql");

export interface RolePasswords {
  owner: string;
  app: string;
  auth: string;
  stream: string;
}

/**
 * Run once as the superuser: roles, extensions, schemas. Idempotent. Passwords
 * come from the environment and are applied with format('%L'), never pasted
 * into SQL text.
 */
export async function bootstrap(
  superUrl: string,
  passwords: RolePasswords,
  log: (m: string) => void = () => {},
): Promise<void> {
  const client = new pg.Client({
    connectionString: superUrl,
    application_name: "loadline-bootstrap",
  });
  await client.connect();
  try {
    const text = await readFile(BOOTSTRAP_SQL, "utf8");
    log("creating roles, extensions and schemas");
    await client.query(text);
    const dbName = (await client.query<{ db: string }>("SELECT current_database() AS db")).rows[0]
      ?.db;
    if (!dbName) throw new Error("could not read current_database()");
    const roles: Array<[string, string]> = [
      ["loadline_owner", passwords.owner],
      ["loadline_app", passwords.app],
      ["loadline_auth", passwords.auth],
      ["loadline_stream", passwords.stream],
    ];
    for (const [role, password] of roles) {
      const stmt = await client.query<{ q: string }>(
        "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS q",
        [role, password],
      );
      await client.query(stmt.rows[0]?.q ?? "");
      const grant = await client.query<{ q: string }>(
        "SELECT format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text) AS q",
        [dbName, role],
      );
      await client.query(grant.rows[0]?.q ?? "");
    }
    // The database itself stays owned by the superuser; loadline_owner owns the schemas.
    log("roles ready");
  } finally {
    await client.end();
  }
}

/** Drop everything the migrations and bootstrap created in this database (test databases only). */
export async function dropAll(superUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: superUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS auth CASCADE");
    await client.query("DROP SCHEMA IF EXISTS meta CASCADE");
  } finally {
    await client.end();
  }
}
