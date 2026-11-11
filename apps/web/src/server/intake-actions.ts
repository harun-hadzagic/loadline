"use server";

import { requireContextOrThrow } from "./context";
import { type ActionResult, toActionResult } from "./errors";
import { extractIntake, type IntakeResult } from "./intake";

/** Paste a rate confirmation, get a pre-filled form. Saves nothing. */
export async function extractIntakeAction(input: unknown): Promise<ActionResult<IntakeResult>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    const text =
      typeof input === "object" && input !== null && "text" in input
        ? String((input as { text: unknown }).text ?? "")
        : "";
    return extractIntake(ctx, text);
  });
}
