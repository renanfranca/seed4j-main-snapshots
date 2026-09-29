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
      version:
        "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
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
  const issueBody = retryIdentityBody();
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

test("a cycle rechecks failed official CI as a retry with exact SHA evidence", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "retry");
  assert.equal(result.upstreamSha, sha);
  assert.equal(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Official main SHA",
    ).status,
    "Accepted",
  );
  assert.equal(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).status,
    "Rejected",
  );
  assert.match(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /failed/i,
  );
  assert.equal(result.assessment.nextCheck, "2026-09-28T12:41:00Z");
  assert.equal(requests.length, 0);
});

test("a failed official run reports the failed job, step, observed error code, and inert log evidence", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });
  requests[3][2].workflow_runs[0].id = 12;
  requests[3][2].workflow_runs[0].html_url =
    "https://github.com/seed4j/seed4j/actions/runs/12";
  requests.push([
    "/repos/seed4j/seed4j/actions/runs/12/jobs?per_page=100",
    200,
    {
      jobs: [
        {
          id: 19,
          name: "verify",
          conclusion: "failure",
          html_url: "https://github.com/seed4j/seed4j/actions/runs/12/job/19",
          steps: [{ name: "Maven verify", conclusion: "failure" }],
        },
      ],
    },
  ]);
  requests.push([
    "/repos/seed4j/seed4j/actions/jobs/19/logs",
    200,
    "Authorization: Bearer secret-value\nError: ENOSPC: no space left on device @evil [login](https://attacker.example)\n",
  ]);

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "retry");
  assert.match(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /verify.*Maven verify.*Confirmed cause.*ENOSPC/,
  );
  assert.match(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).evidence,
    /\/job\/19/,
  );
  assert.doesNotMatch(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /secret-value|@evil|\[login\]\(/,
  );
  assert.doesNotMatch(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /https?:\/\//,
  );
  assert.equal(requests.length, 0);
});

test("a cycle retries HTTP 503 and API rate limits without inventing a candidate", async () => {
  const common = {
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    schedule: "41 * * * *",
  };

  const unavailable = await qualificationResult({
    ...common,
    request: async () => ({ status: 503, body: {} }),
  });
  const limited = await qualificationResult({
    ...common,
    request: async () => ({
      status: 429,
      body: {},
      headers: { get: (name) => (name === "retry-after" ? "7200" : null) },
    }),
  });

  assert.equal(unavailable.outcome, "retry");
  assert.equal(unavailable.assessment.nextCheck, "2026-09-28T12:41:00Z");
  assert.equal(limited.outcome, "retry");
  assert.equal(limited.assessment.nextCheck, "2026-09-28T13:41:00Z");
  assert.equal("upstreamSha" in limited, false);
});

test("cycle diagnostics distinguish absent, running, cancelled, and failed official runs", async () => {
  const common = {
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    schedule: "41 * * * *",
  };
  for (const [state, expected] of [
    ["missing", "Missing official run"],
    ["in_progress", "Official run in progress"],
    ["cancelled", "Official run cancelled"],
    ["failure", "Official run failed"],
  ]) {
    const requests = officialHeadRequests({
      centralStatus: undefined,
      workflowConclusion: state,
    });
    if (state === "missing") requests[3][2].workflow_runs = [];
    if (state === "in_progress")
      requests[3][2].workflow_runs[0].status = "in_progress";
    const result = await qualificationResult({
      ...common,
      request: queuedRequest(requests),
    });

    assert.equal(result.outcome, "retry");
    assert.match(
      result.assessment.criteria.find(
        (criterion) => criterion.name === "Exact-SHA official CI",
      ).observed,
      new RegExp(expected),
    );
    assert.equal(requests.length, 0);
  }
});

test("a later successful exact-SHA official run makes the same cycle publishable", async () => {
  const requests = officialHeadRequests({
    centralStatus: 404,
    workflowConclusion: "success",
  });

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T12:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "publish");
  assert.equal(result.identity.upstreamSha, sha);
  assert.equal(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).status,
    "Accepted",
  );
  assert.equal(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Retention",
    ).status,
    "Accepted",
  );
  assert.equal(requests.length, 0);
});

test("an expired recorded Central token ends a cycle even when official CI is pending", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });

  const result = await qualificationResult({
    config: {
      ...baseConfig,
      pilotCompleted: true,
      centralTokenExpiresOn: "2026-09-27",
    },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T12:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.reason, /expired/);
  assert.equal(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Central token",
    ).status,
    "Rejected",
  );
  assert.equal(requests.length, 1);
});

test("failed official CI without a diagnostic code leaves the cause unknown", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });
  requests[3][2].workflow_runs[0].id = 12;
  requests.push([
    "/repos/seed4j/seed4j/actions/runs/12/jobs?per_page=100",
    200,
    {
      jobs: [
        {
          id: 19,
          name: "verify",
          conclusion: "failure",
          steps: [{ name: "Maven verify", conclusion: "failure" }],
        },
      ],
    },
  ]);
  requests.push([
    "/repos/seed4j/seed4j/actions/jobs/19/logs",
    200,
    "Process failed without a diagnostic code",
  ]);

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.match(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /Cause unknown/,
  );
  assert.doesNotMatch(
    result.assessment.criteria.find(
      (criterion) => criterion.name === "Exact-SHA official CI",
    ).observed,
    /Confirmed cause/,
  );
});

test("invalid official CI API data ends the cycle instead of retrying forever", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });
  requests[3][2] = { workflow_runs: "invalid" };

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.reason, /Invalid official workflow runs/);
});

test("failed official CI records every failed job with its step, bounded excerpt, and link", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });
  requests[3][2].workflow_runs[0].id = 12;
  requests.push([
    "/repos/seed4j/seed4j/actions/runs/12/jobs?per_page=100",
    200,
    {
      jobs: [
        {
          id: 19,
          name: "backend",
          conclusion: "failure",
          html_url: "https://github.com/seed4j/seed4j/actions/runs/12/job/19",
          steps: [{ name: "Maven verify", conclusion: "failure" }],
        },
        {
          id: 20,
          name: "frontend",
          conclusion: "failure",
          html_url: "https://github.com/seed4j/seed4j/actions/runs/12/job/20",
          steps: [{ name: "npm test", conclusion: "failure" }],
        },
      ],
    },
  ]);
  requests.push([
    "/repos/seed4j/seed4j/actions/jobs/19/logs",
    200,
    "Error: ENOSPC: no space left on device",
  ]);
  requests.push([
    "/repos/seed4j/seed4j/actions/jobs/20/logs",
    200,
    "Error: assertion failed in component test",
  ]);

  const result = await qualificationResult({
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "retry");
  assert.equal(result.assessment.diagnostics.length, 2);
  assert.match(
    result.assessment.diagnostics[0].summary,
    /backend.*Maven verify.*ENOSPC/,
  );
  assert.match(
    result.assessment.diagnostics[1].summary,
    /frontend.*npm test.*Cause unknown/,
  );
  assert.match(result.assessment.diagnostics[1].url, /\/job\/20/);
  assert.equal(requests.length, 0);
});

test("an hourly recheck continues a manual cycle while the scheduled pilot gate is disabled", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "failure",
  });

  const result = await qualificationResult({
    config: baseConfig,
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    request: queuedRequest(requests),
    schedule: "41 * * * *",
  });

  assert.equal(result.outcome, "retry");
  assert.equal(requests.length, 0);
});

test("qualification reads the log tail beyond 64 KiB, including a split error", () => {
  const result = qualifyWithStreamedLogs([
    "setup output\n".repeat(7000),
    "Error: ENOS",
    "PC: no space left on device\n",
  ]);

  assert.equal(result.outcome, "retry");
  assert.match(
    result.assessment.diagnostics[0].summary,
    /Confirmed cause.*ENOSPC/,
  );
  assert.match(result.assessment.diagnostics[0].url, /job\/19$/);
});

function qualifyWithStreamedLogs(
  chunks,
  { interrupted = false, status = 200 } = {},
) {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join, resolve } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const directory = mkdtempSync(join(tmpdir(), "publisher-log-test-"));
  const preload = join(directory, "fetch.cjs");
  const configPath = join(directory, "config.json");
  const runs = workflowRuns("failure");
  runs.workflow_runs[0].id = 12;
  const responses = [
    commit(),
    pomContent(),
    licenseContent(),
    runs,
    {
      jobs: [
        {
          id: 19,
          name: "verify",
          conclusion: "failure",
          html_url: "https://github.com/seed4j/seed4j/actions/runs/12/job/19",
          steps: [{ name: "Maven verify", conclusion: "failure" }],
        },
      ],
    },
  ];
  const { centralTokenExpiresOn, ...configFields } = baseConfig;
  writeFileSync(
    configPath,
    JSON.stringify({
      ...configFields,
      centralTokenExpiresAt: centralTokenExpiresOn,
    }),
  );
  writeFileSync(
    preload,
    `
    const assert = require("node:assert/strict");
    const responses = ${JSON.stringify(responses)};
    const chunks = ${JSON.stringify(chunks)}.map(value => Buffer.from(value));
    let index = 0;
    let cancelled = false;
    let released = false;
    global.fetch = async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (!url.endsWith("/logs")) return new Response(JSON.stringify(responses.shift()), {status: 200});
      return {status: ${status}, headers: new Headers(), body: {getReader: () => ({
        read: async () => {
          if (index < chunks.length) return {done: false, value: chunks[index++]};
          if (${interrupted}) throw new Error("stream interrupted");
          return {done: true};
        },
        cancel: async () => { cancelled = true; },
        releaseLock: () => { released = true; }
      })}};
    };
    process.on("exit", () => {
      assert.equal(index, chunks.length, "logs must be drained");
      assert.equal(cancelled, true);
      assert.equal(released, true);
    });
  `,
  );
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--require",
        preload,
        resolve(__dirname, "../scripts/qualify-candidate.cjs"),
        "--config",
        configPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: "",
          GH_TOKEN: "test-token",
          PUBLISHER_EVENT: "workflow_dispatch",
          PUBLISHER_OPERATION: "head",
          PUBLISHER_REF: "refs/heads/main",
          PUBLISHER_CYCLE_ISSUE: "52",
          GITHUB_REPOSITORY: "renanfranca/seed4j-main-snapshots",
        },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout);
    return {
      ...output,
      assessment: JSON.parse(
        Buffer.from(output.assessment, "base64url").toString(),
      ),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("specific log evidence outranks later substantive errors and generic termination", () => {
  const result = qualifyWithStreamedLogs([
    "Error: ENOENT: no such file or directory\n" +
      "Error: ENOSPC: no space left on device\n" +
      "Error: compilation failed\n" +
      "Process completed with exit code 1\n",
  ]);

  assert.match(
    result.assessment.diagnostics[0].summary,
    /Confirmed cause.*ENOSPC/,
  );
  assert.doesNotMatch(
    result.assessment.diagnostics[0].summary,
    /ENOENT|exit code|compilation/,
  );
});

test("interrupted logs disclose incomplete analysis while preserving available evidence", () => {
  const result = qualifyWithStreamedLogs(
    ["Error: ENOSPC: no space left on device\n"],
    { interrupted: true },
  );

  assert.equal(result.outcome, "retry");
  assert.match(result.assessment.diagnostics[0].summary, /incomplete.*ENOSPC/i);
  assert.match(result.assessment.diagnostics[0].url, /job\/19$/);
});

test("Central 503 preserves completed approvals and blocks Retention for retry", async () => {
  const requests = officialHeadRequests({
    centralStatus: 503,
    workflowConclusion: "success",
  });

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "retry");
  assert.equal(result.upstreamSha, sha);
  assert.equal("identity" in result, false);
  assert.equal(result.assessment.nextCheck, "2026-09-28T12:41:00Z");
  assert.deepEqual(
    result.assessment.criteria.map(({ name, status }) => [name, status]),
    [
      ["Qualification", "Accepted"],
      ["Official main SHA", "Accepted"],
      ["Exact-SHA official CI", "Accepted"],
      ["Central token", "Accepted"],
      ["Retention", "Rejected"],
    ],
  );
  assert.match(
    result.assessment.criteria[4].observed,
    /503.*eligibility.*unknown/i,
  );
  assert.match(
    result.assessment.criteria[4].evidence,
    /central\.sonatype\.com/,
  );
});

function cycleInvocation() {
  return {
    config: { ...baseConfig, pilotCompleted: true },
    cycleIssueNumber: 52,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    publisherRepository: "renanfranca/seed4j-main-snapshots",
    ref: "refs/heads/main",
    schedule: "41 * * * *",
  };
}

test("a validated main SHA survives provenance failure without an invented identity", async () => {
  const requests = [
    ["/repos/seed4j/seed4j/commits/main", 200, commit()],
    [`/repos/seed4j/seed4j/contents/pom.xml?ref=${sha}`, 503, {}],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "retry");
  assert.equal(result.upstreamSha, sha);
  assert.equal("identity" in result, false);
  assert.deepEqual(
    result.assessment.criteria.map(({ name, status }) => [name, status]),
    [
      ["Qualification", "Rejected"],
      ["Official main SHA", "Accepted"],
      ["Exact-SHA official CI", "Not evaluated"],
      ["Central token", "Not evaluated"],
      ["Retention", "Not evaluated"],
    ],
  );
  assert.match(
    result.assessment.criteria[1].evidence,
    new RegExp(`/commit/${sha}$`),
  );
});

test("log diagnostics retain the newest substantive error ahead of generic termination", () => {
  const result = qualifyWithStreamedLogs([
    "Error: first compilation failure\n" +
      "Error: unresolved dependency org.example:missing\n" +
      "Process completed with exit code 1\n",
  ]);

  assert.match(
    result.assessment.diagnostics[0].summary,
    /Cause unknown.*unresolved dependency/,
  );
  assert.doesNotMatch(
    result.assessment.diagnostics[0].summary,
    /Confirmed cause|first compilation|exit code/,
  );
});

test("log tails discard old evidence by bytes and leave unsupported causes unknown", () => {
  const result = qualifyWithStreamedLogs([
    "Error: ENOSPC: no space left on device\n",
    "é".repeat(32768),
    "\nProcess completed with exit code 1\n",
  ]);

  assert.match(
    result.assessment.diagnostics[0].summary,
    /Cause unknown.*exit code 1/,
  );
  assert.doesNotMatch(
    result.assessment.diagnostics[0].summary,
    /Confirmed cause|ENOSPC/,
  );
});

test("unavailable job logs and logs without error evidence do not claim a cause", () => {
  const unavailable = qualifyWithStreamedLogs(["service unavailable"], {
    status: 503,
  });
  const emptyEvidence = qualifyWithStreamedLogs([
    "job started\nsetup complete\n",
  ]);

  assert.match(
    unavailable.assessment.diagnostics[0].summary,
    /cause unknown; job logs unavailable/i,
  );
  assert.match(
    emptyEvidence.assessment.diagnostics[0].summary,
    /cause unknown; no error line found/i,
  );
  assert.doesNotMatch(
    unavailable.assessment.diagnostics[0].summary,
    /Confirmed cause/,
  );
  assert.doesNotMatch(
    emptyEvidence.assessment.diagnostics[0].summary,
    /Confirmed cause/,
  );
});

test("streamed error evidence is sanitized and bounded before publication", () => {
  const result = qualifyWithStreamedLogs([
    "Error: ENOSPC: no space left on device token=private-value @evil [login](https://attacker.example) " +
      "x".repeat(1000),
  ]);

  assert.match(
    result.assessment.diagnostics[0].summary,
    /Confirmed cause.*ENOSPC/,
  );
  assert.doesNotMatch(
    result.assessment.diagnostics[0].summary,
    /private-value|@evil|\[login\]\(|https?:\/\//,
  );
  assert.ok(result.assessment.diagnostics[0].summary.length <= 240);
});

test("Central rate limits preserve approvals and the service retry deadline", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "success",
  });
  const upstreamRequest = queuedRequest(requests);

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: async (url) =>
      url.includes("central.sonatype.com")
        ? {
            status: 429,
            body: "",
            headers: new Headers({ "retry-after": "7200" }),
          }
        : upstreamRequest(url),
  });

  assert.equal(result.outcome, "retry");
  assert.equal(result.assessment.nextCheck, "2026-09-28T13:41:00Z");
  assert.deepEqual(
    result.assessment.criteria.map(({ status }) => status),
    ["Accepted", "Accepted", "Accepted", "Accepted", "Rejected"],
  );
  assert.match(
    result.assessment.criteria[4].observed,
    /429.*eligibility remains unknown/,
  );
});

test("invalid Central metadata preserves approvals but ends qualification definitively", async () => {
  const requests = officialHeadRequests({
    centralStatus: 200,
    workflowConclusion: "success",
  });
  requests[4][2] = { invalid: "not XML" };

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.equal(result.upstreamSha, sha);
  assert.equal(result.identity.upstreamSha, sha);
  assert.equal("nextCheck" in result.assessment, false);
  assert.deepEqual(
    result.assessment.criteria.map(({ status }) => status),
    ["Accepted", "Accepted", "Accepted", "Accepted", "Rejected"],
  );
  assert.match(
    result.assessment.criteria[4].observed,
    /not XML.*eligibility remains unknown/,
  );
});

test("invalid CI rejects only the CI stage after identity and token approval", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "success",
  });
  requests[3][2] = { workflow_runs: "invalid" };

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.deepEqual(
    result.assessment.criteria.map(({ status }) => status),
    ["Accepted", "Accepted", "Rejected", "Accepted", "Not evaluated"],
  );
  assert.match(
    result.assessment.criteria[2].observed,
    /Invalid official workflow runs/,
  );
  assert.equal(result.assessment.criteria[4].observed, "Not reached");
});

test("expired token preserves identity but never approves unqueried CI or retention", async () => {
  const requests = officialHeadRequests({
    centralStatus: undefined,
    workflowConclusion: "success",
  });

  const result = await qualificationResult({
    ...cycleInvocation(),
    config: { ...baseConfig, centralTokenExpiresOn: "2026-09-27" },
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.deepEqual(
    result.assessment.criteria.map(({ status }) => status),
    ["Accepted", "Accepted", "Not evaluated", "Rejected", "Not evaluated"],
  );
  assert.match(result.assessment.criteria[3].observed, /expired/);
  assert.equal(requests.length, 1);
});

test("an invalid main SHA rejects resolution without approving provenance or later criteria", async () => {
  const requests = [
    ["/repos/seed4j/seed4j/commits/main", 200, { ...commit(), sha: "invalid" }],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.equal("upstreamSha" in result, false);
  assert.equal("identity" in result, false);
  assert.deepEqual(
    result.assessment.criteria.map(({ status }) => status),
    [
      "Not evaluated",
      "Rejected",
      "Not evaluated",
      "Not evaluated",
      "Not evaluated",
    ],
  );
  assert.equal(requests.length, 0);
});

test("cycle reports render preserved approvals, the Central blocker, and unperformed build and deploy", async () => {
  const {
    beginCycle,
    completeCycle,
  } = require("../scripts/publication-cycle.cjs");
  const repository = "renanfranca/seed4j-main-snapshots";
  let issueBody;
  const comments = [];
  let closed = false;
  const issueRequest = async (url, options = {}) => {
    if (options.method === "POST" && url.endsWith("/issues")) {
      issueBody = options.body.body;
      return { status: 201, body: { number: 52 } };
    }
    if (options.method === "POST") {
      comments.push(options.body.body);
      return { status: 201, body: {} };
    }
    if (options.method === "PATCH") {
      if (options.body.body) issueBody = options.body.body;
      if (options.body.state === "closed") closed = true;
      return { status: 200, body: {} };
    }
    return {
      status: 200,
      body: url.endsWith("/issues/52") ? { body: issueBody } : [],
    };
  };
  await beginCycle({
    ...cycleInvocation(),
    event: "workflow_dispatch",
    schedule: undefined,
    now: "2026-09-28T10:00:00Z",
    repository,
    request: issueRequest,
  });

  for (const [status, body, run] of [
    [503, "", 34],
    [200, { invalid: true }, 35],
  ]) {
    const requests = officialHeadRequests({
      centralStatus: status,
      workflowConclusion: "success",
    });
    requests[3][2].workflow_runs[0].html_url =
      "https://github.com/seed4j/seed4j/actions/runs/12";
    requests[4][2] = body;
    const qualification = await qualificationResult({
      ...cycleInvocation(),
      request: queuedRequest(requests),
    });
    await completeCycle({
      ...qualification,
      issueNumber: 52,
      now: "2026-09-28T11:42:00Z",
      repository,
      request: issueRequest,
      workflowRunUrl: `https://github.com/${repository}/actions/runs/${run}`,
    });

    assert.match(
      issueBody,
      /\| Qualification \| Accepted \| Official candidate identity resolved/,
    );
    assert.match(issueBody, /\| Official main SHA \| Accepted \| 4eebd07/);
    assert.match(
      issueBody,
      /\| Exact-SHA official CI \| Accepted \| Completed successfully for exact SHA/,
    );
    assert.match(
      issueBody,
      /\| Central token \| Accepted \| Recorded expiry is valid/,
    );
    assert.match(
      issueBody,
      /\| Retention \| Rejected \| .*retention eligibility remains unknown/,
    );
    assert.match(issueBody, /\| Publisher build \| Not evaluated \|/);
    assert.match(issueBody, /\| Deploy\/public artifacts \| Not evaluated \|/);
    assert.match(
      issueBody,
      /https:\/\/github.com\/seed4j\/seed4j\/actions\/runs\/12/,
    );
    assert.match(issueBody, /https:\/\/central.sonatype.com/);
  }
  assert.equal(comments.length, 2);
  assert.match(comments[0], /Retention \| Rejected \| .*503/);
  assert.match(comments[1], /Retention \| Rejected \| .*not XML/);
  assert.match(issueBody, /Final report/);
  assert.equal(closed, true);
});

test("manual retry with no open failure skips without upstream requests", async () => {
  const requests = [[/\/issues\?state=open&labels=publisher-failure/, 200, []]];

  const result = await qualificationResult({
    ...cycleInvocation(),
    cycleIssueNumber: undefined,
    event: "workflow_dispatch",
    operation: "retry-last-failed",
    request: queuedRequest(requests),
  });

  assert.deepEqual(result, {
    openFailureIssue: false,
    outcome: "skip",
    reason: "no-retryable-publication",
  });
  assert.equal(requests.length, 0);
});

test("manual retry with one failure lacking recorded identity skips without rechecking upstream", async () => {
  const requests = [
    [
      /\/issues\?state=open&labels=publisher-failure/,
      200,
      [
        {
          number: 14,
          title: "[publisher] Seed4J main snapshot failure",
          body: "Qualification failed before identity was available. Retry state: not retryable.",
        },
      ],
    ],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    cycleIssueNumber: undefined,
    event: "workflow_dispatch",
    operation: "retry-last-failed",
    request: queuedRequest(requests),
  });

  assert.deepEqual(result, {
    openFailureIssue: false,
    outcome: "skip",
    reason: "no-retryable-publication",
  });
  assert.equal(requests.length, 0);
});

test("invalid failure-issue API data remains an error rather than an empty retry", async () => {
  const requests = [
    [
      /\/issues\?state=open&labels=publisher-failure/,
      200,
      { message: "invalid issue list" },
    ],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    cycleIssueNumber: undefined,
    event: "workflow_dispatch",
    operation: "retry-last-failed",
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.reason, /Invalid publisher failure issues response/);
  assert.equal(requests.length, 0);
});

function retryIdentityBody() {
  return `<!-- seed4j-main-snapshot-publisher-failure-state:start -->
\`\`\`json
{
  "artifactId": "seed4j-main-snapshot",
  "derivedVersion": "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  "groupId": "io.github.renanfranca",
  "upstreamCommitTimestamp": "2026-09-07T05:58:00Z",
  "upstreamLicenseSha256": "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  "upstreamPomVersion": "2.2.1-SNAPSHOT",
  "upstreamSha": "${sha}"
}
\`\`\`
<!-- seed4j-main-snapshot-publisher-failure-state:end -->`;
}

test("recorded retry identity corruption remains a failure before any upstream request", async () => {
  for (const body of [
    "<!-- seed4j-main-snapshot-publisher-failure-state:start -->",
    "<!-- seed4j-main-snapshot-publisher-failure-state:end -->",
    retryIdentityBody().replace(
      '"upstreamSha": "' + sha + '"',
      '"upstreamSha": "invalid"',
    ),
    retryIdentityBody().replace(
      '"artifactId": "seed4j-main-snapshot"',
      '"artifactId": "other"',
    ),
    retryIdentityBody() + retryIdentityBody(),
    retryIdentityBody().replaceAll("-->", "--"),
  ]) {
    const requests = [
      [
        /\/issues\?state=open&labels=publisher-failure/,
        200,
        [
          {
            number: 14,
            title: "[publisher] Seed4J main snapshot failure",
            body,
          },
        ],
      ],
    ];

    const result = await qualificationResult({
      ...cycleInvocation(),
      cycleIssueNumber: undefined,
      event: "workflow_dispatch",
      operation: "retry-last-failed",
      request: queuedRequest(requests),
    });

    assert.equal(result.outcome, "failure");
    assert.notEqual(result.reason, "no-retryable-publication");
    assert.equal(requests.length, 0);
  }
});

test("duplicate failure issues remain errors even when neither has retry identity", async () => {
  const requests = [
    [
      /\/issues\?state=open&labels=publisher-failure/,
      200,
      [
        {
          number: 14,
          title: "[publisher] Seed4J main snapshot failure",
          body: "No identity",
        },
        {
          number: 15,
          title: "[publisher] Seed4J main snapshot failure",
          body: "No identity",
        },
      ],
    ],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    cycleIssueNumber: undefined,
    event: "workflow_dispatch",
    operation: "retry-last-failed",
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.match(result.reason, /exactly one.*found 2/);
  assert.equal(requests.length, 0);
});

test("retry issue query failures do not become absence of an eligible publication", async () => {
  for (const status of [401, 403, 503]) {
    const requests = [
      [
        /\/issues\?state=open&labels=publisher-failure/,
        status,
        { message: "request failed" },
      ],
    ];

    const result = await qualificationResult({
      ...cycleInvocation(),
      cycleIssueNumber: undefined,
      event: "workflow_dispatch",
      operation: "retry-last-failed",
      request: queuedRequest(requests),
    });

    assert.equal(result.outcome, "failure");
    assert.match(
      result.reason,
      new RegExp(
        `publisher failure issues request returned status '${status}'`,
      ),
    );
    assert.equal(requests.length, 0);
  }
});

test("retry provenance mismatches remain failures on the recorded SHA", async () => {
  const requests = [
    [
      /\/issues\?state=open&labels=publisher-failure/,
      200,
      [
        {
          number: 14,
          title: "[publisher] Seed4J main snapshot failure",
          body: retryIdentityBody(),
        },
      ],
    ],
    [`/repos/seed4j/seed4j/commits/${sha}`, 200, commit()],
    [`/repos/seed4j/seed4j/contents/pom.xml?ref=${sha}`, 200, pomContent()],
    [
      `/repos/seed4j/seed4j/contents/LICENSE.txt?ref=${sha}`,
      200,
      {
        encoding: "base64",
        content: Buffer.from("changed license").toString("base64"),
      },
    ],
  ];

  const result = await qualificationResult({
    ...cycleInvocation(),
    cycleIssueNumber: undefined,
    event: "workflow_dispatch",
    operation: "retry-last-failed",
    request: queuedRequest(requests),
  });

  assert.equal(result.outcome, "failure");
  assert.match(
    result.reason,
    /does not match re-fetched official upstream facts/,
  );
  assert.equal(requests.length, 0);
});
