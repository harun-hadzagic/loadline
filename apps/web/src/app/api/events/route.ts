import { getContext } from "@/server/context";
import { getHub, nextClientId, type StreamClient } from "@/server/stream/hub";

// The event stream: text/event-stream on the Node runtime, one per browser tab.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const ctx = await getContext().catch(() => null);
  if (!ctx) return new Response("Unauthorized", { status: 401 });

  const hub = getHub();
  const encoder = new TextEncoder();
  let client: StreamClient | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = {
        id: nextClientId(),
        companyId: ctx.companyId,
        role: ctx.role,
        driverId: ctx.driverId,
        send: (chunk) => controller.enqueue(encoder.encode(chunk)),
        close: () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      const c = client;
      // The browser sends Last-Event-ID on its own reconnects; a manual
      // reconnect (after an explicit pause) passes the same cursor as ?after=.
      const after =
        request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
      hub.subscribe(c, after).catch((err) => {
        console.warn("[events] subscribe failed", err);
        hub.unsubscribe(c);
      });
    },
    cancel() {
      if (client) hub.unsubscribe(client);
    },
  });
  request.signal.addEventListener("abort", () => {
    if (client) hub.unsubscribe(client);
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
