"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { useStreamBridge } from "@/hooks/use-event-stream";

/** Keeps the event stream applying to the cache for the whole tab, whatever page is open. */
function StreamBridge() {
  useStreamBridge();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <StreamBridge />
      {children}
    </QueryClientProvider>
  );
}
