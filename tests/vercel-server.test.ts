import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), post: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class { tool() {} connect = mocks.connect; },
}));
vi.mock("@modelcontextprotocol/sdk/server/sse.js", () => ({
  SSEServerTransport: class {
    sessionId = "session-1";
    handlePostMessage = mocks.post;
    constructor(_path: string, _res: unknown) {}
  },
}));

const originalEnv = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv, ALLOWED_ORIGINS: "https://client.example", MCP_BEARER_TOKEN: "mcp-secret" };
});

function req(path: string, method: string, token?: string) {
  return {
    url: path,
    method,
    headers: { host: "service.example", origin: "https://client.example", ...(token ? { authorization: token } : {}) },
  } as IncomingMessage;
}

function res() {
  const response = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; },
    writeHead(code: number) { this.statusCode = code; },
    end(chunk?: string) { this.body = chunk ?? ""; },
    on: vi.fn(),
  };
  return response as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, unknown> };
}

describe("HTTP MCP transport", () => {
  it.each(["/sse", "/messages?sessionId=session-1"])("rejects %s without bearer even with allowed Origin", async (path) => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req(path, path.startsWith("/sse") ? "GET" : "POST"), response);
    expect(response.statusCode).toBe(401);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("rejects an invalid token and fails closed when configuration is absent", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const invalid = res();
    await handler(req("/sse", "GET", "Bearer wrong"), invalid);
    expect(invalid.statusCode).toBe(401);
    delete process.env.MCP_BEARER_TOKEN;
    const missing = res();
    await handler(req("/sse", "GET", "Bearer mcp-secret"), missing);
    expect(missing.statusCode).toBe(503);
  });

  it("allows authenticated SSE and authenticates the messages request again", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    await handler(req("/sse", "GET", "Bearer mcp-secret"), res());
    await handler(req("/messages?sessionId=session-1", "POST", "Bearer mcp-secret"), res());
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("allows preflight without running MCP logic", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req("/sse", "OPTIONS"), response);
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("returns a minimal public root response", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req("/", "GET"), response);
    expect(JSON.parse(response.body)).toEqual({ name: "vidal-helpdesk-mcp", status: "running" });
    expect(response.body).not.toMatch(/tools|schema|org|organization_id|MCP_ORGANIZATION_ID/i);
  });
});
