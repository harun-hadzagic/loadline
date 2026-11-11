import { expect, type Locator, type Page } from "@playwright/test";

/** Drag a board card onto the Assigned column with real pointer moves (dnd-kit's PointerSensor). */
export async function dragToAssigned(page: Page, card: Locator): Promise<void> {
  const target = page.getByTestId("column-assigned");
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("card or column not visible");
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + 40 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * i) / 12,
      start.y + ((end.y - start.y) * i) / 12,
    );
  }
  await page.mouse.up();
  await expect(page.getByTestId("assign-dialog")).toBeVisible();
}

export async function waitForLive(page: Page): Promise<void> {
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "live");
}

export interface LoadJson {
  id: string;
  reference: string;
  version: number;
  status: string;
}

export async function loadsByReference(page: Page): Promise<Map<string, LoadJson>> {
  const res = await page.request.get("/api/loads");
  expect(res.ok()).toBeTruthy();
  const { loads } = (await res.json()) as { loads: LoadJson[] };
  return new Map(loads.map((l) => [l.reference, l]));
}

export async function receivedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__loadlineStream?.received ?? []);
}

declare global {
  interface Window {
    __loadlineStream?: {
      received: string[];
      pause: () => void;
      resume: () => void;
      status: string;
    };
  }
}

/** Create an open load through the API so each test owns its data and can run any number of times. */
export async function createOpenLoad(
  page: Page,
  tag: string,
  offsetHours?: number,
): Promise<LoadJson> {
  // A window of its own (a random day months out), so repeated runs do not exhaust free drivers and trucks.
  offsetHours ??= 24 * (30 + Math.floor(Math.random() * 300));
  const cities = (await (await page.request.get("/api/loads")).json()) as {
    loads: Array<{ stops: Array<{ cityId: number }> }>;
  };
  const cityIds = [...new Set(cities.loads.flatMap((l) => l.stops.map((s) => s.cityId)))];
  const [a, b] = cityIds;
  const start = new Date(Date.now() + offsetHours * 3_600_000);
  const iso = (h: number) => new Date(start.getTime() + h * 3_600_000).toISOString();
  const reference = `E2E-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const res = await page.request.post("/api/loads", {
    data: {
      reference,
      brokerName: "E2E Broker",
      commodity: "Test freight",
      weightLbs: 1000,
      rateCents: 150_000,
      equipment: "dry_van",
      stops: [
        { kind: "pickup", cityId: a, appointmentStart: iso(0), appointmentEnd: iso(2) },
        { kind: "delivery", cityId: b, appointmentStart: iso(20), appointmentEnd: iso(24) },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { load: LoadJson }).load;
}
