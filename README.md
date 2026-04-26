# vidal-helpdesk-mcp

> **AI-Powered IT Helpdesk MCP Server v2.0**
> 100% compatible with [ticket-system](https://github.com/vidal-renao/ticket-system) — same schema, same AI engine, same DB tables.

![Version](https://img.shields.io/badge/version-2.0.0-0A84FF?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript)
![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.0-green?style=flat-square)
![Claude](https://img.shields.io/badge/Claude-Sonnet%204-purple?style=flat-square)
![Supabase](https://img.shields.io/badge/Supabase-public%20schema-3ECF8E?style=flat-square&logo=supabase)
![Compliance](https://img.shields.io/badge/Swiss-revDSG-DA291C?style=flat-square)

---

## What changed in v2.0

| Field | v1 (old) | v2 (current) |
|-------|----------|--------------|
| Schema | `helpdesk` (isolated) | `public` (ticket-system) |
| Priority | `P1/P2/P3/P4` | `low/medium/high/critical` |
| AI results | `tickets.ai_summary` | `ai_analysis` table |
| organization_id | Not included | Required via `MCP_ORGANIZATION_ID` |
| created_by | Not included | Required via `MCP_AGENT_ID` |
| Ticket ref | UUID only | `TK-1001` format |

---

## Tools (7)

| Tool | Description |
|------|-------------|
| `create_ticket` | AI triage → saves to `tickets` + `ai_analysis` table |
| `get_ticket_status` | Get ticket by `TK-XXXX` or UUID with AI analysis |
| `list_tickets` | List tickets with status/priority filters |
| `prioritize_incident` | Re-run triage with new context, upsert `ai_analysis` |
| `suggest_solution` | Step-by-step solution in DE/EN/ES/FR/IT, saved as internal comment |
| `update_ticket_status` | Change status + optional internal comment |
| `generate_report` | Real Supabase report: SLA compliance, priorities, avg resolution |

---

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
npm run build
npm start
```

### Get your IDs from Supabase SQL Editor

```sql
-- MCP_ORGANIZATION_ID
SELECT id FROM organizations WHERE slug = 'vidal-lab';

-- MCP_AGENT_ID
SELECT id FROM profiles WHERE role = 'admin';
```

---

## Connect to Claude Desktop

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vidal-helpdesk": {
      "command": "node",
      "args": ["C:/path/to/vidal-helpdesk-mcp/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "ANTHROPIC_API_KEY": "sk-ant-your-key",
        "MCP_ORGANIZATION_ID": "your-org-uuid",
        "MCP_AGENT_ID": "ee677b39-906f-4027-a01c-69024c8c23f5"
      }
    }
  }
}
```

> **Windows:** After code changes kill orphaned process: `Stop-Process -Name "node" -Force`

---

## Test without Claude Desktop

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
# Open http://localhost:5173
```

---

## Architecture
Claude Desktop (MCP Client)
│ stdio / JSON-RPC
▼
vidal-helpdesk-mcp (Node.js)
│ service_role key (bypasses RLS)
▼
Supabase PostgreSQL — public schema
├── tickets           (main table)
├── ai_analysis       (AI triage results — UNIQUE per ticket)
├── ticket_comments   (internal notes from MCP)
├── categories        (Networking, Hardware, Software...)
├── organizations     (multi-tenant isolation)
└── audit_logs        (immutable — revDSG Art.6)
│
▼
Anthropic API (Claude Sonnet 4)
└── Same triage engine as ticket-system/lib/ai/triage.ts

---

## Compliance (Swiss revDSG)

- **Data Residency:** Supabase `eu-central-2` (Zurich) recommended
- **PII Detection:** Claude flags `contains_pii` on every triage
- **Audit Trail:** `audit_logs` immutable via INSERT-only RULE
- **AI Disclosure:** Declare as "automatisierte Verarbeitung durch Anthropic"

---

## Author

**Vidal Reñao Lopelo** — IT Infrastructure & AI Solutions Engineer
Basel, Switzerland 🇨🇭
[vidal-pro-portfolio.vercel.app](https://vidal-pro-portfolio.vercel.app)
