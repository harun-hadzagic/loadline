// Records the README GIF: two browser windows side by side, one dispatcher
// assigns a load and the other's board updates, then the map with a truck
// moving. Playwright records one video per browser context; ffmpeg stacks
// them and converts to docs/media/two-browsers.gif (under 45 s, under 8 MB).
//
//   pnpm gif            (needs the web server from the e2e config and ffmpeg on PATH)
//   E2E_BASE_URL=http://localhost:3000 SIMULATOR_TOKEN=... pnpm gif
//                       (against the Compose stack: production build, no dev overlay)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { baseURL, testEnv } from "../playwright.config.ts";
import { createOpenLoad, dragToAssigned, waitForLive } from "../tests/board-helpers.ts";
import { signIn, USERS } from "../tests/helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const videoDir = path.resolve(here, "../video");
const out = path.resolve(here, "../../docs/media/two-browsers.gif");
const SIZE = { width: 1100, height: 720 };
const MAX_SECONDS = 44;
const MAX_BYTES = 8 * 1024 * 1024;

async function main(): Promise<void> {
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });
  mkdirSync(path.dirname(out), { recursive: true });
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({
    baseURL,
    viewport: SIZE,
    recordVideo: { dir: path.join(videoDir, "a"), size: SIZE },
  });
  const ctxB = await browser.newContext({
    baseURL,
    viewport: SIZE,
    recordVideo: { dir: path.join(videoDir, "b"), size: SIZE },
  });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const started = Date.now();
  const pause = (ms: number) => Promise.all([a.waitForTimeout(ms), b.waitForTimeout(ms)]);

  await signIn(a, USERS.acmeDispatcher1);
  await signIn(b, USERS.acmeDispatcher2);
  await Promise.all([a.goto("/board"), b.goto("/board")]);
  await Promise.all([waitForLive(a), waitForLive(b)]);
  const load = await createOpenLoad(a, "gif", 24 * 3);
  await expect(b.getByTestId(`card-${load.reference}`)).toBeVisible();
  await pause(2_000);

  // Scene 1: dispatcher A drags the new load to Assigned; dispatcher B's board follows.
  await dragToAssigned(a, a.getByTestId(`card-${load.reference}`));
  await pause(1_200);
  await a.getByTestId("assign-confirm").click();
  await expect(
    b.getByTestId("column-assigned").getByTestId(`card-${load.reference}`),
  ).toBeVisible();
  await pause(3_000);

  // Scene 2: the map, with a truck driving toward its next stop.
  await Promise.all([a.goto("/map"), b.goto("/map")]);
  await expect(a.getByTestId("truck-map")).toBeVisible();
  await pause(2_000);
  const positions = (await (await a.request.get("/api/positions")).json()) as {
    positions: Array<{
      truckId: string;
      unitNumber: string;
      lat: number;
      lng: number;
      loadStatus: string | null;
    }>;
  };
  const moving =
    positions.positions.find((p) => p.loadStatus === "in_transit") ?? positions.positions[0];
  if (moving) {
    // Drive it a little north-east, one report per second, as the simulator would.
    for (let i = 1; i <= 10; i++) {
      await a.request.post("/api/positions", {
        headers: {
          authorization: `Bearer ${process.env.SIMULATOR_TOKEN ?? testEnv().SIMULATOR_TOKEN}`,
        },
        data: {
          companyId: "01930000-0000-7000-8000-00000000a001",
          positions: [
            {
              truckId: moving.truckId,
              lat: moving.lat + i * 0.03,
              lng: moving.lng + i * 0.03,
              heading: 45,
              speedMph: 55,
            },
          ],
        },
      });
      await pause(900);
    }
  }
  await pause(1_500);
  const seconds = (Date.now() - started) / 1000;
  await ctxA.close();
  await ctxB.close();
  await browser.close();

  const video = (dir: string) =>
    path.join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")) as string);
  const va = video(path.join(videoDir, "a"));
  const vb = video(path.join(videoDir, "b"));
  // Sign-in frames are trimmed; the recording starts a little before scene 1.
  const trim = Math.max(0, seconds - MAX_SECONDS);
  for (const [fps, width] of [
    [10, 1400],
    [8, 1200],
    [6, 1000],
  ] as const) {
    const filter = `[0:v][1:v]hstack=inputs=2,fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`;
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      trim.toFixed(1),
      "-i",
      va,
      "-ss",
      trim.toFixed(1),
      "-i",
      vb,
      "-t",
      String(MAX_SECONDS),
      "-filter_complex",
      filter,
      out,
    ]);
    const bytes = statSync(out).size;
    console.log(`fps ${fps}, width ${width}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    if (bytes <= MAX_BYTES) break;
  }
  const bytes = statSync(out).size;
  if (bytes > MAX_BYTES) throw new Error(`GIF is ${bytes} bytes, over the 8 MB limit`);
  console.log(
    `wrote ${out} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${Math.min(seconds, MAX_SECONDS).toFixed(0)} s)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
