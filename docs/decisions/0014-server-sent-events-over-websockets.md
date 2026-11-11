# 0014 · Server-sent events over WebSockets

**Date:** 2026-11-11 · **Phase:** 3

## Context

Boards need a push channel from the server. The data flow is one-directional: writes already go through fetch and server actions; only the change feed needs to be pushed.

## Decision

`GET /api/events` is a Next.js route handler on the Node runtime returning `text/event-stream`. The browser's built-in `EventSource` does the hard parts for free: automatic reconnection with the `retry:` hint, and `Last-Event-ID` on reconnect, which is exactly the cursor handshake the outbox needs. A comment line every 15 seconds keeps proxies from closing idle connections. The client wrapper (`apps/web/src/lib/stream-client.ts`) adds a connection indicator, de-duplication by row id, and a test hook to cut and restore the stream.

## Rejected

- WebSockets: two-way, which nothing here needs; no built-in reconnect or resume semantics; a separate upgrade path that Next.js route handlers do not serve natively, so it would need a custom server.
- Long polling: more connections, more latency, more code for the same result.
- A hosted push service: an external dependency and a bill, for a feed PostgreSQL already produces.
