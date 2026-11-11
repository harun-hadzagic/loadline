// Seeds Better Auth's tables for the demo users: one user and one
// credential account per person, one organization per company, one
// membership per person. Runs as loadline_auth with search_path = auth.
import { hashPassword } from "better-auth/crypto";
import pg from "pg";
import { DEMO_COMPANIES } from "./data.ts";

export interface AuthSeedOptions {
  authUrl: string;
  /** Every demo user gets this password. Local use only. */
  password: string;
}

export async function seedAuth(
  opts: AuthSeedOptions,
  log: (m: string) => void = () => {},
): Promise<number> {
  const client = new pg.Client({
    connectionString: opts.authUrl,
    options: "-c search_path=auth",
    application_name: "loadline-seed-auth",
  });
  await client.connect();
  let created = 0;
  try {
    // One hash for everyone: the demo password is shared and documented.
    const hash = await hashPassword(opts.password);
    await client.query("BEGIN");
    for (const company of DEMO_COMPANIES) {
      await client.query(
        `INSERT INTO "organization" ("id", "name", "slug", "createdAt")
         VALUES ($1, $2, $3, now()) ON CONFLICT ("id") DO NOTHING`,
        [company.orgId, company.name, company.slug],
      );
      for (const u of company.users) {
        const r = await client.query(
          `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, true, now(), now()) ON CONFLICT ("id") DO NOTHING`,
          [u.id, u.name, u.email],
        );
        if (r.rowCount === 1) {
          created++;
          await client.query(
            `INSERT INTO "account" ("accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
             VALUES ($1::text, 'credential', $1::uuid, $2, now(), now())`,
            [u.id, hash],
          );
        }
        await client.query(
          `INSERT INTO "member" ("organizationId", "userId", "role", "createdAt")
           VALUES ($1, $2, $3, now()) ON CONFLICT ("organizationId", "userId") DO NOTHING`,
          [company.orgId, u.id, u.role],
        );
      }
      log(`${company.name}: ${company.users.length} demo logins`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return created;
}
