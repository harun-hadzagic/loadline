/**
 * Next.js calls register() once per server process at boot. Starting the hub
 * here (rather than on the first SSE client) means the LISTEN connection is
 * warm, the safety poll is running, and the 24-hour outbox prune happens even
 * when no board is open. Errors are logged, not thrown: the first SSE client
 * retries start() anyway.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { getHub } = await import("@/server/stream/hub");
  getHub()
    .start()
    .catch((err: unknown) =>
      console.warn("[stream] hub did not start at boot; the first client will retry", err),
    );
}
