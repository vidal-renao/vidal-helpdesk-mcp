import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), closeServer: vi.fn(), handle: vi.fn(), closeTransport: vi.fn() }));
vi.mock("../src/lib/mcp-server.js", () => ({
  createMcpServer: () => ({ connect: mocks.connect, close: mocks.closeServer }),
}));
vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    handleRequest = mocks.handle;
    close = mocks.closeTransport;
  },
}));

const originalEnv = { ...process.env };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv, ALLOWED_ORIGINS: "https://client.example", MCP_BEARER_TOKEN: "mcp-secret" };
});

function req(path: string, method: string, token?: string, body = "{}", contentType = "application/json") {
  const chunks = [Buffer.from(body)];
  return {
    url: path,
    method,
    headers: {
      host: "service.example",
      origin: "https://client.example",
      "content-type": contentType,
      ...(token ? { authorization: token } : {}),
    },
    async *[Symbol.asyncIterator]() { yield* chunks; },
  } as unknown as IncomingMessage;
}

function res() {
  const response = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) { this.headers[name.toLowerCase()] = value; },
    writeHead(code: number, headers?: Record<string, unknown>) {
      this.statusCode = code;
      for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
    },
    end(chunk?: string) { this.body = chunk ?? ""; },
  };
  return response as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, unknown> };
}

describe("stateless Streamable HTTP MCP transport", () => {
  it("authenticates every POST /mcp independently", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const absent = res();
    await handler(req("/mcp", "POST"), absent);
    expect(absent.statusCode).toBe(401);
    const invalid = res();
    await handler(req("/mcp", "POST", "Bearer wrong"), invalid);
    expect(invalid.statusCode).toBe(401);
    await handler(req("/mcp", "POST", "Bearer mcp-secret"), res());
    await handler(req("/mcp", "POST", "Bearer mcp-secret"), res());
    expect(mocks.handle).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.closeTransport).toHaveBeenCalledTimes(2);
    expect(mocks.closeServer).toHaveBeenCalledTimes(2);
  });

  it("fails closed when bearer configuration is absent", async () => {
    delete process.env.MCP_BEARER_TOKEN;
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req("/mcp", "POST", "Bearer mcp-secret"), response);
    expect(response.statusCode).toBe(503);
  });

  it("validates content type and JSON", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const type = res();
    await handler(req("/mcp", "POST", "Bearer mcp-secret", "{}", "text/plain"), type);
    expect(type.statusCode).toBe(415);
    const malformed = res();
    await handler(req("/mcp", "POST", "Bearer mcp-secret", "{"), malformed);
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body).error.code).toBe(-32700);
  });

  it("rejects oversized bodies and unsupported methods", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const oversized = res();
    await handler(req("/mcp", "POST", "Bearer mcp-secret", "x".repeat(1_048_577)), oversized);
    expect(oversized.statusCode).toBe(413);
    const get = res();
    await handler(req("/mcp", "GET", "Bearer mcp-secret"), get);
    expect(get.statusCode).toBe(405);
  });

  it("allows preflight without MCP execution", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req("/mcp", "OPTIONS"), response);
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(["/sse", "/messages"])("retires legacy route %s without exposing internals", async (path) => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req(path, "GET"), response);
    expect(response.statusCode).toBe(410);
    expect(response.body).not.toMatch(/tools|schema|organization|secret/i);
  });

  it("returns a minimal public root response", async () => {
    const handler = (await import("../src/vercel-server.js")).default;
    const response = res();
    await handler(req("/", "GET"), response);
    expect(JSON.parse(response.body)).toEqual({ name: "vidal-helpdesk-mcp", status: "running" });
  });
});
