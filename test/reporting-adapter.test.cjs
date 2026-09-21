const assert = require("node:assert/strict");
const test = require("node:test");

const { encodeIdentity } = require("../scripts/publisher-policy.cjs");
const { reportPublisherResult } = require("../scripts/report-result.cjs");

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
    buildDiagnostic:
      "npm ci failed\nAuthorization: Bearer secret-value\nregistry returned 503",
    buildResult: "failure",
    encodedIdentity: encodeIdentity(identity),
    now: "2026-09-11T10:20:30.787Z",
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
  assert.match(
    calls[1].options.body.body,
    /- 2026-09-11T10:20:30Z \| build \|/,
  );
  assert.doesNotMatch(calls[1].options.body.body, /\.787Z/);
  assert.match(calls[1].options.body.body, /registry returned 503/);
  assert.doesNotMatch(calls[1].options.body.body, /snapshot-absent/);
  assert.doesNotMatch(calls[1].options.body.body, /secret-value/);
});

test("a pre-identity qualification failure creates a nonretryable issue without invented provenance", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    return options.method === "POST"
      ? { body: { number: 43 }, status: 201 }
      : { body: [], status: 200 };
  };

  const result = await reportPublisherResult({
    now: "2026-09-11T10:20:30Z",
    outcome: "failure",
    reason:
      "Official upstream POM\nresponse contained an invalid token=secret-value and malformed metadata ".repeat(
        10,
      ),
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/124",
  });

  assert.deepEqual(result, { action: "create", issueNumber: 43 });
  const body = calls[1].options.body.body;
  assert.match(body, /Stage: `qualify`/);
  assert.match(body, /Identity and provenance: unavailable/i);
  assert.match(body, /not retryable/i);
  assert.doesNotMatch(body, /failure-state:start/);
  assert.doesNotMatch(body, /secret-value/);
  const diagnostic = /- Diagnostic: (.*)/.exec(body)[1];
  assert.ok(diagnostic.length <= 240);
  assert.doesNotMatch(diagnostic, /[\r\n]/);
});

test("a qualification job failure without candidate outputs creates a bounded nonretryable issue", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    return options.method === "POST"
      ? { body: { number: 44 }, status: 201 }
      : { body: [], status: 200 };
  };

  const result = await reportPublisherResult({
    now: "2026-09-11T10:20:30Z",
    qualifyResult: "failure",
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/125",
  });

  assert.deepEqual(result, { action: "create", issueNumber: 44 });
  const body = calls[1].options.body.body;
  assert.match(body, /Stage: `qualify`/);
  assert.match(body, /qualification job ended with result 'failure'/i);
  assert.match(body, /Identity and provenance: unavailable/i);
  assert.match(body, /not retryable/i);
  assert.doesNotMatch(body, /failure-state:start/);
  assert.doesNotMatch(body, /Upstream SHA:/);
  const diagnostic = /- Diagnostic: (.*)/.exec(body)[1];
  assert.ok(diagnostic.length <= 240);
  assert.doesNotMatch(diagnostic, /[\r\n]/);
});

test("untrusted diagnostics cannot mention arbitrary accounts or create Markdown links", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ options, url });
    if (!options.method) {
      return {
        body: [
          {
            body: `## Failure history

<!-- seed4j-main-snapshot-publisher-failure-history:start -->
- 2026-09-10T10:20:30Z | qualify | https://github.example/run/1 | Notify @legacy-team through [old login](https://attacker.example/old).
<!-- seed4j-main-snapshot-publisher-failure-history:end -->`,
            number: 45,
            title: "[publisher] Seed4J main snapshot failure",
          },
        ],
        status: 200,
      };
    }
    return { body: {}, status: 200 };
  };

  const result = await reportPublisherResult({
    now: "2026-09-11T10:20:30Z",
    outcome: "failure",
    qualifyResult: "success",
    reason:
      "Notify @octocat and @seed4j/security; sign in at [Central login](https://attacker.example/login).",
    repository: "renanfranca/seed4j-main-snapshots",
    request,
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/126",
  });

  assert.deepEqual(result, { action: "update", issueNumber: 45 });
  const body = calls[1].options.body.body;
  assert.equal((body.match(/@renanfranca/g) ?? []).length, 1);
  assert.doesNotMatch(body, /@legacy-team|@octocat|@seed4j\/security/);
  assert.doesNotMatch(body, /\[[^\]]+\]\(https?:\/\//);
  assert.match(body, /octocat/);
  assert.match(body, /Central login/);
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
