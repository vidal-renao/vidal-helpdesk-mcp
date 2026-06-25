import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketPriority } from "../types/index.js";

export type OrganizationVipConfig = {
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  plan: string | null;
  isVip: boolean;
  vipReason: string | null;
  immediateResponseHours: number;
  immediateEscalationHours: number;
  premiumDomains: string[];
};

export type VipPriorityDecision = {
  isVip: boolean;
  reason: string | null;
  priority: TicketPriority;
  priorityLabel: TicketPriority | "emergency";
};

type OrganizationRow = {
  id: string;
  name: string | null;
  slug: string | null;
  plan: string | null;
  support_email: string | null;
  data_controller_email: string | null;
  settings: Record<string, unknown> | null;
};

export async function getOrganizationVipConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<OrganizationVipConfig> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, slug, plan, support_email, data_controller_email, settings")
    .eq("id", organizationId)
    .single<OrganizationRow>();

  if (error || !data) {
    throw new Error(`Failed to load organization ${organizationId}: ${error?.message ?? "not found"}`);
  }

  const settings = data.settings ?? {};
  const envVipSlugs = splitCsv(process.env.VIP_ORGANIZATION_SLUGS);
  const envVipDomains = splitCsv(process.env.VIP_EMAIL_DOMAINS);
  const settingsDomains = readStringArray(settings.vip_email_domains);
  const premiumDomains = [...new Set([...envVipDomains, ...settingsDomains])];
  const forcedVip = readBoolean(settings.is_vip) || readString(settings.tier) === "vip";
  const isEnterprisePlan = data.plan === "enterprise";
  const slugVip = Boolean(data.slug && envVipSlugs.includes(data.slug));
  const orgEmailVip = [data.support_email, data.data_controller_email]
    .filter(Boolean)
    .some((value) => domainMatches(value!, premiumDomains));
  const isVip = forcedVip || isEnterprisePlan || slugVip || orgEmailVip;
  const vipReason = forcedVip
    ? "organization.settings marks this tenant as VIP"
    : isEnterprisePlan
      ? "organization plan is enterprise"
      : slugVip
        ? "organization slug is listed as VIP"
        : orgEmailVip
          ? "organization email domain matches premium domain policy"
          : null;

  return {
    organizationId: data.id,
    organizationName: data.name ?? null,
    organizationSlug: data.slug ?? null,
    plan: data.plan ?? null,
    isVip,
    vipReason,
    immediateResponseHours: Number(process.env.VIP_FIRST_RESPONSE_HOURS ?? 1),
    immediateEscalationHours: Number(process.env.VIP_ESCALATION_HOURS ?? 1),
    premiumDomains,
  };
}

export function decideVipPriority(input: {
  organizationVip: OrganizationVipConfig;
  requesterEmail?: string | null;
  currentPriority: TicketPriority;
}): VipPriorityDecision {
  const requesterDomainVip = Boolean(
    input.requesterEmail &&
      domainMatches(input.requesterEmail, input.organizationVip.premiumDomains)
  );
  const isVip = input.organizationVip.isVip || requesterDomainVip;
  const reason = requesterDomainVip
    ? `requester domain ${extractDomain(input.requesterEmail!)} is premium`
    : input.organizationVip.vipReason;

  if (!isVip) {
    return {
      isVip: false,
      reason: null,
      priority: input.currentPriority,
      priorityLabel: input.currentPriority,
    };
  }

  return {
    isVip: true,
    reason: reason ?? "VIP policy matched",
    priority: "critical",
    priorityLabel: "emergency",
  };
}

export function buildVipMetadata(input: {
  isVip: boolean;
  reason: string | null;
  priorityLabel: TicketPriority | "emergency";
  requesterEmail?: string | null;
}) {
  return {
    is_vip: input.isVip,
    tier: input.isVip ? "vip" : "standard",
    vip_reason: input.reason,
    priority_label: input.priorityLabel,
    requester_email: input.requesterEmail ?? null,
  };
}

export function computeSlaState(input: {
  ageHours: number;
  assignedTo: string | null;
  isVip: boolean;
  normalRiskHours: number;
  normalOverdueHours: number;
  vipRiskHours?: number;
  vipOverdueHours?: number;
}): "on_time" | "at_risk" | "overdue" {
  const vipRisk = input.vipRiskHours ?? Number(process.env.VIP_RISK_WINDOW_HOURS ?? 0.5);
  const vipOverdue = input.vipOverdueHours ?? Number(process.env.VIP_FIRST_RESPONSE_HOURS ?? 1);

  if (input.isVip && !input.assignedTo) {
    if (input.ageHours >= vipOverdue) return "overdue";
    if (input.ageHours >= vipRisk) return "at_risk";
    return "on_time";
  }

  if (input.ageHours >= input.normalOverdueHours) return "overdue";
  if (input.ageHours >= input.normalRiskHours) return "at_risk";
  return "on_time";
}

function splitCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
        .filter(Boolean)
    : [];
}

function domainMatches(email: string, premiumDomains: string[]): boolean {
  const domain = extractDomain(email);
  return Boolean(domain && premiumDomains.includes(domain));
}

function extractDomain(email: string): string | null {
  const parts = email.toLowerCase().split("@");
  return parts.length === 2 ? parts[1] : null;
}
