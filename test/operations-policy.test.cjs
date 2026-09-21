const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalPublisherTimestamp,
  failureIssueUpdate,
  successIssueResolution,
  tokenRotationAction,
  validatePublisherConfig,
} = require("../scripts/operations-policy.cjs");

const identity = Object.freeze({
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

test("creates or updates one marked failure issue and closes it after successful publication", () => {
  const first = failureIssueUpdate({
    existingBody: undefined,
    failure: {
      diagnostic: "manifest digest mismatch",
      failedAt: "2026-09-11T10:20:30Z",
      identity,
      stage: "verify",
      workflowRunUrl:
        "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/123",
    },
  });

  assert.equal(first.action, "create");
  assert.equal(first.title, "[publisher] Seed4J main snapshot failure");
  assert.deepEqual(first.labels, ["publisher-failure"]);
  assert.deepEqual(first.assignees, ["renanfranca"]);
  assert.match(first.body, /@renanfranca/);
  assert.match(first.body, /Stage: `verify`/);
  assert.match(first.body, /manifest digest mismatch/);
  assert.equal((first.body.match(/failure-state:start/g) ?? []).length, 1);
  assert.equal((first.body.match(/failure-state:end/g) ?? []).length, 1);

  const second = failureIssueUpdate({
    existingBody: first.body,
    failure: {
      diagnostic: "Central returned 503",
      failedAt: "2026-09-11T11:22:33Z",
      identity,
      stage: "deploy",
      workflowRunUrl:
        "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/124",
    },
  });

  assert.equal(second.action, "update");
  assert.match(second.body, /manifest digest mismatch/);
  assert.match(second.body, /Central returned 503/);
  assert.equal((second.body.match(/failure-state:start/g) ?? []).length, 1);
  assert.deepEqual(successIssueResolution({ issueNumber: 42, identity }), {
    action: "close",
    comment:
      "Published io.github.renanfranca:seed4j-main-snapshot:2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT from upstream 4eebd07bce14c9a6ac70bace157fcc616133e950; closing the publisher failure.",
    issueNumber: 42,
  });
});

test("warns thirty days before the recorded Central token expiry and closes the warning after rotation", () => {
  assert.deepEqual(
    tokenRotationAction({
      openIssueNumber: undefined,
      recordedExpiry: "2027-03-03",
      today: "2027-01-31",
    }),
    {
      action: "none",
    },
  );
  assert.deepEqual(
    tokenRotationAction({
      openIssueNumber: undefined,
      recordedExpiry: "2027-03-03",
      today: "2027-02-01",
    }),
    {
      action: "create",
      assignees: ["renanfranca"],
      body: "@renanfranca rotate the dedicated Central Portal publisher token before 2027-03-03 and update config/publisher.json with the new expiry date.",
      labels: ["publisher-token-rotation"],
      title: "[publisher] Rotate Central token before 2027-03-03",
    },
  );
  assert.deepEqual(
    tokenRotationAction({
      openIssueNumber: 17,
      recordedExpiry: "2027-09-01",
      today: "2027-03-02",
    }),
    {
      action: "close",
      comment:
        "The recorded Central token expiry is now 2027-09-01; closing the obsolete rotation warning.",
      issueNumber: 17,
    },
  );
});

test("canonicalizes publisher runtime timestamps to whole UTC seconds", () => {
  assert.equal(
    canonicalPublisherTimestamp("2026-09-12T14:25:30Z"),
    "2026-09-12T14:25:30Z",
  );
  assert.equal(
    canonicalPublisherTimestamp("2026-09-12T14:25:30.000Z"),
    "2026-09-12T14:25:30Z",
  );
  assert.equal(
    canonicalPublisherTimestamp("2026-09-12T14:25:30.787Z"),
    "2026-09-12T14:25:30Z",
  );
  for (const timestamp of [
    "2026-02-30T14:25:30Z",
    "2026-13-01T14:25:30Z",
    "2026-09-12T14:25:30.78Z",
    "2026-09-12T14:25:30+00:00",
  ]) {
    assert.throws(
      () => canonicalPublisherTimestamp(timestamp),
      /Invalid publisher runtime timestamp/,
    );
  }
});

test("keeps scheduled publication weekly until the pilot and an explicit eighty-percent quota review permit daily mode", () => {
  const weekly = {
    centralTokenExpiresOn: null,
    pilotCompleted: false,
    quotaReview: null,
    scheduleMode: "weekly",
    schemaVersion: 1,
  };

  assert.deepEqual(validatePublisherConfig(weekly), weekly);
  assert.throws(
    () => validatePublisherConfig({ ...weekly, scheduleMode: "daily" }),
    /quota review/,
  );
  assert.throws(
    () =>
      validatePublisherConfig({
        ...weekly,
        quotaReview: {
          approvedBy: "renanfranca",
          monthlyReleasePercent: 81,
          reviewedOn: "2027-02-01",
          storedBytesPercent: 50,
        },
        scheduleMode: "daily",
      }),
    /80%/,
  );
  const daily = {
    ...weekly,
    pilotCompleted: true,
    quotaReview: {
      approvedBy: "renanfranca",
      monthlyReleasePercent: 70,
      reviewedOn: "2027-02-01",
      storedBytesPercent: 80,
    },
    scheduleMode: "daily",
  };
  assert.deepEqual(validatePublisherConfig(daily), daily);
});
