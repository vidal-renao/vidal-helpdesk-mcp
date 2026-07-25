# DOMAIN.md

This repository consumes a domain model it does not own. This document describes that model **as inferred from actual queries and types in this codebase** (`src/types/index.ts`, `src/tools/*.ts`, `src/lib/audit-service.ts`), cross-checked on 2026-07-22 against the live production schema (Supabase project "Ticket System", `focgfmhgfmhmcbywwsej`) via `information_schema` and foreign-key constraint queries — it is not the authoritative schema definition, which lives in the separate "ticket-system" application.

## Entities

### Ticket

The core entity. Fields referenced in code (`src/types/index.ts`):

- Identity: `id` (UUID), `ticket_number` (int, rendered as `TK-0042`), `organization_id`
- Classification: `category_id`, `priority`, `status`, `source`, `tags[]`
- Content: `title`, `description`, `detected_language`
- People: `created_by`, `assigned_to`
- SLA: `sla_policy_id`, `sla_first_response_due`, `sla_resolution_due`, `sla_breached`
- Lifecycle timestamps: `created_at`, `updated_at`, `resolved_at`, `closed_at`
- Privacy: `contains_pii`
- `metadata` (jsonb, used to carry `requester_name` and `mcp_created: true` — see `create-ticket.ts`)

**Priority**: `low | medium | high | critical`
**Status**: `open | in_progress | pending_customer | pending_third_party | resolved | closed`
**Source**: `portal | email | api | phone`

### AiAnalysis

One row per ticket (accessed as a to-one embed in every query, e.g. `ai_analysis(...)`), written by `create_ticket` and `prioritize_incident`:

`suggested_category`, `suggested_priority`, `confidence_score` (0–100), `summary`, `sentiment`, `keywords[]`, `detected_language`, `contains_pii_detected`, `smart_response`, `estimated_resolution_hours`, `reasoning`, `model_used`, `input_tokens`, `output_tokens`, `processing_time_ms`, `raw_response`.

**Sentiment**: `calm | neutral | frustrated | urgent | angry`

### Category

`categories` table, looked up by `(organization_id, slug, is_active)` via `resolveCategoryId()`. The AI triage prompt constrains categories to a fixed set: `Networking | Hardware | Software | Security | Billing | Other`. If `resolveCategoryId` finds no match, `category_id` is left `null` rather than failing the ticket creation.

### TicketComment

`ticket_comments` table. Written by `suggest_solution` (AI-generated solution, `is_ai_generated: true`) and `update_ticket_status` (human/agent note, `is_ai_generated: false`). All comments written by these tools are `is_internal: true` — there is no customer-visible comment path in this repo.

### Organization

`organizations` table, in the `public` schema regardless of `SUPABASE_SCHEMA`. Only `name` and `slug` are read here (`src/lib/audit-service.ts`), by `organization_id`. This repo never creates or lists organizations — it treats `MCP_ORGANIZATION_ID` as a given, fixed identity.

### Profile

`profiles` table. Represents a person — staff or requester — referenced by `tickets.created_by`, `assigned_to`, `assigned_by`, `reviewed_by`, etc. **`tickets.created_by` has no formal foreign key to `profiles.id`** (verified against the live schema); the relationship is application-level only, same as `category_id → categories.id`. `profiles.company_name` exists as a column but is unused in production (`NULL` on every profile, including ones with real `customers_info` data) — don't read from it.

### CustomerInfo (the "company" concept)

`customers_info` table, a 1:1 extension of `profiles` (`customers_info.id → profiles.id`, FK-enforced). Holds `company_name`, `industry`, `business_details`, `tax_id` for a profile that has them — most profiles don't (2 of ~25 in production today). This is the only "company" concept that exists in this schema, and it belongs to the ticket's **requester** (`created_by`), not to the ticket directly. `src/lib/sla-audit.ts` resolves it as: `tickets.created_by → profiles.id → customers_info.id`. There is no separate `companies` table and no `company_id` column on `tickets` — `company_id` in `get_sla_audit_report`'s output is the requester's `profiles.id`, reused as a stable grouping key, not a foreign key into a companies table that doesn't exist.

### Project — confirmed absence

There is no ticket-to-project relationship in this schema. A `projects` table exists in the same Supabase project, but it's a software-deployment registry (`vercel_project_id`, `github_repo`, `lighthouse_score`, `security_status`) belonging to a different application entirely — referenced only by `deployment_events` and `security_advisories`, never by `tickets`. `get_sla_audit_report` and the audit email report `project_id`/`project_name` as `null` for every ticket. This was verified by querying the live foreign-key constraints, not assumed from missing documentation — do not wire ticket data to that `projects` table; it would associate a support ticket with an unrelated deployment record.

### AuditRun

`helpdesk.audit_runs` table — note the schema: literal `helpdesk`, not `SUPABASE_SCHEMA` (which is `"public"` in production for everything else). This table is this app's own, exclusively — no other application reads or writes it. One row per `(organization_id, report_type, reporting_period_start, recipient)`, enforced by a unique constraint. `status` is `pending | sent | failed`; a row starts `pending` when a slot is claimed, becomes `sent` once Resend confirms delivery (with `provider_message_id` recorded), or `failed` on any error (retryable by a later invocation). `payload` stores the full `SlaAuditReport` snapshot for that send. See `ARCHITECTURE.md` "Idempotency design" for the claim/reclaim mechanics and `DECISIONS.md` ADR-009 for why this table was extended in place rather than replaced.

## Business rules encoded in this repo

- **AI priority is only applied automatically above a confidence threshold.** `create_ticket` and `prioritize_incident` both gate on `confidence_score >= 60`; below that, the ticket keeps its prior/default priority ("medium" for new tickets) and the AI's suggestion is recorded but not acted on.
- **SLA status** (`src/lib/sla-audit.ts`) is three-way per ticket, computed in this order: `sla_breached = true` on the ticket → `"breached"`. Otherwise, if `sla_resolution_due` (falling back to `sla_first_response_due`) is within **4 hours** of now → `"at_risk"`. Otherwise → `"compliant"`. The 4-hour window is a single deployment-wide constant (`AT_RISK_WINDOW_MS`) introduced on 2026-07-22, not derived from configured policy data — `sla_policies` has zero active rows in production today, so there's nothing per-priority to read instead. Revisit this once real SLA policies exist.
- **SLA compliance %** (audit) = tickets with `sla_status = "compliant"` ÷ total active tickets (`open`, `in_progress`, `pending_customer`, `pending_third_party`).
- **VIP risk** (audit) = active ticket with `priority` in `(high, critical)` **and** `sla_status != "compliant"`. This tightened on 2026-07-22 from the older definition (any high/critical-priority active ticket, regardless of SLA proximity) — a high-priority ticket that's comfortably within its SLA window is no longer flagged. This remains a proxy for "at-risk," not a literal VIP-customer flag — there is no VIP field in the ticket model as used here.
- **`risk_reason`/`required_action`** are deterministic, rule-based strings (not AI-generated) keyed off `sla_status`: `"breached"` → escalate-immediately wording; `"at_risk"` → assign-an-owner wording. Both are `null` for `"compliant"` tickets.
- **Status transitions set timestamps automatically**: moving to `resolved` sets `resolved_at`; moving to `closed` sets `closed_at` (`update-ticket-status.ts`). No other transition side effects (e.g. no state-machine validation of allowed transitions — any status can follow any other).
- **`suggest_solution` can auto-advance status**: if the ticket is `open`, the solution isn't flagged `escalate`, and the caller asked to save the comment, status moves to `in_progress` as a side effect.
- **Escalation** is a boolean produced by the AI solution generator (`escalate: true` when priority is `critical` or the fix needs on-site access), used only to skip the auto-`in_progress` transition — it does not create any ticket or notification on its own.

## Roles

This repository has no role/permission model. Two identities are configured, not authenticated:

- `MCP_ORGANIZATION_ID` — the fixed organization this deployment acts on behalf of.
- `MCP_AGENT_ID` — the fixed "author" UUID attributed to AI-generated tickets/comments (`created_by`, `author_id`). It represents "the AI agent," not a logged-in human user.

Any human-facing role model (admin, agent, customer) is owned by the ticket-system application, not here.

## Phase 1 contract clarifications

`customer_profile_id` names the requester profile; legacy `company_id` is
deprecated and is not a company entity id. MCP-created tickets use
`MCP_AGENT_ID` and may resolve as `Unassigned`. Project fields remain `null`.
Delivery adds `sending` and `delivery_unknown`.
