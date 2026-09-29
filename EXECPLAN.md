# Add publication cycle reporting and diagnostics

## Purpose and success

Each enabled scheduled check or manual `head` dispatch opens or joins one GitHub issue for a publication cycle. The issue records every attempt, reports observed eligibility criteria and evidence in English, and closes with a final outcome. Recoverable external conditions are checked again by an hourly cron while the cycle is open, for at most 48 hours from its actual start. `retry-last-failed` remains a separate operation on the existing failure issue.

## Context and limits

The publisher runs from `main` in `.github/workflows/publish.yml`. Existing qualification in `scripts/qualify-candidate.cjs` requires successful official `github-actions.yml` for the exact official SHA; `scripts/publisher-policy.cjs` applies 60-day retention; `scripts/report-result.cjs` manages `publisher-failure`. Preserve those contracts, the protected deploy environment, data-only bundle, and global workflow concurrency. The new hourly trigger may be late or dropped; the cycle issue proves a run started but does not detect a missed cron independently.

## Milestones

1. Specify cycle start, join, expiry, and duplicate prevention through `test/publication-cycle.test.cjs`; implement `scripts/publication-cycle.cjs` and wire the hourly and start jobs in `.github/workflows/publish.yml`. Validate with `npm test`. Acceptance: disabled daily checks are silent, manual head checks immediately, hourly checks only join open cycles, and the original deadline survives SHA changes and manual dispatch.
2. Specify recoverable qualification and detailed official CI states through `test/qualification-adapter.test.cjs` and cycle tests; update `scripts/qualify-candidate.cjs` and supporting policy. Validate with `npm test`. Acceptance: each recheck reads current official main, exact-SHA CI remains mandatory, transient external errors respect retry timing, and invalid data or expired token terminates the cycle.
3. Specify attempt and final issue reporting, code-level CI diagnostics, bounded inert log excerpts, own-build failures, and ambiguous deploy probing through behavior tests; update reporting scripts and workflow outputs. Validate with `npm test` and a workflow syntax check. Acceptance: every attempt and criterion has observed values and evidence; comments mention the owner only on SHA, blocker, or final outcome change; public artifact observation never triggers automatic redeploy.
4. Update `README.md` with cycle states, criteria, report examples, manual behavior, and recovery. Run `npm test`, `npm run prettier:check`, and a final public-path checkpoint. Review the completed green change with the `refactor-design` skill and rerun validation.

## Progress

- [x] Confirmed the previous branch was merged, fast-forwarded local `main`, removed the stale local branch, and created `publisher-cycle-diagnostics`.
- [x] Inspected the existing workflow, qualification, retention, failure issue, and diagnostic boundaries.
- [x] Milestone 1: cycle lifecycle and workflow entry; `npm test` passed (53 tests).
- [x] Milestone 2: rechecks, CI states, external retries, and fixed deadline; `npm test` passed (59 tests).
- [x] Milestone 3: attempt comments, final criteria, failure handling, public artifact observation, and inert CI diagnostics; `npm test` passed (75 tests).
- [x] Milestone 4: README cycle/recovery guide, design review, and final validation complete.

## Decisions

- Store only compact attempt references and the latest detailed attempt in the issue body; write every full attempt as a comment. A 48-hour run can produce about 48 attempts, and duplicating every table in the body and JSON state would exceed the GitHub issue body limit. This keeps the full history reviewable in the issue while bounding state size.
- Identify open cycle issues by exact title across paginated open issues instead of requiring a new repository label. The global workflow concurrency group serializes start and finish operations; duplicate title matches fail closed. This avoids an external label setup dependency.
- End an ambiguous deploy after a public metadata and artifact reachability probe. HTTP reachability is reported as an observation, not proof of byte identity or a reason to send the bundle again. Manual `retry-last-failed` remains the recovery path after inspection.
- Separate Central artifact observation from issue lifecycle code. The two mechanisms have different data and failure modes; the public cycle API and behavior tests remain unchanged.

## Validation

Observed on 2026-09-28 from Node.js 24.16.0: `npm test` exited 0 with 75/75 tests; `npm run prettier:check` exited 0; Python YAML parsing of `.github/workflows/publish.yml` exited 0 and found all six jobs; `git diff --check` exited 0. `actionlint` was unavailable locally. The cycle behavior tests exercise start, join, hourly retry, changed SHA, final reporting, and 48-hour expiry through the workflow-facing functions. No live GitHub workflow or Central deployment was triggered by this implementation.

The changed paths are `.github/workflows/publish.yml`, `.prettierignore`, `EXECPLAN.md`, `README.md`, `scripts/qualify-candidate.cjs`, `scripts/publication-cycle.cjs`, `scripts/public-artifact-observation.cjs`, and their behavior tests in `test/`. `.prettierignore` now excludes preexisting untracked `.agent/tmp/` files so the requested repository-wide formatting check can pass without rewriting temporary artifacts.

## Risks

The cycle issue is persisted GitHub state. A malformed state marker or duplicate open cycle issue must fail closed. GitHub schedule delays reduce the number of checks inside the fixed 48-hour window. Public Central metadata can lag deployment, so an ambiguous deploy result must be reported with observed reachability and require manual inspection before another upload. External log text must be bounded and rendered inert before issue publication. If GitHub Issues is unavailable at the initial trigger, the workflow cannot create durable cycle state; a later manual `head` is the recovery path.
