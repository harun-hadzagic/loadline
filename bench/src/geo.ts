// Geospatial benchmark: a separate database with 100,000 trucks and 100,000
// open stops spread over the city table; EXPLAIN (ANALYZE, BUFFERS) for the
// nearest-free-trucks query and the arrival check, with and without the GiST
// index on truck_positions.location, median of 20 runs after warm-up.
// Writes results/geo.json. Never run under x86 emulation (decision 0001).
//
//   BENCH_DATABASE_URL_SUPER=postgres://postgres:postgres-local@localhost:5433/loadline_bench pnpm bench:geo
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, createPool, migrate, withCredentials } from "@loadline/db/testing";
import { machineInfo, percentile } from "./env.ts";

const SUPER =
  process.env.BENCH_DATABASE_URL_SUPER ??
  "postgres://postgres:postgres-local@localhost:5433/loadline_bench";
const ROWS = Number(process.env.BENCH_ROWS ?? 100_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const WARMUP = 3;
const PASSWORDS = {
  owner: "owner-bench",
  app: "app-bench",
  auth: "auth-bench",
  stream: "stream-bench",
};
const COMPANY = "01930000-0000-7000-8000-0000000bec40";

type Plan = { "Execution Time": number; Plan: { "Node Type": string; Plans?: unknown[] } };

function planType(plan: Plan): string {
  const names: string[] = [];
  const walk = (n: { "Node Type": string; "Index Name"?: string; Plans?: unknown[] }) => {
    names.push(n["Index Name"] ? `${n["Node Type"]} on ${n["Index Name"]}` : n["Node Type"]);
    for (const c of (n.Plans ?? []) as Array<typeof n>) walk(c);
  };
  walk(plan.Plan);
  const idx = names.find((n) => /Index/.test(n));
  return idx ?? names.find((n) => /Seq Scan/.test(n)) ?? names[0] ?? "?";
}

async function main(): Promise<void> {
  const superPool = createPool(SUPER, { max: 2 });
  const dbName = new URL(SUPER).pathname.slice(1);
  // Create the benchmark database if needed (from the maintenance database).
  const maint = createPool(SUPER.replace(`/${dbName}`, "/postgres"), { max: 1 });
  const exists = await maint.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (!exists.rowCount) await maint.query(`CREATE DATABASE "${dbName}"`);
  await maint.end();

  console.log(`preparing ${dbName}: schema and ${ROWS.toLocaleString()} trucks and stops`);
  await superPool.query(
    "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS meta CASCADE;",
  );
  await bootstrap(SUPER, PASSWORDS);
  await migrate(withCredentials(SUPER, "loadline_owner", PASSWORDS.owner));

  // Seed as the superuser: this is throwaway benchmark data, not the app's write path.
  const c = await superPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'system', true)",
      [COMPANY],
    );
    await c.query(
      `INSERT INTO app.companies (id, org_id, name, timezone) VALUES ($1, 'org_bench', 'Bench Freight', 'America/Chicago')`,
      [COMPANY],
    );
    await c.query(
      `INSERT INTO app.drivers (company_id, name) SELECT $1, 'Driver ' || g FROM generate_series(1, 2000) g`,
      [COMPANY],
    );
    // Trucks and positions: each truck near a random city with up to ~25 miles of scatter.
    await c.query(
      `INSERT INTO app.trucks (id, company_id, unit_number, equipment, home_city_id)
       SELECT uuidv7(), $1, 'B' || g, (ARRAY['dry_van','reefer','flatbed'])[1 + (g % 3)]::app.equipment,
              (SELECT id FROM app.cities ORDER BY id OFFSET (g * 7919) % 1000 LIMIT 1)
         FROM generate_series(1, $2::int) g`,
      [COMPANY, ROWS],
    );
    await c.query(
      `INSERT INTO app.truck_positions (truck_id, company_id, location, heading, speed_mph, recorded_at)
       SELECT t.id, $1,
              ST_SetSRID(ST_MakePoint(ST_X(c.location::geometry) + (random() - 0.5) * 0.7, ST_Y(c.location::geometry) + (random() - 0.5) * 0.6), 4326)::geography,
              (random() * 360)::real, 0, now()
         FROM app.trucks t JOIN app.cities c ON c.id = t.home_city_id`,
      [COMPANY],
    );
    // Open loads with one pickup and one delivery each, spread over the cities.
    await c.query(
      `INSERT INTO app.loads (id, company_id, reference, status)
       SELECT uuidv7(), $1, 'BL-' || g, 'open' FROM generate_series(1, $2::int) g`,
      [COMPANY, ROWS],
    );
    await c.query(
      `INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
       SELECT $1, l.id, 1, 'pickup', c.id, c.location, tstzrange(now() + r.h * interval '1 hour', now() + (r.h + 2) * interval '1 hour', '[)')
         FROM app.loads l
         CROSS JOIN LATERAL (SELECT random() * 72 AS h) r
         JOIN LATERAL (SELECT id, location FROM app.cities ORDER BY id OFFSET abs(hashtext(l.id::text)) % 1000 LIMIT 1) c ON true`,
      [COMPANY],
    );
    await c.query(
      `INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
       SELECT $1, l.id, 2, 'delivery', c.id, c.location, tstzrange(now() + interval '96 hours', now() + interval '100 hours', '[)')
         FROM app.loads l JOIN LATERAL (SELECT id, location FROM app.cities ORDER BY id OFFSET abs(hashtext(l.reference)) % 1000 LIMIT 1) c ON true`,
      [COMPANY],
    );
    // A few thousand assignments so "free" means something.
    await c.query(
      `INSERT INTO app.assignments (company_id, load_id, driver_id, truck_id, period)
       SELECT $1, l.id, d.id, t.id, tstzrange(now() + interval '1 hour', now() + interval '30 hours', '[)')
         FROM (SELECT id, row_number() OVER () rn FROM app.loads LIMIT 2000) l
         JOIN (SELECT id, row_number() OVER () rn FROM app.trucks LIMIT 2000) t ON t.rn = l.rn
         JOIN (SELECT id, row_number() OVER () rn FROM app.drivers) d ON d.rn = l.rn`,
      [COMPANY],
    );
    await c.query("COMMIT");
    await c.query(
      "ANALYZE app.truck_positions; ANALYZE app.stops; ANALYZE app.assignments; ANALYZE app.trucks",
    );
  } finally {
    c.release();
  }

  const pickup = await superPool.query<{ load_id: string; lng: number; lat: number }>(
    "SELECT load_id, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM app.stops WHERE seq = 1 ORDER BY load_id LIMIT 1 OFFSET 4242",
  );
  const p = pickup.rows[0]!;
  const window = "tstzrange(now() + interval '1 hour', now() + interval '20 hours', '[)')";

  const queries = [
    {
      name: "Nearest free trucks (5 closest active trucks with no overlapping assignment, ordered by location <-> pickup)",
      sql: `SELECT t.id, ST_Distance(p.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1609.344 AS miles
              FROM app.truck_positions p JOIN app.trucks t ON t.id = p.truck_id
             WHERE t.active AND NOT EXISTS (
                     SELECT 1 FROM app.assignments a WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND a.period && ${window})
             ORDER BY p.location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
             LIMIT 5`,
      params: [p.lng, p.lat],
    },
    {
      name: "Arrival check (open stops within 1 mile of a truck position, ST_DWithin on geography)",
      sql: `SELECT count(*) FROM app.stops s
             WHERE s.arrived_at IS NULL AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 1609.344)`,
      params: [p.lng + 0.004, p.lat],
    },
  ];

  const run = async (
    sql: string,
    params: unknown[],
  ): Promise<{ medianMs: number; plan: string; runs: number[] }> => {
    const times: number[] = [];
    let plan = "";
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const r = await superPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const j = (r.rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0] as Plan;
      if (i >= WARMUP) times.push(j["Execution Time"]);
      plan = planType(j);
    }
    times.sort((a, b) => a - b);
    return {
      medianMs: Number(percentile(times, 50).toFixed(3)),
      plan,
      runs: times.map((t) => Number(t.toFixed(3))),
    };
  };

  // Without the indexes: drop them, so the planner cannot use them; put them back after.
  // (SET enable_indexscan = off would leave bitmap scans available.)
  const results = [];
  for (const q of queries) {
    console.log(`with index: ${q.name}`);
    const withIndex = await run(q.sql, q.params);
    await superPool.query(
      "DROP INDEX app.truck_positions_location_idx; DROP INDEX app.stops_location_idx;",
    );
    console.log(`without index: ${q.name}`);
    const withoutIndex = await run(q.sql, q.params);
    await superPool.query(
      "CREATE INDEX truck_positions_location_idx ON app.truck_positions USING gist (location); CREATE INDEX stops_location_idx ON app.stops USING gist (location); ANALYZE app.truck_positions; ANALYZE app.stops;",
    );
    results.push({ name: q.name, withIndex, withoutIndex });
    console.log(
      `  ${withIndex.medianMs} ms (${withIndex.plan})  vs  ${withoutIndex.medianMs} ms (${withoutIndex.plan})`,
    );
  }

  const versions = await superPool.query<{ pg: string; postgis: string }>(
    "SELECT version() AS pg, postgis_version() AS postgis",
  );
  const out = {
    benchmark: "geo",
    date: new Date().toISOString(),
    machine: machineInfo(),
    database: {
      postgres: versions.rows[0]?.pg,
      postgis: versions.rows[0]?.postgis,
      image: process.env.POSTGIS_IMAGE ?? "see .env",
    },
    rows: ROWS,
    runs: RUNS,
    warmup: WARMUP,
    method:
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON); median Execution Time of the timed runs; the GiST indexes are dropped for the without-index runs and recreated afterwards",
    queries: results,
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../results/geo.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${file}`);
  await superPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
