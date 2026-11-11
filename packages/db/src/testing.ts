// Helpers for database tests. Only test code imports this.
import { bootstrap, dropAll } from "./bootstrap.ts";
import { dbEnv, withCredentials } from "./env.ts";
import { migrate } from "./migrate.ts";
import { seed } from "./seed/index.ts";

export interface TestUrls {
  superuser: string;
  owner: string;
  app: string;
  auth: string;
  stream: string;
}

export const TEST_PASSWORDS = {
  owner: "owner-test",
  app: "app-test",
  auth: "auth-test",
  stream: "stream-test",
} as const;

/** Connection strings for the test database, one per role. */
export function testUrls(): TestUrls {
  const env = dbEnv();
  const superuser =
    env.TEST_DATABASE_URL_SUPER ??
    "postgres://postgres:postgres-local@localhost:5433/loadline_test";
  return {
    superuser,
    owner: withCredentials(superuser, "loadline_owner", TEST_PASSWORDS.owner),
    app: withCredentials(superuser, "loadline_app", TEST_PASSWORDS.app),
    auth: withCredentials(superuser, "loadline_auth", TEST_PASSWORDS.auth),
    stream: withCredentials(superuser, "loadline_stream", TEST_PASSWORDS.stream),
  };
}

/** Drop everything, bootstrap, migrate and (optionally) seed. Every db test run starts here. */
export async function resetTestDatabase(options: { seed?: boolean } = {}): Promise<TestUrls> {
  const urls = testUrls();
  await dropAll(urls.superuser);
  await bootstrap(urls.superuser, TEST_PASSWORDS);
  await migrate(urls.owner);
  if (options.seed) await seed({ appUrl: urls.app, ownerUrl: urls.owner });
  return urls;
}
