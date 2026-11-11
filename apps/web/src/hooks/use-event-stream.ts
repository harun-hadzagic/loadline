"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getStream, type StreamEvent, type StreamStatus } from "@/lib/stream-client";
import type { LoadView } from "@/server/loads";

export const LOADS_KEY = ["loads"] as const;
export const POSITIONS_KEY = ["positions"] as const;

/**
 * The cache bridge: mounted once per tab (in Providers), so events are applied
 * to the TanStack Query cache whether or not the board is on screen. A load
 * event carries only {version, status}; the row itself is fetched, and it is
 * only written to the cache when it is at least as new as what the cache
 * holds. A row id counts as "applied" only after that succeeded; a failed
 * fetch invalidates the list instead, so nothing is silently lost. On every
 * hello (first connection and each reconnect) the lists are refetched: that
 * closes the gap between a page's server-rendered data and the moment the hub
 * added this client.
 */
export function useStreamBridge(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const stream = getStream();
    const off = stream.subscribe((event) => void apply(event));

    async function apply(event: StreamEvent): Promise<void> {
      try {
        if (event.type === "hello" || event.type === "resync") {
          await Promise.all([
            qc.invalidateQueries({ queryKey: LOADS_KEY }),
            qc.invalidateQueries({ queryKey: POSITIONS_KEY }),
            qc.invalidateQueries({ queryKey: ["fleet"] }),
          ]);
          return;
        }
        if (
          event.type === "load.created" ||
          event.type === "load.updated" ||
          event.type === "stop.arrived"
        ) {
          if (!event.entityId) return;
          const version = Number(event.payload.version ?? 0);
          const cached = qc
            .getQueryData<LoadView[]>(LOADS_KEY)
            ?.find((l) => l.id === event.entityId);
          if (cached && version && cached.version >= version && event.type !== "stop.arrived") {
            stream.markApplied(event.id); // older than what we have: nothing to do
            return;
          }
          const res = await fetch(`/api/loads/${event.entityId}`, { cache: "no-store" });
          if (res.status === 404) {
            qc.setQueryData<LoadView[]>(LOADS_KEY, (old) =>
              old?.filter((l) => l.id !== event.entityId),
            );
            stream.markApplied(event.id);
            return;
          }
          if (!res.ok) throw new Error(`fetch load ${res.status}`);
          const { load } = (await res.json()) as { load: LoadView };
          qc.setQueryData<LoadView[]>(LOADS_KEY, (old) => mergeLoad(old ?? [], load));
          stream.markApplied(event.id);
          return;
        }
        if (event.type === "position.updated") {
          // The map keeps its own cache of positions; the payload is complete.
          stream.markApplied(event.id);
          return;
        }
        if (event.type.startsWith("driver.") || event.type.startsWith("truck.")) {
          await Promise.all([
            qc.invalidateQueries({ queryKey: ["fleet"] }),
            qc.invalidateQueries({ queryKey: LOADS_KEY }),
          ]);
          stream.markApplied(event.id);
        }
      } catch (err) {
        console.warn("[stream] could not apply event; refetching", err);
        await qc.invalidateQueries({ queryKey: LOADS_KEY });
      }
    }

    return off;
  }, [qc]);
}

/** The connection status for indicators. */
export function useStreamStatus(): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  useEffect(() => getStream().onStatus(setStatus), []);
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
