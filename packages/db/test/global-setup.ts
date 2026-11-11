import { resetTestDatabase } from "../src/testing.ts";

// Every db test run starts from a dropped and freshly migrated, seeded database.
export default async function setup(): Promise<void> {
  await resetTestDatabase({ seed: true });
}
