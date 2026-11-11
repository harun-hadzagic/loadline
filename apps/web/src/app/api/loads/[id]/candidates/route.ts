import { z } from "zod";
import { jsonError } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { assignmentCandidates } from "@/server/loads";

export const dynamic = "force-dynamic";

/** Drivers and trucks for the assign dialog, free ones first, nearest trucks first. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const { id } = await params;
    return Response.json(await assignmentCandidates(ctx, z.uuid().parse(id)));
  } catch (err) {
    return jsonError(err);
  }
}
