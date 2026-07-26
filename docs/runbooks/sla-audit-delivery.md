# SLA audit delivery reconciliation runbook

## Operational status

GitHub workflow `Audit` (`.github/workflows/audit.yml`, ID `294419190`) is
`disabled_manually`. The local YAML schedules 06:00 UTC daily; that file state
does not mean the remote workflow is enabled. Verify with:

`gh api repos/vidal-renao/vidal-helpdesk-mcp/actions/workflows/294419190`

Pause future triggers with:

`gh workflow disable audit.yml --repo vidal-renao/vidal-helpdesk-mcp`

Do not enable it until migration, runtime, PostgreSQL concurrency, security and
daily schedule are independently verified and the owner explicitly approves.

## State interpretation

| State | Meaning | Automatic resend |
|---|---|---|
| `pending` | Claimed; provider not contacted | Prohibited |
| `sending` | Provider call may be imminent or completed | Prohibited |
| `sent` | Provider confirmed and DB persistence succeeded | Prohibited |
| `failed` | Reliable evidence of provider rejection | Allowed through conditional claim |
| `delivery_unknown` | Acceptance cannot be ruled out | Prohibited |

## Reconciliation

1. Keep the workflow disabled and inspect the exact row in
   `helpdesk.audit_runs`.
2. Search structured logs by `auditRunId`. `Provider confirmed delivery`
   includes `providerMessageId`, `idempotencyKey`, `deliveryOutcome` and
   `persistenceConfirmed` before database compensation is attempted.
3. If no provider ID exists, search Resend using
   `sla-audit/<audit-run-id>` and the UTC time window. Log retention depends on
   deployment configuration and is not guaranteed by this repository.
4. Never resend `sending` or `delivery_unknown`, and never turn them into
   `failed`, unless Resend reliably proves it did not accept the request.
5. If accepted, reconcile to `sent` with reviewed SQL constrained by both row
   ID and expected current state. If definitively rejected, document evidence
   and conditionally transition to `failed`.
6. Record actor, time, audit run ID, prior state, provider evidence, target
   state and explicit resend authorization.

Old `failed` rows without a valid snapshot cannot be delivered automatically.
`pending`, `sending` and `delivery_unknown` require manual investigation.

## Rollback and escalation

Runtime rollback keeps the workflow disabled. Schema rollback is forbidden
while new runtime writers are active or any `sending`/`delivery_unknown` row
exists. Preserve provider evidence before dropping columns. Escalate when logs
are unavailable, idempotency retention expired, provider and DB disagree, or a
resend cannot be proven safe. After authorized reactivation, observe state
counts, provider confirmations, persistence failures and duplicate reports.
