# CONTRIBUTING.md

## Workflow

1. Branch off `main`.
2. Make the change. If it touches a Supabase query, re-read `AGENTS.md`'s "Non-negotiable architectural facts" first — org-scoping is not optional.
3. Run the full validation gate locally before opening a PR:
   ```bash
   npm ci
   npm run lint
   npm test
   npm run build
   ```
4. Open a PR against `main`. CI (`.github/workflows/ci.yml`) runs the same gate — there is no bypass and no test-skip flag in this repo.

## Commit style

This repo's history uses Conventional-Commits-style prefixes (`feat:`, `fix:`, `docs:`, `chore:`) — follow that convention. Keep the subject line focused on *why*, not a restatement of the diff.

## Branches

No enforced naming convention beyond branching off `main` (the CI workflow also triggers on `master` for legacy compatibility, but `main` is the active default branch). Delete feature branches after merge.

## Pull requests

- Keep PRs scoped to one concern (a tool fix, a doc set, a test batch) — this repo is small enough that mixed PRs make review slower, not faster.
- If a PR changes behavior described in `README.md`, `ARCHITECTURE.md`, `SECURITY.md`, or `DOMAIN.md`, update the relevant doc in the same PR.
- If a PR adds or changes a Supabase query, add or update the corresponding Vitest test using `tests/helpers/supabase-mock.ts` (see `TESTING.md`).

## Definition of Done

A change is done when:

- `npm run lint`, `npm test`, `npm run build` all pass locally and in CI.
- New behavior has test coverage following the existing pattern.
- No secret, stack trace, or raw error object is newly exposed in an HTTP response.
- Docs affected by the change are updated, not left to drift.

## What not to do

- Don't add a linter/formatter config (ESLint, Prettier) as a drive-by change — if the project wants one, that's a deliberate decision to record in `DECISIONS.md`, not a silent addition.
- Don't introduce a new HTTP framework on the Vercel functions (see `DECISIONS.md` ADR-007).
- Don't invent database columns/tables not already referenced in `src/types/index.ts` or existing queries — this repo doesn't own that schema.
