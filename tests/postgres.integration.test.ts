import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const looksUnsafe = (value: string) =>
  /supabase\.co|pooler\.supabase\.com|prod(uction)?/i.test(value) || !/[?&]application_name=vidal_mcp_test\b/.test(value);

describe.skipIf(!url)("PostgreSQL audit-run concurrency (opt-in)", () => {
  it("rejects a URL that is not explicitly disposable", () => {
    expect(url).toBeTruthy();
    expect(looksUnsafe(url!)).toBe(false);
  });

  it("enforces one concurrent claim and conditional state transitions", async () => {
    if (!url || looksUnsafe(url)) throw new Error("Unsafe TEST_DATABASE_URL rejected");
    const packageName = "pg";
    let pg: any;
    try {
      pg = await import(packageName);
    } catch {
      throw new Error("Opt-in PostgreSQL test requires the optional 'pg' package");
    }
    const schema = `vidal_mcp_test_${Date.now()}`;
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      await pool.query(`create schema "${schema}"`);
      await pool.query(`create table "${schema}".audit_runs (
        id bigserial primary key, slot text not null unique, status text not null
      )`);
      const attempts = await Promise.allSettled([
        pool.query(`insert into "${schema}".audit_runs(slot,status) values ('same','pending') returning id`),
        pool.query(`insert into "${schema}".audit_runs(slot,status) values ('same','pending') returning id`),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const transitions = await Promise.all([
        pool.query(`update "${schema}".audit_runs set status='sending' where slot='same' and status='pending' returning id`),
        pool.query(`update "${schema}".audit_runs set status='sending' where slot='same' and status='pending' returning id`),
      ]);
      expect(transitions.reduce((sum, result) => sum + result.rowCount, 0)).toBe(1);
    } finally {
      await pool.query(`drop schema if exists "${schema}" cascade`);
      await pool.end();
    }
  });
});
