import type { IncomingMessage, ServerResponse } from "http";

import { getRuntimeEnv } from "./env.js";

export type CorsDecision =
  | { allowed: true; preflight: boolean }
  | { allowed: false; preflight: false };

export function enforceCors(
  req: IncomingMessage,
  res: ServerResponse,
  methods: readonly string[],
  allowedOrigins = getRuntimeEnv({ requireAllowedOrigins: true }).ALLOWED_ORIGINS
): CorsDecision {
  const origin = getRequestOrigin(req);
  const allowlist = getAllowedOrigins(allowedOrigins);

  if (!origin || !allowlist.has(origin)) {
    res.writeHead(403, { "Content-Type": "application/json", Vary: "Origin" });
    res.end(JSON.stringify({ error: "Forbidden origin" }));
    return { allowed: false, preflight: false };
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return { allowed: true, preflight: true };
  }

  return { allowed: true, preflight: false };
}

function getRequestOrigin(req: IncomingMessage): string | null {
  const header = req.headers.origin;
  const value = Array.isArray(header) ? header[0] : header;

  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins(allowedOrigins: readonly string[]): Set<string> {
  return new Set(
    allowedOrigins
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map(normalizeOrigin)
      .filter((origin): origin is string => origin !== null)
  );
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}
