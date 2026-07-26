import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSlaAuditReport = vi.hoisted(() => vi.fn(async () => JSON.stringify({ success: true, organization_id: "org-test" })));
vi.mock("../src/tools/get-sla-audit-report.js", async () => {
  const { z } = await import("zod");
  return { getSlaAuditReportSchema: z.object({}), getSlaAuditReport };
});

const resources: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (resources.length) await resources.pop()!.close();
  vi.clearAllMocks();
});

describe("MCP protocol contract", () => {
  it("initializes, lists all eight tools, and invokes the read-only SLA tool", async () => {
    const { createMcpServer } = await import("../src/lib/mcp-server.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "phase-2-test", version: "1.0.0" });
    resources.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "create_ticket",
      "generate_report",
      "get_sla_audit_report",
      "get_ticket_status",
      "list_tickets",
      "prioritize_incident",
      "suggest_solution",
      "update_ticket_status",
    ]);

    const response = await client.callTool({ name: "get_sla_audit_report", arguments: {} });
    expect(response.isError).not.toBe(true);
    expect(getSlaAuditReport).toHaveBeenCalledOnce();
  });
});
