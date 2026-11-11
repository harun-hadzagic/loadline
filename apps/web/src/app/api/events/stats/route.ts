import { jsonError } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { getHub } from "@/server/stream/hub";

export const dynamic = "force-dynamic";

/** Hub counters for diagnostics and the sync-latency benchmark. Signed-in users only. */
export async function GET(): Promise<Response> {
  try {
    await requireContextOrThrow();
    return Response.json(getHub().stats());
  } catch (err) {
    return jsonError(err);
  }
}
