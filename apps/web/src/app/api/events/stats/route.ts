import { jsonError } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { ForbiddenError } from "@/server/errors";
import { getHub } from "@/server/stream/hub";

export const dynamic = "force-dynamic";

/**
 * Hub counters for diagnostics and the sync-latency benchmark. The numbers are
 * process-wide (every company's clients and deliveries), so only owners and
 * admins may read them.
 */
export async function GET(): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    if (ctx.role !== "owner" && ctx.role !== "admin")
      throw new ForbiddenError("Stream statistics are for owners and admins.");
    return Response.json(getHub().stats());
  } catch (err) {
    return jsonError(err);
  }
}
