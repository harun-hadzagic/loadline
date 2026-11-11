import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveMessagesClient } from "../src/claude.ts";

// This build makes no API call to Anthropic: no key is set, the SDK is only
// imported lazily behind the --live flag, and nothing in the package reaches
// for the network on its own.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no network, no key", () => {
  it("ANTHROPIC_API_KEY is not set while the tests run", () => {
    expect(process.env.ANTHROPIC_API_KEY ?? "").toBe("");
  });

  it("the live client refuses to exist without a key", async () => {
    await expect(liveMessagesClient()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("only claude.ts touches the SDK, and only through a dynamic import; nothing calls fetch", () => {
    const files = walk(path.join(root, "src")).concat(walk(path.join(root, "test")));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const rel = path.relative(root, file);
      if (/^import\s[^;]*["']@anthropic-ai\/sdk["']/m.test(text)) {
        expect.fail(`${rel} imports the SDK statically`);
      }
      if (
        /@anthropic-ai\/sdk/.test(text) &&
        !rel.endsWith("src/claude.ts") &&
        !rel.endsWith("test/no-network.test.ts")
      ) {
        expect.fail(`${rel} references the SDK`);
      }
      expect(/\bfetch\s*\(/.test(text), `${rel} calls fetch`).toBe(false);
    }
  });
});
