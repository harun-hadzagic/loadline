import Link from "next/link";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money, STATUS_LABEL, windowInZone } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { listLoads } from "@/server/loads";

export default async function LoadsPage() {
  const ctx = await requireContext();
  if (!can(ctx.role, "board", "read")) return <Forbidden />;
  const loads = await listLoads(ctx);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Loads</h1>
        <Button render={<Link href="/loads/new" />}>New load</Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reference</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Pickup window</TableHead>
            <TableHead>Driver / truck</TableHead>
            <TableHead className="text-right">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loads.map((l) => {
            const first = l.stops[0];
            const last = l.stops[l.stops.length - 1];
            return (
              <TableRow key={l.id} data-testid={`load-row-${l.reference}`}>
                <TableCell>
                  <Link
                    href={`/loads/${l.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {l.reference}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      l.status === "cancelled"
                        ? "destructive"
                        : l.status === "open"
                          ? "outline"
                          : "default"
                    }
                  >
                    {STATUS_LABEL[l.status]}
                  </Badge>
                </TableCell>
                <TableCell>
                  {first ? `${first.city}, ${first.state}` : "—"} →{" "}
                  {last ? `${last.city}, ${last.state}` : "—"}
                </TableCell>
                <TableCell>
                  {first
                    ? windowInZone(first.appointmentStart, first.appointmentEnd, first.timezone)
                    : "—"}
                </TableCell>
                <TableCell>
                  {l.assignment ? `${l.assignment.driverName} · #${l.assignment.unitNumber}` : "—"}
                </TableCell>
                <TableCell className="text-right">{money(l.rateCents)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
