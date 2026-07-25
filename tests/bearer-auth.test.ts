import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, verifyBearerRequest } from "../src/lib/bearer-auth.js";

function request(authorization?: string) {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage;
}

describe("bearer authentication", () => {
  it("accepts only an exact Bearer token", () => {
    expect(verifyBearerRequest(request("Bearer secret-value"), "secret-value")).toEqual({ authorized: true });
  });

  it.each([undefined, "Basic abc", "Bearer", "Bearer wrong", "bearer secret-value", "Bearer secret-value extra"])(
    "rejects missing or malformed authorization: %s",
    (value) => expect(verifyBearerRequest(request(value), "secret-value")).toMatchObject({ authorized: false, status: 401 })
  );

  it("fails closed when the configured secret is missing", () => {
    expect(verifyBearerRequest(request("Bearer anything"), undefined)).toEqual({
      authorized: false,
      status: 503,
      reason: "not_configured",
    });
  });

  it("safely compares different-length values", () => {
    expect(constantTimeEqual("short", "a-much-longer-value")).toBe(false);
  });
});
