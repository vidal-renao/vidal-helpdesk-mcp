# TESTING.md

## Strategy

This project uses **Vitest unit tests with mocked boundaries** — no live Supabase, Anthropic, or Resend calls in CI, and no end-to-end test environment. Every external dependency (`src/lib/supabase.ts`, `src/lib/ai.ts`, `resend`) is mocked via `vi.mock`, so tests assert on *what the code asked the boundary to do* (which table, which filter, which payload) rather than on real network/DB behavior.

There is currently no integration or e2e layer. If one is added later, it should run against a disposable Supabase branch, not production data — do not point tests at a real project's service-role key.

## Layout

```text
tests/
  helpers/
    supabase-mock.ts       # shared chainable/thenable Supabase query-builder mock
  audit.test.ts             # api/cron/audit.ts — CORS, auth, claim/skip orchestration, Resend failure handling
  audit-runs.test.ts        # claimAuditRunSlot unit logic — insert-wins, reclaim, race, stale-pending, period/recipient isolation
  audit-template.test.ts    # email rendering — companies, VIP risks, empty states, HTML escaping, mobile width
  sla-audit.test.ts         # buildSlaAuditReport — company grouping, sla_status, vip_risk, ordering, no double-counting
  get-sla-audit-report.test.ts
  health-audit.test.ts      # api/health/audit.ts — auth, health check shape
  create-ticket.test.ts
  get-ticket-status.test.ts
  list-tickets.test.ts
  prioritize-incident.test.ts
  suggest-solution.test.ts
  update-ticket-status.test.ts
  generate-report.test.ts
```

Every MCP tool in `src/tools/` has a corresponding test file exercising its exported handler function directly (not through the MCP transport or `createValidatedToolHandler` — schema validation itself isn't re-tested per tool since it's Zod's behavior, already exercised generically).

`audit.test.ts` no longer mocks Supabase directly — since 2026-07-22 it mocks `audit-runs.js` (`claimAuditRunSlot`/`markAuditRunSent`/`markAuditRunFailed`) and `sla-audit.js` (`buildSlaAuditReport`) wholesale, so it stays focused on HTTP/CORS/auth/orchestration. The underlying claim logic has its own dedicated unit tests in `audit-runs.test.ts` against a mocked `getHelpdeskSchema()`, and the aggregation logic has its own in `sla-audit.test.ts` against mocked `getDomainSchema()`/`getPublicSchema()`. Don't collapse these back into one file — they were split because each needs a different mock shape and testing them together made failures hard to localize.

## The shared mock (`tests/helpers/supabase-mock.ts`)

`createQuery(result)` returns an object where every Supabase filter-builder method (`select`, `eq`, `in`, `order`, `limit`, `gte`, `returns`, `insert`, `update`, `upsert`, `delete`) returns itself (chainable), `.single()`/`.maybeSingle()` resolve to `result`, and the object is itself thenable — so it works whether the tool code calls `.single()` or just `await`s the query directly.

`createFromQueue(entries)` builds a `from(table)` mock that returns queued query objects in call order, asserting the table name matches what's expected at each position. Use this whenever a tool calls `.from()` more than once (e.g. a `select` to fetch a ticket, then an `update`/`insert` on the same or a different table) — the queue enforces the real call order instead of silently reusing one mock for every call.

When adding a new tool test, prefer this helper over hand-rolling a new mock shape.

## Commands

```bash
npm test          # vitest run — CI mode, single pass
npm run test:watch
npm run lint       # tsc --noEmit — run alongside tests, not a substitute for them
npm run build      # tsc — must succeed after any change
```

## What's covered vs. not

Covered: all 8 MCP tool handlers' main success paths, their not-found/error paths, the confidence-threshold gating logic, the audit endpoint's CORS/auth/orchestration behavior, the health endpoint, the SLA aggregation's company grouping/status classification/ordering, the email template's rendering and HTML escaping, and the idempotency claim logic (first-claim-wins, already-sent skip, in-progress skip, failed-row reclaim, stale-pending reclaim, and the race case where a concurrent reclaim attempt loses).

"Concurrent invocations produce one accepted delivery" is tested at the `claimAuditRunSlot` unit level by asserting the *shape* of the reclaim race (a conditional `UPDATE ... WHERE status = 'failed'` that matches zero rows when another process already won) rather than by spinning up literal concurrent requests — Vitest's mocked Supabase client can't model real Postgres row-locking, so the atomicity guarantee itself rests on the database (a single `UPDATE ... WHERE` statement), not on anything the test can observe directly. Trust the Postgres semantics documented in `ARCHITECTURE.md`, not the test, for that guarantee.

Not covered, and out of scope for unit tests: `src/index.ts` / `src/vercel-server.ts` transport wiring (would require a real MCP client or SSE harness), the actual Anthropic prompt output quality (that's a model behavior, not code), CORS behavior against a real browser preflight.

## Opt-in PostgreSQL

`tests/postgres.integration.test.ts` runs only with `TEST_DATABASE_URL`,
rejects production-looking URLs, requires `application_name=vidal_mcp_test`,
creates/drops its own schema, and uses two connections. Install optional `pg`.

## Minimum bar for new work

- A new or changed tool handler needs at least: one success-path test, one "not found"/empty-result test if the handler has that branch, and one test for any confidence/threshold/branching logic it introduces.
- A new query added to an existing tool must be reflected in that tool's test mocks — don't let a test pass by coincidence because the mock never asserts the new call happened.
- Don't add tests that only assert a mock was called with itself (tautological tests) — assert on the actual payload/branch outcome.
