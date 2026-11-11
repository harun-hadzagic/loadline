import {
  createClaudeExtractor,
  type Extraction,
  extractWithBaseline,
  liveMessagesClient,
} from "@loadline/intake";
import { z } from "zod";
import { assertCan } from "./authorize";
import type { RequestContext } from "./context";

/** The paste box accepts this many characters; a rate confirmation is a few thousand. */
export const MAX_INTAKE_CHARS = 20_000;

export const intakeInputSchema = z.object({
  text: z
    .string()
    .min(20, "Paste the rate confirmation text.")
    .max(MAX_INTAKE_CHARS, `Keep it under ${MAX_INTAKE_CHARS.toLocaleString("en-US")} characters.`),
});

export interface IntakeResult {
  extraction: Extraction;
  /** Which extractor produced the answer. */
  extractor: "baseline" | "claude";
  /** Why the baseline answered, when it did. Shown to the dispatcher. */
  notice: string | null;
  costUsd: number | null;
  latencyMs: number;
}

/** Nothing in this build sets the key; when Harun does, the page switches to Claude. */
export function claudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Paste → pre-filled form. The regex baseline when no key is set; the Claude
 * extractor (with its own retry and fallback to the baseline) when one is.
 * Nothing is saved here: the dispatcher reviews the form and clicks Create.
 */
export async function extractIntake(ctx: RequestContext, rawText: string): Promise<IntakeResult> {
  assertCan(ctx, "intake", "use");
  const { text } = intakeInputSchema.parse({ text: rawText });
  const started = performance.now();
  if (!claudeAvailable()) {
    return {
      extraction: extractWithBaseline(text),
      extractor: "baseline",
      notice:
        "No ANTHROPIC_API_KEY is set, so this was read by the regex baseline. Check every field before creating the load.",
      costUsd: null,
      latencyMs: Math.round(performance.now() - started),
    };
  }
  const extract = createClaudeExtractor({ client: await liveMessagesClient() });
  const r = await extract(text);
  return {
    extraction: r.extraction,
    extractor: r.source,
    notice: r.notice,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
  };
}
