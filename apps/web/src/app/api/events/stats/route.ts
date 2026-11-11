import { jsonError } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { ForbiddenError } from "@/server/errors";
import { getHub } from "@/server/stream/hub";

export const dynamic = "force-dynamic";

/**
 * Hub counters for diagnostics. The client count is the caller's company's;
 * the cursor, drain and delivery counters are process-wide totals with no
 * tenant content. Owners and admins only.
 */
export async function GET(): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    if (ctx.role !== "owner" && ctx.role !== "admin")
      throw new ForbiddenError("Stream statistics are for owners and admins.");
    return Response.json(getHub().stats(ctx.companyId));
  } catch (err) {
    return jsonError(err);
  }
}
