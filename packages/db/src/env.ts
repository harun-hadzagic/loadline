import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

let loaded = false;

/** Find the repository root by walking up to pnpm-workspace.yaml. */
export function repoRoot(from = process.cwd()): string {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/** Load the repo-root .env once (Node's built-in loader; no dependency). Existing variables win. */
export function loadDotEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = path.join(repoRoot(), ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // Malformed .env: fall through and let the schema below report what is missing.
  }
}

const urlSchema = z.string().url().startsWith("postgres");

const dbEnvSchema = z.object({
  DATABASE_URL_SUPER: urlSchema.optional(),
  DATABASE_URL_OWNER: urlSchema.optional(),
  DATABASE_URL_APP: urlSchema.optional(),
  DATABASE_URL_AUTH: urlSchema.optional(),
  DATABASE_URL_STREAM: urlSchema.optional(),
  LOADLINE_OWNER_PASSWORD: z.string().min(1).optional(),
  LOADLINE_APP_PASSWORD: z.string().min(1).optional(),
  LOADLINE_AUTH_PASSWORD: z.string().min(1).optional(),
  LOADLINE_STREAM_PASSWORD: z.string().min(1).optional(),
  TEST_DATABASE_URL_SUPER: urlSchema.optional(),
  DEMO_PASSWORD: z.string().min(1).default("loadline-demo"),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

export function dbEnv(): DbEnv {
  loadDotEnv();
  return dbEnvSchema.parse(process.env);
}

/** Read one required variable with a clear error naming it. */
export function requireEnv<K extends keyof DbEnv>(key: K): NonNullable<DbEnv[K]> {
  const value = dbEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`${key} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value as NonNullable<DbEnv[K]>;
}

/** Replace the user and password of a postgres URL. Used to derive role URLs for tests. */
export function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}
