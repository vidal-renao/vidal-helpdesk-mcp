/**
 * Column contract for the tables this server WRITES to.
 *
 * This repository does not own the schema (see AGENTS.md): ticket-system's
 * migrations do. These lists are a snapshot of `information_schema.columns`
 * on the production project, taken read-only on 2026-11-16. Any payload key
 * outside these lists makes PostgREST reject the whole write, which is how
 * `tags` / `raw_response` silently broke create_ticket and prioritize_incident.
 *
 * When ticket-system adds or drops a column that a tool writes, update the
 * snapshot here in the same change.
 */
export const HD_TICKETS_COLUMNS = new Set([
  "id", "organization_id", "created_by", "category_id", "title", "description",
  "status", "priority", "source", "detected_language", "contains_pii",
  "resolved_at", "closed_at", "created_at", "assigned_to", "sla_policy_id",
  "sla_first_response_due", "sla_resolution_due", "first_response_at",
  "sla_first_response_met", "sla_resolution_met", "sla_breached", "anonymized_at",
  "retention_delete_at", "assigned_team_id", "ticket_number", "category",
  "response_due_at", "resolution_due_at", "first_agent_response_at",
  "sla_response_breached", "sla_resolution_breached", "review_status",
  "review_requested_at", "review_requested_by", "reviewed_at", "reviewed_by",
  "routing_override", "assigned_at", "assigned_by", "deleted_at", "deleted_by",
  "metadata", "archived_at", "archived_by",
]);

export const HD_AI_ANALYSIS_COLUMNS = new Set([
  "id", "ticket_id", "suggested_category", "suggested_priority", "confidence_score",
  "sentiment", "detected_language", "summary", "keywords", "smart_response",
  "estimated_resolution_hours", "reasoning", "contains_pii_detected", "model_used",
  "input_tokens", "output_tokens", "processing_time_ms", "created_at",
]);

/** Returns the payload keys that do not exist as columns. */
export function unknownColumns(payload: Record<string, unknown>, columns: Set<string>): string[] {
  return Object.keys(payload).filter((key) => !columns.has(key));
}
