"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Map as MapLibreMap, Marker, NavigationControl, Popup } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { ConnectionIndicator } from "@/components/connection-indicator";
import { LOADS_KEY, POSITIONS_KEY, useStreamStatus } from "@/hooks/use-event-stream";
import { inZone } from "@/lib/format";
import { getStream } from "@/lib/stream-client";
import type { LoadView } from "@/server/loads";
import type { TruckPositionView } from "@/server/positions";
import "maplibre-gl/dist/maplibre-gl.css";

// OpenFreeMap: no key, no per-load billing. Without internet the base map stays
// blank and the markers still work.
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

interface Props {
  initialPositions: TruckPositionView[];
  initialLoads: LoadView[];
  companyTimezone: string;
}

function colorFor(p: TruckPositionView): string {
  if (p.loadStatus === "in_transit") return "#2563eb"; // moving on a load
  if (p.loadStatus === "assigned") return "#f59e0b"; // heading to a pickup
  return "#6b7280"; // idle
}

export function TruckMap({ initialPositions, initialLoads, companyTimezone }: Props) {
  const status = useStreamStatus();
  const qc = useQueryClient();
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const stopMarkers = useRef<Marker[]>([]);
  const [baseMapError, setBaseMapError] = useState<string | null>(null);

  const { data: positions = [] } = useQuery<TruckPositionView[]>({
    queryKey: POSITIONS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/positions", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load positions.");
      return ((await res.json()) as { positions: TruckPositionView[] }).positions;
    },
    initialData: initialPositions,
  });
  const { data: loads = [] } = useQuery<LoadView[]>({
    queryKey: LOADS_KEY,
    queryFn: async () => {
      const res = await fetch("/api/loads?status=assigned,in_transit", { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load loads.");
      return ((await res.json()) as { loads: LoadView[] }).loads;
    },
    initialData: initialLoads,
  });

  // Positions arrive in the event payload: update the cache without a refetch.
  useEffect(() => {
    const stream = getStream();
    return stream.subscribe((event) => {
      if (event.type !== "position.updated" || !event.entityId) return;
      const p = event.payload as {
        lat: number;
        lng: number;
        heading: number | null;
        speedMph: number | null;
        recordedAt: string;
      };
      qc.setQueryData<TruckPositionView[]>(POSITIONS_KEY, (old) => {
        const list = old ?? [];
        const i = list.findIndex((x) => x.truckId === event.entityId);
        if (i === -1) {
          void qc.invalidateQueries({ queryKey: POSITIONS_KEY });
          return list;
        }
        const current = list[i] as TruckPositionView;
        if (current.recordedAt >= p.recordedAt) return list;
        const next = [...list];
        next[i] = { ...current, ...p };
        return next;
      });
    });
  }, [qc]);

  // The map itself.
  useEffect(() => {
    if (!container.current || map.current) return;
    const first = positions[0];
    const m = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      center: first ? [first.lng, first.lat] : [-96.8, 32.78],
      zoom: 5,
      attributionControl: { compact: true },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.on("error", (e) => {
      const message = String((e as { error?: { message?: string } }).error?.message ?? "");
      if (message.match(/Failed to fetch|NetworkError|style/i)) {
        setBaseMapError(
          "Base map tiles are unavailable (no internet?). Trucks and stops still show.",
        );
      }
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      markers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Truck markers follow the positions cache.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const p of positions) {
      seen.add(p.truckId);
      let marker = markers.current.get(p.truckId);
      const popupHtml = `<div style="font:12px system-ui"><strong>#${p.unitNumber}</strong> · ${p.equipment.replace("_", " ")}<br/>${p.driverName ?? "no driver"}${p.loadReference ? ` · ${p.loadReference} (${p.loadStatus?.replace("_", " ")})` : ""}<br/>${p.speedMph ?? 0} mph · ${inZone(p.recordedAt, companyTimezone, { second: "2-digit" })}</div>`;
      if (!marker) {
        const el = document.createElement("div");
        el.dataset.testid = `truck-marker-${p.unitNumber}`;
        el.style.cssText =
          "width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,.4);cursor:pointer";
        marker = new Marker({ element: el })
          .setLngLat([p.lng, p.lat])
          .setPopup(new Popup({ offset: 10 }).setHTML(popupHtml))
          .addTo(m);
        markers.current.set(p.truckId, marker);
      } else {
        marker.setLngLat([p.lng, p.lat]);
        marker.getPopup()?.setHTML(popupHtml);
      }
      const el = marker.getElement();
      el.style.background = colorFor(p);
      el.dataset.lat = String(p.lat);
      el.dataset.lng = String(p.lng);
    }
    for (const [id, marker] of markers.current) {
      if (!seen.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
  }, [positions, companyTimezone]);

  // Stops of active loads.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const s of stopMarkers.current) s.remove();
    stopMarkers.current = [];
    for (const l of loads) {
      if (l.status !== "assigned" && l.status !== "in_transit") continue;
      for (const s of l.stops) {
        const el = document.createElement("div");
        el.style.cssText = `width:10px;height:10px;border:2px solid ${s.kind === "pickup" ? "#16a34a" : "#dc2626"};background:${s.arrivedAt ? "#fff" : "transparent"};transform:rotate(45deg)`;
        el.title = `${l.reference} ${s.kind} · ${s.city}, ${s.state}`;
        stopMarkers.current.push(
          new Marker({ element: el })
            .setLngLat([s.lng, s.lat])
            .setPopup(
              new Popup({ offset: 8 }).setHTML(
                `<div style="font:12px system-ui"><strong>${l.reference}</strong> ${s.kind}<br/>${s.facilityName ?? ""} ${s.city}, ${s.state}${s.arrivedAt ? "<br/>arrived" : ""}</div>`,
              ),
            )
            .addTo(m),
        );
      }
    }
  }, [loads]);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-2">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Map</h1>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-3 rounded-full bg-[#2563eb]" /> in transit
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-3 rounded-full bg-[#f59e0b]" /> to pickup
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="inline-block size-3 rounded-full bg-[#6b7280]" /> idle
          </span>
          <ConnectionIndicator status={status} />
        </div>
      </div>
      {baseMapError ? <p className="text-xs text-amber-700">{baseMapError}</p> : null}
      <div
        ref={container}
        className="flex-1 rounded-lg border"
        data-testid="truck-map"
        data-trucks={positions.length}
      />
    </div>
  );
}
