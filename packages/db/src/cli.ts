import { bootstrap } from "./bootstrap.ts";
import { requireEnv } from "./env.ts";
import { migrate } from "./migrate.ts";
import { seed } from "./seed/index.ts";

const log = (m: string) => console.log(`[db] ${m}`);

async function runBootstrap() {
  await bootstrap(
    requireEnv("DATABASE_URL_SUPER"),
    {
      owner: requireEnv("LOADLINE_OWNER_PASSWORD"),
      app: requireEnv("LOADLINE_APP_PASSWORD"),
      auth: requireEnv("LOADLINE_AUTH_PASSWORD"),
      stream: requireEnv("LOADLINE_STREAM_PASSWORD"),
    },
    log,
  );
}

async function runMigrate() {
  const r = await migrate(requireEnv("DATABASE_URL_OWNER"), log);
  log(`applied ${r.applied.length}, already applied ${r.skipped.length}`);
}

async function runSeed() {
  const r = await seed(
    {
      appUrl: requireEnv("DATABASE_URL_APP"),
      ownerUrl: requireEnv("DATABASE_URL_OWNER"),
      // The demo logins: Better Auth rows through loadline_auth, password from DEMO_PASSWORD.
      authUrl: requireEnv("DATABASE_URL_AUTH"),
      demoPassword: requireEnv("DEMO_PASSWORD"),
    },
    log,
  );
  log(`seeded ${r.companies.length} companies`);
}

const command = process.argv[2];
try {
  switch (command) {
    case "bootstrap":
      await runBootstrap();
      break;
    case "migrate":
      await runMigrate();
      break;
    case "seed":
      await runSeed();
      break;
    case "setup":
      await runBootstrap();
      await runMigrate();
      await runSeed();
      break;
    default:
      console.error("usage: cli.ts <bootstrap|migrate|seed|setup>");
      process.exit(2);
  }
} catch (err) {
  console.error(`[db] ${command} failed:`, err instanceof Error ? err.message : err);
  if (err instanceof Error && err.cause) console.error(err.cause);
  process.exit(1);
}
