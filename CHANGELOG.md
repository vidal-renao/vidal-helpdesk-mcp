# CHANGELOG.md

Format: newest first. Entries before 2026-07-21 are reconstructed from git history, not from prior changelog entries (none existed).

## 2026-07-28 — Root cause of the silent daily-audit outage: the ledger was unreachable through PostgREST

**Fixed**

- **No daily SLA report was delivered between 2026-07-26 and 2026-07-28, while every scheduled run reported success.** The owner's last real report was 2026-07-25 13:08 CEST — sent by the *previous* deployment. Verified root cause:

  ```text
  $ curl "$SUPABASE_URL/rest/v1/audit_runs?select=id" -H "Accept-Profile: helpdesk"
  {"code":"PGRST106","message":"Invalid schema: helpdesk",
   "hint":"Only the following schemas are exposed: public, omnisciencia, aura_core"}
  ```

  `src/lib/audit-runs.ts` reached the ledger with `.schema("helpdesk")`, but this project's PostgREST does not expose that schema. Every claim `INSERT` failed with `PGRST106`; `claimAuditRunSlot` special-cases only `23505`, so it collapsed to an opaque `claim_failed`, and the service returned a successful-looking no-op.

  **This is the second failure of the same underlying gap.** The 2026-07-22 entry below "fixed" the duplicate-email incident by repointing `audit-runs.ts` from `SUPABASE_SCHEMA` (`public.audit_runs` — does not exist) to `getHelpdeskSchema()` (`helpdesk.audit_runs` — exists but is not API-reachable). Both are broken; the earlier one merely failed *open*, so emails still went out while dedupe silently did nothing. Commit `17bf9a0` correctly made delivery conditional on a successful claim — which turned a silent dedupe failure into a silent delivery failure. Neither was caught because nothing ever asserted that an email was actually sent.

  Fixed by adding `public.audit_runs`, a `security_invoker`, service_role-only view over the same table (`supabase/migrations/20260728120000_audit_runs_public_view.sql`), and writing through it. See `DECISIONS.md` ADR-017 for why the `helpdesk` schema was *not* simply exposed.

- **HTTP 200 no longer means "an email was sent."** `api/cron/audit.ts` returned 200 for any outcome that did not throw, and `.github/workflows/audit.yml` asserted nothing beyond the status code, so two independent layers each reported success for a total no-op. The endpoint now derives its status from the logical outcome (`src/lib/audit-outcome.ts`: `disabled` → 503, `in_progress` → 409, anything else undelivered → 500), and the workflow independently asserts `emailEnabled === true` and (`emailSent === true` or a verified `already_sent`). The redundancy is deliberate — a regression in either layer alone can no longer go green. See ADR-018.

**Security**

- Revoked `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` on `helpdesk.audit_runs` from `anon` and `authenticated`. These grants were unreachable only because the schema is not exposed — security by obscurity — and directly adjacent to a change that brings this table nearer the API surface. The new view is `service_role`-only and uses `security_invoker` so it cannot bypass the base table's RLS.

**Added**

- `claim_failed` now carries the underlying database error code and is logged at error level, so this failure class is diagnosable from one log line.
- Regression tests: `tests/audit-outcome.test.ts` (13 cases, every logical outcome incl. fail-closed on unknown reasons), the exact `PGRST106` claim path in `tests/audit-runs.test.ts`, HTTP-status assertions per outcome in `tests/audit.test.ts`, and real-PostgreSQL coverage in `tests/postgres.integration.test.ts` proving the view is insertable/updatable, that writes land in the base table, that `23505` still fires through it, and that `anon`/`authenticated` can read neither relation.

## 2026-07-25 — Local Phase 2 P1 remediation (not deployed)

- Replaced in-memory SSE sessions with stateless authenticated `POST /mcp`.
- Added conservative Resend classification, immutable snapshot retries and
  explicit persisted/effective delivery outcomes.
- Preserved provider evidence before compensation and made output deterministic.
- Corrected requester identity and made the delivery migration atomic.
- Workflow ID `294419190` remains `disabled_manually`.

## 2026-07-25 — Local Phase 1 hardening (not deployed)

- Mandatory remote MCP bearer and fail-closed audit secret.
- Minimal root; conservative delivery states; stable Resend idempotency.
- Removed incomplete Composio/autonomous code and tracked `.vercel` metadata.
- Added unapplied additive migration and security/concurrency tests.

## 2026-07-22 — Company/VIP-risk audit detail, delivery idempotency, root-cause fix for duplicate emails

**Fixed**

- **Root cause of the 9 duplicate audit emails on 2026-07-21, verified against live production data**: `src/lib/audit-runs.ts` read/wrote the dedupe table via `SUPABASE_SCHEMA` (`"public"` in production), but the real `audit_runs` table — 274 historical rows, last written 2026-05-22 — lives in the literal `helpdesk` schema. Every dedupe check and persist since 2026-05-22 silently failed against a nonexistent `public.audit_runs`, so nothing ever blocked a repeat send. Combined with an hourly (not daily) cron, this sent one email per successful GitHub Actions firing — 9 that day. Fixed by pointing `audit-runs.ts` at `getHelpdeskSchema()` explicitly (an existing, previously-unused helper) and replacing the fingerprint dedupe with an atomic per-UTC-day claim. See `supabase/migrations/20260722000000_audit_runs_period_idempotency.sql`, `ARCHITECTURE.md` "Idempotency design", `DECISIONS.md` ADR-009/ADR-010.
- `.github/workflows/audit.yml` cron changed from hourly (`"0 * * * *"`) to once daily at 06:00 UTC (`"0 6 * * *"`) — it was always branded "Daily," never intended to run hourly.
- Removed `AUDIT_EMAIL_DEDUPE_MINUTES` (env var, health-endpoint field, docs) — it was superseded by the new idempotency design and had become dead configuration.

**Added**

- New read-only MCP tool `get_sla_audit_report`: compliance %, active-ticket count, per-company active-ticket breakdown (with an explicit "Unassigned" bucket — no ticket is silently excluded), and `vip_risks` ordered by urgency with a deterministic `risk_reason`/`required_action` per ticket. `project_id`/`project_name` are always `null` — verified against the live schema that no ticket-to-project relationship exists (see `DOMAIN.md`, `DECISIONS.md` ADR-012).
- `src/lib/sla-audit.ts`: the shared aggregation behind both the new tool and the audit email — one computation, two consumers, avoiding duplicated SLA/VIP logic.
- Company resolution: `tickets.created_by → profiles.id → customers_info.id`, batched into one extra query regardless of ticket count (not N+1). `customers_info` was already there and populated; no schema change was needed for this part.
- Redesigned daily audit email (`src/lib/audit-template.ts`): companies list with per-company ticket counts, VIP risks with company/project/reference/risk/action/due-date, priority-actions list, explicit empty states ("No VIP risks detected.", "Company not assigned."), and HTML-escaping of all untrusted (database-sourced) content before interpolation.
- Atomic delivery idempotency (`src/lib/audit-runs.ts`): `claimAuditRunSlot`/`markAuditRunSent`/`markAuditRunFailed` against a new unique constraint on `helpdesk.audit_runs`. Pending → sent/failed state machine; a slot is only marked `sent` after Resend confirms acceptance (message id recorded); a `failed` slot can be reclaimed and retried by a later invocation; a `sent` slot never can.
- 33 new tests (`audit-runs.test.ts`, `sla-audit.test.ts`, `audit-template.test.ts`, `get-sla-audit-report.test.ts`) plus a rewritten `audit.test.ts` — 66 tests total, up from 35.
- `supabase/migrations/20260722000000_audit_runs_period_idempotency.sql` — this repo's first tracked migration, extending (not replacing) the existing `helpdesk.audit_runs` table; all 274 historical rows preserved.

**Notes**

- Verified live, not assumed: the domain investigation (company/project relationships, the `audit_runs` schema mismatch, the actual GitHub Actions run history for 2026-07-21) used direct Supabase and `gh` CLI queries against production, not code inspection alone.
- `npm audit` still reports the same 15 vulnerabilities as 2026-07-21, all pre-existing transitive dependencies — unchanged by this work, not addressed here (see `SECURITY.md`, `ROADMAP.md`).

## 2026-07-21 — Audit hardening + test coverage + documentation baseline

**Fixed**

- Removed `error.stack` from `api/cron/audit.ts`'s HTTP 500 response body — it was reachable without authentication whenever `AUDIT_CRON_SECRET` was unset. The error message is still returned; stack traces remain in server-side logs only.
- Corrected the audit email template (`src/lib/audit-template.ts`): removed a false "Powered by Gemini 3 Flash" footer claim (this project uses Anthropic Claude, not Gemini) and translated a stray Spanish sentence in an otherwise English template.
- Made the SLA audit email recipient configurable via `AUDIT_RECIPIENT_EMAIL` (falls back to the previous hardcoded address if unset) instead of a value fixed in `src/lib/audit-service.ts`.

**Added**

- Vitest coverage for all 7 MCP tool handlers (`create_ticket`, `get_ticket_status`, `list_tickets`, `prioritize_incident`, `suggest_solution`, `update_ticket_status`, `generate_report`) — previously only the audit/health endpoints had tests. 22 new tests, plus a shared `tests/helpers/supabase-mock.ts` query-builder mock.
- Documentation/guardrail set: `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, `DOMAIN.md`, `TESTING.md`, `DECISIONS.md`, `CONTRIBUTING.md`, `ROADMAP.md`, this `CHANGELOG.md`.

**Notes**

- `npm audit` reports 15 vulnerabilities, all in transitive dependencies of `@modelcontextprotocol/sdk` (not directly exploitable via this project's own code paths — see `SECURITY.md`). Not fixed in this pass; tracked in `ROADMAP.md`.

## 2026-06-12 — Audit pipeline stabilization

- Added `/api/health/audit` health-check endpoint plus `AUDIT_EMAIL_ENABLED`/`AUDIT_EMAIL_DEDUPE_MINUTES` controls.
- Audit run persistence failures no longer fail the whole audit request (email still sends; failure is logged and reported in the response instead).
- Audit queries switched to the configured `SUPABASE_SCHEMA` domain schema instead of an assumed fixed schema.

## 2026-04-29 → 2026-04-30 — Audit infrastructure + security hardening (SME standard)

- Introduced the scheduled SLA audit system end-to-end: GitHub Actions cron → Vercel endpoint → Supabase metrics → Resend email, with diagnostics and redacted-header error logging in the workflow.
- CORS allowlist enforcement, explicit public-schema/service-role auth alignment, and README rewrite documenting the security posture ("infrastructure hardening & security compliance" milestone).

## 2026-04-26 — v2.0: ticket-system schema compatibility

- Rebuilt to be schema-compatible with the external "ticket-system" application's public schema (the dependency boundary this repo still has today — see `ARCHITECTURE.md`).

## 2026-04-22 — v1.2.1: initial release

- First working MCP server with an isolated helpdesk schema, SSE deployment orchestration on Vercel, and the initial 7-tool set.
