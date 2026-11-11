// Prints the SQL Better Auth needs for its tables, so it can be reviewed and
// committed as a migration (packages/db/migrations/0005_auth_schema.sql).
// Usage: pnpm --filter @loadline/web exec tsx scripts/generate-auth-schema.ts
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/lib/auth";

const { compileMigrations } = await getMigrations(auth.options);
const sql = await compileMigrations();
process.stdout.write(sql);
process.exit(0);
