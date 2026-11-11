import type { RequestContext } from "./context";
import { type LoadView, listLoads } from "./loads";

/**
 * The driver page: the load in progress first, then upcoming ones. Row-level
 * security already limits a driver to loads with an open assignment for them;
 * this only orders and splits them.
 */
export async function myLoads(
  ctx: RequestContext,
): Promise<{ current: LoadView | null; upcoming: LoadView[] }> {
  const loads = await listLoads(ctx, { statuses: ["assigned", "in_transit"] });
  const current = loads.find((l) => l.status === "in_transit") ?? loads[0] ?? null;
  const upcoming = loads.filter((l) => l !== current);
  return { current, upcoming };
}
