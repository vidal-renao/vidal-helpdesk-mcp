# Unified AI Helpdesk integration contract

The canonical product and architecture specification lives in the Ticket System repository at `docs/specs/ai-helpdesk-platform/`. This document defines only the MCP boundary and does not duplicate domain ownership.

## Boundary

Ticket System owns user authentication, roles, tickets, comments, attachments, SLA configuration, knowledge administration, human approvals and dashboards. Supabase owns durable relational/vector/workflow/audit state. This service owns versioned MCP tool contracts, trusted orchestration adapters and the existing idempotent SLA audit execution/delivery.

The service remains single-tenant per deployment through trusted `MCP_ORGANIZATION_ID`. Tool inputs must not accept or override organization identity. Service-role database operations apply explicit organization predicates; RLS is defense in depth.

## Compatibility

Existing tools remain supported:

- Read-only: `get_ticket_status`, `list_tickets`, `generate_report`, `get_sla_audit_report`.
- Mutating: `create_ticket`, `prioritize_incident`, `suggest_solution`, `update_ticket_status`.

Future versioned capabilities may provide authorized ticket context, tenant-scoped knowledge retrieval, grounded drafts, action requests/decisions, workflow status and RAG traces. Names are provisional until contract review.

All future outputs use strict schemas with `schema_version`, `correlation_id`, optional `trace_id`, result and safe structured errors. Writes require an idempotency key. Retries never duplicate effects. Sensitive mutations operate only on an authorized approval bound to action, target, payload hash, actor role and expiry.

## RAG boundary

Retrieval organization scope is injected by trusted server context and enforced inside SQL/RPC before vector ranking. MCP returns evidence identifiers and grounding metadata but does not invent citations. The canonical document lifecycle and approval policy remain in Ticket System/Supabase.

## Workflow boundary

Workflow state (`queued`, `running`, `waiting_for_approval`, `completed`, `failed`, `cancelled`, `delivery_unknown`) is separate from ticket state. Each step emits a redacted durable event with correlation ID, attempt and idempotency identity. The existing Audit workflow ID `294419190` must remain `disabled_manually`; this specification does not authorize enabling or invoking it.

## Security and operations

Remote `/mcp` requires Bearer authentication; CORS is secondary. Stdio remains local. Logs exclude bearer tokens, secrets, PII, document bodies and raw embeddings. Rate limits are per deployment/tool, timeouts are bounded, and ambiguous external delivery is reconciled rather than blindly retried.

No runtime, dependency, migration, secret, workflow or production-state change is part of Phase 3.

