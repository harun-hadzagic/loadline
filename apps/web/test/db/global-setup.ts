import { resetTestDatabase } from "@loadline/db/testing";

export default async function setup(): Promise<void> {
  await resetTestDatabase({ seed: true });
}
