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
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listCities, listDrivers } from "@/server/fleet";

export default async function DriversPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "fleet", "read")) return <Forbidden />;
  const [drivers, cities] = await Promise.all([listDrivers(ctx), listCities(ctx)]);
  const manage = can(ctx.role, "fleet", "manage");
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Drivers</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Home</TableHead>
            <TableHead>Login</TableHead>
            <TableHead>Now</TableHead>
            <TableHead>Status</TableHead>
            {manage ? <TableHead /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {drivers.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="font-medium">{d.name}</TableCell>
              <TableCell>{d.phone ?? "—"}</TableCell>
              <TableCell>{d.homeCity ?? "—"}</TableCell>
              <TableCell>{d.userId ? "linked" : "—"}</TableCell>
              <TableCell>{d.currentLoad ?? "available"}</TableCell>
              <TableCell>
                <Badge variant={d.active ? "default" : "outline"}>
                  {d.active ? "active" : "inactive"}
                </Badge>
              </TableCell>
              {manage ? (
                <TableCell>
                  <FleetForm kind="driver" cities={cities} driver={d} />
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {manage ? <FleetForm kind="driver" cities={cities} /> : null}
    </div>
  );
}
