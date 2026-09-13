# Stabilize upstream headless verification in the publisher

## Purpose and success

Make `renanfranca/seed4j-main-snapshots` run the exact upstream `./mvnw --batch-mode -ntp clean verify` gate reliably without changing Seed4J. Success means the publisher temporarily replaces only the known `test:component:headless` watcher command with the proven no-watcher preview runner, preserves and restores the upstream manifests byte for byte, completes a credential-free rehearsal at the immutable candidate SHA, and merges a reviewed publisher pull request with a green `tests` check.

This correction stops after its pull request is green and merged. It does not dispatch the publisher, complete the pilot, close the publisher failure issue, publish an artifact, or change Central, schedules, permissions, tests, retries, or credentials.

## Context and limits

The only repository changed by this plan is `renanfranca/seed4j-main-snapshots`. The immutable rehearsal candidate is `seed4j/seed4j@4eebd07bce14c9a6ac70bace157fcc616133e950`. No commit, branch, pull request, tracked edit, or worktree mutation is allowed in Seed4J; all existing Seed4J worktrees and changes must remain preserved.

Publisher runs `34718857592` and `34721871206` failed during the single upstream Maven gate after TikUI's Sass watcher attempted `inotify_add_watch` on a transient Vite `node_modules/.vite/deps_temp_*` directory. Diagnostic pull request [#6](https://github.com/renanfranca/seed4j-main-snapshots/pull/6) was closed without merge after hosted run [34727053924](https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34727053924) established:

- the current watcher reproduced the exact collision in 1/3 samples;
- the forced Vite watcher reproduced the same collision in 1/3 samples;
- the no-watcher preview runner passed 3/3 samples, resolved `/style/tikui.css` as a non-empty 30,867-byte response, and passed unchanged Cypress 7/7;
- the pristine full gate passed with Cypress 7/7 and `BUILD SUCCESS`, confirming that green watcher runs are favorable timing samples rather than evidence against the race.

Preserve exactly one `./mvnw --batch-mode -ntp clean verify`. Do not add skips, retries, `continue-on-error`, timeout changes, Cypress changes, credentials in the build job, unpinned actions, or publication capabilities. Qualification, personal overlay, upstream dependency installation and lint, candidate collection and upload, deploy, reporting, token rotation, schedules, permissions, and environment boundaries remain unchanged.

The trusted adapter interface is `node scripts/run-upstream-verification.cjs --checkout <directory>`. It must recognize exactly the expected Seed4J package identity and watcher runner, preserve the original `package.json` and `package-lock.json` bytes, replace only `test:component:headless` for the Maven invocation, restore both manifests in `finally`, and fail on an unknown contract, nonzero Maven exit, changed lockfile, or inexact restoration.

The temporary runner must retain `concurrently -k -s first`; reuse the TikUI artifacts built earlier in the Maven lifecycle; prepare a coverage-instrumented Vite preview copy; start `tikui-core preview` on the port configured by `tikuiconfig.json`; start `vite preview --port 9000 --strictPort`; wait no more than 30 seconds for a non-empty `GET /style/tikui.css`; and then run the same `cypress run --headless --config-file src/test/webapp/component/cypress-config.ts`. No generated artifact or temporary package change becomes part of the qualified upstream identity or collected candidate.

## Decisions

- Apply an ephemeral publisher-owned adapter rather than changing Seed4J. The upstream gate and tests remain authoritative, while the publisher owns recovery from a hosted timing race in its personal publication path. Remove the adapter after an upstream watcher-free contract is available and qualified.
- Recognize the exact watcher string rather than generically rewriting scripts. This fails closed when upstream changes its package identity, Cypress command, configuration path, or runner topology.
- Treat any manifest restoration mismatch, lockfile change, leftover TikUI/Vite process, rehearsal failure, policy regression, failed pull-request check, or unexpected diff as a stop condition. Do not weaken the gate or dispatch publication to work around it.
- End this plan at the merged correction. `pilotCompleted` remains `false`, issue 3 remains open, Central remains untouched, and a later reviewed recovery plan decides whether to retry publication.
- Preserve the original lockfile across Maven's npm 11.7 install with `npm_config_save=false`. A focused reproduction showed npm 11.7 otherwise removes platform `libc` metadata even without a dependency change; disabling saves retains the lock as resolution input, while the adapter still detects and restores any forced mutation.
- Build a coverage-instrumented Vite preview copy inside the temporary headless runner before starting the two preview servers. The first immutable rehearsal proved that ordinary production artifacts pass Cypress but yield no component coverage; enabling the existing `vite:istanbul` plugin for this verify-only build restored 100% combined coverage. Maven has already packaged the candidate JAR before the `verify` phase, so this temporary target output cannot enter the collected JAR.

## Risks

- Editing an untrusted checkout during verification could contaminate the candidate. Byte-for-byte snapshots, `finally` restoration, post-run equality checks, and collection only after restoration contain this risk.
- An upstream script change could make a broad replacement unsafe. Exact package and command recognition turns that compatibility change into a hard failure before Maven runs.
- Preview processes could survive a failed component run. `concurrently -k -s first` remains the process supervisor, and the rehearsal must verify that no TikUI or Vite process remains.
- The immutable rehearsal is expensive and may expose environment-specific failures. It runs in an isolated checkout without credentials and cannot justify any retry, skip, or test modification.

## Milestones

1. Reconcile the durable plan and diagnostic evidence. Replace the obsolete pilot-completion plan, confirm PR 6 is closed without merge and run 34727053924's results, rename the local publisher branch to `stabilize-publisher-headless-verification`, and leave all Seed4J worktrees untouched. Acceptance is a self-contained plan with the new stop conditions and no publisher source change yet.

2. Implement and behavior-test the adapter. Add `scripts/run-upstream-verification.cjs` and Node tests covering temporary application, exact Cypress/config/coverage retention, successful and failed restoration, unknown upstream rejection, lockfile mutation detection with restoration, and Maven failure propagation. Change only `Run complete upstream verification` in `publish.yml` to invoke it. Update workflow policy tests to require the adapter and continue rejecting skips, retries, `continue-on-error`, build credentials, and unpinned actions. Acceptance is focused and full Node tests passing.

3. Reconcile documentation and rehearse the immutable candidate. Update `README.md` with the ephemeral, non-identity-changing workaround. In an isolated checkout of `4eebd07bce14c9a6ac70bace157fcc616133e950`, reproduce overlay, dependency installation, POM formatting, lint, adapter, and collection without credentials. Acceptance requires one `clean verify`, `BUILD SUCCESS`, Cypress 7/7, green frontend coverage, no TikUI/Vite process, and byte-exact manifest restoration before collection.

4. Complete local validation and review. Run `npm ci`, `npm test`, `npm run prettier:check`, `./mvnw --version`, `npm run dry-run`, YAML parsing, checksum-verified `actionlint`, and `habit-hooks` when available. Audit the diff against every unchanged capability. Acceptance is all applicable checks exiting zero and a scoped publisher-only diff.

5. Deliver and stop. Commit exactly `fix(publisher): stabilize upstream headless verification` with a body explaining the ephemeral runner, preserved single gate, byte-exact restoration, fail-closed contract, and unchanged publication guarantees. Push, open a publisher pull request, wait for `tests`, inspect the hosted diff, and merge without amend or force-push. Stop with `pilotCompleted=false`, issue 3 open, Central untouched, schedules and permissions unchanged, and Seed4J worktrees preserved.

## Progress

- [x] Repeated publisher failures classified as the same TikUI/Vite watcher race before this correction.
- [x] Diagnostic PR 6 closed without merge after run 34727053924 proved watcher collision and 3/3 preview success with 30,867-byte CSS and Cypress 7/7.
- [x] Local publisher branch renamed to `stabilize-publisher-headless-verification` from `main@0ec842cca927463a52c5ac5116db73f82fabfeba`.
- [x] Durable plan reconciled to a publisher-only correction with new stop conditions.
- [x] Adapter and behavior tests implemented; the full publisher suite passes 48/48 tests.
- [x] Workflow policy and README reconciled around the ephemeral, fail-closed contract.
- [x] First immutable rehearsal stopped after Cypress 7/7 because ordinary preview output left frontend coverage below 100% and npm 11.7 rewrote lockfile platform metadata; no candidate was collected.
- [x] Focused isolated experiments proved `npm_config_save=false` preserves the lock byte for byte and an instrumented verify-only Vite build makes the unchanged preview/Cypress path satisfy 100% coverage.
- [x] Fresh immutable candidate rehearsal completed: one `clean verify`, `BUILD SUCCESS`, Cypress 7/7, frontend coverage 100%, byte-exact manifest restoration before collection, zero leftover TikUI/Vite processes, and a four-file candidate bundle.
- [x] Local validation, YAML/actionlint, Habit Hooks, design review, and final boundary audit completed.
- [ ] Exact commit created, pull request opened, `tests` green, diff reviewed, and pull request merged.

## Validation

Tests must execute the CLI adapter against temporary checkout fixtures and observable fake Maven wrappers. They must confirm the exact temporary runner contains unchanged Cypress invocation and config, invokes the sole full gate, restores original manifest bytes, rejects unfamiliar package contracts before Maven, reports nonzero Maven status, and detects lockfile mutation while still restoring it.

The isolated rehearsal follows build-job order without Central credentials: apply the personal overlay, run upstream `npm ci`, format only the POM, run `npm run lint:ci`, invoke the adapter once, confirm restoration and no relevant process, then collect the candidate. Evidence must show one `clean verify`, `BUILD SUCCESS`, Cypress 7/7, and successful frontend coverage checks.

Run:

```bash
npm ci
npm test
npm run prettier:check
./mvnw --version
npm run dry-run
habit-hooks
```

Parse every workflow as YAML and run checksum-verified `actionlint`. Every applicable command must exit 0. The final audit must confirm that only the trusted adapter call changed in the publication workflow; qualification, overlay, lint, collection, manifest, deploy, reporting, token rotation, permissions, schedules, and pinned actions remain intact. It must confirm no skip, retry, `continue-on-error`, Cypress modification, build credential, publisher dispatch, or Seed4J change was introduced.

Hosted acceptance is a green `tests` check followed by an unchanged final diff and merge. After merge, confirm `pilotCompleted=false` and issue 3 open. Do not run `publish.yml`.

Observed locally on 2026-09-12: `npm ci`, `npm test` (48/48), `npm run prettier:check`, `./mvnw --version` (Maven 3.9.16 on Java 25), and `npm run dry-run` all exited 0. Both workflows parsed as YAML. The official actionlint 1.7.12 Linux archive passed its published SHA-256 check and actionlint exited 0. Habit Hooks exited 0 and reported that this publisher has no configured sensor files. The scoped design review found no behavior-preserving structural change justified beyond the implemented fail-closed flow.

The final pre-commit boundary audit found no config, schedule, permission, qualification, overlay, lint, collection, deploy, reporting, token-rotation, pinned-action, Central, or Seed4J change. `pilotCompleted` remained `false`, issue 3 remained open, and the most recent `publish.yml` run remained 34721871206 from before this correction.

## Documentation

`README.md` is the operator-facing contract. It must explain that the publisher briefly substitutes the known watcher command only inside verification, restores both manifests before collection, does not change the qualified upstream SHA or collected artifacts, preserves the complete Maven/Cypress/coverage gate, and exists because diagnostic run 34727053924 correlated Sass/inotify failure on Vite's temporary directory with missing CSS.

This `EXECPLAN.md` is the durable evidence and handoff record. Update it only at milestone boundaries, after material risk or direction changes, and immediately before handoff.

## Rollout and recovery

The pull request is the only rollout. If `tests` fails or the diff changes unexpectedly, do not merge; diagnose on this branch without amend or force-push. If rehearsal fails, remove only its isolated checkout and stop.

After merge, do not dispatch publication. A later plan may use `retry-last-failed` only after separately rechecking identity and issue state. To recover, revert the publisher merge; do not edit Seed4J or hand-modify upstream manifests. Remove the adapter only when a validated upstream watcher-free runner contract exists.
