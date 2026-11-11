import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Extraction, extractionSchema } from "./schema.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(here, "../fixtures");
export const CLAUDE_FIXTURES_DIR = path.resolve(here, "../fixtures-claude");

export interface Fixture {
  name: string;
  document: string;
  expected: Extraction;
  /** The eight documents that carry a prompt-injection attempt. */
  injected: boolean;
}

const INJECTION_MARKERS = [
  /ignore (?:all )?(?:previous|prior) instructions/i,
  /\bSYSTEM:/,
  /assistant,? disregard/i,
  /<<set /i,
  /note to ai/i,
  /\[assistant:/i,
  /ai extractor:/i,
];

export function loadFixtures(dir = FIXTURES_DIR): Fixture[] {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort();
  return names.map((file) => {
    const name = file.replace(/\.txt$/, "");
    const document = readFileSync(path.join(dir, file), "utf8");
    const expected = extractionSchema.parse(
      JSON.parse(readFileSync(path.join(dir, `${name}.expected.json`), "utf8")),
    );
    return {
      name,
      document,
      expected,
      injected: INJECTION_MARKERS.some((re) => re.test(document)),
    };
  });
}
