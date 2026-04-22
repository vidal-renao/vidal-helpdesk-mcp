// src/tools/list-tickets.ts
// Lista tickets con filtros y paginación (v1.2.0)

import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const listTicketsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Número máximo de tickets a devolver (1-100)"),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Offset para paginación"),
  status: z
    .enum(["open", "in_progress", "pending", "resolved", "closed"])
    .optional()
    .describe("Filtrar por estado"),
  priority: z
    .enum(["low", "medium", "high", "critical"])
    .optional()
    .describe("Filtrar por prioridad"),
  category: z
    .string()
    .optional()
    .describe("Filtrar por categoría"),
  assigned_to: z
    .string()
    .uuid()
    .optional()
    .describe("Filtrar por UUID del usuario asignado"),
  order_by: z
    .enum(["created_at", "updated_at", "priority"])
    .default("created_at")
    .describe("Campo por el que ordenar"),
  order_dir: z
    .enum(["asc", "desc"])
    .default("desc")
    .describe("Dirección de orden"),
});

export type ListTicketsInput = z.infer<typeof listTicketsSchema>;

// ─── Supabase client (service role — capa admin segura) ──────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  }
);

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function listTickets(input: ListTicketsInput): Promise<string> {
  const {
    limit,
    offset,
    status,
    priority,
    category,
    assigned_to,
    order_by,
    order_dir,
  } = input;

  let query = supabase
    .from("tickets")
    .select(
      "id, title, status, priority, category, reporter_email, created_at, updated_at, assigned_to, sla_deadline"
    )
    .order(order_by, { ascending: order_dir === "asc" })
    .range(offset, offset + limit - 1);

  if (status) query = query.eq("status", status);
  if (priority) query = query.eq("priority", priority);
  if (category) query = query.eq("category", category);
  if (assigned_to) query = query.eq("assigned_to", assigned_to);

  const { data, error } = await query;

  if (error) {
    return JSON.stringify(
      { error: true, message: `Supabase query failed: ${error.message}` },
      null,
      2
    );
  }

  // Enriquecer cada ticket con flag de SLA breach
  const now = Date.now();
  const tickets = (data ?? []).map((t) => ({
    ...t,
    sla_breached: t.sla_deadline ? new Date(t.sla_deadline).getTime() < now : false,
  }));

  return JSON.stringify(
    {
      count: tickets.length,
      pagination: { limit, offset },
      filters: { status, priority, category, assigned_to, order_by, order_dir },
      tickets,
    },
    null,
    2
  );
}
