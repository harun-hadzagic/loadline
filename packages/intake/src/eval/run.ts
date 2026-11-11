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
  /**
   * The eight injected documents try to change the rate, the weight, the
   * reference, the stops or the equipment; untouched means the field matched
   * the expected answer, which ignores the injection.
   */
  injection: {
    documents: number;
    allCorrect: number;
    rateUntouched: number;
    untouched: Record<"rateUsd" | "weightLbs" | "loadReference" | "stops" | "equipment", number>;
  };
  failures: Summary["failures"];
  /** True when the run stopped early (cost cap or an error); documents says how many were scored. */
  partial: boolean;
  /** The year assumed for documents that omit it (the fixtures are set in late 2026). */
  defaultYear: number;
  cost?: {
    totalUsd: number;
    perDocumentUsd: number;
    inputTokens: number;
    outputTokens: number;
    pricing: typeof PRICING;
  };
  latency?: { p50Ms: number; p95Ms: number; maxMs: number };
  /** Documents the regex baseline answered for Claude, by reason. */
  fallbacks?: { total: number; validation: number; refusal: number; error: number };
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
  /** Year assumed when a document omits it; the fixtures are written for 2026. */
  defaultYear?: number;
}

/** The fixtures' year: every document without a year means this one. */
export const FIXTURE_YEAR = 2026;

/** Score an extractor over the fixtures. The baseline needs nothing; Claude needs --live and a key. */
export async function runEval(opts: RunOptions): Promise<EvalResult> {
  const fixtures = opts.fixtures ?? loadFixtures();
  const log = opts.log ?? (() => {});
  const defaultYear = opts.defaultYear ?? FIXTURE_YEAR;
  const scores: DocumentScore[] = [];
  const injectionScores: DocumentScore[] = [];
  let rateUntouched = 0;
  const claudeResults: ClaudeResult[] = [];
  let partial = false;
  let stopReason: string | null = null;

  let extract: (
    doc: string,
  ) => Promise<ClaudeResult | { extraction: ReturnType<typeof extractWithBaseline> }>;
  if (opts.extractor === "baseline") {
    extract = async (doc) => ({ extraction: extractWithBaseline(doc, { defaultYear }) });
  } else {
    if (!opts.live)
      throw new Error(
        "The Claude extractor only runs with --live and ANTHROPIC_API_KEY; this build never calls the API.",
      );
    const client = await liveMessagesClient();
    extract = createClaudeExtractor({ client, defaultYear });
  }

  const maxCost = opts.maxCostUsd ?? 1;
  let spent = 0;
  for (const f of fixtures) {
    if (opts.extractor === "claude" && spent >= maxCost) {
      stopReason = `the cost cap of $${maxCost} was reached after ${scores.length} documents`;
      log(`stopping: ${stopReason}`);
      partial = true;
      break;
    }
    let r: Awaited<ReturnType<typeof extract>>;
    try {
      r = await extract(f.document);
    } catch (err) {
      // Whatever was scored so far is still written, marked partial.
      stopReason = `${f.name} threw: ${err instanceof Error ? err.message : String(err)}`;
      log(`stopping: ${stopReason}`);
      partial = true;
      break;
    }
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
  const untouchedFields = ["rateUsd", "weightLbs", "loadReference", "stops", "equipment"] as const;
  const untouched = Object.fromEntries(
    untouchedFields.map((f) => [f, injectionScores.filter((x) => x.fields[f]).length]),
  ) as EvalResult["injection"]["untouched"];
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
      untouched,
    },
    failures: s.failures,
    partial,
    defaultYear,
    note: [
      opts.extractor === "baseline"
        ? "Regex baseline on the 60 synthetic fixtures it was tuned on: an upper bound for these layouts, not a general figure. Exact match after normalising case, whitespace, money and dates."
        : "Claude extractor on the 60 synthetic fixtures with a live key; the prompt was written against these fixtures but never run on them before this eval. Cost from usage and the dated pricing table.",
      `Documents without a year are read as ${defaultYear}.`,
      partial ? `PARTIAL: ${stopReason}.` : null,
    ]
      .filter(Boolean)
      .join(" "),
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
    const by = (reason: ClaudeResult["fallbackReason"]) =>
      claudeResults.filter((r) => r.fallbackReason === reason).length;
    result.fallbacks = {
      total: claudeResults.filter((r) => r.source === "baseline").length,
      validation: by("validation"),
      refusal: by("refusal"),
      error: by("error"),
    };
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
