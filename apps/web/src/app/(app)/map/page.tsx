import { Forbidden } from "@/components/forbidden";
import { TruckMap } from "@/components/truck-map";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listLoads } from "@/server/loads";
import { listPositions } from "@/server/positions";

export default async function MapPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "map", "read")) return <Forbidden />;
  const [positions, loads] = await Promise.all([
    listPositions(ctx),
    listLoads(ctx, { statuses: ["assigned", "in_transit"] }),
  ]);
  return (
    <TruckMap
      initialPositions={positions}
      initialLoads={loads}
      companyTimezone={ctx.companyTimezone}
    />
  );
}
