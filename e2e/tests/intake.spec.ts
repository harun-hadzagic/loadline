import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { signIn, USERS } from "./helpers.ts";

const fixturesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/intake/fixtures",
);
const doc = readFileSync(path.join(fixturesDir, "001-email-st-louis-to-tulsa.txt"), "utf8");

test("paste a rate confirmation, review the pre-filled form, create the load", async ({ page }) => {
  await signIn(page, USERS.acmeDispatcher1);
  await page.goto("/loads/new");
  // No key in this build: the page says which extractor is in use.
  await expect(page.getByTestId("intake-extractor")).toContainText("regex baseline");
  await page.getByTestId("intake-text").fill(doc);
  await page.getByTestId("intake-extract").click();
  await expect(page.getByTestId("intake-notice")).toContainText("regex baseline");

  // The form is pre-filled from the document; nothing is saved yet.
  await expect(page.getByLabel("Reference")).toHaveValue("NW-293350");
  await expect(page.getByLabel("Broker")).toHaveValue("Northwind Freight Brokerage LLC");
  await expect(page.getByLabel("Rate (USD)")).toHaveValue("2575");
  await expect(page.getByLabel("Weight (lb)")).toHaveValue("41000");
  await expect(page.getByLabel("Equipment")).toHaveValue("flatbed");
  await expect(page.getByTestId("stop-0").getByLabel("City")).toHaveValue(/\d+/);
  await expect(page.getByTestId("stop-0").getByLabel("Window start (local)")).toHaveValue(
    "2026-11-20T08:00",
  );
  await expect(page.getByTestId("stop-1").getByLabel("Window end (local)")).toHaveValue(
    "2026-11-22T16:00",
  );
  const before = await page.request.get("/api/loads");
  expect(
    ((await before.json()) as { loads: Array<{ reference: string }> }).loads.some(
      (l) => l.reference === "NW-293350",
    ),
  ).toBe(false);

  // A dispatcher reviews, then creates.
  await page.getByRole("button", { name: "Create load" }).click();
  await expect(page).toHaveURL(/\/loads\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "NW-293350" })).toBeVisible();
  await expect(page.getByText("Building materials")).toBeVisible();
});

test("the paste box refuses more than 20,000 characters", async ({ page }) => {
  await signIn(page, USERS.acmeDispatcher1);
  const res = await page.request.post("/api/loads", { data: {} }); // sanity: API alive
  expect([400, 401, 422]).toContain(res.status());
  await page.goto("/loads/new");
  const huge = "x".repeat(20_001);
  // The textarea caps input; the server action caps it too.
  await page.getByTestId("intake-text").fill(huge);
  const value = await page.getByTestId("intake-text").inputValue();
  expect(value.length).toBeLessThanOrEqual(20_000);
});
