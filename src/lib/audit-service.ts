import { Resend } from "resend";

import { auditRunsTable, buildAuditFingerprint, findRecentAuditRun, formatSupabaseError } from "./audit-runs.js";
import { auditTemplate } from "./audit-template.js";
import { getRuntimeEnv } from "./env.js";
import { logError, logInfo } from "./logger.js";
import { getDomainSchema, getPublicSchema, SUPABASE_SCHEMA } from "./supabase.js";

type AuditServiceOptions = {
  requestId: string;
};

type OrganizationRow = {
  name: string | null;
  slug: string | null;
};

export type AuditCronPayload = {
  success: true;
  generatedAt: string;
  organizationId: string;
  organizationName: string | null;
  organizationSlug: string | null;
  recipient: string;
  stats: {
    compliance: number;
    totalTickets: number;
    vipBreaches: number;
  };
  auditRun: {
    schema: string;
    fingerprint: string;
    overallSeverity: string;
    findingsCount: number;
    persisted: boolean;
    error: string | null;
  };
  html: string;
  emailSent: boolean;
  emailSkippedReason: string | null;
  emailError: string | null;
  emailErrorDetail: unknown;
  emailData: unknown;
};

export class AuditService {
  static async run({ requestId }: AuditServiceOptions): Promise<AuditCronPayload> {
    const startedAt = Date.now();
    const env = getRuntimeEnv({ requireAuditRuntime: true });
    const organizationId = env.MCP_ORGANIZATION_ID;

    if (!organizationId) {
      throw new Error("MCP_ORGANIZATION_ID is not configured");
    }

    logInfo({
      requestId,
      organizationId,
      workflow: "audit-cron",
      httpStatus: null,
      supabaseErrorCode: null,
      resendErrorCode: null,
      message: "Audit cron started",
    });

    const metrics = await this.loadAuditMetrics(requestId, organizationId);
    const total = metrics.totalTickets;
    const compliant = metrics.compliantTickets;
    const vip = metrics.vipBreaches;
    const findingsCount = Math.max(total - compliant, 0);
    const compliance = calculateCompliance(total, compliant);
    const html = auditTemplate({
      compliance,
      totalTickets: total,
      vipBreaches: vip,
    });

    const recipient = "htcpacoxo31@gmail.com".trim().toLowerCase();
    const subject = `Vidal Audit: ${compliance}% SLA Compliance - ${new Date().toLocaleDateString()}`;
    const from = env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev";
    const overallSeverity = vip > 0 ? "critical" : compliance < 100 ? "warning" : "info";

    const fingerprint = buildAuditFingerprint([
      organizationId,
      compliance,
      total,
      compliant,
      vip,
      overallSeverity,
      findingsCount,
    ]);
    const duplicate = await this.findDuplicateAuditRun({
      requestId,
      organizationId,
      fingerprint,
      dedupeMinutes: env.AUDIT_EMAIL_DEDUPE_MINUTES,
    });
    const email = await this.deliverAuditEmail({
      requestId,
      organizationId,
      enabled: env.AUDIT_EMAIL_ENABLED,
      duplicate,
      apiKey: env.RESEND_API_KEY,
      from,
      to: recipient,
      subject,
      html,
    });

    const payload = {
      compliance,
      totalTickets: total,
      compliantTickets: compliant,
      vipBreaches: vip,
      recipient,
      emailSent: email.sent,
      emailSkippedReason: email.skippedReason,
      emailError: email.error,
      organizationName: metrics.organization?.name ?? null,
      organizationSlug: metrics.organization?.slug ?? null,
    };
    let auditRunPersisted = true;
    let auditRunPersistError: string | null = null;
    const { error: auditRunError } = await auditRunsTable().insert({
      organization_id: organizationId,
      fingerprint,
      overall_severity: overallSeverity,
      findings_count: findingsCount,
      payload,
    });

    if (auditRunError) {
      const auditRunMeta = formatSupabaseError(auditRunError);
      const code = auditRunError.code ?? null;
      auditRunPersisted = false;
      auditRunPersistError = auditRunMeta?.message ?? "unknown error";
      logError({
        requestId,
        organizationId,
        workflow: "audit-cron",
        httpStatus: 500,
        supabaseErrorCode: code,
        resendErrorCode: null,
        message: `Supabase audit_runs insert failed: ${auditRunPersistError}`,
      });
    }

    logInfo({
      requestId,
      organizationId,
      workflow: "audit-cron",
      httpStatus: 200,
      supabaseErrorCode: null,
      resendErrorCode: null,
      message: "Audit cron completed",
      durationMs: Date.now() - startedAt,
      emailSent: email.sent,
      auditRunPersisted,
    });

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      organizationId,
      organizationName: metrics.organization?.name ?? null,
      organizationSlug: metrics.organization?.slug ?? null,
      recipient,
      stats: {
        compliance,
        totalTickets: total,
        vipBreaches: vip,
      },
      auditRun: {
        schema: SUPABASE_SCHEMA,
        fingerprint,
        overallSeverity,
        findingsCount,
        persisted: auditRunPersisted,
        error: auditRunPersistError,
      },
      html,
      emailSent: email.sent,
      emailSkippedReason: email.skippedReason,
      emailError: email.error,
      emailErrorDetail: email.errorDetail,
      emailData: email.data,
    };
  }

  private static async loadAuditMetrics(requestId: string, organizationId: string) {
    const domainSchema = getDomainSchema();
    const publicSchema = getPublicSchema();
    const activeStatuses = ["open", "in_progress", "pending_customer", "pending_third_party"];

    const [
      { count: totalTickets, error: totalTicketsError },
      { count: compliantTickets, error: compliantTicketsError },
      { count: vipBreaches, error: vipBreachesError },
      { data: organization, error: organizationError },
    ] = await Promise.all([
      domainSchema
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses),
      domainSchema
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses)
        .eq("sla_breached", false),
      domainSchema
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .in("status", activeStatuses)
        .in("priority", ["high", "critical"]),
      publicSchema
        .from("organizations")
        .select("name, slug")
        .eq("id", organizationId)
        .maybeSingle<OrganizationRow>(),
    ]);

    if (totalTicketsError) {
      this.logSupabaseError(requestId, organizationId, "Supabase total tickets query failed", totalTicketsError);
      throw new Error(`Supabase total tickets query failed: ${totalTicketsError.message}`);
    }

    if (compliantTicketsError) {
      this.logSupabaseError(requestId, organizationId, "Supabase compliant tickets query failed", compliantTicketsError);
      throw new Error(`Supabase compliant tickets query failed: ${compliantTicketsError.message}`);
    }

    if (vipBreachesError) {
      this.logSupabaseError(requestId, organizationId, "Supabase VIP breaches query failed", vipBreachesError);
      throw new Error(`Supabase VIP breaches query failed: ${vipBreachesError.message}`);
    }

    if (organizationError) {
      this.logSupabaseError(requestId, organizationId, "Supabase organization query failed", organizationError);
      throw new Error(`Supabase organization query failed: ${organizationError.message}`);
    }

    return {
      totalTickets: totalTickets ?? 0,
      compliantTickets: compliantTickets ?? 0,
      vipBreaches: vipBreaches ?? 0,
      organization,
    };
  }

  private static async deliverAuditEmail(input: {
    requestId: string;
    organizationId: string;
    enabled: boolean;
    duplicate: boolean;
    apiKey: string | undefined;
    from: string;
    to: string;
    subject: string;
    html: string;
  }) {
    if (!input.enabled) {
      return { sent: false, skippedReason: "disabled", error: null, errorDetail: null, data: null };
    }

    if (input.duplicate) {
      return { sent: false, skippedReason: "duplicate_recent_audit", error: null, errorDetail: null, data: null };
    }

    try {
      if (!input.apiKey) {
        throw new Error("RESEND_API_KEY is not configured");
      }

      const resend = new Resend(input.apiKey);
      const { data, error } = await resend.emails.send({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });

      if (error) {
        const code = getResendErrorCode(error);
        logError({
          requestId: input.requestId,
          organizationId: input.organizationId,
          workflow: "audit-cron",
          httpStatus: null,
          supabaseErrorCode: null,
          resendErrorCode: code,
          message: `Resend audit email failed: ${error.message}`,
        });
        return { sent: false, skippedReason: null, error: error.message, errorDetail: error, data };
      }

      return { sent: true, skippedReason: null, error: null, errorDetail: null, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown email error";
      logError({
        requestId: input.requestId,
        organizationId: input.organizationId,
        workflow: "audit-cron",
        httpStatus: null,
        supabaseErrorCode: null,
        resendErrorCode: getResendErrorCode(error),
        message: `Resend audit email failed: ${message}`,
      });
      return { sent: false, skippedReason: null, error: message, errorDetail: error, data: null };
    }
  }

  private static async findDuplicateAuditRun(input: {
    requestId: string;
    organizationId: string;
    fingerprint: string;
    dedupeMinutes: number;
  }): Promise<boolean> {
    if (input.dedupeMinutes <= 0) {
      return false;
    }

    const since = new Date(Date.now() - input.dedupeMinutes * 60_000).toISOString();
    const { data, error } = await findRecentAuditRun(input.fingerprint, since);

    if (error) {
      logError({
        requestId: input.requestId,
        organizationId: input.organizationId,
        workflow: "audit-cron",
        httpStatus: null,
        supabaseErrorCode: error.code ?? null,
        resendErrorCode: null,
        message: `Supabase audit_runs duplicate check failed: ${error.message}`,
      });
      return false;
    }

    return Boolean(data);
  }

  private static logSupabaseError(
    requestId: string,
    organizationId: string,
    message: string,
    error: { code?: string | null; message: string }
  ) {
    logError({
      requestId,
      organizationId,
      workflow: "audit-cron",
      httpStatus: 500,
      supabaseErrorCode: error.code ?? null,
      resendErrorCode: null,
      message: `${message}: ${error.message}`,
    });
  }
}

export function calculateCompliance(totalTickets: number, compliantTickets: number): number {
  return totalTickets > 0 ? Number(((compliantTickets / totalTickets) * 100).toFixed(2)) : 100;
}

function getResendErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }

  return null;
}
