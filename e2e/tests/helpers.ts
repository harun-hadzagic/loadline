import { type BrowserContext, expect, type Page } from "@playwright/test";

export const DEMO_PASSWORD = "loadline-demo";

export const USERS = {
  acmeDispatcher1: "dispatch1@acme-freight.example",
  acmeDispatcher2: "dispatch2@acme-freight.example",
  acmeAdmin: "admin@acme-freight.example",
  acmeDriver1: "driver1@acme-freight.example",
  acmeDriver2: "driver2@acme-freight.example",
  blueRidgeDispatcher1: "dispatch1@blueridge-haulers.example",
} as const;

export async function signIn(page: Page, email: string, password = DEMO_PASSWORD): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("current-user")).toBeVisible();
}

export async function newSignedInPage(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}
