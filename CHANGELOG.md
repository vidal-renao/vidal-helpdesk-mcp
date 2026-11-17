# CHANGELOG.md

Format: newest first. Entries before 2026-07-21 are reconstructed from git history, not from prior changelog entries (none existed).

## Unreleased — Phase 1: MCP write audit and AI-unavailable fallback (REQ-F1-06, REQ-F1-09)

> **Deploy order (blocking):** ticket-system migration `20261117` (`admin_audit_logs`), which creates `public.hd_admin_audit_logs`, must be applied to the database **before** this change is deployed. If it is not, `update_ticket_status` still changes the status but every call returns `audit_logged: false` and no audit trail is written.

**Added**

- `update_ticket_status` writes an audit event to `hd_admin_audit_logs` after every successful status change: `actor_type: "mcp"`, `action: "ticket.status_changed"`, `target_type: "ticket"`, `outcome: "success"`, `details: { from, to, ticket_number }`. The comment text is never stored in the audit row. The response has a new `audit_logged` boolean; a failed audit write is logged server-side (error code only) and never throws or hides the status change.
- `create_ticket` no longer fails when AI triage is unavailable (missing `ANTHROPIC_API_KEY`, provider error, unparseable response). The ticket is created with priority `medium`, `category_id: null`, the caller's `language` hint, `contains_pii: false` and `metadata.triage_status: "unavailable"`; no `hd_ai_analysis` row is written. The response has a new `ai_triage` field (`"completed"` | `"unavailable"`). Only the error class is logged.
- `HD_ADMIN_AUDIT_LOGS_COLUMNS` in `tests/helpers/schema-contract.ts` (agreed contract with the ticket-system migration, to be re-verified against `information_schema` once applied).

**Fixed** (`update_ticket_status`)

- `ticket_ref` is validated (`^TK-?\d{1,7}$` or a UUID). Malformed references used to reach the database as `ticket_number = NaN`.
- `comment` is capped at 2000 characters.
- Soft-deleted tickets (`deleted_at` set) can no longer be found or updated; the update itself is now also scoped by `organization_id`.
- A failed update no longer returns database error text to the MCP client (`Failed to update ticket status`; code logged server-side).

**Rollback**: revert these commits. No migration in this repository; the `hd_admin_audit_logs` table can stay in place.

## Unreleased — Phase 0: schema contract fix (DOM-22)

**Fixed**

- `create_ticket` no longer writes `hd_tickets.tags` and `hd_ai_analysis.raw_response`. Neither column exists in production (verified read-only against `information_schema` on 2026-11-16), so PostgREST rejected every insert and the tool could not create tickets.
- `prioritize_incident` no longer writes `tags`, checks the `error` of its `hd_tickets` update and returns `success: false` instead of claiming "Priority updated" when the write fails. The update is now also scoped by `organization_id`.
- Both tools report `analysis_saved: false` when the `hd_ai_analysis` write fails instead of ignoring it. Database error text is logged server-side (code only) and is no longer included in the thrown error returned to MCP clients.

**Added**

- `tests/helpers/schema-contract.ts` + `tests/schema-contract.test.ts`: write payloads must be a subset of the production column snapshot. Update the snapshot whenever ticket-system changes a written column.

**Rollback**: revert this commit. No migration and no schema change.

## Unreleased — Enterprise email design

**Changed** (presentation only — numbers, sections, subject line and finding wording are unchanged)

- **Daily SLA brief redesigned** (`src/lib/audit-template.ts`) in the VIDAL ECOSYSTEM brand: navy header band with a text wordmark "VIDAL ECOSYSTEM" and "HelpDesk AI · Daily SLA brief", organization and Zurich date/time on the right, thin accent rule; severity-coloured status banner; four KPI tiles (SLA compliance 7d, Breached in queue, Active, Unowned) that stack 2x2 under 480px; sections as white cards with counts — Today's actions (numbered), Waiting for admin approval, High-priority SLA risks (priority/status badges), Active tickets (zebra rows, SLA pills, right-aligned age), Companies.
- **Footer** now states the source ("HelpDesk AI live ticket queue (Supabase), evaluated by the vidal-helpdesk-mcp SLA audit"), snapshot time, methodology note, recipient note, "© {year} VIDAL ECOSYSTEM · Basel, Switzerland" and a no-reply line.
- Email-client hardening: 640px table layout, `role="presentation"` on every table, `bgcolor` attributes alongside inline styles, MSO wrapper for Outlook, `color-scheme: light`, no images or external URLs, tabular numbers; the only `<style>` block is a mobile media query (progressive enhancement). Verified no horizontal overflow at 340/360/375px.

**Added**

- **Plain-text alternative** `getAuditEmailText(report, options)` with header, sections and the same footer. It is sent as Resend `text` alongside `html`. Both renderers share one view model, so they cannot drift.
- `DeliveryPayload.text` (optional). `stablePayloadHash` includes it only when present, so persisted html-only snapshots keep their hash and still retry; `validSnapshot` accepts snapshots with or without `text`.
- `escapeHtml` also escapes backticks.

**Rollback**: revert this commit. No migration; `payload_snapshot` is JSON and older rows remain valid.

## 2026-11-14 — Daily SLA email: accurate "now", resolved-window compliance, truthful risk text

**Fixed**

- **SLA was evaluated at 00:00 UTC, not at send time.** `AuditService.run` passed the dedupe period start as `now`, so anything that fell due between midnight and the send was reported as on track. SLA is now evaluated at the real invocation time (injectable clock, `AuditService.run({ requestId, now })`); the period remains only the dedupe key. The footer states the real snapshot time.
- **Risk text could be false.** The old reason used `Math.abs`, so a deadline in the future could read "was due 2h ago", and response/resolution deadlines were collapsed into one. Each target is now judged on its own: "First response overdue by 3h", "First response was 2h late", "Resolution overdue by 4h", "Resolution due in 45m". A ticket with no first response past its response deadline counts as breached even before ticket-system writes `sla_response_breached`.
- **At-risk threshold now matches the app** (ticket-system `lib/sla-display.ts`): ≤1h remaining or ≤25% of the window, instead of a fixed 4h.
- **Company count grouped by requester**: two requesters from the same company counted as two companies. Companies are now grouped by normalized `company_name`; requesters without a company stay in "Unassigned".
- **Tickets waiting for admin approval** (`in_progress` + `review_status = pending`) were listed as needing an agent. They now have their own "Waiting for admin approval" section/count and are excluded from "Unowned".

**Changed**

- **`compliance_percentage` now means "SLA compliance (resolved in last 7 days)"** — tickets resolved/closed in a rolling 7-day window by `resolved_at` (`RESOLVED_WINDOW_DAYS`), response and resolution judged separately like `assessSla`. It is shown separately from **Breached in queue**. With no resolved tickets the email shows "—" / "No resolved tickets in the last 7 days" (and `null` in the API) instead of 0% or 100%. New `compliance_window` object carries the counts and per-target tallies. One extra org-scoped `hd_tickets` query.
- **"VIP risks" renamed to "High-priority SLA risks"** in the email, verdict and MCP tool description. The JSON field names (`vip_risk`, `vip_risks`, `vip_risk_count`) are unchanged for compatibility. The always-empty "No project on file" segment was removed from risk cards.
- **All email dates/times are Europe/Zurich with an explicit CET/CEST suffix** (`src/lib/zurich-time.ts`). The dedupe slot deliberately stays the UTC calendar day (see ARCHITECTURE.md).
- Subject now reads e.g. `[Action required] 4 active tickets · 2 breached · SLA 7d 75% — Org · 14 Nov`.
- `SlaAuditReport` gains `compliance_window`, `awaiting_approval_count`, `awaiting_approval`; tickets gain `response_status`, `resolution_status`, `response_due_at`, `resolution_due_at`, `first_response_at`, `review_status`, `awaiting_approval`. Audit endpoint `stats` gain `breachedInQueue`, `awaitingApproval`; skipped runs report `compliance: null`.
- Audit workflow cron moved from `0 6 * * *` to `17 5 * * *` (off-peak minute; GitHub delays top-of-hour schedules). The dead-man's-switch step stays last and conditional.

**Security**

- **Removed the hardcoded fallback recipient.** `AUDIT_RECIPIENT_EMAIL` is now required; without it the run fails closed with HTTP 500 `AUDIT_RECIPIENT_EMAIL not configured` before claiming a slot or reading ticket data. **Verify the variable exists in the Vercel production environment before deploying.**

**Rollback**: revert this commit. No migration; all newly selected columns (`review_status`, `first_response_at`, `first_agent_response_at`, `resolved_at`) already exist on `hd_tickets`.

## 2026-09-28 — Daily SLA email redesign; stop reporting unmeasured tickets as compliant

**Changed**

- **New daily email layout** (`src/lib/audit-template.ts`). Table-based and inline-styled so it renders the same in Gmail, Outlook and Apple Mail (the previous flexbox KPI row collapsed in Outlook). It opens with a status banner and a one-sentence verdict, mirrored in a hidden inbox preheader; shows SLA compliance, active, unowned and oldest-open KPIs; a numbered "Today" action list; an active-ticket table (reference, company, status, priority, SLA, owner, age — no ticket titles); company bars; and an optional dashboard button.
- **Subject leads with the verdict**, e.g. `[Needs attention] 5 active tickets · SLA not measured · 3 unowned — Vidal Real Estate · 28 Sept`, instead of the same `100% compliance` line every day.
- Removed the footer claim "Swiss DSG Compliant": it asserted a legal certification this repository does not hold.
- `SlaAuditReport` (also returned by the `get_sla_audit_report` MCP tool) gains `health`, `sla_measured_ticket_count`, `sla_unmeasured_ticket_count`, `breached_ticket_count`, `at_risk_ticket_count`, `unowned_ticket_count`, `waiting_ticket_count`, `oldest_active_age_days`, and per-ticket `priority`, `sla_measured`, `has_owner`, `age_days`. **`compliance_percentage` is now `number | null`.**

**Fixed**

- **The report said "100% compliance · No priority follow-ups required" every day since 2026-09-08 while no ticket had an SLA deadline.** `sla_policies` is empty, so all 5 active tickets had no due date, and a ticket without a due date was classified as compliant. Among them was a critical-priority ticket that had been open 38 days, and 3 tickets had no assigned agent. Compliance is now computed over measurable tickets only and is `null` when none are; unowned and high-priority unmeasured tickets are listed as actions.
- Soft-deleted tickets (`deleted_at` set) were included in the audit; they are now excluded, matching ticket-system.
- The audit read only the legacy `sla_resolution_due`/`sla_first_response_due` columns and only `sla_breached`. It now prefers the canonical `resolution_due_at`/`response_due_at` that ticket-system writes, and honours `sla_response_breached`/`sla_resolution_breached`.

**Added**

- Optional `AUDIT_DASHBOARD_URL` (https only) for the email's dashboard button; the button is omitted when unset.

**Rollback**: revert this commit. No migration or schema change is involved; the new selected columns already exist on `hd_tickets`.

## 2026-08-01 — Dead-man's switch: the absence of a run is now an alert

**Added**

- **A liveness ping as the final step of `.github/workflows/audit.yml`**, conditional on the response-contract assertion having passed. That assertion (ADR-018) only fires if the run executes and reaches it, so it is blind to the cron never firing — GitHub disables scheduled workflows after 60 days of repository inactivity — to Actions outages, and to the workflow being deleted. Those produce no run, no red build and no signal; the only symptom is a missing email, which is how the 2026-07-26 outage stayed invisible for three days. A healthy delivery now pings an external monitor, and the *absence* of that ping raises the alarm from a system outside this repository. The alerting channel must not be Resend, which is inside the path being watched. Setup, grace-window rationale and the coverage matrix are in `README.md` ("Dead-man's switch"); the independence argument is ADR-019.
- New repository secret `HC_PING_URL`. The step fails when it is unset: a disarmed monitor reporting success is the anti-pattern ADR-018 exists to eliminate. The ping runs after delivery completes, so a failure here never costs a report.

**Fixed**

- **Documentation claimed the audit workflow was off while it was running daily.** `README.md` and `AGENTS.md` both stated that workflow ID `294419190` was `disabled_manually` and would remain off pending approval. It is `active` and has delivered on every scheduled run through 2026-08-01 (verified against the GitHub API, not inferred). Corrected in both files, with the observed 2–4h queue delay recorded — it is what sets the monitor's grace window.

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
