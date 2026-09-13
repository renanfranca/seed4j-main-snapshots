# Diagnose the TikUI headless runner on GitHub Actions

## Purpose and success

Diagnose why the immutable Seed4J candidate passes local and official verification but the personal publisher fails inside `./mvnw clean verify`. Success means producing GitHub-hosted evidence that either confirms or rejects the observed collision between the TikUI Sass watcher and Vite's transient `node_modules/.vite/deps_temp_*` directory, and testing the no-watcher `preview` arrangement without changing the normative publisher.

## Context and limits

The immutable upstream candidate is `seed4j/seed4j@4eebd07bce14c9a6ac70bace157fcc616133e950`. Publisher runs `34718857592` and `34721871206` both failed after the TikUI Sass process logged `inotify_add_watch` against a missing `.vite/deps_temp_*` directory; the official upstream run `34088809580` and local clean verification were green. The publisher failure issue remains open.

This work is diagnostic only. Do not modify `.github/workflows/publish.yml`, upstream source, Cypress timeouts, the protected `central-snapshots` environment, publisher configuration, schedules, issues, or Central. Do not dispatch the publisher. The diagnostic workflow receives no secrets and no write permission. Preserve all existing worktrees and their uncommitted files.

## Decisions

- Run the first exploration in the publisher repository because its nested `upstream/` checkout reproduces the failed path and current GitHub-hosted environment. The alternative was the Seed4J fork, which is reserved for validating an eventual upstream correction.
- Use a temporary pull request and close it without merge after evidence is recorded. This keeps the normative publisher unchanged while retaining GitHub logs and PR history.
- Treat the two failed publisher runs as the overlaid full-build baseline. Run one pristine full verification plus focused isolated component variants instead of a third identical publisher retry.

## Prototypes

- **Pristine full verification:** checkout the exact upstream SHA without the personal POM overlay, run `npm ci`, `npm run lint:ci`, and `./mvnw --batch-mode -ntp clean verify`. A known watcher collision or a green build is a valid observation; any different failure is a stop condition.
- **Current watcher:** in three fresh jobs, build the frontend and run the unchanged `npm run test:component:headless`, while probing the real CSS endpoint. Record whether the Sass watcher logs the known `inotify_add_watch` failure and whether CSS ever becomes resolvable.
- **Forced Vite optimizer:** in three fresh jobs, start the same TikUI watcher while Vite starts with `--force`. This deliberately increases the chance of the already observed `.vite/deps_temp_*` lifecycle collision without changing Cypress behavior or timeouts.
- **No-watcher preview:** in three fresh jobs, build once, serve TikUI with `tikui-core preview`, serve Vite with `vite preview --strictPort`, wait for `/style/tikui.css`, and run the same Cypress specifications. All three must pass before this arrangement is considered a supported correction hypothesis.

## Milestones

1. Add a temporary pull-request workflow with empty default permissions, exact pinned action revisions, the immutable upstream SHA, bounded diagnostics, and no publication path. Validate its YAML structure and repository formatting locally.
2. Push the diagnostic branch and open a draft PR. Observe every job rather than retrying failed publication infrastructure. Preserve logs, CSS probes, and Cypress screenshots as short-lived diagnostic artifacts.
3. Reconcile the evidence across the existing overlaid failures, pristine verification, watcher variants, and preview variants. Record exact run and job URLs and classify any unexpected signature.
4. Close the diagnostic PR without merge. Leave the branch available until the separate upstream-fix plan is agreed; do not alter or close the publisher failure issue.

## Progress

- [x] Confirmed the two normative publisher failures have the same TikUI `inotify_add_watch` signature.
- [x] Created an isolated publisher worktree from `origin/main@0ec842cca927463a52c5ac5116db73f82fabfeba` on branch `tikui-headless-diagnostic`.
- [x] Added and locally validated the diagnostic workflow.
- [ ] Opened the temporary draft PR and observed all GitHub-hosted experiments.
- [ ] Reconciled results and closed the PR without merge.

## Validation

Before pushing, run:

```bash
npm ci
npm test
npm run prettier:check
```

Observed before push on 2026-09-12: `npm ci` exited 0, `npm test` exited 0 with 44/44 tests passing, `npm run prettier:check` exited 0, the workflow parsed as YAML, and checksum-verified `actionlint` 1.7.12 exited 0. A capability audit found no Central credentials, secrets, protected environment, issue mutation, schedule, report, token rotation, or deploy reference in the diagnostic workflow.

The existing publisher `tests` check must remain green. The diagnostic workflow must expose its command exit status and known-signature detection in the job summary, upload only logs/probes/screenshots, and never upload publication JARs.

The watcher hypothesis is confirmed when a pristine watcher variant records the same `.vite/deps_temp_*` `inotify_add_watch` signature with missing CSS, while all three preview variants resolve non-empty `/style/tikui.css` and pass the unchanged Cypress suite. A different failure signature stops the conclusion. Green watcher samples without the signature are recorded as timing-dependent observations and do not disprove the race.

## Rollout and recovery

This diagnostic PR is never merged. If the workflow unexpectedly reaches any secret, environment, issue mutation, schedule, or deploy path, cancel it immediately and remove that capability before further runs. After evidence is recorded, close the PR without merge; GitHub retains its logs and the branch can be deleted only after separate user authorization. Any upstream runner change and subsequent publisher recovery require separate reviewed plans.
