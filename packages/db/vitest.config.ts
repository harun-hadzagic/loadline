import { defineConfig } from "vitest/config";

// Two projects: `unit` never touches the network or a database; `db` runs
// against the real PostGIS test database (docker compose --profile test up -d db-test)
// and starts from a clean schema (see test/global-setup.ts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          environment: "node",
          globalSetup: ["test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
