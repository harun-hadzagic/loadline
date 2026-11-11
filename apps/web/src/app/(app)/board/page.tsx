import { Board } from "@/components/board";
import { Forbidden } from "@/components/forbidden";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listDrivers, listTrucks } from "@/server/fleet";
import { listLoads } from "@/server/loads";

export default async function BoardPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "board", "read")) return <Forbidden />;
  const canAssign = can(ctx.role, "load", "assign");
  const [loads, drivers, trucks] = await Promise.all([
    listLoads(ctx),
    canAssign ? listDrivers(ctx) : Promise.resolve([]),
    canAssign ? listTrucks(ctx) : Promise.resolve([]),
  ]);
  return <Board initialLoads={loads} drivers={drivers} trucks={trucks} canAssign={canAssign} />;
}
