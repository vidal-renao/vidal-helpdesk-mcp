// src/types/index.ts
export type TicketPriority = "low" | "medium" | "high" | "critical";
export type TicketStatus =
  | "open" | "in_progress" | "pending_customer"
  | "pending_third_party" | "resolved" | "closed";
export type TicketSource = "portal" | "email" | "api" | "phone";
export type SentimentType = "calm" | "neutral" | "frustrated" | "urgent" | "angry";
export type Language = "de" | "en" | "es" | "fr" | "it";
export type TicketCategory =
  | "Networking" | "Hardware" | "Software"
  | "Security" | "Billing" | "Other";

export interface Ticket {
  id: string;
  ticket_number: number;
  organization_id: string;
  category_id: string | null;
  created_by: string;
  assigned_to: string | null;
  title: string;
  description: string;
  detected_language: string | null;
  status: TicketStatus;
  priority: TicketPriority;
  source: TicketSource;
  tags: string[];
  sla_policy_id: string | null;
  sla_first_response_due: string | null;
  sla_resolution_due: string | null;
  sla_breached: boolean;
  resolved_at: string | null;
  closed_at: string | null;
  contains_pii: boolean;
  created_at: string;
  updated_at: string;
}

export interface TriageResult {
  suggested_category: TicketCategory;
  suggested_priority: TicketPriority;
  confidence_score: number;
  sentiment: SentimentType;
  detected_language: Language;
  summary: string;
  keywords: string[];
  smart_response: string;
  estimated_resolution_hours: number;
  reasoning: string;
  contains_pii: boolean;
}

export interface TriageResultWithMeta extends TriageResult {
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  processing_time_ms: number;
}
