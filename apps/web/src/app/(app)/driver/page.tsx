import { DriverActions } from "@/components/driver-actions";
import { Forbidden } from "@/components/forbidden";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { money, STATUS_LABEL, windowInZone } from "@/lib/format";
import { requireContext } from "@/server/context";
import { myLoads } from "@/server/driver-view";
import type { LoadView } from "@/server/loads";

export default async function DriverPage() {
  const ctx = await requireContext();
  if (!ctx.driverId) return <Forbidden message="Only linked driver accounts have a driver page." />;
  const { current, upcoming } = await myLoads(ctx);
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold">My loads</h1>
      {current ? (
        <LoadCard load={current} emphasis />
      ) : (
        <Card>
          <CardContent
            className="py-8 text-center text-sm text-muted-foreground"
            data-testid="no-current-load"
          >
            Nothing assigned right now.
          </CardContent>
        </Card>
      )}
      {upcoming.length ? (
        <>
          <h2 className="text-sm font-medium text-muted-foreground">Up next</h2>
          {upcoming.map((l) => (
            <LoadCard key={l.id} load={l} />
          ))}
        </>
      ) : null}
    </div>
  );
}

function LoadCard({ load, emphasis = false }: { load: LoadView; emphasis?: boolean }) {
  const pickup = load.stops.find((s) => s.kind === "pickup") ?? load.stops[0];
  const delivery =
    [...load.stops].reverse().find((s) => s.kind === "delivery") ??
    load.stops[load.stops.length - 1];
  return (
    <Card
      data-testid={`driver-load-${load.reference}`}
      className={emphasis ? "border-primary" : ""}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{load.reference}</span>
          <Badge>{STATUS_LABEL[load.status]}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {pickup ? (
          <div>
            <div className="text-xs uppercase text-muted-foreground">Pickup</div>
            <div className="font-medium">
              {pickup.city}, {pickup.state}
              {pickup.facilityName ? ` · ${pickup.facilityName}` : ""}
            </div>
            <div>
              {windowInZone(pickup.appointmentStart, pickup.appointmentEnd, pickup.timezone)}
            </div>
          </div>
        ) : null}
        {delivery ? (
          <div>
            <div className="text-xs uppercase text-muted-foreground">Delivery</div>
            <div className="font-medium">
              {delivery.city}, {delivery.state}
              {delivery.facilityName ? ` · ${delivery.facilityName}` : ""}
            </div>
            <div>
              {windowInZone(delivery.appointmentStart, delivery.appointmentEnd, delivery.timezone)}
            </div>
          </div>
        ) : null}
        <div className="flex justify-between text-muted-foreground">
          <span>{load.commodity ?? "—"}</span>
          <span>{money(load.rateCents)}</span>
        </div>
        {emphasis ? <DriverActions load={load} /> : null}
      </CardContent>
    </Card>
  );
}
