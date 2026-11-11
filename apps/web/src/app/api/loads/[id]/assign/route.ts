import { assignInputSchema } from "@/lib/schemas";
import { jsonError, readJson } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { assignLoad } from "@/server/loads";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const { id } = await params;
    const body = await readJson(request);
    const input = assignInputSchema.parse({ ...(body as object), loadId: id });
    return Response.json({ load: await assignLoad(ctx, input) });
  } catch (err) {
    return jsonError(err);
  }
}
