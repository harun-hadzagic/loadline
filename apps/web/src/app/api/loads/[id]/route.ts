import { z } from "zod";
import { loadPatchSchema } from "@/lib/schemas";
import { jsonError, readJson } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { getLoad, updateLoad } from "@/server/loads";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const { id } = await params;
    return Response.json({ load: await getLoad(ctx, z.uuid().parse(id)) });
  } catch (err) {
    return jsonError(err);
  }
}

/** Edit a load (optimistic: the body carries the version it was based on). */
export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const { id } = await params;
    const body = await readJson(request);
    const patch = loadPatchSchema.parse({ ...(body as object), id });
    return Response.json({ load: await updateLoad(ctx, patch) });
  } catch (err) {
    return jsonError(err);
  }
}
