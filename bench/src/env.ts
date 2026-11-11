import { cpus, platform, release, totalmem } from "node:os";
import { loadDotEnv } from "@loadline/db";

loadDotEnv();

export const BASE_URL = process.env.BENCH_BASE_URL ?? "http://localhost:3000";
export const BENCH_EMAIL = process.env.BENCH_EMAIL ?? "dispatch1@acme-freight.example";
export const BENCH_PASSWORD =
  process.env.BENCH_PASSWORD ?? process.env.DEMO_PASSWORD ?? "loadline-demo";

export function machineInfo() {
  const cpu = cpus()[0];
  return {
    platform: `${platform()} ${release()}`,
    arch: process.arch,
    cpu: cpu?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
  };
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

/** Sign in through Better Auth and return the Cookie header value. */
export async function signInCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email: BENCH_EMAIL, password: BENCH_PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0] as string);
  if (!cookies.length) throw new Error("sign-in returned no cookie");
  return cookies.join("; ");
}
