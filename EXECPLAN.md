# Publish modular Seed4J snapshots

## Purpose and success

Publish the Seed4J parent, API, engine, test tools, and core modules under `io.github.renanfranca` at one version derived from the full upstream SHA. A publication succeeds after Sonatype confirms five POMs and four JARs. A standalone Maven consumer must run against both the premerge file repository and the public snapshot repository.

## Context and limits

The publisher lives in `renanfranca/seed4j-main-snapshots`. Upstream build code runs without publishing credentials. The protected `central-snapshots` job receives a file bundle and checks it using trusted publisher code. Preserve exact SHA official CI, the existing Maven goal, and the operator's recorded SHA for retries.

## Milestones

1. Qualify the reactor and reject legacy retries in `scripts/qualify-candidate.cjs`. Exercise both routes through `npm test`.
2. Prepare and build the reactor in `scripts/prepare-upstream.cjs` and the publish workflow. Collect and verify the nine files via `scripts/artifact-policy.cjs`. Exercise the deploy adapter and run `npm run dry-run`.
3. Observe snapshot files in Sonatype before qualification and after deployment. Document the retention window, partial recovery, and coordinates in `README.md`. Run the complete publisher suite and formatter check.
4. Publish a verified bundle into a temporary Maven file repository and run an isolated consumer. Open the issue and PR, verify the merge and protected `head` run, and repeat the consumer check against public Sonatype.

## Progress

- [x] Created `feat/modular-snapshots` and confirmed the baseline of 100 passing tests.
- [x] Complete qualification, artifact and retention behavior.
- [x] Verify the standalone consumer before merge.
- [ ] Verify the protected full reactor run and public consumer after merge.

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
