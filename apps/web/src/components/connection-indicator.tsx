"use client";

import type { StreamStatus } from "@/lib/stream-client";
import { cn } from "@/lib/utils";

const LABEL: Record<StreamStatus, string> = {
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  offline: "offline",
};

export function ConnectionIndicator({ status }: { status: StreamStatus }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="connection-status"
      data-status={status}
    >
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          status === "live" && "bg-emerald-500",
          status === "reconnecting" && "bg-amber-500 animate-pulse",
          status === "connecting" && "bg-amber-400",
          status === "offline" && "bg-red-500",
        )}
      />
      {LABEL[status]}
    </span>
  );
}
