-- VIP support and audit persistence for VIDAL Helpdesk
-- Run in Supabase SQL editor against ticket-system

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'standard';

ALTER TABLE organizations
  ADD CONSTRAINT organizations_tier_check
  CHECK (tier IN ('standard', 'vip', 'enterprise'));

CREATE TABLE IF NOT EXISTS audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  overall_severity TEXT NOT NULL,
  findings_count INTEGER NOT NULL DEFAULT 0,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_org_created_at
  ON audit_runs (organization_id, created_at DESC);

COMMENT ON TABLE audit_runs IS 'Stores SLA audit executions for deduplication and historical tracking.';

-- Example VIP enablement
-- UPDATE organizations
-- SET tier = 'vip',
--     settings = jsonb_set(
--       COALESCE(settings, '{}'::jsonb),
--       '{vip_email_domains}',
--       '["vip-client.com","premium-client.ch"]'::jsonb,
--       true
--     )
-- WHERE slug = 'vidal-real-estate';
