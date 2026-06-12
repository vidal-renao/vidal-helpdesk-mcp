import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "http";

import { enforceCors } from "../../src/lib/cors.js";
import { getRuntimeEnv } from "../../src/lib/env.js";
import { getDomainSchema, SUPABASE_SCHEMA } from "../../src/lib/supabase.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const requestId = getRequestId(req);

  try {
    const env = getRuntimeEnv({ requireAllowedOrigins: true });
    const cors = enforceCors(req, res, ["GET", "OPTIONS"], env.ALLOWED_ORIGINS);
    if (!cors.allowed || cors.preflight) {
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed", requestId }));
      return;
    }

    if (!isAuthorized(req, env.AUDIT_CRON_SECRET)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized", requestId }));
      return;
    }

    const checks = await runHealthChecks(env);
    const healthy = checks.supabase === "ok" && checks.organizationId === "set";

    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ requestId, status: healthy ? "ok" : "degraded", ...checks }, null, 2));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        requestId,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown health error",
      })
    );
  }
}

async function runHealthChecks(env: ReturnType<typeof getRuntimeEnv>) {
  let supabase: "ok" | "error" = "ok";
  let supabaseError: string | null = null;

  try {
    const { error } = await getDomainSchema()
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) {
      supabase = "error";
      supabaseError = error.message || error.code || "Unknown Supabase error";
    }
  } catch (error) {
    supabase = "error";
    supabaseError = error instanceof Error ? error.message : "Unknown Supabase error";
  }

  return {
    supabase,
    supabaseError,
    resend: env.RESEND_API_KEY ? "configured" : "missing",
    schema: SUPABASE_SCHEMA,
    organizationId: env.MCP_ORGANIZATION_ID ? "set" : "missing",
    emailEnabled: env.AUDIT_EMAIL_ENABLED,
    dedupeMinutes: env.AUDIT_EMAIL_DEDUPE_MINUTES,
  };
}

function isAuthorized(req: IncomingMessage, expectedSecret: string | undefined): boolean {
  const expected = expectedSecret?.trim();
  if (!expected) {
    return true;
  }

  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return bearer === expected;
}

function getRequestId(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  const requestId = Array.isArray(header) ? header[0] : header;
  return requestId?.trim() || randomUUID();
}
