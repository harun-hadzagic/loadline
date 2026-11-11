import { resetTestDatabase } from "@loadline/db/testing";

export default async function globalSetup(): Promise<void> {
  await resetTestDatabase({ seed: true });
}
