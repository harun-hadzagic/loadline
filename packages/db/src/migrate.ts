import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadCities } from "./cities.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../migrations");

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply migrations/*.sql in name order as loadline_owner. Each file runs in
 * its own transaction and is recorded in meta.migrations, so a failed file
 * leaves nothing half-applied and a rerun picks up where it stopped. Nothing
 * here changes the schema at run time: this runs from the migrate container
 * or by hand.
 */
export async function migrate(
  ownerUrl: string,
  log: (m: string) => void = () => {},
): Promise<MigrateResult> {
  const client = new pg.Client({
    connectionString: ownerUrl,
    application_name: "loadline-migrate",
  });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS meta.migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    // Serialise concurrent runners (e.g. two compose starts).
    await client.query("SELECT pg_advisory_lock(7245001)");
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM meta.migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const text = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(text);
        await client.query("INSERT INTO meta.migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file);
    }
    log("loading cities");
    const n = await loadCities(client);
    log(`cities: ${n} rows`);
    await client.query("SELECT pg_advisory_unlock(7245001)");
  } finally {
    await client.end();
  }
  return result;
}
