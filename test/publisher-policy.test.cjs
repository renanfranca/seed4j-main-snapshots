const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deriveSnapshotIdentity,
  qualifyCandidate,
  retentionDecision,
} = require("../scripts/publisher-policy.cjs");

test("derives the same personal snapshot identity from immutable upstream facts", () => {
  const upstream = {
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  };

  const firstIdentity = deriveSnapshotIdentity(upstream);
  const retryIdentity = deriveSnapshotIdentity(upstream);

  assert.deepEqual(firstIdentity, {
    artifactId: "seed4j-main-snapshot",
    groupId: "io.github.renanfranca",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    version:
      "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  });
  assert.deepEqual(retryIdentity, firstIdentity);
});

test("rejects missing, malformed, or ambiguous upstream identity facts", () => {
  const valid = {
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  };
  const invalidCandidates = [
    { ...valid, upstreamSha: "" },
    { ...valid, upstreamSha: "4EEBD07BCE14C9A6AC70BACE157FCC616133E950" },
    { ...valid, upstreamCommitTimestamp: "2026-09-07T05:58:00+02:00" },
    { ...valid, upstreamCommitTimestamp: "not-a-time" },
    { ...valid, upstreamLicenseSha256: "not-a-digest" },
    { ...valid, upstreamPomVersion: "" },
    { ...valid, upstreamPomVersion: "${revision}" },
    { ...valid, upstreamPomVersion: "2.2.1-SNAPSHOT-SNAPSHOT" },
  ];

  for (const candidate of invalidCandidates) {
    assert.throws(() => deriveSnapshotIdentity(candidate), /upstream/i);
  }
});

test("rejects a derived Maven version longer than 256 characters", () => {
  assert.throws(
    () =>
      deriveSnapshotIdentity({
        upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
        upstreamLicenseSha256:
          "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
        upstreamPomVersion: `2.2.1-${"a".repeat(200)}-SNAPSHOT`,
        upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
      }),
    /256 characters/i,
  );
});

test("qualifies only the exact successful official upstream push build and treats every other result as a skip", () => {
  const candidate = {
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  };
  const successfulCheck = {
    conclusion: "success",
    event: "push",
    headSha: candidate.upstreamSha,
    status: "completed",
    workflow: "github-actions.yml",
  };

  const qualified = qualifyCandidate({
    candidate,
    operation: "head",
    upstreamCheck: successfulCheck,
  });

  assert.equal(qualified.outcome, "qualified");
  assert.deepEqual(qualified.identity, deriveSnapshotIdentity(candidate));
  for (const upstreamCheck of [
    undefined,
    { ...successfulCheck, status: "queued", conclusion: undefined },
    { ...successfulCheck, conclusion: "cancelled" },
    { ...successfulCheck, conclusion: "failure" },
    { ...successfulCheck, event: "pull_request" },
    { ...successfulCheck, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...successfulCheck, workflow: "another-workflow.yml" },
  ]) {
    assert.deepEqual(
      qualifyCandidate({ candidate, operation: "head", upstreamCheck }),
      {
        openFailureIssue: false,
        outcome: "skip",
        reason: "official-upstream-build-not-successful",
        upstreamSha: candidate.upstreamSha,
      },
    );
  }
});

test("retry derives its candidate only from deterministic failure markers and requires official reachability", () => {
  const retryIssueBody = `Publisher diagnostics before marker.
<!-- seed4j-main-snapshot-publisher-failure-state:start -->
\`\`\`json
{
  "artifactId": "seed4j-main-snapshot",
  "derivedVersion": "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  "groupId": "io.github.renanfranca",
  "upstreamCommitTimestamp": "2026-09-07T05:58:00Z",
  "upstreamLicenseSha256": "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  "upstreamPomVersion": "2.2.1-SNAPSHOT",
  "upstreamSha": "4eebd07bce14c9a6ac70bace157fcc616133e950"
}
\`\`\`
<!-- seed4j-main-snapshot-publisher-failure-state:end -->`;
  const upstreamCheck = {
    conclusion: "success",
    event: "push",
    headSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    status: "completed",
    workflow: "github-actions.yml",
  };

  const result = qualifyCandidate({
    operation: "retry-last-failed",
    retryIssueBody,
    retryReachable: true,
    upstreamCheck,
  });

  assert.equal(result.outcome, "qualified");
  assert.equal(
    result.identity.version,
    "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  );
  assert.throws(
    () =>
      qualifyCandidate({
        operation: "retry-last-failed",
        retryIssueBody,
        retryReachable: false,
        upstreamCheck,
      }),
    /reachable from official upstream/,
  );
  assert.throws(
    () =>
      qualifyCandidate({
        operation: "retry-last-failed",
        retryIssueBody: "untrusted prose",
        retryReachable: true,
        upstreamCheck,
      }),
    /failure state markers/,
  );
  assert.throws(
    () =>
      qualifyCandidate({
        candidate: {},
        operation: "4eebd07bce14",
        upstreamCheck,
      }),
    /Unsupported publisher operation/,
  );
});

test("uses public Central state to skip recent snapshots and refresh absent or sixty-day snapshots", () => {
  const identity = deriveSnapshotIdentity({
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  });
  const recentCentralMetadata = {
    lastUpdated: "20260910060000",
    status: 200,
    version: identity.version,
  };

  assert.deepEqual(
    retentionDecision({
      centralMetadata: recentCentralMetadata,
      identity,
      now: "2026-09-20T06:00:00Z",
    }),
    {
      openFailureIssue: false,
      outcome: "skip",
      reason: "snapshot-published-within-60-days",
    },
  );
  assert.deepEqual(
    retentionDecision({
      centralMetadata: recentCentralMetadata,
      identity,
      now: "2026-11-09T06:00:00Z",
    }),
    {
      outcome: "publish",
      reason: "retention-refresh",
    },
  );
  assert.deepEqual(
    retentionDecision({
      centralMetadata: { status: 404 },
      identity,
      now: "2026-09-20T06:00:00Z",
    }),
    {
      outcome: "publish",
      reason: "snapshot-absent",
    },
  );
  assert.throws(
    () =>
      retentionDecision({
        centralMetadata: {
          ...recentCentralMetadata,
          version: "another-version-SNAPSHOT",
        },
        identity,
        now: "2026-09-20T06:00:00Z",
      }),
    /Central metadata version/,
  );
});
