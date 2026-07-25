import { vi } from "vitest";

export type QueryResult = { data?: unknown; error?: unknown };

const CHAIN_METHODS = [
  "select",
  "eq",
  "in",
  "order",
  "limit",
  "gte",
  "returns",
  "insert",
  "update",
  "upsert",
  "delete",
] as const;

/**
 * Mimics a Supabase PostgrestFilterBuilder: every chain method returns itself,
 * `.single()`/`.maybeSingle()` resolve to the configured result, and the
 * object itself is thenable so it can be awaited without a terminal call.
 */
export function createQuery(result: QueryResult = { data: null, error: null }) {
  const query: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(() => Promise.resolve(result));
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  query.then = (resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return query as Record<(typeof CHAIN_METHODS)[number] | "single" | "maybeSingle", ReturnType<typeof vi.fn>> &
    QueryResult;
}

/**
 * Builds a `from(table)` mock that returns queued queries in call order,
 * asserting each call targets the expected table.
 */
export function createFromQueue(entries: Array<{ table: string; query: ReturnType<typeof createQuery> }>) {
  const queue = [...entries];
  return vi.fn((table: string) => {
    const next = queue.shift();
    if (!next) {
      throw new Error(`Unexpected extra call to from("${table}")`);
    }
    if (next.table !== table) {
      throw new Error(`Expected from("${next.table}") but got from("${table}")`);
    }
    return next.query;
  });
}
