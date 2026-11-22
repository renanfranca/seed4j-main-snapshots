# Publish modular Seed4J snapshots

## Purpose and success

Publish the Seed4J parent, API, engine, test tools, and core modules under `io.github.renanfranca` at one version derived from the full upstream SHA. A publication succeeds after Sonatype confirms five POMs and four JARs. A standalone Maven consumer must run against both the premerge file repository and the public snapshot repository. Report a partial publication explicitly and identify whether a later confirmation recovered the recorded SHA or superseded it.

## Context and limits

The publisher lives in `renanfranca/seed4j-main-snapshots`. Upstream build code runs without publishing credentials. The protected `central-snapshots` job receives a file bundle and checks it using trusted publisher code. Preserve exact SHA official CI, the existing Maven goal, and the operator's recorded SHA for retries.

## Milestones

1. Qualify the reactor and reject legacy retries in `scripts/qualify-candidate.cjs`. Exercise both routes through `npm test`.
2. Prepare and build the reactor in `scripts/prepare-upstream.cjs` and the publish workflow. Collect and verify the nine files via `scripts/artifact-policy.cjs`. Exercise the deploy adapter and run `npm run dry-run`.
3. Observe snapshot files in Sonatype before qualification and after deployment. Document the retention window, partial recovery, and coordinates in `README.md`. Run the complete publisher suite and formatter check.
4. Publish a verified bundle into a temporary Maven file repository and run an isolated consumer. Open the issue and PR, verify the merge and protected `head` run, and repeat the consumer check against public Sonatype.
5. Clarify partial recovery in `scripts/publication-cycle.cjs`, `scripts/report-result.cjs`, and `scripts/operations-policy.cjs`. Verify failure issue transitions and protected deployment with simulated GitHub, Sonatype, and Maven. Document the operator outcomes in `README.md`. Run the publisher validation commands below.

## Progress

- [x] Created `feat/modular-snapshots` and confirmed the baseline of 100 passing tests.
- [x] Complete qualification, artifact and retention behavior.
- [x] Verify the standalone consumer before merge.
- [ ] Verify the protected full reactor run and public consumer after merge.
- [x] Clarify and test partial recovery on `fix/partial-snapshot-recovery`, based on the merge of PR #24.

## Validation

Run `npm test`, `npm run prettier:check`, `npm run dry-run`, and `git diff --check`. For each consumer proof, use a fresh `maven.repo.local` and verify the downloaded parent and the API resolved from the engine and core modules.

The premerge file proof used upstream SHA `65403861f94c000ecf2e0db50ed53e030b39d290`, whose official
[build run](https://github.com/seed4j/seed4j/actions/runs/44960671325) succeeded. The local full verification passed
the parent and four published modules. Nine server integration tests required a Docker environment unavailable locally.
In a separate run, the upstream Playwright command passed seven tests. All five Maven uploads to a temporary
`file://` repository succeeded and produced nine files. A separate Java 25 consumer with an empty local Maven repository
compiled against the engine and core modules, passed one test with the test tools, and resolved the API transitively and
the parent under the same personal version
`2.4.1-main.20261121.231244.65403861f94c000ecf2e0db50ed53e030b39d290-SNAPSHOT`.

The design review removed the executable monolithic preparation, collection, and upload paths. Historical failure
identities can still be read to reject legacy retries before build. The final local checks cover the modular data
boundary, ordered deployment, public confirmation and partial recovery. Follow rollout evidence in
[issue #23](https://github.com/renanfranca/seed4j-main-snapshots/issues/23).

### Partial recovery evidence

| Scenario                                         | Observed result                                                                                                                                                                                                                                         | Automated evidence                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `head` sees SHA A at 3/9                         | The final report says `partial-snapshot-requires-retry`, names A, lists the parent POM and API POM and JAR, and directs the operator to manual retry. Build and deploy are skipped. The failure issue records A.                                        | `test/qualification-adapter.test.cjs`, `test/workflow-policy.test.cjs`   |
| SHA B is waiting for official CI                 | B's cycle remains open. The existing failure issue retains A, and `retry-last-failed` selects A.                                                                                                                                                        | `test/qualification-adapter.test.cjs`, `test/workflow-policy.test.cjs`   |
| SHA B fails its publisher build or deploy        | Each failure updates the same open issue. The next retry qualifies B.                                                                                                                                                                                   | `test/qualification-adapter.test.cjs`                                    |
| SHA B completes publication while A is recorded  | The reporting test supplies the successful protected deploy result. The comment names A and B, says B superseded A, and closes the issue. A subsequent retry has no eligible failure. The protected deploy tests verify the nine-file success contract. | `test/qualification-adapter.test.cjs`, `test/artifact-boundary.test.cjs` |
| Retry finds all nine files for A                 | Qualification selects A and skips deployment. The closing comment says A was recovered.                                                                                                                                                                 | `test/qualification-adapter.test.cjs`                                    |
| Legacy failure identity is missing or unreadable | The reporter posts the generic resolution comment and closes the issue.                                                                                                                                                                                 | `test/reporting-adapter.test.cjs`                                        |
| Protected deploy retries A at 3/9                | The Maven wrapper receives five invocations in parent, API, engine, test, and core modules order. The deploy confirms 9/9.                                                                                                                              | `test/artifact-boundary.test.cjs`                                        |
| Protected deploy finds a recent, complete set    | It confirms 9/9 with zero Maven invocations.                                                                                                                                                                                                            | `test/artifact-boundary.test.cjs`                                        |
| Protected deploy refreshes an expired set        | It waits when the ninth file is stale or unavailable. It succeeds when all nine are visible and inside the retention window. If one file stays unavailable through all four checks, it reports failure at 8/9.                                          | `test/artifact-boundary.test.cjs`                                        |

The design review found a risk of inconsistent partial outcome strings across action selection and report rendering.
The cycle uses one local outcome identifier for both. The closing comment uses the same identity parser as retry
qualification, with the generic fallback limited to reporting.

A local command line check ran the actual `deploy-candidate.cjs execute` and `report-result.cjs` entry points
in sequence with simulated Sonatype, Maven, and GitHub. The deploy exited 0 after confirming 9/9 for
`7805dd517f11234e958cfc638f75d3bd8fc47260`. Reporting exited 0, closed the issue, and stated that this SHA
superseded the recorded partial SHA `4eebd07bce14c9a6ac70bace157fcc616133e950`.

All requested checks exited 0. `npm test` passed 112 tests. `npm run prettier:check` accepted all files.
`npm run dry-run` produced five deploy commands in order. `git diff --check` reported no whitespace errors.

### Evidence pending in live services

The follow-up scenarios above were exercised locally. The hosted GitHub Actions job, real Central uploads and
propagation, and a Maven consumer against the public repository have no evidence from this follow-up.
