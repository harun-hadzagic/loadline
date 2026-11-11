import { loadInputSchema } from "@/lib/schemas";
import { jsonError, readJson } from "@/server/api";
import { requireContextOrThrow } from "@/server/context";
import { createLoad, type LoadStatus, listLoads } from "@/server/loads";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const url = new URL(request.url);
    const statuses = url.searchParams.get("status")?.split(",").filter(Boolean) as
      | LoadStatus[]
      | undefined;
    const loads = await listLoads(ctx, statuses?.length ? { statuses } : {});
    return Response.json({ loads });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireContextOrThrow();
    const load = await createLoad(ctx, loadInputSchema.parse(await readJson(request)));
    return Response.json({ load }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
