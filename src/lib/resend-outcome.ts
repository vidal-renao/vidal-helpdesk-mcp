export type ResendErrorLike = { name?: string; message?: string } | null | undefined;
export type DeliveryOutcome =
  | { kind: "provider_confirmed"; messageId: string | null }
  | { kind: "definitive_failure"; code: string; message: string }
  | { kind: "ambiguous_delivery"; code: string; message: string };

const DEFINITIVE_REJECTIONS = new Set([
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
]);

export function classifyResendResponse(
  data: { id?: string } | null | undefined,
  error: ResendErrorLike
): DeliveryOutcome {
  if (!error) return { kind: "provider_confirmed", messageId: data?.id ?? null };
  const code = error.name || "unknown_provider_error";
  const message = error.message || "Provider response was not recognized";
  return DEFINITIVE_REJECTIONS.has(code)
    ? { kind: "definitive_failure", code, message }
    : { kind: "ambiguous_delivery", code, message };
}

export function classifyResendException(error: unknown): DeliveryOutcome {
  return {
    kind: "ambiguous_delivery",
    code: "provider_response_unknown",
    message: error instanceof Error ? error.message : "Provider response unknown",
  };
}
