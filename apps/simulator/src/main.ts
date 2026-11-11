// The position simulator. Every tick it asks the app for each demo company's
// trucks and their next stops, moves the ones with an active assignment along
// the great circle toward that stop at 55 mph (sped up by a factor, default 60,
// so one real second is one simulated minute), jitters the idle ones around
// their home city, and posts the batch to POST /api/positions with the service
// token. Arrival detection happens in the database on that write.
import { DEMO_COMPANIES, loadDotEnv } from "@loadline/db";
import { z } from "zod";
import { bearing, distanceMiles, jitterNear, type Point, stepToward } from "./geo.ts";

loadDotEnv();

const env = z
  .object({
    SIMULATOR_TARGET_URL: z.string().url().default("http://localhost:3000"),
    SIMULATOR_TOKEN: z.string().min(8),
    SIMULATOR_SPEED_FACTOR: z.coerce.number().positive().default(60),
    SIMULATOR_INTERVAL_MS: z.coerce.number().int().min(250).default(3000),
    SIMULATOR_COMPANIES: z.string().optional(),
  })
  .parse(process.env);

const SPEED_MPH = 55;
const IDLE_RADIUS_MILES = 0.6;
const companies =
  env.SIMULATOR_COMPANIES?.split(",").filter(Boolean) ?? DEMO_COMPANIES.map((c) => c.id);

const truckSchema = z.object({
  truckId: z.string(),
  unitNumber: z.string(),
  home: z.object({ lat: z.number(), lng: z.number() }),
  position: z.object({ lat: z.number(), lng: z.number(), recordedAt: z.string() }).nullable(),
  target: z
    .object({
      stopId: z.string(),
      lat: z.number(),
      lng: z.number(),
      seq: z.number(),
      loadReference: z.string(),
    })
    .nullable(),
});
const stateSchema = z.object({ trucks: z.array(truckSchema) });

const headers = {
  authorization: `Bearer ${env.SIMULATOR_TOKEN}`,
  "content-type": "application/json",
};
const log = (m: string) => console.log(`[sim ${new Date().toISOString().slice(11, 19)}] ${m}`);

async function tick(companyId: string): Promise<void> {
  const res = await fetch(`${env.SIMULATOR_TARGET_URL}/api/simulator/state?company=${companyId}`, {
    headers,
  });
  if (!res.ok) throw new Error(`state ${companyId.slice(0, 8)}: ${res.status} ${await res.text()}`);
  const { trucks } = stateSchema.parse(await res.json());
  const simulatedHours = (env.SIMULATOR_INTERVAL_MS / 3_600_000) * env.SIMULATOR_SPEED_FACTOR;
  const now = new Date().toISOString();
  const positions = trucks.map((t) => {
    const current: Point = t.position ?? t.home;
    if (t.target) {
      const next = stepToward(current, t.target, SPEED_MPH * simulatedHours);
      const arrived = distanceMiles(next, t.target) < 0.01;
      return {
        truckId: t.truckId,
        lat: next.lat,
        lng: next.lng,
        heading: bearing(current, t.target),
        speedMph: arrived ? 0 : SPEED_MPH,
        recordedAt: now,
      };
    }
    const next = jitterNear(t.home, current, IDLE_RADIUS_MILES);
    return {
      truckId: t.truckId,
      lat: next.lat,
      lng: next.lng,
      heading: null,
      speedMph: 0,
      recordedAt: now,
    };
  });
  if (!positions.length) return;
  const post = await fetch(`${env.SIMULATOR_TARGET_URL}/api/positions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ companyId, positions }),
  });
  if (!post.ok)
    throw new Error(`positions ${companyId.slice(0, 8)}: ${post.status} ${await post.text()}`);
  const result = (await post.json()) as { written: number; arrivals: number };
  const moving = trucks.filter((t) => t.target).length;
  log(
    `${companyId.slice(0, 8)}: ${result.written} positions, ${moving} moving${result.arrivals ? `, ${result.arrivals} arrived` : ""}`,
  );
}

async function loop(): Promise<void> {
  log(
    `target ${env.SIMULATOR_TARGET_URL}, ${companies.length} companies, every ${env.SIMULATOR_INTERVAL_MS} ms, x${env.SIMULATOR_SPEED_FACTOR}`,
  );
  for (;;) {
    const started = Date.now();
    for (const c of companies) {
      try {
        await tick(c);
      } catch (err) {
        log(`error: ${(err as Error).message}`);
      }
    }
    const wait = Math.max(0, env.SIMULATOR_INTERVAL_MS - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
