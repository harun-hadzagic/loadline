// Geospatial benchmark: a separate database with 100,000 trucks and 200,000
// stops spread over the city table; EXPLAIN (ANALYZE, BUFFERS) for the app's
// nearest-free-trucks query and a stops-within-radius query, with and without
// the GiST indexes, median of 20 runs after warm-up. The nearest query is the
// exact SQL the app runs (apps/web/src/server/loads.ts, assignmentCandidates),
// executed as loadline_app with the company set, so row security is in the
// plan. A third row repeats the radius query as a superuser, which shows what
// row security costs when the operator is not LEAKPROOF (decision 0018). Writes results/geo.json. Never run under x86 emulation (decision 0001).
//
//   BENCH_DATABASE_URL_SUPER=postgres://postgres:postgres-local@localhost:5433/loadline_bench pnpm bench:geo
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bootstrap,
  createPool,
  migrate,
  TEST_PASSWORDS,
  withCredentials,
} from "@loadline/db/testing";
import { machineInfo, percentile } from "./env.ts";

const SUPER =
  process.env.BENCH_DATABASE_URL_SUPER ??
  "postgres://postgres:postgres-local@localhost:5433/loadline_bench";
const ROWS = Number(process.env.BENCH_ROWS ?? 100_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const WARMUP = 3;
// Roles are cluster-wide: bootstrap would ALTER ROLE for every database on
// the server, so the benchmark uses the test cluster's own passwords.
const PASSWORDS = TEST_PASSWORDS;
const COMPANY = "01930000-0000-7000-8000-0000000bec40";

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
};
type Plan = { "Execution Time": number; Plan: PlanNode };

/** How the planner reached the geometry: the GiST index, or a scan of every row plus a sort. */
function planType(plan: Plan): string {
  const names: string[] = [];
  const walk = (n: PlanNode) => {
    const on = n["Index Name"] ?? n["Relation Name"];
    names.push(on ? `${n["Node Type"]} on ${on}` : n["Node Type"]);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(plan.Plan);
  const gist = names.find((n) => /location_idx/.test(n));
  if (gist) return gist;
  const scan =
    names.find((n) => /Seq Scan on (truck_positions|stops)/.test(n)) ??
    names.find((n) => /Scan on (truck_positions|stops)/.test(n)) ??
    names[0] ??
    "?";
  return names.includes("Sort") ? `Sort over ${scan}` : scan;
}

async function main(): Promise<void> {
  const superPool = createPool(SUPER, { max: 2 });
  const dbName = new URL(SUPER).pathname.slice(1);
  const maint = createPool(SUPER.replace(`/${dbName}`, "/postgres"), { max: 1 });
  const exists = await maint.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (!exists.rowCount) await maint.query(`CREATE DATABASE "${dbName}"`);
  await maint.end();

  console.log(`preparing ${dbName}: schema and ${ROWS.toLocaleString()} trucks and loads`);
  await superPool.query(
    "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS meta CASCADE;",
  );
  await bootstrap(SUPER, PASSWORDS);
  await migrate(withCredentials(SUPER, "loadline_owner", PASSWORDS.owner));

  // Seed as the superuser: throwaway benchmark data, not the app's write path.
  const c = await superPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'system', true)",
      [COMPANY],
    );
    await c.query(
      "INSERT INTO app.companies (id, org_id, name, timezone) VALUES ($1, 'org_bench', 'Bench Freight', 'America/Chicago')",
      [COMPANY],
    );
    // One driver per benchmark assignment: the WITHOUT OVERLAPS constraint is real here too.
    await c.query(
      "INSERT INTO app.drivers (company_id, name) SELECT $1, 'Driver ' || g FROM generate_series(1, 2000) g",
      [COMPANY],
    );
    // Trucks spread over the cities (by offset, not by ordering on a constant), positions scattered around home.
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
              ST_SetSRID(ST_MakePoint(ST_X(c.location::geometry) + (random() - 0.5) * 0.7,
                                      ST_Y(c.location::geometry) + (random() - 0.5) * 0.6), 4326)::geography,
              (random() * 360)::real, 0, now()
         FROM app.trucks t JOIN app.cities c ON c.id = t.home_city_id`,
      [COMPANY],
    );
    await c.query(
      "INSERT INTO app.loads (id, company_id, reference, status) SELECT uuidv7(), $1, 'BL-' || g, 'open' FROM generate_series(1, $2::int) g",
      [COMPANY, ROWS],
    );
    await c.query(
      `INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
       SELECT $1, l.id, 1, 'pickup', c.id, c.location,
              tstzrange(now() + r.h * interval '1 hour', now() + (r.h + 2) * interval '1 hour', '[)')
         FROM app.loads l
         CROSS JOIN LATERAL (SELECT random() * 72 AS h) r
         JOIN LATERAL (SELECT id, location FROM app.cities ORDER BY id OFFSET abs(hashtext(l.id::text)) % 1000 LIMIT 1) c ON true`,
      [COMPANY],
    );
    await c.query(
      `INSERT INTO app.stops (company_id, load_id, seq, kind, city_id, location, appointment)
       SELECT $1, l.id, 2, 'delivery', c.id, c.location, tstzrange(now() + interval '96 hours', now() + interval '100 hours', '[)')
         FROM app.loads l
         JOIN LATERAL (SELECT id, location FROM app.cities ORDER BY id OFFSET abs(hashtext(l.reference)) % 1000 LIMIT 1) c ON true`,
      [COMPANY],
    );
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

  // A load whose pickup is one of the cities, far down the list. The app reads
  // the pickup point and the load's window first and passes them back as
  // constants (apps/web/src/server/loads.ts); the benchmark does the same.
  const target = await superPool.query<{
    load_id: string;
    pickup: string;
    window: string;
    lng: number;
    lat: number;
  }>(
    `SELECT load_id, location::text AS pickup, app.load_window(load_id)::text AS window,
            ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat
       FROM app.stops WHERE seq = 1 ORDER BY load_id LIMIT 1 OFFSET 4242`,
  );
  const p = target.rows[0]!;

  const radiusSql = `SELECT count(*) FROM app.stops s
             WHERE s.arrived_at IS NULL AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 1609.344)`;
  const queries: Array<{ name: string; asApp: boolean; sql: string; params: unknown[] }> = [
    {
      name: "Nearest free trucks, as the app role under row security (the app's query: 5 closest active trucks with no assignment overlapping the load's window, ORDER BY location <-> $pickup LIMIT 5)",
      asApp: true,
      sql: `SELECT t.id
              FROM app.truck_positions p
              JOIN app.trucks t ON t.id = p.truck_id
             WHERE t.active
               AND NOT EXISTS (SELECT 1 FROM app.assignments a
                                WHERE a.truck_id = t.id AND a.ended_reason IS NULL AND a.period && $2::tstzrange)
             ORDER BY p.location <-> $1::geography
             LIMIT 5`,
      params: [p.pickup, p.window],
    },
    {
      name: "Open stops within 1 mile of a point, as the app role under row security (ST_DWithin on geography: the shape of an arrival sweep; the app's own arrival check looks up one stop by id). ST_DWithin is not LEAKPROOF, so row security keeps it out of the index condition",
      asApp: true,
      sql: radiusSql,
      params: [p.lng + 0.004, p.lat],
    },
    {
      name: "The same radius query as a superuser that row security does not apply to",
      asApp: false,
      sql: radiusSql,
      params: [p.lng + 0.004, p.lat],
    },
  ];

  // The app's role, with the company set the way withTenant sets it: row security is part of the plan.
  const appPool = createPool(withCredentials(SUPER, "loadline_app", PASSWORDS.app), { max: 1 });
  const run = async (
    sql: string,
    params: unknown[],
    asApp: boolean,
  ): Promise<{ medianMs: number; plan: string; runs: number[] }> => {
    const client = await (asApp ? appPool : superPool).connect();
    const times: number[] = [];
    let plan = "";
    try {
      for (let i = 0; i < WARMUP + RUNS; i++) {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.company_id', $1, true), set_config('app.role', 'dispatcher', true)",
          [COMPANY],
        );
        const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
        await client.query("COMMIT");
        const j = (r.rows[0] as { "QUERY PLAN": Plan[] })["QUERY PLAN"][0] as Plan;
        if (i >= WARMUP) times.push(j["Execution Time"]);
        plan = planType(j);
      }
    } finally {
      client.release();
    }
    times.sort((a, b) => a - b);
    return {
      medianMs: Number(percentile(times, 50).toFixed(3)),
      plan,
      runs: times.map((t) => Number(t.toFixed(3))),
    };
  };

  // Without the indexes: drop them so the planner cannot use them; put them back after.
  const results = [];
  for (const q of queries) {
    console.log(`with index: ${q.name.slice(0, 60)}`);
    const withIndex = await run(q.sql, q.params, q.asApp);
    await superPool.query(
      "DROP INDEX app.truck_positions_location_idx; DROP INDEX app.stops_location_idx;",
    );
    console.log(`without index: ${q.name.slice(0, 60)}`);
    const withoutIndex = await run(q.sql, q.params, q.asApp);
    await superPool.query(
      "CREATE INDEX truck_positions_location_idx ON app.truck_positions USING gist (location); CREATE INDEX stops_location_idx ON app.stops USING gist (location); ANALYZE app.truck_positions; ANALYZE app.stops;",
    );
    results.push({
      name: q.name,
      role: q.asApp ? "loadline_app" : "superuser",
      withIndex,
      withoutIndex,
    });
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
      "Rows 1 and 2 run as loadline_app with app.company_id set (row security in the plan), row 3 as a superuser; EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON); median Execution Time of the timed runs after warm-up; the GiST indexes are dropped for the without-index runs and recreated afterwards",
    queries: results,
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../results/geo.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${file}`);
  await appPool.end();
  await superPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
