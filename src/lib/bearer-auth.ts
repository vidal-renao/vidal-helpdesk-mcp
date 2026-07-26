import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type BearerAuthResult =
  | { authorized: true }
  | { authorized: false; status: 401 | 503; reason: "unauthorized" | "not_configured" };

export function verifyBearerRequest(
  req: IncomingMessage,
  configuredSecret: string | undefined
): BearerAuthResult {
  const expected = configuredSecret?.trim();
  if (!expected) {
    return { authorized: false, status: 503, reason: "not_configured" };
  }

  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = typeof value === "string" ? /^Bearer ([^\s]+)$/.exec(value) : null;
  if (!match || !constantTimeEqual(match[1], expected)) {
    return { authorized: false, status: 401, reason: "unauthorized" };
  }
  return { authorized: true };
}

export function constantTimeEqual(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(actual);
  const expectedDigest = Buffer.from(expected);
  if (actualDigest.length !== expectedDigest.length) {
    const padded = Buffer.alloc(expectedDigest.length);
    actualDigest.copy(padded, 0, 0, Math.min(actualDigest.length, padded.length));
    timingSafeEqual(padded, expectedDigest);
    return false;
  }
  return timingSafeEqual(actualDigest, expectedDigest);
}
