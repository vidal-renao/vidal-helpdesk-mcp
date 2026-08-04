# DECISIONS.md — Architecture Decision Records (simplified)

Each entry: what was decided, and why, as best reconstructed from the code and git history. New decisions should be appended, not inserted retroactively.

## ADR-015 — Phase 1 security decisions (2026-07-25)

Require distinct MCP/audit bearer secrets and treat CORS as secondary. Use
`pending -> sending -> sent|failed|delivery_unknown`, stable payloads, and
`sla-audit/<audit_run_id>`; never auto-reclaim ambiguous states. Remove the
unregistered, build-breaking Composio experiment (recoverable in `bb4b9c2`) and
ignore `.vercel` project metadata.

## ADR-001 — Dual MCP transport (stdio + remote HTTP) from one tool set

**Decision**: Define the 7 tools once conceptually, but register them separately in `src/index.ts` (stdio) and `src/vercel-server.ts` (SSE), rather than sharing a single server instance.
**Why**: stdio serves local/desktop MCP clients; SSE serves remote clients through Vercel. MCP's SDK ties a server instance to one transport connection at a time, and Vercel functions are stateless per-invocation, so a fresh `McpServer` is constructed per SSE session in `vercel-server.ts`.
**Consequence**: tool registration is duplicated across two files (see `AGENTS.md`) — a known maintenance cost, not yet worth abstracting away for 7 tools.

## ADR-002 — Service-role Supabase access with application-level org scoping

**Decision**: Use `SUPABASE_SERVICE_ROLE_KEY` for all database access, and enforce organization isolation via `.eq("organization_id", ...)` in every query rather than relying on Postgres RLS.
**Why**: this service runs as a trusted backend automation layer (MCP tools + a cron job), not a user-facing API — there is no per-request user session to hand RLS a JWT for.
**Consequence**: the database provides no backstop against a missing filter. See `SECURITY.md`. Any new query must be reviewed for this explicitly.

## ADR-003 — One organization per deployment, not multi-tenant routing

**Decision**: `MCP_ORGANIZATION_ID` is a single env var, not derived from the caller or request.
**Why**: this repo was built for one Swiss SME organization ("vidal-lab"), and the ticket-system schema it consumes is multi-tenant-*capable* but this consumer doesn't need to be.
**Consequence**: features that assume multi-tenant behavior (e.g. routing audit emails per-organization) don't apply here without first changing this decision. Documented explicitly so it isn't rediscovered as a "bug" later — see the 2026-07-21 audit entry in `CHANGELOG.md` for a case where this was initially misread as one.

## ADR-004 — Anthropic Claude for triage and solution generation

**Decision**: Use `@anthropic-ai/sdk` with a fixed model string (`claude-sonnet-4-20250514`) for both ticket triage and solution generation, prompted to return strict JSON.
**Why**: Claude's instruction-following on structured JSON output was judged sufficient without a schema-constrained API.
**Consequence**: the model id is a dated snapshot with no fallback or override. Revisit if/when it's deprecated upstream — track this as a P2 in `ROADMAP.md`, not an urgent fix, since it currently works.

## ADR-005 — Resend for audit email delivery

**Decision**: Use Resend rather than raw SMTP for the scheduled SLA audit email.
**Why**: matches the `resend` dependency and `RESEND_API_KEY`/`RESEND_FROM_EMAIL` env vars already in place; simple API for a single templated transactional email.
**Consequence**: `AUDIT_RECIPIENT_EMAIL` (added 2026-07-21) is the only per-deployment configuration point for where that email goes; see ADR-003 for why there's one recipient, not one per organization.

## ADR-006 — Zod for both env and tool-input validation

**Decision**: Validate `process.env` through a single Zod schema (`src/lib/env.ts`, parsed fresh per call) and every MCP tool input through a per-tool Zod schema wrapped by `createValidatedToolHandler`.
**Why**: fail fast and structured — a malformed tool call returns a typed error payload instead of an uncaught exception or a confusing downstream Supabase/Anthropic failure.
**Consequence**: any new tool or env var must follow this pattern; skipping it is a review flag, not a style choice.

## ADR-007 — No HTTP framework on the Vercel functions (2026-07-21 audit finding, pre-existing decision)

**Decision**: `src/vercel-server.ts`, `api/cron/audit.ts`, and `api/health/audit.ts` handle raw `http.IncomingMessage`/`ServerResponse` directly instead of using Express/Hono/Fastify.
**Why**: minimal dependency surface for small, low-traffic serverless functions; CORS and routing needs are simple enough to hand-roll (`src/lib/cors.ts`).
**Consequence**: `@modelcontextprotocol/sdk`'s own transitive dependency on Hono (flagged in `npm audit`) is unrelated to this decision — this project never imports Hono itself.

## ADR-008 — Remove stack traces from HTTP error responses (2026-07-21)

**Decision**: `api/cron/audit.ts`'s 500 handler no longer includes `error.stack` in the JSON response body.
**Why**: an unauthenticated-by-default endpoint (when `AUDIT_CRON_SECRET` is unset) returning full server stack traces on any failure is an information-disclosure risk with no offsetting benefit — server-side `logError()` already captures the error message for operators.
**Consequence**: the corresponding test (`tests/audit.test.ts`) was updated to assert `json.stack` is `undefined` instead of asserting it's a string.

## ADR-009 — Extend the existing `helpdesk.audit_runs` table rather than create a new one (2026-07-22)

**Decision**: When fixing the broken audit-dedupe table, extend the existing `helpdesk.audit_runs` (274 historical rows, last written 2026-05-22) in place via `ALTER TABLE`, rather than creating a fresh table.
**Why**: investigation found the table already existed with real history — the actual bug was that `src/lib/audit-runs.ts` queried `SUPABASE_SCHEMA` (`"public"` in production) instead of the literal `helpdesk` schema this table has always lived in, so every dedupe check and insert since 2026-05-22 silently failed against a nonexistent `public.audit_runs`. `src/lib/supabase.ts` already had an unused `getHelpdeskSchema()` helper, seemingly written for exactly this purpose and never wired up. Creating a second, parallel table would have left the 274 real historical rows orphaned and duplicated the mistake's symptom (two "audit_runs"-shaped tables, one dead) instead of fixing its cause.
**Consequence**: `supabase/migrations/20260722000000_audit_runs_period_idempotency.sql` is an `ALTER TABLE`, not a `CREATE TABLE`. `auditRunsTable()` in `audit-runs.ts` now calls `getHelpdeskSchema()` explicitly, independent of `SUPABASE_SCHEMA` (which continues to govern ticket-domain tables only).

## ADR-010 — Atomic per-UTC-day claim instead of a fingerprint/time-window dedupe (2026-07-22)

**Decision**: Replace the old "insert a fingerprint of current stats, then look back N minutes for a matching fingerprint" dedupe with an atomic claim against a `(organization_id, report_type, reporting_period_start, recipient)` unique constraint, where `reporting_period_start` is the UTC calendar day.
**Why**: the old design didn't actually guarantee "at most one email per day" — it only suppressed a *repeat* send if the underlying stats hadn't changed within `AUDIT_EMAIL_DEDUPE_MINUTES`. If ticket counts changed between two runs an hour apart, both would send, regardless of dedupe window. The explicit requirement (verified against the 9-duplicate-email incident on 2026-07-21) is "one report per calendar day," which needs a stable period key, not a data fingerprint.
**Consequence**: `claimAuditRunSlot`/`markAuditRunSent`/`markAuditRunFailed` in `audit-runs.ts` fully replace `findRecentAuditRun`. `AUDIT_EMAIL_DEDUPE_MINUTES` is removed from `env.ts`, `.env.example`, and the health endpoint response — it would otherwise be a documented config knob with no effect, which is worse than not having it. If it's set in an existing Vercel deployment's environment variables, it's simply ignored (Zod strips unknown keys). Reporting periods are UTC, not `Europe/Zurich` — chosen for infra simplicity over Swiss-business-hours framing; revisit only if the report's audience explicitly needs the day boundary to match Zurich midnight.

## ADR-011 — Company resolution via a batched two-hop application-level join, no migration (2026-07-22)

**Decision**: Resolve company information in bounded batches of at most 100
requester IDs. Query count is one tickets query, one organization query, plus
`ceil(min(distinct requester IDs, 1000) / 100)` customer queries.
**Why**: bounded batching avoids N+1 behavior without claiming a fixed query
count.

## ADR-015 — Stateless Streamable HTTP and conservative delivery

Remote MCP creates a sessionless Streamable HTTP transport for each
authenticated `POST /mcp`; legacy SSE routes return 410. Provider errors are
ambiguous unless rejection is proven. Retries use the persisted snapshot.

## ADR-016 — Temporary dependency-risk acceptance

**Owner**: repository owner and security lead.

SDK, Resend and Vitest upgrades remain separate from Phase 2 functional
commits. The workflow stays disabled while production advisories are evaluated.

**Exit condition**: a separate dependency commit passes Node 20 and protocol
tests and records an advisory-by-advisory fix or time-bounded acceptance for
every reachable high or critical vulnerability.
**Consequence**: `company_id` in `get_sla_audit_report`'s output is a `profiles.id`, not a foreign key into a `companies` table (none exists). If `tickets.created_by → profiles` is ever given a real FK constraint, this code doesn't need to change — it doesn't depend on the constraint existing, only on the values being consistent, which they already are.

## ADR-012 — `project_id`/`project_name` are always `null` — no ticket-to-project relationship exists (2026-07-22)

**Decision**: Do not wire the existing `projects` table (a software-deployment registry: `vercel_project_id`, `github_repo`, `lighthouse_score`) into ticket data. `get_sla_audit_report` and the audit email always report `project_id: null, project_name: null`.
**Why**: verified via live foreign-key constraints that `projects` is referenced only by `deployment_events` and `security_advisories` — an unrelated bounded context (this ecosystem's deployment/ops tracker), not customer projects tied to support tickets. Joining them would associate a ticket with an arbitrary, meaningless deployment record — worse than reporting `null`.
**Consequence**: this is a confirmed, documented domain gap, not an oversight. If a genuine ticket-to-project concept is ever needed, it requires a real schema decision in the owning "ticket-system" application (a new table or column), not a workaround in this repo. See `ROADMAP.md`.

## ADR-013 — New `get_sla_audit_report` tool instead of extending `list_tickets`/`generate_report` (2026-07-22)

**Decision**: Add an 8th MCP tool rather than bolting the company/VIP-risk/action-item shape onto either existing read tool.
**Why**: the requested output (compliance %, per-company breakdown, ordered VIP risks with risk reasons and required actions) is materially different from both existing tools' contracts, and both already have real test coverage and (potentially) real MCP-client consumers — changing their output shape risks breaking backward compatibility for no benefit. The new tool also gave a clean seam to extract `src/lib/sla-audit.ts` as one aggregation shared by both the tool and the audit email, rather than computing SLA/VIP logic twice.
**Consequence**: `list_tickets` and `generate_report` are unchanged — verified by their existing test suites passing without modification.

## ADR-014 — Cron changed from hourly to once daily (2026-07-22)

**Decision**: `.github/workflows/audit.yml`'s schedule changed from `"0 * * * *"` (hourly) to `"0 6 * * *"` (06:00 UTC daily).
**Why**: the workflow and email are both branded "Daily SLA Report" — hourly execution was never the intended cadence, and was a root-cause contributor (alongside the broken dedupe table, ADR-009) to 9 duplicate emails on 2026-07-21. The per-day idempotency claim (ADR-010) makes duplicate sends impossible regardless of cron frequency, but leaving it hourly would still waste ~23 no-op invocations a day.
**Consequence**: if a future requirement genuinely needs more-than-daily reporting, that's a deliberate product decision requiring a distinct `report_type` (so it doesn't collide with the daily slot's idempotency key) — not a cron-frequency change alone.

## ADR-017 — `audit_runs` is reached through a `public` view, not by exposing the `helpdesk` schema (2026-07-28)

**Context**: between 2026-07-26 21:12 UTC (deployment of the delivery state machine, commit `17bf9a0`) and 2026-07-28, every scheduled Audit run reported success and delivered nothing. The owner's last real report was 2026-07-25 13:08 CEST, sent by the *previous* deployment.

**Root cause** — verified, not inferred:

```
$ curl "$SUPABASE_URL/rest/v1/audit_runs?select=id" -H "Accept-Profile: helpdesk"
{"code":"PGRST106","message":"Invalid schema: helpdesk",
 "hint":"Only the following schemas are exposed: public, omnisciencia, aura_core"}
```

`src/lib/audit-runs.ts` reached the ledger with `.schema("helpdesk")`, but this Supabase project's PostgREST exposes only `public, omnisciencia, aura_core`. Every claim `INSERT` failed with `PGRST106`; `claimAuditRunSlot` special-cases only `23505`, so it degraded to an opaque `claim_failed`, `AuditService` returned a *successful-looking* no-op, and `api/cron/audit.ts` answered HTTP 200.

**Decision**: add `public.audit_runs`, a `security_invoker`, service_role-only view over `helpdesk.audit_runs`, and write through it. Do **not** add `helpdesk` to `pgrst.db_schemas`.

**Why not expose the schema**: `pgrst.db_schemas` is an instance-wide setting on a Supabase project shared with several unrelated products (`omnisciencia`, `aura_core`, `lumen_invoice`, `cuadrante`); it lives outside git and outside CI; and `anon`/`authenticated` still held blanket `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` on `helpdesk.audit_runs`, so exposing the schema would have published an audit ledger to the public API surface. The same migration revokes those grants — they were unreachable only by obscurity.

**Consequence**: the ledger keeps its `helpdesk` home, its 274 historical rows, its constraints and its idempotency key untouched. `security_invoker = true` is load-bearing: without it the view would execute as its owner and bypass the base table's RLS for anyone able to read it. Rolling the view back makes the endpoint fail closed (`claim_failed`) — it can never produce a duplicate or an unintended send.

## ADR-018 — A run that delivered nothing must not answer HTTP 200 (2026-07-28)

**Decision**: `api/cron/audit.ts` derives its status code from the logical outcome (`src/lib/audit-outcome.ts`), and `.github/workflows/audit.yml` independently asserts the response contract.

**Why**: the outage above was invisible for three days because *two* layers each assumed the other was checking. The endpoint returned 200 for any outcome that did not throw, and the workflow asserted nothing beyond the status line — so `{"emailSent":false,"emailSkippedReason":"claim_failed"}` was a green build. Only two states now count as success: `emailSent === true`, or `already_sent` (which `claimAuditRunSlot` only reports after re-reading the persisted row and confirming `status='sent'` for that exact organization/report-type/period/recipient key — a verified prior delivery, not an assumption). `disabled` → 503, `in_progress` → 409, everything else → 500, including any skip reason added in the future: the classifier fails closed by construction.

**Consequence**: the two checks are deliberately redundant. A regression in either layer alone can no longer produce a false green. `claim_failed` is additionally logged at error level with the underlying database error code attached, so the next occurrence of this failure class is diagnosable from one log line instead of a three-day investigation.

## ADR-019 — Liveness is proved by an external dead-man's switch, not by this repository (2026-08-01)

**Context**: ADR-018 closed the "run executed and delivered nothing" hole. It leaves open the strictly larger one: **no run at all**. GitHub disables scheduled workflows after 60 days of repository inactivity, Actions has outages, and a workflow can be deleted or broken above the assertion. None of those produce a failed build — they produce nothing, and the only remaining symptom is an email the owner may not notice is missing. That is the same silence that hid the 2026-07-26 outage for three days.

**Decision**: the audit job's last step pings an external monitor (healthchecks.io, `HC_PING_URL`), conditional on the contract assertion having passed. The absence of a ping — not the presence of an error — is the alert, and the alert is raised by a system this repository does not run.

**Why an external service rather than a second workflow**: a watchdog workflow querying `audit_runs` on an offset cron was the obvious in-house alternative, but it shares its availability, its scheduler and its 60-day disable rule with the thing it watches, so it cannot detect the largest failure class in the list above. A detector must not share a failure mode with its subject. For the same reason the notification channel must not be Resend, which sits inside the delivery path being monitored.

**Why the step fails when `HC_PING_URL` is unset**: a disarmed switch that reports success is the exact anti-pattern of ADR-018. The ping is the final step and delivery has already completed by then, so failing here never costs a report — it costs a red build that accurately says the monitor is not armed.

**Consequence**: the alerting configuration (check period, grace, notification channel) lives outside git and outside CI, so it cannot be reviewed here. That is the price of independence and it is deliberate; the README documents the setup and the coverage matrix, and the residual uncovered case — the monitoring account or its channel silently breaking — is stated there rather than assumed away. Grace is 6h because observed GitHub queue delay puts the 06:00 UTC run between 08:30 and 10:04 UTC, which admits legitimate ping gaps of nearly 28h.
