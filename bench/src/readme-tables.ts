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
      role?: string;
      withIndex: { medianMs: number; plan: string };
      withoutIndex: { medianMs: number; plan: string };
    }>;
  }>("geo.json");
  if (!r) return "_Not measured yet: run `pnpm bench:geo`._";
  // Short labels for the README; the full descriptions stay in geo.json.
  const label = (name: string) => {
    if (/^Nearest free trucks/.test(name))
      return "Five nearest free trucks for a load (`ORDER BY location <-> $pickup LIMIT 5`)";
    if (/^Open stops within/.test(name))
      return "Open stops within one mile of a point (`ST_DWithin`)";
    if (/superuser/.test(name)) return "The same radius query with row security bypassed";
    return name;
  };
  const role = (q: { role?: string }) =>
    q.role === "superuser" ? "superuser" : "`loadline_app`, row security on";
  const lines = [
    `| Query | Runs as | With GiST index | Without index |`,
    `| --- | --- | --- | --- |`,
    ...r.queries.map(
      (q) =>
        `| ${label(q.name)} | ${role(q)} | ${q.withIndex.medianMs} ms (${q.withIndex.plan}) | ${q.withoutIndex.medianMs} ms (${q.withoutIndex.plan}) |`,
    ),
    ``,
    `${r.rows.toLocaleString("en-US")} trucks and ${(r.rows * 2).toLocaleString("en-US")} stops in a separate benchmark database, median of 20 runs after warm-up, \`EXPLAIN (ANALYZE, BUFFERS)\`, measured ${r.date.slice(0, 10)} on ${r.machine.cpu}. The first row is the query the assign dialog runs. The second shows that under row security a PostGIS condition cannot use the index, because PostGIS functions are not \`LEAKPROOF\`; the third is the same query without row security, for scale. The app does no radius sweeps: its arrival check reads one stop by id. See [decision 0018](docs/decisions/0018-geospatial-queries-under-row-security.md).`,
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
    documents: number;
    documentAccuracy: number;
    fieldAccuracy: number;
    partial?: boolean;
    cost?: { perDocumentUsd: number };
    latency?: { p50Ms: number };
    fallbacks?: { total: number };
  }>("intake-claude.json");
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows = [
    `| Extractor | Field accuracy | Whole-document accuracy | Cost / doc | Latency p50 |`,
    `| --- | --- | --- | --- | --- |`,
    baseline
      ? `| Regex baseline | ${pct(baseline.fieldAccuracy)} | ${pct(baseline.documentAccuracy)} | $0 | — |`
      : `| Regex baseline | _not measured_ | _not measured_ | $0 | — |`,
    claude
      ? `| Claude (claude-haiku-5-5)${claude.partial ? ` (partial: ${claude.documents} documents)` : ""} | ${pct(claude.fieldAccuracy)} | ${pct(claude.documentAccuracy)} | $${(claude.cost?.perDocumentUsd ?? 0).toFixed(4)} | ${claude.latency?.p50Ms ?? "—"} ms |`
      : `| Claude (claude-haiku-5-5) | not yet measured | not yet measured | not yet measured | not yet measured |`,
  ];
  const claudeNote = claude
    ? `Claude's row: ${claude.fallbacks?.total ?? 0} of ${claude.documents} documents fell back to the baseline; measured ${claude.date.slice(0, 10)}.`
    : "Claude's row is filled in by `pnpm eval:intake --extractor claude --live`, which needs an API key and was not run in this build.";
  if (baseline)
    rows.push(
      ``,
      `${baseline.documents} synthetic rate confirmations, exact match per field after normalisation, measured ${baseline.date.slice(0, 10)}. The baseline's patterns were tuned on these same documents, so its score is an upper bound for these layouts, not a general figure. ${claudeNote}`,
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
