const assert = require("node:assert/strict");
const test = require("node:test");

const {
  qualificationResult,
  qualifyPublication,
} = require("../scripts/qualify-candidate.cjs");

const sha = "4eebd07bce14c9a6ac70bace157fcc616133e950";
const baseConfig = Object.freeze({
  centralTokenExpiresOn: "2027-09-01",
  pilotCompleted: false,
  quotaReview: null,
  scheduleMode: "weekly",
  schemaVersion: 1,
});

test("qualifies official main head through the exact workflow and public Central state", async () => {
  const requests = officialHeadRequests({
    centralStatus: 404,
    workflowConclusion: "success",
  });

  const result = await qualifyPublication({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "2026-09-11T12:00:00.787Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
  });

  assert.deepEqual(result, {
    identity: {
      artifactId: "seed4j-main-snapshot",
      groupId: "io.github.renanfranca",
      upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
      upstreamLicenseSha256:
        "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
      upstreamPomVersion: "2.2.1-SNAPSHOT",
      upstreamSha: sha,
      version: "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
    },
    outcome: "publish",
    reason: "snapshot-absent",
    upstreamSha: sha,
  });
  assert.equal(requests.length, 0);
});

test("scheduled runs skip safely before network access until the pilot and selected cadence allow them", async () => {
  let requests = 0;
  const request = async () => {
    requests++;
    throw new Error("network must not be used");
  };

  assert.deepEqual(
    await qualifyPublication({
      config: baseConfig,
      event: "schedule",
      now: "not-a-runtime-timestamp",
      operation: "head",
      publisherRepository: "renanfranca/seed4j-main-snapshots",
      ref: "refs/heads/main",
      request,
      schedule: "17 6 * * 1",
    }),
    { openFailureIssue: false, outcome: "skip", reason: "pilot-not-completed" },
  );
  assert.deepEqual(
    await qualifyPublication({
      config: { ...baseConfig, pilotCompleted: true },
      event: "schedule",
      now: "not-a-runtime-timestamp",
      operation: "head",
      publisherRepository: "renanfranca/seed4j-main-snapshots",
      ref: "refs/heads/main",
      request,
      schedule: "17 6 * * 0,2-6",
    }),
    {
      openFailureIssue: false,
      outcome: "skip",
      reason: "daily-schedule-not-enabled",
    },
  );
  assert.equal(requests, 0);
});

test("missing or unsuccessful official workflow state is an expected skip without a Central request", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });

  const result = await qualifyPublication({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "2026-09-11T12:00:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
  });

  assert.deepEqual(result, {
    openFailureIssue: false,
    outcome: "skip",
    reason: "official-upstream-build-not-successful",
    upstreamSha: sha,
  });
  assert.equal(requests.length, 0);
});

test("invalid publisher runtime time fails before token and retention policies", async () => {
  const requests = officialHeadRequests({
    centralStatus: 404,
    workflowConclusion: "success",
  });

  const result = await qualificationResult({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "2026-13-01T12:00:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.equal(
    result.reason,
    "Invalid publisher runtime timestamp '2026-13-01T12:00:00Z'.",
  );
  assert.equal(result.identity.upstreamSha, sha);
  assert.equal(result.upstreamSha, sha);
  assert.equal(requests.length, 1);
});

test("retry reads the sole marked failure, verifies official facts and reachability, and reuses its identity", async () => {
  const issueBody = `<!-- seed4j-main-snapshot-publisher-failure-state:start -->
\`\`\`json
{
  "artifactId": "seed4j-main-snapshot",
  "derivedVersion": "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
  "groupId": "io.github.renanfranca",
  "upstreamCommitTimestamp": "2026-09-07T05:58:00Z",
  "upstreamLicenseSha256": "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  "upstreamPomVersion": "2.2.1-SNAPSHOT",
  "upstreamSha": "${sha}"
}
\`\`\`
<!-- seed4j-main-snapshot-publisher-failure-state:end -->`;
  const requests = [
    [
      /\/repos\/renanfranca\/seed4j-main-snapshots\/issues\?/,
      200,
      [
        {
          body: issueBody,
          number: 31,
          title: "[publisher] Seed4J main snapshot failure",
        },
      ],
    ],
    [`/repos/seed4j/seed4j/commits/${sha}`, 200, commit()],
    [`/repos/seed4j/seed4j/contents/pom.xml?ref=${sha}`, 200, pomContent()],
    [
      `/repos/seed4j/seed4j/contents/LICENSE.txt?ref=${sha}`,
      200,
      licenseContent(),
    ],
    [`/repos/seed4j/seed4j/compare/${sha}...main`, 200, { status: "ahead" }],
    [
      /\/repos\/seed4j\/seed4j\/actions\/workflows\/github-actions.yml\/runs\?/,
      200,
      workflowRuns("success"),
    ],
    [/central\.sonatype\.com.*maven-metadata\.xml$/, 404, ""],
  ];

  const result = await qualifyPublication({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "2026-09-11T12:00:00Z",
    operation: "retry-last-failed",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "publish");
  assert.equal(result.identity.upstreamSha, sha);
  assert.equal(requests.length, 0);
});

test("a dispatch from any ref other than publisher main skips before network or environment access", async () => {
  let requests = 0;

  const result = await qualifyPublication({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "not-a-runtime-timestamp",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/feature",
    request: async () => requests++,
  });

  assert.deepEqual(result, {
    openFailureIssue: false,
    outcome: "skip",
    reason: "publisher-ref-not-main",
  });
  assert.equal(requests, 0);
});

test("a failure before upstream identity exists becomes an explicit nonretryable qualification result", async () => {
  const result = await qualificationResult({
    config: baseConfig,
    event: "workflow_dispatch",
    now: "2026-09-11T12:00:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: async () => ({ body: {}, status: 503 }),
  });

  assert.deepEqual(result, {
    outcome: "failure",
    reason: "official main commit request returned status '503'.",
  });
  assert.equal("identity" in result, false);
  assert.equal("upstreamSha" in result, false);
});

function officialHeadRequests({ centralStatus, workflowConclusion }) {
  return [
    ["/repos/seed4j/seed4j/commits/main", 200, commit()],
    [`/repos/seed4j/seed4j/contents/pom.xml?ref=${sha}`, 200, pomContent()],
    [
      `/repos/seed4j/seed4j/contents/LICENSE.txt?ref=${sha}`,
      200,
      licenseContent(),
    ],
    [
      /\/repos\/seed4j\/seed4j\/actions\/workflows\/github-actions.yml\/runs\?/,
      200,
      workflowRuns(workflowConclusion),
    ],
    ...(centralStatus === undefined
      ? []
      : [[/central\.sonatype\.com.*maven-metadata\.xml$/, centralStatus, ""]]),
  ];
}

function commit() {
  return { commit: { committer: { date: "2026-09-07T05:58:00Z" } }, sha };
}

function pomContent() {
  const pom = `<project><parent><version>4.0.6</version></parent><groupId>com.seed4j</groupId><artifactId>seed4j</artifactId><version>2.2.1-SNAPSHOT</version><properties /></project>`;
  return { content: Buffer.from(pom).toString("base64"), encoding: "base64" };
}

function licenseContent() {
  return {
    content: Buffer.from("upstream Apache license\n").toString("base64"),
    encoding: "base64",
  };
}

function workflowRuns(conclusion) {
  return {
    workflow_runs: [
      {
        conclusion,
        event: "push",
        head_sha: sha,
        status: "completed",
      },
    ],
  };
}

function queuedRequest(requests) {
  return async (url) => {
    const expected = requests.shift();
    assert.ok(expected, `Unexpected request ${url}`);
    const [pattern, status, body] = expected;
    if (typeof pattern === "string") {
      assert.ok(
        url.endsWith(pattern),
        `Expected ${url} to end with ${pattern}`,
      );
    } else {
      assert.match(url, pattern);
    }
    return { body, status };
  };
}
