import { notFound } from "next/navigation";
import { Forbidden } from "@/components/forbidden";
import { LoadActions } from "@/components/load-actions";
import { LoadForm } from "@/components/load-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EQUIPMENT_LABEL, inZone, money, pounds, STATUS_LABEL, windowInZone } from "@/lib/format";
import { can } from "@/lib/permissions";
import { requireContext } from "@/server/context";
import { AppError } from "@/server/errors";
import { listCities, listDrivers, listTrucks } from "@/server/fleet";
import { getLoad } from "@/server/loads";

export default async function LoadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireContext();
  if (ctx.role === "driver")
    return <Forbidden message="Drivers see their loads on the driver page." />;
  const load = await getLoad(ctx, id).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const canAssign = can(ctx.role, "load", "assign");
  const editable =
    can(ctx.role, "load", "update") && (load.status === "open" || load.status === "assigned");
  const [drivers, trucks, cities] = await Promise.all([
    canAssign ? listDrivers(ctx) : Promise.resolve([]),
    canAssign ? listTrucks(ctx) : Promise.resolve([]),
    editable ? listCities(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{load.reference}</h1>
        <Badge data-testid="load-status">{STATUS_LABEL[load.status]}</Badge>
        <span className="text-sm text-muted-foreground">
          v{load.version} · updated {inZone(load.updatedAt, ctx.companyTimezone)}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Stops</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {load.stops.map((s) => (
              <div key={s.id} className="flex flex-col gap-0.5 border-l-2 pl-3">
                <div className="text-sm font-medium">
                  {s.kind === "pickup" ? "Pickup" : "Delivery"} · {s.city}, {s.state}
                </div>
                <div className="text-sm text-muted-foreground">{s.facilityName ?? "—"}</div>
                <div className="text-sm">
                  {windowInZone(s.appointmentStart, s.appointmentEnd, s.timezone)}
                </div>
                {s.arrivedAt ? (
                  <div className="text-xs text-muted-foreground">
                    arrived {inZone(s.arrivedAt, s.timezone)}
                    {s.departedAt ? ` · departed ${inZone(s.departedAt, s.timezone)}` : ""}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 text-sm">
            <Row k="Broker" v={load.brokerName ?? "—"} />
            <Row k="Commodity" v={load.commodity ?? "—"} />
            <Row k="Equipment" v={(load.equipment && EQUIPMENT_LABEL[load.equipment]) || "—"} />
            <Row k="Weight" v={pounds(load.weightLbs)} />
            <Row k="Rate" v={money(load.rateCents)} />
            <Row k="Driver" v={load.assignment ? load.assignment.driverName : "—"} />
            <Row k="Truck" v={load.assignment ? `#${load.assignment.unitNumber}` : "—"} />
            {load.notes ? <Row k="Notes" v={load.notes} /> : null}
          </CardContent>
        </Card>
      </div>

      <LoadActions load={load} role={ctx.role} drivers={drivers} trucks={trucks} />

      {editable ? (
        <Card>
          <CardHeader>
            <CardTitle>Edit</CardTitle>
          </CardHeader>
          <CardContent>
            <LoadForm cities={cities} load={load} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
