import { z } from "zod";
import { jsonError } from "@/server/api";
import { assertServiceToken, simulatorState } from "@/server/positions";

export const dynamic = "force-dynamic";

/** Trucks, positions and next stops for one company, for the simulator (service token). */
export async function GET(request: Request): Promise<Response> {
  try {
    assertServiceToken(request);
    const companyId = z.uuid().parse(new URL(request.url).searchParams.get("company"));
    return Response.json({ trucks: await simulatorState(companyId) });
  } catch (err) {
    return jsonError(err);
  }
}
