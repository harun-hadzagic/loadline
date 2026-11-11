# Loadline

`SPEC.md` at the repo root is the full build spec and the source of truth. Read it completely before writing code. Its **This build run** section overrides anything later in it that disagrees.

In short: one unattended run through Phases 1 to 6; no Anthropic API calls; no deploy, push, tag or publish; US market; all data synthetic.

# Rules for Claude Code

## How to work

1. Read this whole spec first. Its This build run section overrides anything else in it.
2. Work one phase at a time, in order. End each with its checks passing, a commit and an entry in `PROGRESS.md`, then go straight on. Run long jobs in the background and poll their logs. Use subagents where they help: a fresh-context reviewer at the end of each phase, and smaller models for mechanical work.
3. Do not stop to ask. When something is missing, unclear or seems wrong, take the option most consistent with this spec, write a decision record, and continue. Where only Harun can supply something, stub it behind a clear error, add it to `HANDOFF.md`, and keep going; never hide a gap behind a silent mock.
4. Never call the Anthropic API, spend money, deploy, push, tag or publish anything.
5. Never invent a number. Every figure in the README comes from a committed results file that a script produced.
6. Database rules belong in the database. Isolation, overlap, transitions and events are enforced in SQL and proved by tests against a real PostgreSQL; never mock the database in a test that claims to check one of them.
7. Every query in the app runs inside `withTenant`. No exceptions, and a test enforces it.
8. Never commit secrets, `.env`, benchmark databases or downloaded source files. List every variable in `.env.example`.
9. All data is synthetic. No real brokers, carriers, people or documents, and nothing from Harun's former employer.
10. Write a short decision record in `docs/decisions/` for each choice below and for anything that departs from this spec: the context, the decision, and what was rejected.
11. Keep `docs/building-with-ai.md`: per phase, what Claude Code wrote, what its reviewer caught, and where it was wrong. It feeds the README.
12. Make small commits, one concern each, with messages that say why.

Decision records to write: row-level security over filters in application code; an outbox with `NOTIFY` over a message broker, and when to replace it; the visibility-safe cursor; temporal constraints over an application check; server-sent events over WebSockets; self-hosting over serverless; the stream role with `BYPASSRLS`; the state-to-time-zone approximation; the PostGIS image on Apple Silicon.

## Engineering conventions

- Strict TypeScript, ES modules only, Node.js 24 or later, pnpm, Biome, Vitest, Playwright, and Zod for runtime validation.
- Migrations are SQL files reviewed by hand and committed; nothing changes the schema at run time.
- Unit tests never touch the network. Database tests use the test database service and start from a clean schema.
- Time zones: store `timestamptz`; show appointment times in the stop's local zone and everything else in the company's zone.
- Workflows get least-privilege `permissions`, third-party actions are pinned to commit SHAs, and nothing uses `pull_request_target`.

## README checklist for v0.1.0

- [ ] The first line says what it is and for whom.
- [ ] The two-browser GIF from `docs/media/`.
- [ ] Three results tables generated from `bench/results`: sync latency, geospatial with and without the index, intake accuracy (baseline measured, Claude "not yet measured").
- [ ] Quick start: copy `.env.example`, `docker compose up`, open `http://localhost:3000`, and the demo logins.
- [ ] How it works: the architecture diagram and links to the decision records.
- [ ] A "Why it is built this way" section: the five interview questions below, each answered in two or three sentences with a link to the code or SQL.
- [ ] Limits: straight-line distances, the city table instead of geocoding, the `NOTIFY` lock, single-process fan-out, no hours-of-service rules, intake measured on synthetic documents only.
- [ ] How this was built: what Claude Code generated, what was verified, and where the AI was wrong.
- [ ] A placeholder paragraph marked `TODO(Harun)` for two sentences on what he saw go wrong in three years of dispatch and which feature answers it. Claude Code does not write this paragraph.
- [ ] A CI badge and one sentence on what the tests cover.

The five questions: Why row-level security instead of a `WHERE` clause in every query? Two dispatchers assign the same load in the same second; what happens? What does a browser miss while it is offline, and how does it catch up? `NOTIFY` takes a global lock at commit; when does that start to hurt, and what would you move to? How do you know the intake is good enough to trust?

## HANDOFF.md

At the end, write `HANDOFF.md` with: the final test-suite result at the top; how to run it locally; the three results; Harun's steps in order (create the GitHub repo and push, check the first CI run, run the live intake eval with a key and commit its result, write the dispatch paragraph, tag v0.1.0); and known gaps.
