import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyBearerRequest } from "./lib/bearer-auth.js";
import { enforceCors } from "./lib/cors.js";
import { createMcpServer } from "./lib/mcp-server.js";

const MAX_MCP_BODY_BYTES = 1_048_576;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/" || url.pathname === "/health") {
    return json(res, 200, { name: "vidal-helpdesk-mcp", status: "running" });
  }

  if (url.pathname === "/sse" || url.pathname === "/messages") {
    return json(res, 410, { error: "Legacy MCP transport retired", endpoint: "/mcp" });
  }

  if (url.pathname !== "/mcp") return json(res, 404, { error: "Not found" });

  try {
    const cors = enforceCors(req, res, ["POST", "OPTIONS"]);
    if (!cors.allowed || cors.preflight) return;
  } catch {
    return json(res, 500, { error: "Service unavailable" });
  }

  const auth = verifyBearerRequest(req, process.env.MCP_BEARER_TOKEN);
  if (!auth.authorized) {
    return json(res, auth.status, { error: auth.status === 503 ? "Service unavailable" : "Unauthorized" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return json(res, 405, { error: "Method not allowed" });
  }
  if (req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json(res, 415, { error: "Content-Type must be application/json" });
  }

  const body = await readJsonBody(req, res);
  if (body === undefined) return;

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close();
    await server.close();
  }
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    json(res, 413, { error: "Request body too large" });
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_MCP_BODY_BYTES) {
      json(res, 413, { error: "Request body too large" });
      return undefined;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
