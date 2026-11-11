import { expect, test } from "@playwright/test";
import { testEnv } from "../playwright.config.ts";
import { signIn, USERS } from "./helpers.ts";

// The token the web server under test was started with (the global setup loads
// the repo .env into this process, so process.env would be the wrong one).
const TOKEN = testEnv().SIMULATOR_TOKEN as string;

test("the map shows the company's trucks and moves one when a position is posted", async ({
  page,
}) => {
  await signIn(page, USERS.acmeDispatcher1);
  await page.goto("/map");
  await expect(page.getByTestId("truck-map")).toBeVisible();
  const markers = page.locator('[data-testid^="truck-marker-"]');
  await expect.poll(() => markers.count()).toBeGreaterThanOrEqual(10);
  // Only Acme's trucks: unit numbers 101–110 exist in both companies, so count is the tell.
  await expect.poll(() => markers.count()).toBeLessThanOrEqual(12);

  const marker = page.getByTestId("truck-marker-110");
  const before = await marker.getAttribute("data-lng");
  // The company id is in the state the simulator would read; post one report as the simulator does.
  const state = await page.request.get("/api/loads");
  expect(state.ok()).toBeTruthy();
  const trucksRes = await page.request.get("/api/positions");
  const { positions } = (await trucksRes.json()) as {
    positions: Array<{ truckId: string; unitNumber: string; lat: number; lng: number }>;
  };
  const t110 = positions.find((p) => p.unitNumber === "110")!;
  const post = await page.request.post("/api/positions", {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: {
      companyId: "01930000-0000-7000-8000-00000000a001",
      positions: [
        {
          truckId: t110.truckId,
          lat: t110.lat + 0.5,
          lng: t110.lng + 0.5,
          heading: 45,
          speedMph: 55,
        },
      ],
    },
  });
  expect(post.status(), await post.text()).toBe(200);
  // No reload: the marker moves because the stream delivered position.updated.
  await expect.poll(() => marker.getAttribute("data-lng")).not.toBe(before);
  await expect
    .poll(async () => Number(await marker.getAttribute("data-lng")))
    .toBeCloseTo(t110.lng + 0.5, 3);
});

test("a position report without the service token is refused", async ({ page }) => {
  await signIn(page, USERS.acmeDispatcher1);
  const res = await page.request.post("/api/positions", {
    data: {
      companyId: "01930000-0000-7000-8000-00000000a001",
      positions: [{ truckId: "00000000-0000-0000-0000-000000000000", lat: 1, lng: 1 }],
    },
  });
  expect(res.status()).toBe(401);
});

test("a truck reaching its next stop sets the arrival, and the board hears about it", async ({
  page,
}) => {
  await signIn(page, USERS.acmeDispatcher1);
  // The seeded in-transit load ACM-1003: its truck is heading for the delivery stop.
  const loadsRes = await page.request.get("/api/loads?status=in_transit");
  const { loads } = (await loadsRes.json()) as {
    loads: Array<{
      id: string;
      reference: string;
      version: number;
      assignment: { truckId: string } | null;
      stops: Array<{ id: string; seq: number; lat: number; lng: number; arrivedAt: string | null }>;
    }>;
  };
  const load = loads.find((l) => l.reference === "ACM-1003")!;
  const next = load.stops.find((s) => !s.arrivedAt)!;
  await page.goto(`/loads/${load.id}`);
  await expect(page.getByText(/^arrived/)).toHaveCount(
    load.stops.filter((s) => s.arrivedAt).length,
  );

  const post = await page.request.post("/api/positions", {
    headers: { authorization: `Bearer ${TOKEN}` },
    data: {
      companyId: "01930000-0000-7000-8000-00000000a001",
      positions: [
        {
          truckId: load.assignment!.truckId,
          lat: next.lat + 0.002,
          lng: next.lng,
          heading: 0,
          speedMph: 5,
        },
      ],
    },
  });
  expect(post.status(), await post.text()).toBe(200);
  expect(await post.json()).toEqual({ written: 1, arrivals: 1 });

  // The detail page re-renders on the stop.arrived event (board clients invalidate their loads).
  await page.goto("/board");
  await page.goto(`/loads/${load.id}`);
  await expect(page.getByText(/^arrived/)).toHaveCount(
    load.stops.filter((s) => s.arrivedAt).length + 1,
  );
  // Arrival never changes the status.
  await expect(page.getByTestId("load-status")).toHaveText("In transit");
});
