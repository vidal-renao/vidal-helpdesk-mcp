import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;

function assertDisposableDatabase(value: string): URL {
  const url = new URL(value);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new Error("TEST_DATABASE_URL must use local PostgreSQL");
  if (/supabase|prod(uction)?/i.test(value)) throw new Error("Remote or production-like TEST_DATABASE_URL rejected");
  if (url.searchParams.get("application_name") !== "vidal_mcp_test") throw new Error("application_name=vidal_mcp_test is required");
  if (!/test|temp|disposable/i.test(url.pathname)) throw new Error("Database name must explicitly identify a test/disposable database");
  return url;
}

describe.skipIf(!connectionString)("PostgreSQL audit-run migrations and concurrency (opt-in)", () => {
  it("runs the real migrations and the delivery concurrency matrix", async () => {
    assertDisposableDatabase(connectionString!);
    const schema = `vidal_mcp_test_${randomUUID().replaceAll("-", "_")}`;
    const qSchema = `"${schema}"`;
    const pool = new Pool({ connectionString, max: 2 });
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query(`create schema ${qSchema}`);
      await clientA.query(`
        create table ${qSchema}.audit_runs (
          id text primary key,
          organization_id text not null,
          fingerprint text not null default '',
          overall_severity text not null default 'pending',
          findings_count integer not null default 0,
          payload jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        )`);
      await clientA.query(`
        insert into ${qSchema}.audit_runs
          (id, organization_id, created_at)
        select 'historical-' || value, 'org-historical',
               timestamptz '2026-01-01 00:00:00+00' + value * interval '1 microsecond'
        from generate_series(1, 274) value`);

      for (const filename of [
        "supabase/migrations/20260721221843_audit_runs_period_idempotency.sql",
        "supabase/migrations/20260725090000_audit_delivery_state_machine.sql",
      ]) {
        const source = await readFile(filename, "utf8");
        const executable = source.replaceAll("helpdesk.audit_runs", `${qSchema}.audit_runs`);
        await clientA.query(executable);
      }

      expect((await clientA.query(`select count(*)::int count from ${qSchema}.audit_runs`)).rows[0].count).toBe(274);
      expect((await clientA.query(`select count(*)::int count from ${qSchema}.audit_runs where status='sent'`)).rows[0].count).toBe(274);

      const insert = `insert into ${qSchema}.audit_runs
        (id, organization_id, report_type, reporting_period_start, reporting_period_end, recipient,
         status, fingerprint, overall_severity, findings_count, payload)
        values ($1,'org-1','sla_daily_audit','2026-07-25','2026-07-26',$2,'pending','','pending',0,'{}')
        returning id`;
      const newClaims = await Promise.allSettled([
        clientA.query(insert, ["run-a", "ops@example.com"]),
        clientB.query(insert, ["run-b", "ops@example.com"]),
      ]);
      expect(newClaims.filter((result) => result.status === "fulfilled")).toHaveLength(1);

      const winner = (await clientA.query(`select id from ${qSchema}.audit_runs where organization_id='org-1'`)).rows[0].id;
      await clientA.query(`update ${qSchema}.audit_runs set status='failed' where id=$1`, [winner]);
      const reclaimSql = `update ${qSchema}.audit_runs set status='pending' where id=$1 and status='failed' returning id`;
      const reclaims = await Promise.all([clientA.query(reclaimSql, [winner]), clientB.query(reclaimSql, [winner])]);
      expect(reclaims.reduce((sum, result) => sum + (result.rowCount ?? 0), 0)).toBe(1);

      for (const status of ["pending", "sending", "sent", "delivery_unknown"]) {
        await clientA.query(`update ${qSchema}.audit_runs set status=$2 where id=$1`, [winner, status]);
        const reclaim = await clientA.query(reclaimSql, [winner]);
        expect(reclaim.rowCount, `${status} must not be reclaimable`).toBe(0);
      }

      const wrongState = await clientA.query(
        `update ${qSchema}.audit_runs set status='sent' where id=$1 and status='sending' returning id`,
        [winner]
      );
      expect(wrongState.rowCount).toBe(0);

      await clientA.query(`update ${qSchema}.audit_runs set idempotency_key='sla-audit/run-a' where id=$1`, [winner]);
      await expect(clientA.query(
        `insert into ${qSchema}.audit_runs
          (id,organization_id,report_type,reporting_period_start,reporting_period_end,recipient,status,
           fingerprint,overall_severity,findings_count,payload,idempotency_key)
         values ('duplicate-key','org-2','sla_daily_audit','2026-07-25','2026-07-26','other@example.com',
                 'pending','','pending',0,'{}','sla-audit/run-a')`
      )).rejects.toMatchObject({ code: "23505" });

      await clientA.query(insert, ["recipient-case-a", "case@example.com"]);
      await expect(clientA.query(insert, ["recipient-case-b", "case@example.com"])).rejects.toMatchObject({ code: "23505" });
      await clientA.query(insert, ["recipient-other", "other@example.com"]);
      await clientA.query(insert.replaceAll("'2026-07-25'", "'2026-07-26'").replaceAll("'2026-07-26'", "'2026-07-27'"), ["period-other", "case@example.com"]);

      await clientA.query(`update ${qSchema}.audit_runs set status='delivery_unknown' where id=$1`, [winner]);
      const rollbackBlockers = await clientA.query(
        `select count(*)::int count from ${qSchema}.audit_runs where status in ('sending','delivery_unknown')`
      );
      expect(rollbackBlockers.rows[0].count).toBeGreaterThan(0);
    } finally {
      clientA.release();
      clientB.release();
      await pool.query(`drop schema if exists ${qSchema} cascade`);
      await pool.end();
    }
  });
});
