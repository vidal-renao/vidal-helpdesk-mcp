# ROADMAP.md

Status as of 2026-07-22. Items move down this list as they're actually built — an idea in "Future" is not a promise, and nothing here should be read as already implemented unless it's in the first section.

## Implemented

- 8 MCP tools over stdio and stateless Streamable HTTP `POST /mcp`.
- AI triage (category, priority, sentiment, language, PII flag, smart response) and multilingual solution generation via Anthropic Claude.
- Confidence-gated priority application (>= 60%) on both ticket creation and re-prioritization.
- Read-only SLA audit report (`get_sla_audit_report`, `src/lib/sla-audit.ts`): per-company active-ticket breakdown (company resolved via `tickets.created_by → profiles → customers_info`), three-way SLA status (compliant/at_risk/breached), VIP risks with deterministic risk reasons and required actions, ordered action items. `project_id`/`project_name` are always `null` — no ticket-to-project relationship exists in this schema (confirmed 2026-07-22).
- Local daily SLA schedule at 06:00 UTC; the remote workflow is currently
  `disabled_manually`. Five delivery states are supported and only `failed` is
  automatically reclaimable.
- Daily audit email redesigned: companies list, VIP risks with company/project/reference/risk/action/due-date, priority actions, explicit empty states, HTML-escaped untrusted content.
- Mandatory MCP bearer authentication, with CORS as secondary defense.
- Structured JSON logging on every audit event.
- Full Vitest coverage: 66 tests across 13 files, including the idempotency claim/reclaim logic and SLA aggregation.
- Documentation/guardrail set: `AGENTS.md`, `ARCHITECTURE.md`, `SECURITY.md`, `DOMAIN.md`, `TESTING.md`, `DECISIONS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `supabase/migrations/`.

## Phase 1 follow-up gates

- Independently re-verify before push or deploy.
- Apply the additive migration only through an approved remote change.
- Reconcile `delivery_unknown` against Resend before changing state.

## Immediate (next changes worth making)

- Run `npm audit fix` for the non-breaking dependency vulnerability fixes (all in `@modelcontextprotocol/sdk`'s transitive deps — see `SECURITY.md`).
- Decide deliberately whether this deployment should ever become multi-tenant. If yes, `AUDIT_RECIPIENT_EMAIL` and `MCP_ORGANIZATION_ID` both need to move from env-level constants to per-request/per-org lookups — that's a real architecture change, not a config tweak. If no (current reality), remove the "organization-scoped" phrasing from the README that implies otherwise.
- Once `sla_policies` has real configured rows (currently zero), replace the single hardcoded `AT_RISK_WINDOW_MS` (4 hours, in `src/lib/sla-audit.ts`) with a per-priority threshold read from that table.

## Medium term

- Pin or version-gate the Anthropic model id (`claude-sonnet-4-20250514`) instead of hardcoding a dated snapshot — add an env override with the current value as default, so a future model swap doesn't require a code change.
- Reassess persistent MCP sessions only if future capabilities cannot operate statelessly.
- Add rate limiting to the HTTP surfaces if they become reachable from more than a small set of trusted origins.
- If a genuine ticket-to-project relationship is ever needed (see `DOMAIN.md`), that requires a real schema decision in the owning "ticket-system" application — not a workaround here. Don't retrofit the existing (unrelated) `projects` deployment-registry table into ticket data.
- Add a formal FK constraint on `tickets.created_by → profiles.id` in the owning schema if the ticket-system app ever wants PostgREST to auto-embed that relationship — today it's application-level only, which is why company resolution is a batched two-query join rather than a single embedded select (see `DECISIONS.md` ADR-011).

## Future ideas (not committed)

- Integration tests against a disposable Supabase branch, covering the parts unit tests can't (real Postgres row-locking under the idempotency claim, real embedded-relation shapes).
- A shared tool-registration table so `src/index.ts` and `src/vercel-server.ts` stop duplicating the 8 tool definitions.
- Per-organization audit email templates/branding if this ever serves more than one SME.
- A `report_type` beyond `sla_daily_audit` if a different reporting cadence is ever genuinely needed (e.g. a weekly executive summary) — the idempotency key already supports this without redesign, just a second, distinct `report_type` value.
