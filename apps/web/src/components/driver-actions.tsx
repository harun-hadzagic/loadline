"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { transitionLoadAction } from "@/server/actions";
import type { LoadView } from "@/server/loads";

export function DriverActions({ load }: { load: LoadView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (to: "in_transit" | "delivered", label: string) =>
    start(async () => {
      const r = await transitionLoadAction({ loadId: load.id, version: load.version, to });
      if (!r.ok) {
        setError(r.message);
        toast.error(r.message);
      } else {
        setError(null);
        toast.success(label);
      }
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2 pt-2">
      {load.status === "assigned" ? (
        <Button
          size="lg"
          className="h-12 text-base"
          disabled={pending}
          onClick={() => go("in_transit", "Marked picked up")}
          data-testid="driver-pickup"
        >
          Picked up
        </Button>
      ) : null}
      {load.status === "in_transit" ? (
        <Button
          size="lg"
          className="h-12 text-base"
          disabled={pending}
          onClick={() => go("delivered", "Marked delivered")}
          data-testid="driver-deliver"
        >
          Delivered
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
