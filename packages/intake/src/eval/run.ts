import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWithBaseline } from "../baseline.ts";
import {
  type ClaudeResult,
  createClaudeExtractor,
  liveMessagesClient,
  PRICING,
} from "../claude.ts";
import { type Fixture, loadFixtures } from "../fixtures.ts";
import { type DocumentScore, FIELDS, type Summary, scoreDocument, summarize } from "./score.ts";

export type ExtractorName = "baseline" | "claude";

export interface EvalResult {
  benchmark: "intake";
  extractor: ExtractorName;
  model: string | null;
  date: string;
  machine: { cpu: string; node: string };
  documents: number;
  documentAccuracy: number;
  fieldAccuracy: number;
  fields: Summary["fields"];
  stopFields: Summary["stopFields"];
  injection: { documents: number; allCorrect: number; rateUntouched: number };
  failures: Summary["failures"];
  cost?: {
    totalUsd: number;
    perDocumentUsd: number;
    inputTokens: number;
    outputTokens: number;
    pricing: typeof PRICING;
  };
  latency?: { p50Ms: number; p95Ms: number; maxMs: number };
  fallbacks?: number;
  note: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.resolve(here, "../../../../bench/results");

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export interface RunOptions {
  extractor: ExtractorName;
  live?: boolean;
  /** Hard cap for the live run; the run stops before exceeding it. */
  maxCostUsd?: number;
  fixtures?: Fixture[];
  log?: (m: string) => void;
}

/** Score an extractor over the fixtures. The baseline needs nothing; Claude needs --live and a key. */
export async function runEval(opts: RunOptions): Promise<EvalResult> {
  const fixtures = opts.fixtures ?? loadFixtures();
  const log = opts.log ?? (() => {});
  const scores: DocumentScore[] = [];
  const injectionScores: DocumentScore[] = [];
  let rateUntouched = 0;
  const claudeResults: ClaudeResult[] = [];

  let extract: (
    doc: string,
  ) => Promise<ClaudeResult | { extraction: ReturnType<typeof extractWithBaseline> }>;
  if (opts.extractor === "baseline") {
    extract = async (doc) => ({ extraction: extractWithBaseline(doc) });
  } else {
    if (!opts.live)
      throw new Error(
        "The Claude extractor only runs with --live and ANTHROPIC_API_KEY; this build never calls the API.",
      );
    const client = await liveMessagesClient();
    const claude = createClaudeExtractor({ client });
    extract = claude;
  }

  const maxCost = opts.maxCostUsd ?? 1;
  let spent = 0;
  for (const f of fixtures) {
    if (opts.extractor === "claude" && spent >= maxCost) {
      log(`stopping: cost cap of $${maxCost} reached after ${scores.length} documents`);
      break;
    }
    const r = await extract(f.document);
    if ("costUsd" in r) {
      claudeResults.push(r);
      spent += r.costUsd;
    }
    const score = scoreDocument(f.name, r.extraction, f.expected);
    scores.push(score);
    if (f.injected) {
      injectionScores.push(score);
      if (score.fields.rateUsd) rateUntouched++;
    }
    log(
      `${score.allCorrect ? "ok  " : "miss"} ${f.name}${score.allCorrect ? "" : `  (${FIELDS.filter((x) => !score.fields[x]).join(", ")})`}`,
    );
  }

  const s = summarize(scores);
  const result: EvalResult = {
    benchmark: "intake",
    extractor: opts.extractor,
    model: opts.extractor === "claude" ? PRICING.model : null,
    date: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model ?? "unknown", node: process.version },
    documents: s.documents,
    documentAccuracy: s.documentAccuracy,
    fieldAccuracy: s.fieldAccuracy,
    fields: s.fields,
    stopFields: s.stopFields,
    injection: {
      documents: injectionScores.length,
      allCorrect: injectionScores.filter((x) => x.allCorrect).length,
      rateUntouched,
    },
    failures: s.failures,
    note:
      opts.extractor === "baseline"
        ? "Regex baseline on the 60 synthetic fixtures; exact match after normalising case, whitespace, money and dates. Synthetic documents only."
        : "Claude extractor on the 60 synthetic fixtures with a live key; cost from usage and the dated pricing table.",
  };
  if (claudeResults.length) {
    const lat = claudeResults.map((r) => r.latencyMs).sort((a, b) => a - b);
    const inputTokens = claudeResults.reduce((a, r) => a + r.usage.inputTokens, 0);
    const outputTokens = claudeResults.reduce((a, r) => a + r.usage.outputTokens, 0);
    result.cost = {
      totalUsd: spent,
      perDocumentUsd: spent / claudeResults.length,
      inputTokens,
      outputTokens,
      pricing: PRICING,
    };
    result.latency = {
      p50Ms: percentile(lat, 50),
      p95Ms: percentile(lat, 95),
      maxMs: lat[lat.length - 1] ?? 0,
    };
    result.fallbacks = claudeResults.filter((r) => r.source === "baseline").length;
  }
  return result;
}

export function writeResult(result: EvalResult, dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `intake-${result.extractor}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

/** Rough token estimate for the pre-run cost estimate (about 4 characters per token). */
export function estimateLiveCostUsd(fixtures: Fixture[]): number {
  const inputChars = fixtures.reduce((a, f) => a + f.document.length + 2_500, 0); // document + prompt + schema
  const inputTokens = inputChars / 4;
  const outputTokens = fixtures.length * 400;
  return (
    (inputTokens * PRICING.inputPerMillion + outputTokens * PRICING.outputPerMillion) / 1_000_000
  );
}
