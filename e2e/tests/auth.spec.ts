import { expect, test } from "@playwright/test";
import { DEMO_PASSWORD, signIn, USERS } from "./helpers.ts";

test("a dispatcher signs in and sees only their company's loads", async ({ page }) => {
  await signIn(page, USERS.acmeDispatcher1);
  await expect(page).toHaveURL(/\/loads$/);
  await expect(page.getByTestId("load-row-ACM-1001")).toBeVisible();
  await expect(page.getByTestId("load-row-BRH-1001")).toHaveCount(0);
});

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(USERS.acmeDispatcher1);
  await page.getByLabel("Password").fill(`${DEMO_PASSWORD}-wrong`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
});

test("the other company's dispatcher sees their own loads and not Acme's", async ({ page }) => {
  await signIn(page, USERS.blueRidgeDispatcher1);
  await expect(page.getByTestId("load-row-BRH-1001")).toBeVisible();
  await expect(page.getByTestId("load-row-ACM-1001")).toHaveCount(0);
});
