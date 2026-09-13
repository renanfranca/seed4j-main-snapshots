# Execute and complete the publisher pilot autonomously

## Purpose and success

Execute the first real publication from `renanfranca/seed4j-main-snapshots`, observe the complete workflow, validate the public artifacts, and enable the weekly schedule without requesting intervention during execution.

The pilot is complete only when:

- `publish.yml` runs from `main` with `operation=head`;
- qualification, build, deploy, reporting, and token rotation are green;
- the build contains exactly one `./mvnw --batch-mode -ntp clean verify`, Cypress passes 7/7, and coverage is approved;
- the POM, main JAR, and tests JAR resolve from a clean Maven repository and match the manifest;
- sources and Javadoc remain unavailable;
- issue 3 is closed automatically by reporting;
- `pilotCompleted=true` is merged through a green pull request;
- `scheduleMode=weekly`, `quotaReview=null`, the token, permissions, and Environment remain unchanged;
- the checkout ends clean on `main`, with no temporary branches.

## Context and limits

The publisher correction for the upstream headless runner is already merged in `main@192c104a683e5c8612c1e152f3dd1344043006de` and passed its hosted tests. The last verified upstream candidate was `seed4j/seed4j@4eebd07bce14c9a6ac70bace157fcc616133e950` with the official upstream CI green. The definitive candidate is the one qualified by the workflow at dispatch time; its manifest makes the upstream SHA and snapshot version immutable for all later checks.

At approval time, the candidate was absent from Central, issue 3 was open, and both named secrets existed only in the `central-snapshots` Environment. Reconfirm those facts immediately before dispatch instead of assuming they remain true.

Do not change Seed4J, seed4j-cli, Cypress, schedule YAML, permissions, Central, secrets, the token, or Environment protection. Do not publish npm, update the experimental dependency, or evaluate daily mode. The only public operational repository change after the pilot is `pilotCompleted: false` to `true`, which enables Monday at `06:17 UTC`; daily cron invocations must continue to terminate with `daily-schedule-not-enabled`.

This ExecPlan records the user's one-time approval exception delegating uninterrupted observation and conclusion of this pilot to the executor. The README and its general human-gate rule remain unchanged. The `central-snapshots` Environment remains restricted to `main`; because no required reviewer is configured, the deploy job is not expected to pause for live approval.

One bounded technical correction cycle is authorized only when the cause is attributable to this publisher. Use `retry-last-failed` when the reporting issue contains the complete candidate identity. Use `head` again only when qualification failed before producing an identity. Never repeat a workflow blindly, use `continue-on-error`, skip or modify tests, or bypass protection.

Invalid credentials, a namespace or SNAPSHOT publication capability that is not enabled, a Central outage or rejection not caused by the publisher, suspected credential exposure, an unexpected artifact, or an unknown upstream contract are definitive stop conditions. A second publication failure is also definitive. In any stop condition, keep `pilotCompleted=false`, leave the issue open, and keep all publication schedules inert.

The first approved `head` dispatch was run 34734778818 from reviewed publisher `main@c280da29123504855221e93076c77001025c1b2b`. Qualification, token rotation, the complete unprivileged build, candidate collection, artifact upload, and reporting succeeded. The deploy stopped before creating the private Maven settings file or invoking Maven because the trusted verifier compared the Prettier-formatted candidate POM with the pre-format metadata template byte for byte. The only observed difference is Prettier's deterministic wrapping of the long `<description>` element. Issue 3 now records the complete immutable identity, so the authorized correction is on `3-publisher-pilot-recovery` and its single redispatch operation is `retry-last-failed`.

## Decisions

- Run `head`, not `retry-last-failed`, because the first successful publication must be the observed pilot of the official upstream HEAD qualified at dispatch time.
- After complete public validation, activate weekly mode only. Do not trigger another publication after weekly activation.
- Permit at most one publisher-only correction through the mandatory pull-request gate and one appropriate redispatch. Choose the redispatch operation from the presence or absence of complete identity in the reporting issue, never from convenience.
- Treat the manifest produced by qualification as the immutable source for SHA, version, filenames, sizes, and hashes throughout the build, deploy, public-resolution, reporting, and completion checks.
- Preserve the general README human gate. This plan alone records the exceptional authorization for autonomous observation and completion of this single pilot.
- Keep privileged POM verification byte-exact by rendering the trusted metadata template in the canonical shape produced by the mandatory upstream Prettier step. Do not introduce general whitespace normalization; the alternative would accept representations outside the single observed publisher path and weaken the fail-closed boundary.

## Risks

- Central snapshot propagation may lag a successful deploy. Poll public metadata for at most 15 minutes at 30-second intervals; this is observation, not a publication retry.
- A green aggregate run can conceal an unacceptable skipped or duplicated gate. Audit each required job and the complete build log, including the exact Maven invocation count, Cypress result, coverage result, manifest restoration, bundle boundary, and credential boundary.
- Resolving artifacts from a warm local repository could produce false confidence. Use a newly created empty `maven.repo.local` for every public-resolution check and compare bytes, size, and SHA-256 with the downloaded run bundle and its manifest.
- A completion change could accidentally alter schedules, credentials, or permissions. Restrict the final branch to the config flag, its policy test, and this ExecPlan, then audit the hosted diff before merge.
- Token rotation may change the token value as part of the intended workflow while preserving its configured expiry and security boundary. Never print, retrieve, compare, or expose secret values; validate only the job result, secret names, Environment placement, expiry configuration, and unchanged permissions.

## Milestones

1. Materialize and approve this operational plan. Replace the completed watcher-correction `EXECPLAN.md` with this plan on branch `publisher-pilot`, commit exactly `docs(publisher): define complete pilot execution`, push, open a pull request to `main`, await the `tests` check, review the final diff, and merge normally. Run `npm ci`, `npm test`, `npm run prettier:check`, `./mvnw --version`, `npm run dry-run`, YAML parsing, checksum-verified `actionlint`, and `habit-hooks` before the pull request. Acceptance is a green, reviewed plan-only pull request merged to `main`, followed by a clean local `main` and removal of the temporary branch.

2. Reconfirm the live boundary and dispatch the publication. Immediately before dispatch, prove a clean worktree, publisher `main` green with no active workflow, upstream HEAD with official CI green, absent Central metadata for the qualified candidate version if already knowable, issue 3 as the single open pilot issue, correct Environment secret names, and an Environment deployment policy restricted to `main`. Then run `gh workflow run publish.yml --repo renanfranca/seed4j-main-snapshots --ref main -f operation=head`, capture the run URL and ID, and observe it with `gh run watch <run-id> --exit-status`. Acceptance is success of `qualify`, `build`, `deploy`, `report`, and `token-rotation` from the reviewed `main` commit.

3. Audit the workflow and validate public publication. Inspect the complete run logs for immutable qualified identity, exactly one `./mvnw --batch-mode -ntp clean verify`, `BUILD SUCCESS`, Cypress 7/7, approved frontend coverage, non-empty CSS, byte-exact manifest restoration, a four-file candidate bundle, and no credentials in the build job. Download `publisher-candidate-<upstream-sha>` immediately into a directory created with `mktemp -d`; require only `candidate-manifest.json`, the POM, main JAR, and tests JAR, and verify identity, sizes, and SHA-256. Poll Central metadata every 30 seconds for no more than 15 minutes. In a separate empty Maven repository, use Maven Dependency Plugin `3.11.0`, `transitive=false`, and only `https://central.sonatype.com/repository/maven-snapshots/` to resolve the POM, main JAR, and tests JAR separately, compare their bytes, sizes, and SHA-256 with the manifest, and require resolution failure for the `sources` and `javadoc` classifiers. Confirm issue 3 received the exact GAV and upstream SHA comment and closed automatically. Acceptance is complete agreement between workflow identity, bundle, public repository, and reporting, with no extra artifact.

4. Record completion and activate weekly publication. Create `record-publisher-pilot` from the updated clean `main`. Change only `config/publisher.json` to set `pilotCompleted=true`, the policy test to expect the new configuration, weekly eligibility, and daily inertness, and this ExecPlan to record the run, SHA, version, hashes, public checks, issue closure, and final state. Preserve `scheduleMode=weekly`, `quotaReview=null`, `centralTokenExpiresAt=2027-03-10`, workflows, permissions, secrets, and Environment. Run the same local validation as milestone 1, commit exactly `chore(publisher): record successful pilot`, push, open a pull request, await `tests`, review the hosted diff, and merge normally. Then await the `main` build, restore the local checkout to clean `main`, and remove local and remote temporary branches. Acceptance is a green merged completion PR, weekly eligibility with daily inertness, no second publication dispatch, and no remaining temporary branch.

If the first publication has a technical failure attributable to the publisher, update this plan at that material boundary, create `3-publisher-pilot-recovery` from current `main`, correct only the observed cause, run the complete local and pull-request validation, merge normally, and perform one redispatch using the operation selected by the Decisions section. If the redispatch fails or any definitive stop condition occurs, end without milestone 4 and record the observed evidence before handoff.

## Progress

- [x] Headless runner correction merged and validated in the publisher.
- [x] Publisher, upstream, Central, Environment, secrets, issue, and checks inspected before approval.
- [x] Exceptional authorization, final schedule, and failure policy decided.
- [x] Operational ExecPlan created on `publisher-pilot` from clean `main@192c104a683e5c8612c1e152f3dd1344043006de`.
- [x] New ExecPlan validated in pull request 8 and merged as `c280da29123504855221e93076c77001025c1b2b` before dispatch.
- [x] Live pre-dispatch boundary reconfirmed: clean green publisher main, no active workflow, green official upstream HEAD, candidate absent, issue 3 uniquely open, expected Environment secrets, and main-only deployment policy.
- [x] First `head` run 34734778818 completed qualification, build, reporting, and token rotation; deploy failed before Maven on the publisher's strict pre-format versus post-format POM comparison.
- [x] Canonical formatted POM contract corrected on `3-publisher-pilot-recovery`; regression suite and dry-run against run 34734778818's real bundle are green without creating Maven settings.
- [ ] Recovery correction merged through one green pull request.
- [ ] Single `retry-last-failed` redispatch succeeds without another build or artifact contract change.
- [ ] `head` pilot completed and full logs audited.
- [ ] Public artifacts and absence of sources and Javadoc verified.
- [ ] Issue 3 closed automatically.
- [ ] `pilotCompleted=true` merged with green `tests`.
- [ ] `main` restored and temporary branches removed.

## Validation

Before each pull request, run:

```bash
npm ci
npm test
npm run prettier:check
./mvnw --version
npm run dry-run
habit-hooks
```

Parse all workflow YAML and run `actionlint` from an official archive whose checksum matches its published SHA-256. All applicable commands must exit zero. Do not run the upstream `clean verify` locally again; the pilot run owns the one authoritative complete upstream gate.

Observed for the recovery on 2026-09-13: `npm ci`, `npm test` (48/48), `npm run prettier:check`, `./mvnw --version` (Maven 3.9.16 on Java 25), `npm run dry-run`, workflow YAML parsing, checksum-verified `actionlint` 1.7.12, and `habit-hooks` exited zero. The patched privileged dry-run also accepted the exact four-file bundle downloaded from run 34734778818 and did not create a Maven settings file. No upstream `clean verify` was run locally.

For public resolution, use an empty Maven local repository and Maven Dependency Plugin `3.11.0` with `transitive=false` to resolve separately:

```text
io.github.renanfranca:seed4j-main-snapshot:<version>:pom
io.github.renanfranca:seed4j-main-snapshot:<version>:jar
io.github.renanfranca:seed4j-main-snapshot:<version>:jar:tests
```

Use only `https://central.sonatype.com/repository/maven-snapshots/`. Compare the three resolved files byte for byte and by size and SHA-256 against the candidate bundle and manifest. Resolve `sources` and `javadoc` from a fresh repository and require both operations to fail.

Final acceptance requires a green pilot workflow linked to the reviewed `main`, three public artifacts identical to the bundle, unavailable sources and Javadoc, automatically closed issue 3, merged `pilotCompleted=true`, weekly eligibility with daily inertness, no exposed secret, no change to Seed4J, seed4j-cli, Central configuration, token metadata, permissions, workflows, or Environment, and a clean publisher checkout on `main` with no temporary branches.

## Documentation

`README.md` remains the canonical general operator contract and is intentionally unchanged. This `EXECPLAN.md` is the durable authorization and evidence record for the one autonomous pilot exception. At milestone boundaries, record concrete run IDs, immutable identity, hashes, validation outcomes, issue state, pull-request commits, and final repository state without recording secret values.

## Rollout and recovery

The rollout has two mandatory reviewed pull requests surrounding one publication dispatch: the plan PR before dispatch and the completion PR after public validation. Neither pull request may be merged with failed or pending `tests`, an unexpected diff, or bypassed protection.

The only authorized recovery is one publisher-only correction PR followed by one appropriate redispatch. Do not use skips, retries inside the gate, workflow bypass, secret changes, Environment changes, or upstream edits. If recovery is exhausted or a definitive stop condition occurs, leave `pilotCompleted=false`, keep issue 3 open, preserve inert schedules, restore a clean `main`, and hand off the evidence. After successful completion, do not dispatch again; the next eligible publication is the configured weekly schedule.
