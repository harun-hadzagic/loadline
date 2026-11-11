import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createOpenLoad, dragToAssigned, receivedIds, waitForLive } from "./board-helpers.ts";
import { signIn, USERS } from "./helpers.ts";

// Two browser contexts, two dispatchers of the same company, both on the board.
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let a: Page;
let b: Page;

test.beforeEach(async ({ browser }) => {
  ctxA = await browser.newContext();
  ctxB = await browser.newContext();
  a = await ctxA.newPage();
  b = await ctxB.newPage();
  await signIn(a, USERS.acmeDispatcher1);
  await signIn(b, USERS.acmeDispatcher2);
  await a.goto("/board");
  await b.goto("/board");
  await waitForLive(a);
  await waitForLive(b);
});

test.afterEach(async () => {
  await ctxA.close();
  await ctxB.close();
});

test("an assignment made in one browser appears in the other without a reload", async () => {
  // A fresh load created through A's session; both boards learn of it over the stream.
  const load = await createOpenLoad(a, "sync");
  const ref = load.reference;
  const card = a.getByTestId(`card-${ref}`);
  await expect(card).toHaveAttribute("data-status", "open");
  await expect(b.getByTestId(`card-${ref}`)).toHaveAttribute("data-status", "open");

  await dragToAssigned(a, card);
  await a.getByTestId("assign-confirm").click();

  // version 2 comes from the server; the optimistic card still says version 1.
  await expect(a.getByTestId(`card-${ref}`)).toHaveAttribute("data-version", "2");
  await expect(a.getByTestId(`card-${ref}`)).toHaveAttribute("data-status", "assigned");
  await expect(a.getByTestId("column-assigned").getByTestId(`card-${ref}`)).toBeVisible();
  // The other browser: no reload, no refresh, the stream did it.
  await expect(b.getByTestId("column-assigned").getByTestId(`card-${ref}`)).toBeVisible();
  await expect(b.getByTestId(`card-${ref}-assignment`)).toBeVisible();
  await expect(b.getByTestId(`card-${ref}`)).toHaveCount(1);
});

test("a browser whose stream was cut catches up on everything it missed, exactly once", async () => {
  // Three loads created just now; B already shows them as open.
  const fresh = [
    await createOpenLoad(a, "cut1"),
    await createOpenLoad(a, "cut2"),
    await createOpenLoad(a, "cut3"),
  ];
  const refs = fresh.map((l) => l.reference);
  for (const ref of refs)
    await expect(b.getByTestId(`card-${ref}`)).toHaveAttribute("data-status", "open");

  const before = await receivedIds(b);
  await b.evaluate(() => window.__loadlineStream?.pause());
  await expect(b.getByTestId("connection-status")).toHaveAttribute("data-status", "offline");

  // Three changes while B is offline, made through A's session via the API.
  for (const l of fresh) {
    const res = await a.request.post(`/api/loads/${l.id}/transition`, {
      data: { version: l.version, to: "cancelled" },
    });
    expect(res.status(), `${l.reference}: ${await res.text()}`).toBe(200);
  }
  // A sees them live; B still shows them as open.
  for (const ref of refs)
    await expect(a.getByTestId("column-cancelled").getByTestId(`card-${ref}`)).toBeVisible();
  for (const ref of refs)
    await expect(b.getByTestId(`card-${ref}`)).toHaveAttribute("data-status", "open");
  expect((await receivedIds(b)).length).toBe(before.length);

  await b.evaluate(() => window.__loadlineStream?.resume());
  await waitForLive(b);
  for (const ref of refs) {
    await expect(b.getByTestId("column-cancelled").getByTestId(`card-${ref}`)).toBeVisible();
    await expect(b.getByTestId(`card-${ref}`)).toHaveCount(1);
  }
  // Exactly three new events arrived during replay, one per change, none twice.
  await expect.poll(async () => (await receivedIds(b)).length - before.length).toBe(3);
  const ids = await receivedIds(b);
  expect(new Set(ids).size).toBe(ids.length);
});

test("two dispatchers assign the same load: one wins, the other sees the conflict", async () => {
  const load = await createOpenLoad(a, "race");
  const ref = load.reference;
  const cardA = a.getByTestId(`card-${ref}`);
  const cardB = b.getByTestId(`card-${ref}`);
  await expect(cardA).toHaveAttribute("data-status", "open");
  await expect(cardB).toHaveAttribute("data-status", "open");

  // Both open the assign dialog on the same open load.
  await dragToAssigned(a, cardA);
  await dragToAssigned(b, cardB);
  // Different free drivers and trucks, so only the load itself can clash.
  const freeOptions = async (p: Page, label: string) =>
    p
      .getByLabel(label)
      .locator('option[data-free="true"]')
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  await expect.poll(async () => (await freeOptions(a, "Driver")).length).toBeGreaterThan(1);
  await expect.poll(async () => (await freeOptions(b, "Driver")).length).toBeGreaterThan(1);
  const [dA, dB] = await freeOptions(a, "Driver");
  const [tA, tB] = await freeOptions(a, "Truck");
  await a.getByLabel("Driver").selectOption(dA!);
  await a.getByLabel("Truck").selectOption(tA!);
  await b.getByLabel("Driver").selectOption(dB!);
  await b.getByLabel("Truck").selectOption(tB!);

  await a.getByTestId("assign-confirm").click();
  await expect(a.getByTestId(`card-${ref}`)).toHaveAttribute("data-version", "2");
  await expect(a.getByTestId("column-assigned").getByTestId(`card-${ref}`)).toBeVisible();
  const winner = (await a.getByTestId(`card-${ref}-assignment`).textContent()) ?? "";

  await b.getByTestId("assign-confirm").click();
  // The loser gets a 409 and its optimistic move is rolled back to the truth.
  await expect(b.getByText(/already|changed|someone else|just now/i).first()).toBeVisible();
  await expect(b.getByTestId("column-assigned").getByTestId(`card-${ref}`)).toBeVisible();
  await expect(b.getByTestId(`card-${ref}-assignment`)).toHaveText(winner);
  await expect(b.getByTestId(`card-${ref}`)).toHaveCount(1);
});
