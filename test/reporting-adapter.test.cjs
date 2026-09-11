const assert = require("node:assert/strict");
const test = require("node:test");

const { encodeIdentity } = require("../scripts/publisher-policy.cjs");
const { reportPublisherResult } = require("../scripts/report-result.cjs");

const identity = Object.freeze({
  artifactId: "seed4j-main-snapshot",
  groupId: "io.github.renanfranca",
  upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
  upstreamPomVersion: "2.2.1-SNAPSHOT",
  upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  version: "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
});

test("expected qualification skips never read or mutate publisher issues", async () => {
  let requests = 0;

  const result = await reportPublisherResult({
    outcome: "skip",
    reason: "official-upstream-build-not-successful",
    request: async () => requests++,
  });

  assert.deepEqual(result, { action: "none", reason: "expected-skip" });
  assert.equal(requests, 0);
});

test("a qualified failure creates the single marked failure issue with deterministic retry state", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    if (options.method === "POST") {
      return { body: { number: 41 }, status: 201 };
    }
    return { body: [], status: 200 };
  };

  const result = await reportPublisherResult({
    buildResult: "failure",
    encodedIdentity: encodeIdentity(identity),
    now: "2026-09-11T10:20:30Z",
    outcome: "publish",
    reason: "snapshot-absent",
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/123",
  });

  assert.deepEqual(result, { action: "create", issueNumber: 41 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /issues\?state=open&labels=publisher-failure/);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(calls[1].options.body.labels, ["publisher-failure"]);
  assert.deepEqual(calls[1].options.body.assignees, ["renanfranca"]);
  assert.match(calls[1].options.body.body, /failure-state:start/);
  assert.match(calls[1].options.body.body, /Stage: `build`/);
});

test("successful publication comments on and closes the sole open failure issue", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    if (url.includes("?state=open")) {
      return {
        body: [
          {
            body: "old body",
            number: 42,
            title: "[publisher] Seed4J main snapshot failure",
          },
        ],
        status: 200,
      };
    }
    return { body: {}, status: options.method === "POST" ? 201 : 200 };
  };

  const result = await reportPublisherResult({
    buildResult: "success",
    deployResult: "success",
    encodedIdentity: encodeIdentity(identity),
    now: "2026-09-11T10:20:30Z",
    outcome: "publish",
    reason: "snapshot-absent",
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/123",
  });

  assert.deepEqual(result, { action: "close", issueNumber: 42 });
  assert.match(calls[1].url, /issues\/42\/comments$/);
  assert.deepEqual(calls[2].options.body, {
    state: "closed",
    state_reason: "completed",
  });
});
