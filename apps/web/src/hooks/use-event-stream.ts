"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getStream, type StreamEvent, type StreamStatus } from "@/lib/stream-client";
import type { LoadView } from "@/server/loads";

export const LOADS_KEY = ["loads"] as const;

/**
 * Apply stream events to the TanStack Query cache by entity id and version.
 * A load event carries only {version, status}; the row itself is fetched, and
 * it is only written to the cache when it is at least as new as what the
 * cache holds. That makes duplicate or late delivery harmless.
 */
export function useEventStream(): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    const stream = getStream();
    const offStatus = stream.onStatus(setStatus);
    const off = stream.subscribe((event) => void apply(event));

    async function apply(event: StreamEvent): Promise<void> {
      if (event.type === "resync") {
        await qc.invalidateQueries({ queryKey: LOADS_KEY });
        return;
      }
      if (event.type === "load.created" || event.type === "load.updated") {
        if (!event.entityId) return;
        const version = Number(event.payload.version ?? 0);
        const cached = qc.getQueryData<LoadView[]>(LOADS_KEY)?.find((l) => l.id === event.entityId);
        if (cached && cached.version >= version) return; // older than what we have
        const res = await fetch(`/api/loads/${event.entityId}`, { cache: "no-store" });
        if (res.status === 404) {
          qc.setQueryData<LoadView[]>(LOADS_KEY, (old) =>
            old?.filter((l) => l.id !== event.entityId),
          );
          return;
        }
        if (!res.ok) return;
        const { load } = (await res.json()) as { load: LoadView };
        qc.setQueryData<LoadView[]>(LOADS_KEY, (old) => mergeLoad(old ?? [], load));
        return;
      }
      if (event.type.startsWith("driver.") || event.type.startsWith("truck.")) {
        await qc.invalidateQueries({ queryKey: ["fleet"] });
      }
    }

    return () => {
      off();
      offStatus();
    };
  }, [qc]);

  return status;
}

export function mergeLoad(list: LoadView[], load: LoadView): LoadView[] {
  const i = list.findIndex((l) => l.id === load.id);
  if (i === -1) return [...list, load];
  const current = list[i];
  if (current && current.version > load.version) return list;
  const next = [...list];
  next[i] = load;
  return next;
}
