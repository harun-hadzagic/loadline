import { expect, test } from "@playwright/test";
import { signIn, USERS } from "./helpers.ts";

// Phase 2 "done when": a seeded driver signed in on a phone-sized viewport
// sees only their own loads. The phone project sets the viewport.
test("a driver sees only their own loads, and dispatcher pages are closed to them", async ({
  page,
}) => {
  await signIn(page, USERS.acmeDriver1);
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole("heading", { name: "My loads" })).toBeVisible();

  const cards = page.locator('[data-testid^="driver-load-"]');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  // Seeded: driver 1 of Acme holds ACM-1001 (in transit) and ACM-1009 (assigned later).
  await expect(page.getByTestId("driver-load-ACM-1001")).toBeVisible();
  await expect(page.getByTestId("driver-load-ACM-1009")).toBeVisible();
  // Another driver's loads are not on the page.
  await expect(page.getByTestId("driver-load-ACM-1002")).toHaveCount(0);
  await expect(page.getByTestId("driver-load-ACM-1004")).toHaveCount(0);
  expect(count).toBe(2);

  // The phone-sized page fits without horizontal scrolling.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // Dispatcher pages redirect or refuse.
  await page.goto("/loads");
  await expect(page.getByRole("heading", { name: "Loads" })).toHaveCount(0);
});

test("a driver marks the current load delivered and it leaves the page", async ({ page }) => {
  await signIn(page, USERS.acmeDriver2);
  await expect(page.getByTestId("driver-load-ACM-1002")).toBeVisible();
  await page.getByTestId("driver-deliver").click();
  await expect(page.getByText("Marked delivered")).toBeVisible();
  // The delivered load leaves the page at once; whatever else the dispatchers
  // assigned to this driver during the run may remain.
  await expect(page.getByTestId("driver-load-ACM-1002")).toHaveCount(0);
});
