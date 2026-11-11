// Regenerates the results tables in README.md from bench/results/*.json,
// between marker comments, so no number in the README is typed by hand.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = path.resolve(here, "../results");
const readme = path.resolve(here, "../../README.md");

function read<T>(name: string): T | null {
  const file = path.join(results, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

function replaceBetween(text: string, marker: string, body: string): string {
  const start = `<!-- bench:${marker}:start -->`;
  const end = `<!-- bench:${marker}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`README is missing the ${marker} markers`);
  return `${text.slice(0, i + start.length)}\n${body.trim()}\n${text.slice(j)}`;
}

export function syncTable(): string {
  const r = read<{
    date: string;
    machine: { cpu: string; cores: number; memoryGb: number };
    config: { clients: number; writes: number; targetWritesPerSecond: number };
    achievedWritesPerSecond: number;
    expectedDeliveries: number;
    deliveries: number;
    lost: number;
    latencyMs: { p50: number; p95: number; p99: number; max: number };
  }>("sync-latency.json");
  if (!r) return "_Not measured yet: run `pnpm bench:sync`._";
  return [
    `| Clients | Writes | Rate | p50 | p95 | p99 | max | Lost |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    `| ${r.config.clients} | ${r.config.writes} | ${r.achievedWritesPerSecond}/s | ${r.latencyMs.p50} ms | ${r.latencyMs.p95} ms | ${r.latencyMs.p99} ms | ${r.latencyMs.max} ms | ${r.lost} of ${r.expectedDeliveries} |`,
    ``,
    `Measured ${r.date.slice(0, 10)} on ${r.machine.cpu} (${r.machine.cores} cores, ${r.machine.memoryGb} GB), one machine, one clock: from the write's HTTP response to each client's SSE receipt.`,
  ].join("\n");
}

export function geoTable(): string {
  const r = read<{
    date: string;
    machine: { cpu: string };
    rows: number;
    queries: Array<{
      name: string;
      withIndex: { medianMs: number; plan: string };
      withoutIndex: { medianMs: number; plan: string };
    }>;
  }>("geo.json");
  if (!r) return "_Not measured yet: run `pnpm bench:geo`._";
  const lines = [
    `| Query | With GiST index | Without index |`,
    `| --- | --- | --- |`,
    ...r.queries.map(
      (q) =>
        `| ${q.name} | ${q.withIndex.medianMs} ms (${q.withIndex.plan}) | ${q.withoutIndex.medianMs} ms (${q.withoutIndex.plan}) |`,
    ),
    ``,
    `${r.rows.toLocaleString("en-US")} trucks and ${r.rows.toLocaleString("en-US")} open stops, median of 20 runs after warm-up, \`EXPLAIN (ANALYZE, BUFFERS)\`, measured ${r.date.slice(0, 10)} on ${r.machine.cpu}.`,
  ];
  return lines.join("\n");
}

export function intakeTable(): string {
  const baseline = read<{
    date: string;
    extractor: string;
    documents: number;
    documentAccuracy: number;
    fieldAccuracy: number;
    fields: Record<string, { accuracy: number }>;
  }>("intake-baseline.json");
  const claude = read<{
    date: string;
    documentAccuracy: number;
    fieldAccuracy: number;
    costUsdPerDocument: number;
    latencyMsP50: number;
  }>("intake-claude.json");
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows = [
    `| Extractor | Field accuracy | Whole-document accuracy | Cost / doc | Latency p50 |`,
    `| --- | --- | --- | --- | --- |`,
    baseline
      ? `| Regex baseline | ${pct(baseline.fieldAccuracy)} | ${pct(baseline.documentAccuracy)} | $0 | — |`
      : `| Regex baseline | _not measured_ | _not measured_ | $0 | — |`,
    claude
      ? `| Claude (claude-haiku-5-5) | ${pct(claude.fieldAccuracy)} | ${pct(claude.documentAccuracy)} | $${claude.costUsdPerDocument.toFixed(4)} | ${claude.latencyMsP50} ms |`
      : `| Claude (claude-haiku-5-5) | not yet measured | not yet measured | not yet measured | not yet measured |`,
  ];
  if (baseline)
    rows.push(
      ``,
      `${baseline.documents} synthetic rate confirmations, measured ${baseline.date.slice(0, 10)}. Claude's row is filled in by \`pnpm eval:intake --extractor claude --live\`, which needs an API key and was not run in this build.`,
    );
  return rows.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let text = readFileSync(readme, "utf8");
  text = replaceBetween(text, "sync-latency", syncTable());
  text = replaceBetween(text, "geo", geoTable());
  text = replaceBetween(text, "intake", intakeTable());
  writeFileSync(readme, text);
  console.log("README tables regenerated");
}
