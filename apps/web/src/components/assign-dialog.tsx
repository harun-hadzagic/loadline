"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { Candidate, LoadView } from "@/server/loads";

interface Props {
  load: LoadView;
  onClose: () => void;
  onAssign: (driverId: string, truckId: string) => void;
}

async function fetchCandidates(
  loadId: string,
): Promise<{ drivers: Candidate[]; trucks: Candidate[]; nearestTruckIds: string[] }> {
  const res = await fetch(`/api/loads/${loadId}/candidates`, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load drivers and trucks.");
  return res.json() as Promise<{
    drivers: Candidate[];
    trucks: Candidate[];
    nearestTruckIds: string[];
  }>;
}

export function AssignDialog({ load, onClose, onAssign }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["candidates", load.id],
    queryFn: () => fetchCandidates(load.id),
    staleTime: 0,
  });
  const [driverId, setDriverId] = useState("");
  const [truckId, setTruckId] = useState("");
  useEffect(() => {
    if (!data) return;
    setDriverId((d) => d || data.drivers.find((x) => x.free)?.id || "");
    setTruckId((t) => t || data.trucks.find((x) => x.free)?.id || "");
  }, [data]);
  const first = load.stops[0];
  // The server's nearest-neighbour query (five closest free trucks), in its order.
  const nearest = (data?.nearestTruckIds ?? [])
    .map((id) => data?.trucks.find((t) => t.id === id))
    .filter((t): t is Candidate => !!t);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="assign-dialog">
        <DialogHeader>
          <DialogTitle>Assign {load.reference}</DialogTitle>
          <DialogDescription>
            Pickup {first ? `${first.city}, ${first.state}` : ""}. Free drivers and trucks come
            first; the database refuses any overlap.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {(error as Error).message}
          </p>
        ) : null}
        {nearest.length ? (
          <div className="text-xs text-muted-foreground" data-testid="nearest-trucks">
            Nearest free trucks:{" "}
            {nearest.map((t) => `${t.label} (${t.distanceMiles} mi)`).join(", ")}
          </div>
        ) : null}
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onAssign(driverId, truckId);
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="assign-driver">Driver</Label>
            <select
              id="assign-driver"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              disabled={isLoading}
            >
              {(data?.drivers ?? []).map((d) => (
                <option key={d.id} value={d.id} data-free={d.free}>
                  {d.label}
                  {d.free ? "" : " (busy in this window)"}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="assign-truck">Truck</Label>
            <select
              id="assign-truck"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={truckId}
              onChange={(e) => setTruckId(e.target.value)}
              disabled={isLoading}
            >
              {(data?.trucks ?? []).map((t) => (
                <option key={t.id} value={t.id} data-free={t.free}>
                  {t.label} · {t.equipment?.replace("_", " ")}
                  {t.distanceMiles !== null ? ` · ${t.distanceMiles} mi` : ""}
                  {t.free ? "" : " (busy in this window)"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" data-testid="assign-confirm" disabled={!driverId || !truckId}>
              Assign
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
