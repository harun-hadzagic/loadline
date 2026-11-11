import { transitionInputSchema } from "@/lib/schemas";
import { jsonError, readJson } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { transitionLoad } from "@/server/loads";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const { id } = await params;
    const body = await readJson(request);
    const input = transitionInputSchema.parse({ ...(body as object), loadId: id });
    return Response.json({ load: await transitionLoad(ctx, input) });
  } catch (err) {
    return jsonError(err);
  }
}
