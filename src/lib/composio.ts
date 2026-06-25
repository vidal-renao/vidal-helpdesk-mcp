import { Composio } from "@composio/core";
import { writeAuditLog } from "./audit-log.js";

let client: Composio | null = null;

type ExecuteOptions = {
  toolSlug: string;
  arguments?: Record<string, unknown>;
  text?: string;
  connectedAccountId?: string;
  retries?: number;
};

export function getComposioClient(): Composio {
  if (client) return client;

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("Missing COMPOSIO_API_KEY");
  }

  client = new Composio({
    apiKey,
    allowTracking: false,
    autoUploadDownloadFiles: false,
    toolkitVersions: {
      supabase:
        process.env.COMPOSIO_TOOLKIT_VERSION_SUPABASE ?? "20260424_00",
      gmail: process.env.COMPOSIO_TOOLKIT_VERSION_GMAIL ?? "20260427_00",
      github: process.env.COMPOSIO_TOOLKIT_VERSION_GITHUB ?? "20260427_00",
    },
  });

  return client;
}

export async function executeComposioTool({
  toolSlug,
  arguments: args,
  text,
  connectedAccountId,
  retries = 1,
}: ExecuteOptions): Promise<unknown> {
  const composio = getComposioClient();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= Math.max(1, retries); attempt += 1) {
    try {
      const response = await composio.tools.execute(toolSlug, {
        userId: process.env.COMPOSIO_USER_ID ?? "vidal-helpdesk-auditor",
        connectedAccountId: connectedAccountId || undefined,
        arguments: args,
        text,
      });

      if (!response.successful) {
        throw new Error(
          `Composio tool ${toolSlug} failed: ${response.error ?? "unknown error"}`
        );
      }

      if (attempt > 1) {
        writeAuditLog("INFO", "Composio tool recovered after retry", {
          toolSlug,
          attempt,
        });
      }

      return response.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      writeAuditLog(
        attempt < retries ? "WARN" : "ERROR",
        "Composio tool execution failed",
        {
          toolSlug,
          attempt,
          retries,
          error: lastError.message,
        }
      );

      if (attempt < retries) {
        await sleep(Math.min(2000, attempt * 500));
      }
    }
  }

  throw lastError ?? new Error(`Composio tool ${toolSlug} failed`);
}

export function parseComposioPayload<T = unknown>(payload: unknown): T {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return payload as T;
    }
  }

  return payload as T;
}

export async function searchComposioTools(query?: string): Promise<unknown[]> {
  void query;
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
