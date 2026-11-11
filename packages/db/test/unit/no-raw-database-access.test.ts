import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../src/env.ts";

// Rule 7: every query in the app runs inside withTenant. Only packages/db may
// import the driver or open a pool; Biome's noRestrictedImports says the same
// at lint time, and this test says it at test time.
const FORBIDDEN = [
  /from\s+["']pg["']/,
  /from\s+["']pg-pool["']/,
  /from\s+["']postgres["']/,
  /from\s+["']drizzle-orm\/node-postgres["']/,
  /from\s+["']drizzle-orm\/postgres-js["']/,
  /require\(\s*["']pg["']\s*\)/,
  /new\s+Pool\s*\(/,
  /new\s+Client\s*\(/,
];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
  ".git",
]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

describe("only packages/db touches the database driver", () => {
  it("no other package imports pg, postgres or a drizzle driver, or constructs a Pool/Client", () => {
    const root = repoRoot();
    const roots = ["apps", "packages", "bench", "e2e"]
      .map((d) => path.join(root, d))
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
    const offenders: string[] = [];
    for (const r of roots) {
      for (const file of walk(r)) {
        if (file.startsWith(path.join(root, "packages", "db") + path.sep)) continue;
        const text = readFileSync(file, "utf8");
        for (const re of FORBIDDEN)
          if (re.test(text)) offenders.push(`${path.relative(root, file)}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
