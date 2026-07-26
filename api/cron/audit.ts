import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { AuditService } from "../../src/lib/audit-service.js";
import { verifyBearerRequest } from "../../src/lib/bearer-auth.js";
import { enforceCors } from "../../src/lib/cors.js";
import { getRuntimeEnv } from "../../src/lib/env.js";
import { logError } from "../../src/lib/logger.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const requestId = getRequestId(req);
  const organizationId = process.env.MCP_ORGANIZATION_ID ?? null;

  try {
    const env = getRuntimeEnv({ requireAllowedOrigins: true });
    const cors = enforceCors(req, res, ["POST", "OPTIONS"], env.ALLOWED_ORIGINS);
    if (!cors.allowed || cors.preflight) {
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed", requestId }));
      return;
    }

    const auth = verifyBearerRequest(req, env.AUDIT_CRON_SECRET);
    if (!auth.authorized) {
      res.writeHead(auth.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: auth.status === 503 ? "Service unavailable" : "Unauthorized", requestId }));
      return;
    }

    const payload = await AuditService.run({ requestId });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...payload, requestId }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown audit error";
    logError({
      requestId,
      organizationId,
      workflow: "audit-cron",
      httpStatus: 500,
      supabaseErrorCode: null,
      resendErrorCode: null,
      message,
    });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, requestId }));
  }
}

function getRequestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] : header;
  return requestId?.trim() || randomUUID();
}
