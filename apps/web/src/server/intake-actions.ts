"use server";

import { requireContextOrThrow } from "./context";
import { type ActionResult, toActionResult } from "./errors";
import { extractIntake, type IntakeResult } from "./intake";
import { LIMITS, limiter } from "./rate-limit";

/** Paste a rate confirmation, get a pre-filled form. Saves nothing. */
export async function extractIntakeAction(input: unknown): Promise<ActionResult<IntakeResult>> {
  return toActionResult(async () => {
    const ctx = await requireContextOrThrow();
    // Per user: with a live key every extraction costs money.
    limiter("intake", LIMITS.intake).take(ctx.userId);
    const text =
      typeof input === "object" && input !== null && "text" in input
        ? String((input as { text: unknown }).text ?? "")
        : "";
    return extractIntake(ctx, text);
  });
}
