import { FleetForm } from "@/components/fleet-form";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EQUIPMENT_LABEL } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listCities, listTrucks } from "@/server/fleet";

export default async function TrucksPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "fleet", "read")) return <Forbidden />;
  const [trucks, cities] = await Promise.all([listTrucks(ctx), listCities(ctx)]);
  const manage = can(ctx.role, "fleet", "manage");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Trucks</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Unit</TableHead>
            <TableHead>Equipment</TableHead>
            <TableHead>Home</TableHead>
            <TableHead>Now</TableHead>
            <TableHead>Status</TableHead>
            {manage ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {trucks.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">#{t.unitNumber}</TableCell>
              <TableCell>{EQUIPMENT_LABEL[t.equipment]}</TableCell>
              <TableCell>{t.homeCity ?? "—"}</TableCell>
              <TableCell>{t.currentLoad ?? "available"}</TableCell>
              <TableCell>
                <Badge variant={t.active ? "default" : "outline"}>
                  {t.active ? "active" : "inactive"}
                </Badge>
              </TableCell>
              {manage ? (
                <TableCell>
                  <FleetForm kind="truck" cities={cities} truck={t} />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {manage ? <FleetForm kind="truck" cities={cities} /> : null}
    </div>
  );
}
