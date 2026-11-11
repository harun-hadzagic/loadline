"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { can, type RoleName } from "@/lib/permissions";
import { assignLoadAction, transitionLoadAction } from "@/server/actions";
import type { ActionResult } from "@/server/errors";
import type { DriverView, TruckView } from "@/server/fleet";
import type { LoadStatus, LoadView } from "@/server/loads";

interface Props {
  load: LoadView;
  role: RoleName;
  drivers: DriverView[];
  trucks: TruckView[];
}

export function LoadActions({ load, role, drivers, trucks }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [driverId, setDriverId] = useState(drivers.find((d) => d.active)?.id ?? "");
  const [truckId, setTruckId] = useState(trucks.find((t) => t.active)?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const handle = (result: ActionResult<LoadView>, okMessage: string) => {
    if (!result.ok) {
      setError(result.message);
      toast.error(result.message);
      router.refresh();
      return;
    }
    setError(null);
    toast.success(okMessage);
    router.refresh();
  };

  const transition = (to: LoadStatus, okMessage: string) =>
    start(async () =>
      handle(await transitionLoadAction({ loadId: load.id, version: load.version, to }), okMessage),
    );

  const buttons: Array<{
    to: LoadStatus;
    label: string;
    permission: "pickup" | "deliver" | "cancel" | "assign";
    from: LoadStatus[];
    variant?: "destructive" | "outline";
  }> = [
    { to: "in_transit", label: "Picked up", permission: "pickup", from: ["assigned"] },
    { to: "delivered", label: "Delivered", permission: "deliver", from: ["in_transit"] },
    { to: "open", label: "Unassign", permission: "assign", from: ["assigned"], variant: "outline" },
    {
      to: "cancelled",
      label: "Cancel load",
      permission: "cancel",
      from: ["open", "assigned"],
      variant: "destructive",
    },
  ];
  const visible = buttons.filter(
    (b) => b.from.includes(load.status) && can(role, "load", b.permission),
  );
  const showAssign = load.status === "open" && can(role, "load", "assign");

  if (!visible.length && !showAssign) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showAssign ? (
          <form
            className="flex flex-wrap items-end gap-3"
            data-testid="assign-form"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () =>
                handle(
                  await assignLoadAction({
                    loadId: load.id,
                    version: load.version,
                    driverId,
                    truckId,
                  }),
                  "Load assigned",
                ),
              );
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="driver">Driver</Label>
              <select
                id="driver"
                className="h-9 min-w-48 rounded-md border bg-background px-2 text-sm"
                value={driverId}
                onChange={(e) => setDriverId(e.target.value)}
              >
                {drivers.map((d) => (
                  <option key={d.id} value={d.id} disabled={!d.active}>
                    {d.name}
                    {d.currentLoad ? ` (on ${d.currentLoad})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="truck">Truck</Label>
              <select
                id="truck"
                className="h-9 min-w-40 rounded-md border bg-background px-2 text-sm"
                value={truckId}
                onChange={(e) => setTruckId(e.target.value)}
              >
                {trucks.map((t) => (
                  <option key={t.id} value={t.id} disabled={!t.active}>
                    #{t.unitNumber} · {t.equipment.replace("_", " ")}
                    {t.currentLoad ? ` (on ${t.currentLoad})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={pending || !driverId || !truckId}>
              Assign
            </Button>
          </form>
        ) : null}
        {visible.length ? (
          <div className="flex flex-wrap gap-2">
            {visible.map((b) => (
              <Button
                key={b.to}
                variant={b.variant ?? "default"}
                disabled={pending}
                onClick={() => transition(b.to, `${load.reference}: ${b.label.toLowerCase()}`)}
                data-testid={`action-${b.to}`}
              >
                {b.label}
              </Button>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive" data-testid="action-error">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
