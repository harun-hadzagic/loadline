import { getTableColumns, getTableName } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "../../src/schema/index.ts";
import { closePools, superPool } from "./helpers.ts";

afterAll(closePools);

// The SQL migrations are the source of truth; the Drizzle schema is a mirror
// for typed queries. This keeps the two from drifting apart.
describe("the Drizzle schema mirrors the migrated tables", () => {
  const tables = [
    schema.cities,
    schema.loadTransitions,
    schema.companies,
    schema.drivers,
    schema.trucks,
    schema.loads,
    schema.stops,
    schema.assignments,
    schema.truckPositions,
    schema.outbox,
  ];
  for (const table of tables) {
    it(getTableName(table), async () => {
      const r = await superPool().query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = $1 ORDER BY 1",
        [getTableName(table)],
      );
      const dbColumns = r.rows.map((x) => x.column_name).sort();
      const tsColumns = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .sort();
      expect(tsColumns).toEqual(dbColumns);
    });
  }
});
