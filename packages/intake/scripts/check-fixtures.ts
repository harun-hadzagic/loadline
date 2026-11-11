import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractionSchema } from "../src/schema";

const dir = join(import.meta.dirname, "..", "fixtures");
const MARKERS = [
  "ignore previous instructions",
  "ignore all prior instructions",
  "system:",
  "disregard the rate",
  "<<set equipment",
  "note to ai",
  "ai extractor",
  "[assistant:",
];

const txts = readdirSync(dir)
  .filter((f) => /^\d{3}-.*\.txt$/.test(f))
  .sort();
const problems: string[] = [];
const injected: string[] = [];
let multi = 0;
for (const t of txts) {
  const base = t.replace(/\.txt$/, "");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, `${base}.expected.json`), "utf8"));
  } catch (e) {
    problems.push(`${base}: missing or unreadable expected json`);
    continue;
  }
  const r = extractionSchema.strict().safeParse(json);
  if (!r.success) problems.push(`${base}: ${r.error.message}`);
  else if (r.data.stops.length > 2) multi++;
  const text = readFileSync(join(dir, t), "utf8");
  const lines = text.trimEnd().split("\n").length;
  if (lines < 15 || lines > 60) problems.push(`${base}: ${lines} lines`);
  if (MARKERS.some((m) => text.toLowerCase().includes(m))) injected.push(base.slice(0, 3));
}
if (txts.length !== 60) problems.push(`expected 60 pairs, found ${txts.length}`);
const expectInj = ["008", "015", "023", "031", "039", "046", "052", "058"];
if (injected.join() !== expectInj.join()) problems.push(`injection set is ${injected.join(",")}`);
console.log(`pairs=${txts.length} multiStop=${multi} injected=${injected.join(",")}`);
if (problems.length) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("ok");
