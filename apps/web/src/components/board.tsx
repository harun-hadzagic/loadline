"use client";

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AssignDialog } from "@/components/assign-dialog";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { Badge } from "@/components/ui/badge";
import { LOADS_KEY, mergeLoad, useStreamStatus } from "@/hooks/use-event-stream";
import { money, STATUS_LABEL, windowInZone } from "@/lib/format";
import { cn } from "@/lib/utils";
import { assignLoadAction } from "@/server/actions";
import type { ActionResult } from "@/server/errors";
import type { DriverView, TruckView } from "@/server/fleet";
import type { LoadStatus, LoadView } from "@/server/loads";

const COLUMNS: LoadStatus[] = ["open", "assigned", "in_transit", "delivered", "cancelled"];

interface Props {
  initialLoads: LoadView[];
  drivers: DriverView[];
  trucks: TruckView[];
  canAssign: boolean;
}

/**
 * Undo an optimistic assignment for one load only. Stream updates applied to
 * other loads while the request was in flight stay in place. The server's
 * current row wins when the 409 carried it; otherwise the pre-request row
 * returns, unless the cache has since moved past the optimistic entry.
 */
export function rollbackLoad(
  list: LoadView[],
  original: LoadView,
  optimistic: LoadView,
  current: LoadView | null,
): LoadView[] {
  return list.map((l) => {
    if (l.id !== original.id) return l;
    if (current) return current;
    return l === optimistic || l.assignment?.id === "pending" ? original : l;
  });
}

export function Board({ initialLoads, drivers, trucks, canAssign }: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  const status = useStreamStatus();
  const { data: loads = [] } = useQuery<LoadView[]>({
    queryKey: LOADS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/loads", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load the board.");
      return ((await res.json()) as { loads: LoadView[] }).loads;
    },
    initialData: initialLoads,
  });
  const [assigning, setAssigning] = useState<LoadView | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (e: DragEndEvent) => {
    const load = loads.find((l) => l.id === e.active.id);
    if (!load || load.status !== "open") return;
    if (e.over?.id === "column-assigned" && canAssign) setAssigning(load);
  };

  const assign = async (load: LoadView, driverId: string, truckId: string) => {
    setAssigning(null);
    // Optimistic: move the card now, roll it back on a 409.
    const driver = drivers.find((d) => d.id === driverId);
    const truck = trucks.find((t) => t.id === truckId);
    const optimistic: LoadView = {
      ...load,
      status: "assigned",
      assignment: {
        id: "pending",
        driverId,
        driverName: driver?.name ?? "…",
        truckId,
        unitNumber: truck?.unitNumber ?? "…",
        periodStart: load.stops[0]?.appointmentStart ?? "",
        periodEnd: load.stops[load.stops.length - 1]?.appointmentEnd ?? "",
      },
    };
    qc.setQueryData<LoadView[]>(LOADS_KEY, (old) =>
      (old ?? []).map((l) => (l.id === load.id ? optimistic : l)),
    );
    setPendingIds((s) => new Set(s).add(load.id));
    let result: ActionResult<LoadView>;
    try {
      result = await assignLoadAction({
        loadId: load.id,
        version: load.version,
        driverId,
        truckId,
      });
    } catch (err) {
      result = {
        ok: false,
        status: 0,
        message: err instanceof Error ? err.message : "Request failed.",
      };
    } finally {
      setPendingIds((s) => {
        const n = new Set(s);
        n.delete(load.id);
        return n;
      });
    }
    if (!result.ok) {
      const current = (result.details?.current as LoadView | undefined) ?? null;
      qc.setQueryData<LoadView[]>(LOADS_KEY, (old) =>
        rollbackLoad(old ?? [], load, optimistic, current),
      );
      void qc.invalidateQueries({ queryKey: LOADS_KEY }); // the truth replaces any guess
      toast.error(result.message, { id: `assign-${load.id}` });
      return;
    }
    qc.setQueryData<LoadView[]>(LOADS_KEY, (old) => mergeLoad(old ?? [], result.data));
    toast.success(`${load.reference} assigned to ${result.data.assignment?.driverName}`);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Board</h1>
        <div className="flex items-center gap-3">
          <ConnectionIndicator status={status} />
          <button
            type="button"
            className="text-xs underline underline-offset-4"
            onClick={() => router.push("/loads/new")}
          >
            New load
          </button>
        </div>
      </div>
      <DndContext id="board" sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-5">
          {COLUMNS.map((col) => (
            <Column
              key={col}
              status={col}
              loads={loads.filter((l) => l.status === col)}
              pendingIds={pendingIds}
              droppable={col === "assigned" && canAssign}
            />
          ))}
        </div>
      </DndContext>
      {assigning ? (
        <AssignDialog
          load={assigning}
          onClose={() => setAssigning(null)}
          onAssign={(d, t) => assign(assigning, d, t)}
        />
      ) : null}
    </div>
  );
}

function Column({
  status,
  loads,
  pendingIds,
  droppable,
}: {
  status: LoadStatus;
  loads: LoadView[];
  pendingIds: Set<string>;
  droppable: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}`, disabled: !droppable });
  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${status}`}
      className={cn(
        "flex max-h-[calc(100vh-8rem)] min-h-40 flex-col gap-2 overflow-y-auto rounded-lg border bg-muted/30 p-2",
        isOver && droppable && "ring-2 ring-primary",
      )}
    >
      <header className="sticky top-0 z-10 flex items-center justify-between bg-muted/80 px-1 py-1 backdrop-blur">
        <h2 className="text-sm font-medium">{STATUS_LABEL[status]}</h2>
        <Badge variant="outline" data-testid={`count-${status}`}>
          {loads.length}
        </Badge>
      </header>
      {loads.map((l) => (
        <LoadCard
          key={l.id}
          load={l}
          pending={pendingIds.has(l.id)}
          draggable={status === "open"}
        />
      ))}
    </section>
  );
}

function LoadCard({
  load,
  pending,
  draggable,
}: {
  load: LoadView;
  pending: boolean;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: load.id,
    disabled: !draggable,
  });
  const first = load.stops[0];
  const last = load.stops[load.stops.length - 1];
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <article
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid={`card-${load.reference}`}
      data-status={load.status}
      data-version={load.version}
      className={cn(
        "flex flex-col gap-1 rounded-md border bg-background p-2 text-xs shadow-sm",
        draggable && "cursor-grab",
        isDragging && "opacity-70 shadow-lg",
        pending && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between">
        <Link
          href={`/loads/${load.id}`}
          className="font-medium hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {load.reference}
        </Link>
        <span className="text-muted-foreground">{money(load.rateCents)}</span>
      </div>
      <div>
        {first ? `${first.city}, ${first.state}` : "—"} →{" "}
        {last ? `${last.city}, ${last.state}` : "—"}
      </div>
      {first ? (
        <div className="text-muted-foreground">
          {windowInZone(first.appointmentStart, first.appointmentEnd, first.timezone)}
        </div>
      ) : null}
      {load.assignment ? (
        <div className="text-muted-foreground" data-testid={`card-${load.reference}-assignment`}>
          {load.assignment.driverName} · #{load.assignment.unitNumber}
        </div>
      ) : null}
    </article>
  );
}
