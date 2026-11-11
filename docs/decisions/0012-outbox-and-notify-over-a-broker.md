# 0012 · An outbox with `NOTIFY` over a message broker

**Date:** 2026-11-11 · **Phase:** 3

## Context

Every change on the board must reach every open board of the same company, and a browser that was offline must catch up with nothing lost and nothing applied twice. The obvious tools are a message broker (Redis streams, NATS, Kafka) or PostgreSQL's own `LISTEN`/`NOTIFY`.

## Decision

A transactional outbox in PostgreSQL plus `NOTIFY` as a wake-up call:

- `app.emit()` (SECURITY DEFINER, decision 0009) inserts an `app.outbox` row and calls `pg_notify('loadline_events', '')` inside the writing transaction. The write and its event commit together, so a board never hears about a change that was rolled back, and a change can never commit without its event.
- The notification payload is empty on purpose. The stream reads the outbox, which is the source of truth; a lost notification costs latency (a 5-second safety poll catches it), never data.
- One `LISTEN` connection per process (`OutboxReader`, as `loadline_stream`), guarded on `globalThis` so development reloads do not multiply it. Fan-out to connected browsers happens in process (`EventHub`), by company and by driver audience.
- Rows older than 24 hours are pruned by `app.prune_outbox()` from a timer in the hub; a client whose cursor predates the oldest row gets a `resync` event and refetches.

Measured with the sync-latency benchmark (50 clients, 200 writes at 5/s, dev server, one machine): every one of the 10,000 expected deliveries arrived; `bench/results/sync-latency.json` has the percentiles.

## When to replace it

`NOTIFY` takes a global lock at commit, and every committed transaction that notified has to be processed under it. That is invisible at a dispatch board's rate (tens of writes per second at the very most) and starts to hurt in the thousands to tens of thousands of simultaneous committing writers (Recall.ai traced production outages to exactly this). The signals to watch: `LWLock:NotifyQueue` or `NotifySLRU` waits in `pg_stat_activity`, and commit latency rising with the number of writers. The first mitigation is to stop notifying per transaction and rely on the poll alone (the outbox makes `NOTIFY` optional); the second is to move fan-out to a broker fed by the outbox (or logical decoding), which keeps the outbox and its exactly-once replay and changes only how processes learn about new rows.

A second limit is architectural: fan-out is single-process. Two web replicas would each hold a listener and each serve their own browsers correctly, but a sticky-session load balancer or a shared broker is needed before that is worth doing.

## Rejected

- A broker from day one: a second stateful system to run, back up and reason about, for a problem the database already solves at this scale, and the hard part (events that cannot diverge from the data) is what the broker does *not* give you without an outbox anyway.
- Dual writes (write the row, then publish): the classic lost-event bug the outbox exists to prevent.
- Logical replication / CDC: heavier to operate locally and in Compose; a 0.2 option if the board ever needs several processes.
