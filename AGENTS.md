# AGENTS.md — Operating Manual for AI Agents

This file governs how any AI coding agent (Claude Code or otherwise) should work in this repository. It is binding: follow it before improvising.

## What this project is

`vidal-helpdesk-mcp` is an MCP (Model Context Protocol) server plus a scheduled SLA-audit runtime for a single Swiss SME IT-helpdesk organization. It does **not** own the helpdesk data model — it is a client of a Supabase database schema created and migrated by a separate "ticket-system" application that is not part of this repository. There are no migrations here; the schema is a contract, not something this repo can change unilaterally.

Two runtime surfaces ship from the same source tree:

1. **MCP tool server** — 8 tools (`create_ticket`, `get_ticket_status`, `list_tickets`, `prioritize_incident`, `suggest_solution`, `update_ticket_status`, `generate_report`, `get_sla_audit_report`) exposed over stdio (`src/index.ts`, for local/desktop MCP clients) and over HTTP/SSE (`src/vercel-server.ts`, deployed on Vercel).
2. **Audit cron runtime** — `api/cron/audit.ts`, triggered daily at 06:00 UTC by `.github/workflows/audit.yml`, computes SLA compliance and emails a report via Resend.

## Non-negotiable architectural facts

- **Single-tenant per deployment.** `MCP_ORGANIZATION_ID` is one fixed env var, read at call time. There is no per-request tenant/user identity — the "organization scoping" (`.eq("organization_id", ...)`) in every query exists to defend against cross-tenant leakage *if* the schema is ever shared, not to serve multiple orgs from one deployment. Do not build multi-tenant features on top of this without first changing how tenant identity is established.
- **Service-role Supabase access, everywhere.** `src/lib/supabase.ts` uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS entirely. Every query's org-scoping is enforced in application code, not the database. If you add a new query against `tickets`, `ai_analysis`, `ticket_comments`, or `categories`, it **must** filter by `organization_id` (directly or via a ticket already scoped by it) — there is no safety net below the application layer.
- **CORS is the perimeter for the HTTP surfaces.** `src/lib/cors.ts` denies by default; an origin must be present in `ALLOWED_ORIGINS`. Do not add a wildcard or a bypass.
- **Zod validates twice**: once for runtime env (`src/lib/env.ts`), once per MCP tool input (`*Schema` in each `src/tools/*.ts`, wrapped by `src/lib/mcp-tool-handler.ts`). New tools must define a schema and route through `createValidatedToolHandler`.
- **`src/index.ts` and `src/vercel-server.ts` duplicate the tool registration list.** If you add, remove, or change a tool, update both files — there is no shared registration table today.

## Sensitive files — read before touching

| File | Why it's sensitive |
|---|---|
| `src/lib/audit-service.ts` | Owns SLA calculation, dedupe fingerprinting, and email delivery. `AUDIT_RECIPIENT_EMAIL` (falls back to a hardcoded address) is the only per-deployment recipient config. |
| `src/lib/cors.ts` | The only thing standing between the public internet and the audit/health endpoints. |
| `src/lib/supabase.ts` | Central point for schema selection (`SUPABASE_SCHEMA`) and service-role client construction. |
| `api/cron/audit.ts`, `api/health/audit.ts` | Publicly routable Vercel functions. Any change here changes what an unauthenticated request can see. |
| `.env.production.local`, any `.env*` file | Never open these into chat output, logs, or commit them. They are correctly gitignored (`.env`, `.env.*.local`) — keep it that way. |

## Required commands before calling anything done

```bash
npm run lint    # tsc --noEmit — must be clean
npm test        # vitest run — must be all green
npm run build   # tsc — must succeed
```

There is no lint config beyond the TypeScript compiler (`tsc --noEmit` is literally what `npm run lint` runs) and no separate formatter — don't introduce ESLint/Prettier config unless asked; it isn't part of this project's current tooling.

## Process before implementing

1. Read the actual file you're about to change — do not assume behavior from the README or from a memory of a similar project.
2. Check whether a helper/pattern already exists (`tests/helpers/supabase-mock.ts` for test mocking, `createValidatedToolHandler` for tool wiring, `getRuntimeEnv()` for env access) before writing a new one.
3. If the change touches a Supabase query, verify the `organization_id` scoping is present.
4. If the change touches the audit endpoints, verify CORS and the `AUDIT_CRON_SECRET` bearer check are still exercised, not bypassed.

## Definition of Done

- `npm run lint`, `npm test`, `npm run build` all pass.
- New/changed tools have Zod schemas and Vitest coverage following the pattern in `tests/*.test.ts`.
- No secret, stack trace, or internal error detail is added to an HTTP response body.
- Documentation (`README.md`, this file, `ARCHITECTURE.md`, `SECURITY.md`, `DOMAIN.md`) is updated if the change alters behavior described in them.

## Prohibited

- Do not invent Supabase tables/columns that aren't already referenced in `src/types/index.ts` or the existing queries — this repo does not own that schema.
- Do not add a second HTTP framework (Express/Hono/Fastify) — the HTTP surfaces are intentionally raw `http.IncomingMessage`/`ServerResponse` handlers for minimal attack surface on Vercel functions.
- Do not remove the `organization_id` filter from any query "to simplify."
- Do not commit `.env*` files or paste their contents into generated files.

## Phase 1 override

Audit is daily at 06:00 UTC. Remote MCP requires `MCP_BEARER_TOKEN` on `/sse`
and every `/messages` request. CORS is secondary, never authentication.
