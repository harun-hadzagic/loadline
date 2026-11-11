// pnpm eval:intake [--extractor baseline|claude] [--live]
//
// Scores an extractor on the 60 fixtures and writes bench/results/intake-<extractor>.json.
// The baseline runs anywhere. The Claude extractor refuses to run without
// --live and ANTHROPIC_API_KEY, prints an estimate first, and stops at $1.
import { loadFixtures } from "../fixtures.ts";
import { estimateLiveCostUsd, runEval, writeResult } from "./run.ts";

const args = process.argv.slice(2);
const extractor = (
  args.includes("--extractor") ? args[args.indexOf("--extractor") + 1] : "baseline"
) as "baseline" | "claude";
const live = args.includes("--live");
const HARD_CAP_USD = 1;

if (extractor !== "baseline" && extractor !== "claude") {
  console.error("usage: pnpm eval:intake [--extractor baseline|claude] [--live]");
  process.exit(2);
}

const fixtures = loadFixtures();

if (extractor === "claude") {
  if (!live) {
    console.error("The Claude extractor only runs with --live. This build makes no API calls.");
    process.exit(2);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Export it and run again with --live.");
    process.exit(2);
  }
  const estimate = estimateLiveCostUsd(fixtures);
  console.log(
    `Estimated cost for ${fixtures.length} documents: about $${estimate.toFixed(4)} (hard cap $${HARD_CAP_USD}).`,
  );
  if (estimate > HARD_CAP_USD) {
    console.error("The estimate exceeds the hard cap; refusing to run.");
    process.exit(2);
  }
}

const result = await runEval({
  extractor,
  live,
  maxCostUsd: HARD_CAP_USD,
  fixtures,
  log: (m) => console.log(m),
});
const file = writeResult(result);
console.log("");
console.log(
  `${result.extractor}: whole-document ${(result.documentAccuracy * 100).toFixed(1)}%, field ${(result.fieldAccuracy * 100).toFixed(1)}% over ${result.documents} documents`,
);
for (const [field, v] of Object.entries(result.fields))
  console.log(`  ${field.padEnd(16)} ${(v.accuracy * 100).toFixed(1)}%`);
console.log(
  `  injection: ${result.injection.allCorrect}/${result.injection.documents} fully correct, rate untouched in ${result.injection.rateUntouched}`,
);
if (result.cost)
  console.log(
    `  cost $${result.cost.totalUsd.toFixed(4)} ($${result.cost.perDocumentUsd.toFixed(5)}/doc), latency p50 ${result.latency?.p50Ms} ms`,
  );
console.log(`wrote ${file}`);
