import { defineConfig, devices } from "@playwright/test";

// The suite runs against a web server started by Playwright, pointed at the
// tmpfs test database (docker compose --profile test up -d db-test). The
// global setup drops, migrates and seeds that database first.
const port = Number(process.env.E2E_PORT ?? 3131);
export const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: process.env.E2E_VIDEO ? "on" : "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /driver\.spec\.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /driver\.spec\.ts/ },
  ],
  webServer: {
    command: `pnpm --filter @loadline/web exec next dev --port ${port}`,
    url: `${baseURL}/sign-in`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...testEnv(),
    },
  },
});

export function testEnv(): Record<string, string> {
  // Mirrors packages/db/src/testing.ts without importing it here (Playwright
  // config files load before the workspace alias is available).
  const superUrl =
    process.env.TEST_DATABASE_URL_SUPER ??
    "postgres://postgres:postgres-local@localhost:5433/loadline_test";
  const u = new URL(superUrl);
  const withCreds = (user: string, pass: string) => {
    const x = new URL(u.toString());
    x.username = user;
    x.password = pass;
    return x.toString();
  };
  return {
    DATABASE_URL_APP: withCreds("loadline_app", "app-test"),
    DATABASE_URL_AUTH: withCreds("loadline_auth", "auth-test"),
    DATABASE_URL_STREAM: withCreds("loadline_stream", "stream-test"),
    BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789",
    BETTER_AUTH_URL: baseURL,
    NEXT_PUBLIC_APP_URL: baseURL,
    SIMULATOR_TOKEN: "e2e-simulator-token",
    // The suite signs in far more than 20 times in 10 minutes from one address.
    SIGN_IN_RATE_LIMIT: "1000",
    NODE_ENV: "development",
  };
}
