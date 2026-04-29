import type { IncomingMessage, ServerResponse } from "http";
import { Resend } from "resend";

import { getAuditEmailHtml } from "../../src/lib/audit-template";
import { getSupabaseClient } from "../../src/lib/supabase";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  console.log(">>> [AUDIT] Petición recibida en el servidor");
  console.log(">>> [AUDIT] Header Auth:", req.headers.authorization ? "Presente" : "Faltante");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const payload = await buildAuditCronPayload();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(">>> [AUDIT] Error fatal:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown audit error",
        stack: error instanceof Error ? error.stack : null,
      })
    );
  }
}

async function buildAuditCronPayload() {
  const supabase = getSupabaseClient();
  const organizationId = process.env.MCP_ORGANIZATION_ID;

  if (!organizationId) {
    throw new Error("MCP_ORGANIZATION_ID is not configured");
  }

  const activeStatuses = ["open", "in_progress", "pending_customer", "pending_third_party"];

  const [
    { count: totalTickets, error: totalTicketsError },
    { count: compliantTickets, error: compliantTicketsError },
    { count: vipBreaches, error: vipBreachesError },
    { data: organization, error: organizationError },
  ] = await Promise.all([
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", activeStatuses),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", activeStatuses)
      .eq("sla_breached", false),
    supabase
      .from("tickets")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", activeStatuses)
      .in("priority", ["high", "critical"]),
    supabase
      .from("organizations")
      .select("name, slug")
      .eq("id", organizationId)
      .maybeSingle(),
  ]);

  if (totalTicketsError) {
    throw new Error(`Supabase total tickets query failed: ${totalTicketsError.message}`);
  }

  if (compliantTicketsError) {
    throw new Error(`Supabase compliant tickets query failed: ${compliantTicketsError.message}`);
  }

  if (vipBreachesError) {
    throw new Error(`Supabase VIP breaches query failed: ${vipBreachesError.message}`);
  }

  if (organizationError) {
    throw new Error(`Supabase organization query failed: ${organizationError.message}`);
  }

  const total = totalTickets ?? 0;
  const compliant = compliantTickets ?? 0;
  const vip = vipBreaches ?? 0;
  const compliance = total > 0 ? Number(((compliant / total) * 100).toFixed(2)) : 100;
  const html = getAuditEmailHtml({
    compliance,
    totalTickets: total,
    vipBreaches: vip,
  });

  const recipient = "htcpacoxo31@gmail.com".trim().toLowerCase();
  const subject = `🚨 Vidal Audit: ${compliance}% SLA Compliance - ${new Date().toLocaleDateString()}`;
  const from = process.env.RESEND_FROM_EMAIL?.trim() || "onboarding@resend.dev";

  let emailSent = false;
  let emailError: string | null = null;
  let emailErrorDetail: unknown = null;
  let emailData: unknown = null;

  try {
    const resendApiKey = process.env.RESEND_API_KEY?.trim();
    if (!resendApiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }

    const resend = new Resend(resendApiKey);

    console.log(`Intentando enviar auditoría a: ${recipient} desde: ${from}`);

    const { data, error } = await resend.emails.send({
      from,
      to: recipient,
      subject,
      html,
    });

    emailData = data;

    if (error) {
      console.error("Detalle error Resend:", error);
      emailError = error.message;
      emailErrorDetail = error;
    } else {
      emailSent = true;
    }
  } catch (error) {
    emailError = error instanceof Error ? error.message : "Unknown email error";
    emailErrorDetail = error;
    console.error("Detalle error Resend:", error);
  }

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    organizationId,
    organizationName: organization?.name ?? null,
    organizationSlug: organization?.slug ?? null,
    recipient,
    stats: {
      compliance,
      totalTickets: total,
      vipBreaches: vip,
    },
    html,
    emailSent,
    emailError,
    emailErrorDetail,
    emailData,
  };
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.AUDIT_CRON_SECRET?.trim();
  if (!expected) {
    return true;
  }

  const authHeader = req.headers.authorization ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return bearer === expected;
}
