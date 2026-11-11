import { jsonError, readJson } from "@/server/api";
import { getContext } from "@/server/context";
import {
  assertServiceToken,
  listPositions,
  positionsBodySchema,
  recordPositions,
} from "@/server/positions";
import { LIMITS, limiter } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/** The simulator (or a telematics bridge) posts positions with the service token. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertServiceToken(request);
    const body = positionsBodySchema.parse(await readJson(request));
    // Per company: a runaway or malicious poster cannot flood the outbox.
    limiter("positions", LIMITS.positions).take(body.companyId);
    const result = await recordPositions(body.companyId, body.positions);
    return Response.json(result);
  } catch (err) {
    return jsonError(err);
  }
}

/** Latest positions for the signed-in user's company (the map). */
export async function GET(): Promise<Response> {
  try {
    const ctx = await getContext();
    if (!ctx) return Response.json({ error: "Sign in first." }, { status: 401 });
    return Response.json({ positions: await listPositions(ctx) });
  } catch (err) {
    return jsonError(err);
  }
}
