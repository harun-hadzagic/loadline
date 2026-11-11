# 0015 · Self-hosting over serverless

**Date:** 2026-11-11 · **Phase:** 3

## Context

The event stream needs one long-lived process: a `LISTEN` connection that stays open, in-memory fan-out to connected browsers, timers for the safety poll, heartbeats and pruning. The spec also rules out any public deployment in 0.1.

## Decision

Next.js with `output: "standalone"`, run as one Node process in Docker Compose (`web` service), alongside the database and the simulator. The hub is created once per process and guarded on `globalThis`.

## Rejected

- Serverless functions (including streaming ones): each invocation is its own process with a lifetime cap, so there is no place for the single listener or the client set; every function would need its own `LISTEN` and its own cursor, and a connection pooler would multiply connections.
- Edge runtimes: no raw TCP, so no PostgreSQL driver and no `LISTEN`.
- A separate stream service: possible later (it is one module), but one process is simpler to run locally, and the design does not need it until there is more than one web replica (decision 0012).
