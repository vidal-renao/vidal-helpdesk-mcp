# SECURITY.md

## Authentication and authorization model

There is **no end-user authentication** in this repository. Two distinct trust boundaries exist instead:

1. **MCP stdio transport** (`src/index.ts`) — trusted by process boundary. Whoever can spawn this process locally (a desktop MCP client) can call every tool. There is no additional access control layer.
2. **Streamable HTTP and audit endpoints** (`src/vercel-server.ts`, `api/cron/audit.ts`, `api/health/audit.ts`) — trusted by independent bearer and CORS checks:
   - **CORS allowlist** (`src/lib/cors.ts`): the request's `Origin` header must resolve to an entry in `ALLOWED_ORIGINS`. Requests without an origin, or with an origin not on the list, are rejected with `403` before any handler logic runs.
   - **Bearer secrets**: MCP requires `MCP_BEARER_TOKEN`; audit endpoints require the independent `AUDIT_CRON_SECRET`. Missing configuration fails closed.

Remote MCP is served only through stateless `POST /mcp` and requires
`MCP_BEARER_TOKEN` on every request. `/sse` and `/messages` return 410. An
allowlisted Origin never authorizes a caller by itself.

## Tenant isolation

`MCP_ORGANIZATION_ID` is a single env var fixed at deployment time — there is no per-request tenant identity. Every Supabase query filters `.eq("organization_id", organizationId)` using that fixed value, which protects against cross-tenant leakage *within a shared schema*, but this deployment only ever acts as one organization. Do not read the README's "organization-scoped" language as multi-tenant request isolation — see `ARCHITECTURE.md` and `DOMAIN.md`.

## Database access

`src/lib/supabase.ts` always authenticates with `SUPABASE_SERVICE_ROLE_KEY`, which **bypasses Row Level Security**. All authorization is therefore enforced in application code (the `organization_id` filters), not by Postgres. A missing filter on any new query is a direct cross-tenant/cross-schema data exposure with no database-level backstop. This key must never reach a browser or a non-backend runtime.

`src/lib/sla-audit.ts`'s company-resolution lookup (`customers_info.id IN (...)`) is **not** organization-scoped by itself — it's scoped indirectly, by only ever querying for `created_by` ids that came from the already-org-filtered ticket query. Any future change that queries `customers_info` independently of that ticket set must add its own `organization_id`-equivalent scoping; `customers_info` has no `organization_id` column of its own (it hangs off `profiles.id`, 1:1).

## Secrets

- `.env`, `.env.*.local` are gitignored and confirmed not tracked in this repo's history.
- Required secrets: `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `AUDIT_CRON_SECRET`. All are read via `process.env` through the Zod-validated `getRuntimeEnv()` — never hardcode a replacement default for a secret-shaped value.
- GitHub Actions secrets (`VIDAL_MCP_AUDIT_URL`, `VIDAL_MCP_AUDIT_SECRET`) are referenced only inside `${{ secrets.* }}` expressions in `.github/workflows/audit.yml`, and the workflow explicitly redacts `authorization`/`cookie`/`set-cookie` response headers before logging on failure.

## Input validation

Every MCP tool input is parsed through a Zod schema (`createValidatedToolHandler` in `src/lib/mcp-tool-handler.ts`) before the handler runs; invalid input returns a structured error instead of reaching Supabase or Anthropic. Runtime env is parsed through `envSchema` (`src/lib/env.ts`) on every call.

## Error handling

As of this audit, `api/cron/audit.ts` no longer includes `error.stack` in its HTTP 500 response body — it previously did, which meant any caller who could pass CORS (and, if unset, the bearer check) received a full server stack trace on failure. The error `message` is still returned; internal stack traces are logged server-side via `logError()` only.

## Logging

`src/lib/logger.ts` writes one structured JSON line per event to stdout (Vercel-log-drain compatible). Fields are fixed (`requestId`, `organizationId`, `workflow`, HTTP/Supabase/Resend error codes, `message`) — there is no free-form object logging, which limits accidental PII leakage into logs. The AI triage prompt (`src/lib/ai.ts`) instructs the model not to reproduce PII in its output and to flag `contains_pii`, but this is a model-driven heuristic, not a guarantee — treat `contains_pii` as advisory, not as a compliance control.

## Audit delivery integrity (2026-07-22)

From 2026-05-22 to 2026-07-22, `src/lib/audit-runs.ts` read/wrote the audit dedupe table using `SUPABASE_SCHEMA` (`"public"` in production) instead of the literal `helpdesk` schema the table actually lives in — every dedupe check and persistence write silently failed. Combined with an hourly (not daily) GitHub Actions schedule, this sent up to 9 duplicate audit emails in a single day (2026-07-21) with no attacker involved — a correctness/observability gap, not an intrusion. Fixed by pointing `audit-runs.ts` at `getHelpdeskSchema()` explicitly and replacing the fingerprint-based dedupe with an atomic per-day claim (`claimAuditRunSlot`). See `ARCHITECTURE.md` "Idempotency design" and `DECISIONS.md` ADR-009/ADR-010. This class of bug (an env-driven schema selector silently missing a table) is worth remembering when adding any new table this app writes to outside the main ticket domain.

## Rate limiting

No distributed rate limiting exists. Mandatory bearer authentication and the
CORS allowlist are the current request-shaping controls.

## Dependency posture

`npm audit` currently reports 15 vulnerabilities (1 critical, 5 high, 8 moderate, 1 low), all in transitive dependencies of `@modelcontextprotocol/sdk` (hono, ws, express-rate-limit → ip-address, body-parser, form-data, qs) and of `vitest`'s dev-only toolchain (esbuild/vite). None of the affected code paths (Hono's HTTP framework, its JWT/cookie/CORS middleware) are exercised by this project — this service uses raw `http` handlers and does not import Hono directly. `npm audit fix` (non-breaking) has not been run yet; recommended as routine maintenance, not urgent.

## Phase 1 HTTP perimeter

Remote MCP requires `MCP_BEARER_TOKEN`; audit requires independent
`AUDIT_CRON_SECRET`. Missing configuration returns `503`, invalid credentials
return `401`, CORS is not authentication, and public root output is minimal.

The 2026-07-25 local audit reports 16 findings: 1 critical, 6 high, 8
moderate, and 1 low. The critical finding is in the dev-only Vitest server
chain. Production findings are transitive through the MCP SDK, including Hono
and `ws`; this service uses SDK SSE but not Hono middleware. The proposed SDK
downgrade and Vitest major upgrade require compatibility review, so neither was
applied automatically and both remain temporarily accepted.

## Compliance posture

This repository provides implementation primitives (structured logs, CORS enforcement, schema-scoped access, PII flagging in AI output) referenced by the README as supporting Swiss DSG/GDPR expectations. It does not constitute legal certification — retention policy, processor agreements, and encryption-at-rest are deployment/infrastructure decisions outside this codebase.
