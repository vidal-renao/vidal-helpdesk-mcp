# HelpdeskAI MCP Server

> **AI-powered IT Helpdesk automation via Model Context Protocol (MCP)**  
> Built for Swiss enterprise environments — trilingual (EN / DE / ES)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.0-green)](https://modelcontextprotocol.io)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-orange)](https://supabase.com)
[![Claude AI](https://img.shields.io/badge/Claude-Sonnet%204-purple)](https://anthropic.com)

---

## What this does

HelpdeskAI is a **Model Context Protocol (MCP) server** that exposes 5 AI-powered tools for IT support automation. Connect it to any MCP-compatible client (Claude Desktop, custom apps) and manage IT tickets through natural language.

```
"Create a P1 ticket — our ERP system is down, affects all 200 users"
→ Ticket created, priority set to P1, SLA: 1 hour, category: software
```

---

## Tools

| Tool | Description |
|------|-------------|
| `create_ticket` | Create ticket from natural language with automatic AI triage (P1–P4) |
| `get_ticket_status` | Retrieve ticket details, SLA countdown, breach detection |
| `prioritize_incident` | Re-evaluate and update priority with AI, accepts new context |
| `suggest_solution` | Generate step-by-step resolution guide in EN / DE / ES |
| `generate_report` | Weekly/monthly summary: counts, priorities, avg resolution time |

---

## Tech Stack

- **MCP SDK** — `@modelcontextprotocol/sdk` (official Anthropic)
- **Claude AI** — `claude-sonnet-4` for triage & solution generation
- **Supabase** — PostgreSQL database with RLS
- **TypeScript** — fully typed, strict mode
- **Zod** — input validation on all tools

---

## Architecture

```
src/
├── index.ts              — MCP Server entry point, tool registration
├── types/
│   └── index.ts          — Shared TypeScript types
├── lib/
│   ├── supabase.ts       — Supabase client singleton
│   └── ai.ts             — Claude AI helpers (classify, generate, SLA)
└── tools/
    ├── create-ticket.ts      — create_ticket tool
    ├── get-ticket-status.ts  — get_ticket_status tool
    ├── prioritize-incident.ts — prioritize_incident tool
    ├── suggest-solution.ts   — suggest_solution tool
    └── generate-report.ts    — generate_report tool

supabase/
└── schema.sql            — Database schema + triggers + seed data
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase project (free tier works)
- Anthropic API key

### Installation

```bash
git clone https://github.com/vidal-renao/helpdesk-ai-mcp
cd helpdesk-ai-mcp
npm install
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
```

### Database Setup

1. Open your [Supabase SQL Editor](https://supabase.com/dashboard)
2. Run the contents of `supabase/schema.sql`
3. Optionally uncomment the seed data at the bottom

### Run

```bash
# Development (with hot reload)
npm run dev

# Production build
npm run build
npm start
```

---

## Connect to Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "helpdesk-ai": {
      "command": "node",
      "args": ["/absolute/path/to/helpdesk-ai-mcp/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-key",
        "ANTHROPIC_API_KEY": "sk-ant-your-key"
      }
    }
  }
}
```

Then restart Claude Desktop and ask:
> *"Create a ticket: user Anna can't login to VPN since this morning"*

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) | ✅ |
| `ANTHROPIC_API_KEY` | Claude API key | ✅ |

---

## SLA Matrix

| Priority | Response Time | Use Case |
|----------|--------------|----------|
| P1 — Critical | 1 hour | System down, security breach |
| P2 — High | 4 hours | Major feature broken, data risk |
| P3 — Medium | 24 hours | Degraded performance, workaround available |
| P4 — Low | 72 hours | Cosmetic issue, minor request |

---

## Author

**Vidal Reñao** — IT Infrastructure & AI Solutions Engineer  
📍 Basel, Switzerland 🇨🇭  
🌐 [vidal-pro-portfolio.vercel.app](https://vidal-pro-portfolio.vercel.app)  
💼 Available for projects in Switzerland & Liechtenstein

---

*Built with the MCP SDK — Model Context Protocol by Anthropic*
