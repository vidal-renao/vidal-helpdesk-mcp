import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  VIDAL_MCP_AUDIT_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
        : []
    ),
  AUDIT_CRON_SECRET: z.string().optional(),
  AUDIT_EMAIL_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  AUDIT_EMAIL_DEDUPE_MINUTES: z.coerce.number().int().min(0).max(1440).default(120),
  MCP_ORGANIZATION_ID: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().optional(),
  SUPABASE_SCHEMA: z.string().default("public"),
});

export type RuntimeEnv = z.infer<typeof envSchema>;

type RuntimeEnvOptions = {
  requireAllowedOrigins?: boolean;
  requireAuditRuntime?: boolean;
};

export function getRuntimeEnv(options: RuntimeEnvOptions = {}): RuntimeEnv {
  const env = envSchema.parse(process.env);

  if (options.requireAllowedOrigins && env.ALLOWED_ORIGINS.length === 0) {
    throw new Error("ALLOWED_ORIGINS must be configured with at least one origin at runtime");
  }

  if (options.requireAuditRuntime) {
    const missing = [
      ["SUPABASE_URL", env.SUPABASE_URL],
      ["SUPABASE_SERVICE_ROLE_KEY", env.SUPABASE_SERVICE_ROLE_KEY],
      ["RESEND_API_KEY", env.RESEND_API_KEY],
      ["MCP_ORGANIZATION_ID", env.MCP_ORGANIZATION_ID],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing runtime env vars: ${missing.join(", ")}`);
    }
  }

  return env;
}
