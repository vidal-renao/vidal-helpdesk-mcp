import { describe, expect, it } from "vitest";
import { classifyResendException, classifyResendResponse } from "../src/lib/resend-outcome.js";

describe("Resend delivery outcome classification", () => {
  it.each([
    "missing_required_field",
    "invalid_idempotency_key",
    "invalid_access",
    "invalid_parameter",
    "invalid_region",
    "missing_api_key",
    "invalid_api_Key",
    "invalid_from_address",
    "validation_error",
    "not_found",
    "method_not_allowed",
  ])("classifies %s as a definitive rejection", (name) => {
    expect(classifyResendResponse(null, { name, message: "rejected" }).kind).toBe("definitive_failure");
  });

  it.each([
    "invalid_idempotent_request",
    "concurrent_idempotent_requests",
    "rate_limit_exceeded",
    "application_error",
    "internal_server_error",
    "future_unknown_error",
  ])("classifies %s conservatively as ambiguous", (name) => {
    expect(classifyResendResponse(null, { name, message: "uncertain" }).kind).toBe("ambiguous_delivery");
  });

  it("classifies a provider response and thrown exception", () => {
    expect(classifyResendResponse({ id: "email-1" }, null)).toEqual({ kind: "provider_confirmed", messageId: "email-1" });
    expect(classifyResendException(new Error("timeout"))).toMatchObject({ kind: "ambiguous_delivery", code: "provider_response_unknown" });
  });
});
