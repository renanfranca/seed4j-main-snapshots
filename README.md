# Seed4J main snapshot publisher

This repository publishes **unofficial** personal rebuilds of the official Seed4J `main` branch for deliberate
experimental use by `seed4j-cli`. It is not operated or endorsed by the Seed4J maintainers and never publishes under
their `com.seed4j` namespace.

The only Maven coordinate is:

```text
io.github.renanfranca:seed4j-main-snapshot:<derived-snapshot-version>
```

## Publication contract

Every candidate is bound to the official `seed4j/seed4j` full commit SHA, that commit's UTC timestamp, and the upstream
POM version. Those facts deterministically produce:

```text
<upstream-base>-main.<yyyyMMdd>.<HHmmss>.<first-12-sha>-SNAPSHOT
```

The data-only candidate contains exactly:

1. the generated POM;
2. the main JAR; and
3. the `tests` classifier JAR.

Sources and Javadoc JARs are explicitly not published. The manifest fixes the personal GAV, exact filenames, roles,
sizes, SHA-256 digests, repository URL, upstream POM version, and full upstream SHA. The main JAR also embeds immutable
provenance carrying the exact upstream SHA, version, timestamp, official repository URL, personal publisher identity,
and unofficial release-channel marker. The upstream Apache-2.0 license and the publisher notice are retained in the
packaged JAR.

Central snapshots can expire. A snapshot whose public Central metadata is less than 60 days old is an expected skip.
At 60 days the same immutable base version becomes eligible for a retention refresh, and an absent snapshot is eligible
for republication.

## Credential boundary

The qualification and build jobs never receive Central deployment secrets. Qualification has read-only access to the
official commit, official `github-actions.yml` result, public Central metadata, and the sole marked retry issue. The
build job checks out the exact qualified SHA without persisted credentials, applies only personal publication metadata
and provenance, then runs upstream `npm ci`, `npm run lint:ci`, and `./mvnw clean verify`.

The deploy job is separate and main-only. It starts from a clean trusted publisher checkout, downloads only the
data-only bundle, rejects unexpected files and manifest fields, rechecks every digest and published POM field, and runs
only Maven Wrapper 3.9.16 with `maven-deploy-plugin:3.1.4:deploy-file`. It never runs upstream scripts, Maven lifecycle,
JARs, or executable output.

Only this deploy job references the protected `central-snapshots` GitHub Environment. Credentials are written to a
temporary mode-`0600` Maven settings file, removed after Maven exits, scrubbed from the child environment, and never
printed or placed in command arguments.

All third-party GitHub Actions are pinned to full commit SHAs. Repository permissions default to empty and expand only
within the job that needs them.

## Required external setup

Before any pilot, the maintainer must:

1. verify the Central namespace `io.github.renanfranca` through the `renanfranca` GitHub account;
2. create a dedicated Central Portal user token with a 180-day lifetime;
3. create the protected `central-snapshots` Environment, restrict it to protected `main` deployments only, and add only
   `CENTRAL_USERNAME` and `CENTRAL_PASSWORD` as environment secrets;
4. create the `publisher-failure` and `publisher-token-rotation` labels;
5. protect `main`, require the `tests` check and pull requests, and disable force pushes and branch deletion; and
6. record the token expiry as `centralTokenExpiresAt` in `config/publisher.json`.

The automation does not create credentials, verify namespaces, change repository/environment protection, purchase a
Central plan, or create external configuration.

## Pilot and schedule policy

The repository starts with `pilotCompleted=false`, `scheduleMode=weekly`, `centralTokenExpiresAt=null`, and no quota
review. Scheduled runs therefore stop safely before candidate resolution. The first publication must be a manually
observed pilot dispatched from `main` with operation `head`; the protected-environment approval is the final human gate.

After resolving the published POM, main JAR, and tests JAR from a clean Maven repository—and confirming that sources and
Javadoc remain unavailable—record `pilotCompleted=true` through a reviewed pull request. The default schedule is every
Monday at 06:17 UTC.

Daily checks at 06:17 UTC remain inert while `scheduleMode=weekly`. Daily publication can be selected only through a
reviewed config change after `renanfranca` records projected monthly release count and stored bytes at or below 80% of
the current Central limits. A changed allowance requires a new quota review. Automation never enables daily mode or a
paid plan automatically.

## Failure, retry, and token rotation

Missing, queued, pending, cancelled, or unsuccessful official upstream CI is an expected skip. A snapshot published
less than 60 days ago is also an expected skip. These outcomes remain visible in the workflow summary and never create
a failure issue.

A failure after qualification creates or updates one `[publisher] Seed4J main snapshot failure` issue with the
`publisher-failure` label, assignment and mention for `@renanfranca`, the failed stage, workflow run, full upstream SHA,
derived version, concise diagnostic, accumulated history, and one deterministic retry marker.

Dispatch `retry-last-failed` only after correcting the trusted publisher or external outage. Retry refuses free-form
SHAs and requires exactly one marked issue, re-fetches and re-derives the official identity, confirms reachability from
official `main`, and again requires successful official CI. A successful retry or newer current publication closes the
failure issue.

Token-rotation reporting reads only the recorded expiry. It opens or updates one `publisher-token-rotation` issue 30
days before expiry and closes an obsolete warning after the maintainer rotates the token and records the new date.
Secrets are never read by token reporting.

## Monitoring and recovery

Monitor workflow summaries, the two publisher labels, protected-environment approvals, public snapshot metadata, and
Central usage after every pilot, retry, refresh, or cadence change. Duplicate marked issues, a manifest rejection,
unexpected environment access, or a quota projection above 80% is a stop condition.

For a publisher failure, preserve the manifest and issue history, repair the trusted code, and use
`retry-last-failed`; never hand-edit marker state or substitute an arbitrary ref. For suspected credential exposure,
disable the publish workflow, revoke the dedicated token, remove the environment secrets, investigate, and provision a
new protected token before retrying.

To roll back or retire the personal channel, first move consumers to a validated good or official coordinate. Then
disable publication and revoke the dedicated token. Do not delete existing snapshots; allow Central retention to
expire them naturally.

## Local verification

Use Node.js 24+, Java 25, and the checked-in Maven Wrapper:

```bash
npm ci
npm test
npm run prettier:check
./mvnw --version
npm run dry-run
```

The dry run builds and verifies a deterministic local fixture in `/tmp/seed4j-main-snapshots-dry-run`, prints the exact
credential-free deployment plan, and never contacts or publishes to Central.
