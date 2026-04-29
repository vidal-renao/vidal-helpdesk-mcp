# vidal-helpdesk-mcp

[![Composio](https://img.shields.io/badge/Composio-Orchestration-111827?style=flat-square)](https://composio.dev)
[![Vercel](https://img.shields.io/badge/Vercel-Serverless-000000?style=flat-square&logo=vercel)](https://vercel.com)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-Hourly%20Cron-2088FF?style=flat-square&logo=githubactions)](https://github.com/features/actions)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase)](https://supabase.com)
[![Resend](https://img.shields.io/badge/Resend-Email%20Reports-111111?style=flat-square)](https://resend.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-SSE%20%2B%20stdio-16a34a?style=flat-square)](https://modelcontextprotocol.io)

AI-powered helpdesk control plane for the VIDAL ecosystem. Exposes `ticket-system` through 7 MCP tools via HTTP/SSE, runs an autonomous SLA audit engine on Vercel, and drives hourly compliance reporting through GitHub Actions CI/CD.

---

## Three Pillars

### 1 · Backend — Supabase PostgreSQL

The data layer. All ticket reads, SLA compliance queries, and write-backs hit Supabase directly through a service-role client (`src/lib/supabase.ts`). Active statuses tracked: `open`, `in_progress`, `pending_customer`, `pending_third_party`.

### 2 · MCP Bridge — Vercel SSE Server

The tool layer. `src/vercel-server.ts` exposes 7 MCP tools over HTTP/SSE. Any MCP-compatible client (Claude Desktop, remote agent) can connect and operate on tickets programmatically.

| Tool | What it does |
|---|---|
| `create_ticket` | Create ticket with AI triage. Returns `TK-XXXX` ref. |
| `get_ticket_status` | Fetch ticket by ref or UUID. Includes SLA state and AI analysis. |
| `list_tickets` | List tickets with optional status/priority filters. |
| `prioritize_incident` | Re-run AI triage with new context. Updates if confidence ≥ 60%. |
| `suggest_solution` | Generate step-by-step solution in DE/EN/ES/FR/IT. Saves as internal comment. |
| `update_ticket_status` | Update ticket status with optional comment. |
| `generate_report` | SLA compliance report for today/week/month. |

### 3 · Autonomous Audit — GitHub Actions → Vercel → Resend

The automation layer. A GitHub Actions workflow fires every hour, triggers the Vercel audit function, which queries Supabase, computes SLA compliance, and sends a branded HTML report via Resend — no human intervention required.

---

## CI/CD Flow

```mermaid
flowchart LR
    GHA["⏱ GitHub Actions\ncron · 0 × × × × (hourly)"]
    VF["▲ Vercel\n/api/cron/audit"]
    SB[("🗄 Supabase\nPostgreSQL")]
    RS["✉ Resend\nemail delivery"]
    EM["📬 Executive\nreport"]

    GHA -->|"POST + Bearer token"| VF
    VF -->|"service_role queries\ntickets · SLA · org"| SB
    SB -->|"compliance stats"| VF
    VF -->|"HTML report"| RS
    RS --> EM
```

**Step-by-step:**
1. GitHub Actions runs `remote-audit.yml` on cron (`0 * * * *`) or `workflow_dispatch`
2. Sends `POST /api/cron/audit` with `Authorization: Bearer $VIDAL_MCP_AUDIT_SECRET`
3. Vercel executes `api/cron/audit.ts` — validates auth via `AUDIT_CRON_SECRET`
4. Queries Supabase for active tickets, SLA compliance %, and VIP/high-risk count
5. Renders branded HTML via `src/lib/audit-template.ts`
6. Sends report through Resend (`RESEND_API_KEY`)
7. GitHub marks run failed on any non-2xx response

---

## MCP Architecture

```mermaid
flowchart TD
    CD["Claude Desktop"]
    RC["Remote MCP Client"]
    IDX["src/index.ts\nstdio transport"]
    VS["src/vercel-server.ts\nSSE transport"]
    TOOLS["7 Core Tools"]
    SB[("Supabase\nPostgreSQL")]
    ADV["audit_sla\nautonomous-triage-engine"]
    CO["Composio\norchestration layer"]
    GH["GitHub actions"]
    GM["Gmail alerts"]

    CD -->|stdio| IDX
    RC -->|HTTP / SSE| VS
    IDX & VS --> TOOLS
    TOOLS -->|direct client| SB
    IDX --> ADV
    ADV --> CO
    CO --> SB
    CO --> GH
    CO --> GM
```

The codebase supports two execution modes:

| Mode | Path | Use case |
|---|---|---|
| **Direct audit** | Vercel → Supabase → Resend | Scheduled, predictable SLA reporting |
| **Orchestrated** | MCP tools → Composio → Supabase / GitHub / Gmail | Advanced workflows: RCA, escalation, issue automation |

---

## Vercel Routing

Defined in `vercel.json`:

```
/api/cron/audit  →  api/cron/audit.ts   (audit endpoint)
/*               →  src/vercel-server.ts  (MCP SSE server)
```

The audit path is explicit to prevent the MCP catch-all from shadowing it.

---

## Environment Variables

Required for the remote audit path:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
MCP_ORGANIZATION_ID=
AUDIT_CRON_SECRET=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
```

Required for the Composio orchestration layer:

```bash
COMPOSIO_API_KEY=
COMPOSIO_USER_ID=
MCP_AGENT_ID=
```

GitHub Actions secrets required:

```
VIDAL_MCP_AUDIT_URL      # deployed /api/cron/audit URL
VIDAL_MCP_AUDIT_SECRET   # matches AUDIT_CRON_SECRET
```

---

## Local Commands

```bash
npm install
npm run build      # tsc
npm run dev        # tsx watch src/index.ts (stdio MCP)
npm run start      # node dist/index.js
npm run lint       # tsc --noEmit
```

---

## Swiss-Market Notes

- Multi-tenant scope is driven by `MCP_ORGANIZATION_ID` — all queries are org-scoped.
- The audit email reports aggregated SLA indicators only; no ticket body content is included.
- Aligned with the Swiss revDSG / DSG compliance positioning of the wider `ticket-system` platform.

---

## Related

- [`ticket-system`](https://github.com/vidal-renao/ticket-system) — the SaaS helpdesk platform this MCP layer operates on
- Live MCP endpoint: [vidal-helpdesk-mcp.vercel.app](https://vidal-helpdesk-mcp.vercel.app)
