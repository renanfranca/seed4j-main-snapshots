# Skip manual retries and their token notices without an eligible publication

## Purpose and success

A manual `retry-last-failed` with no open publisher failure issue, or one issue without recorded identity, returns `outcome: skip` and `reason: no-retryable-publication`. GitHub Actions displays: “No failed publication is eligible for retry. Use operation ‘head’ to recheck the current official main.” No upstream lookup, build, deploy, or issue mutation follows this skip.

The token rotation job must also skip for exactly that qualification outcome and reason. Its other eligible runs, including qualification failures, must keep their existing token notice behavior.

## Context and limits

Continue the publisher work on the clean `publisher-cycle-diagnostics` branch. Qualification lives in `scripts/qualify-candidate.cjs`; identity markers and validation belong to `scripts/publisher-policy.cjs`. The existing `scripts/report-result.cjs` skip contract avoids issue reads and writes. `.github/workflows/publish.yml` gates build and deploy on qualification and renders skip summaries. Preserve exact-SHA official CI, provenance validation, duplicate-issue errors, API errors, and corrupted identity errors. Do not dispatch a live workflow or modify issues #13 or #14. Retry does not automatically become `head`, and cycle timing stays unchanged.

## Milestones

1. Specify and implement absence of an eligible retry through `test/qualification-adapter.test.cjs` and `scripts/qualify-candidate.cjs`. Run `npm test` after each red/green cycle. Accept only explicit absence: zero matching issues or one issue with no occurrence of the reserved identity marker family. Retain errors for partial, duplicated, or malformed markers and invalid API data. Existing valid identity retries must retain their immutable SHA and current checks.
2. Exercise qualification through reporting and the workflow skip summary in existing behavior suites. Update `.github/workflows/publish.yml` to render the requested guidance for the stable reason. Run `npm test`; verify zero reporting requests for skips, visible guidance, and no build/deploy eligibility. Update `README.md` with the two manual operations and recovery behavior.
3. Review the completed green change with `refactor-design`. Run `npm test`, `npm run prettier:check`, and `git diff --check`, all expected to exit 0. Reconcile this plan with actual results and changed files before handoff.
4. Test the effective `token-rotation` job admission matrix in `test/workflow-policy.test.cjs` against its actual workflow expression and dependencies. Update only the job's `needs` and `if` in `.github/workflows/publish.yml`: depend on `cycle` and `qualify`, explicitly use `!cancelled()`, and exclude the combined `skip`/`no-retryable-publication` result. Run `npm test` after each behavior cycle. Accept skips for both ineligible retry shapes, cancellation, hourly cron, and disabled daily schedule while retaining token eligibility for valid retry, `head`, and qualification failure with empty outputs. Review the green change, then run `npm test`, `npm run prettier:check`, and `git diff --check`, each expected to exit 0.

## Progress

- [x] Inspected the clean branch and existing qualification, identity, reporting, and workflow contracts.
- [x] Milestone 1: absent issues and absent identity skip safely; malformed markers, duplicate issues, invalid API data, HTTP errors, provenance mismatch, and valid identity behavior verified.
- [x] Milestone 2: actual workflow summary command and qualification/report integration passed; README explains both manual operations and recovery.
- [x] Milestone 3: requested behavior and public-path checkpoints green; scoped design review complete; final tests, formatting, and diff checks passed.
- [x] Milestone 4: token job admission matrix, scoped design review, and final validation passed.

## Validation

Observed on 2026-09-29 with Node.js 24.16.0: `npm test` exited 0 with 99 tests; `npm run prettier:check` exited 0; `git diff --check` exited 0. Public-path checkpoints exercise qualification through reporting and execute the workflow's real skip-summary shell command against a temporary summary file. Valid retries retain provenance checks, recorded SHA, reachability, and official CI. Corruption, duplicate issues, invalid API data, and failed requests remain failures.

Changed paths: `scripts/qualify-candidate.cjs`, `.github/workflows/publish.yml`, `test/qualification-adapter.test.cjs`, `test/reporting-adapter.test.cjs`, `test/workflow-policy.test.cjs`, `README.md`, and this plan. No live workflow, build, deploy, or issue mutation was triggered. Changes remain local and uncommitted on the reused branch.

The scoped design review classified further extraction as No action: the absence guard is local, explicit, precedes upstream requests, and uses the existing strict identity parser whenever the reserved marker family occurs. An additional abstraction would scatter this small invariant. The reporting skip boundary already avoids issue reads and mutations; no reporting implementation change was needed. Recovery guidance in the README directs users to inspect errors or select `head` explicitly when no retry identity exists.

For milestone 4, observed on 2026-09-29: `npm test` exited 0 with 100 tests; `npm run prettier:check` exited 0; `git diff --check` exited 0. YAML parsing of `.github/workflows/publish.yml` confirmed `needs: [cycle, qualify]` and the intended condition. The effective expression matrix covers ineligible retries, valid retries, head runs, failed qualification with absent outputs, cancellation, hourly checks, and disabled daily checks. The existing qualification and reporting tests still exercise the summary and absence of issue mutations. Scope stayed within the token job's `needs` and `if`, its workflow behavior tests, and this plan. No token script, qualification contract, README, live workflow, issue, or deploy was changed by this milestone. GitHub hosted execution remains unverified.

The scoped milestone 4 design review removed a duplicate admission test after the matrix covered its behavior. No further structural change was justified: the job condition directly expresses the requested admission policy, and introducing another policy layer would duplicate it outside the workflow. The previous ineligible retry and issue recovery guidance remains in the README.
