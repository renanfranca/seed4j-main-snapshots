const assert = require("node:assert/strict");
const test = require("node:test");

const {
  beginCycle,
  completeCycle,
} = require("../scripts/publication-cycle.cjs");

const repository = "renanfranca/seed4j-main-snapshots";
const config = {
  centralTokenExpiresOn: "2027-03-10",
  pilotCompleted: true,
  quotaReview: null,
  scheduleMode: "weekly",
  schemaVersion: 1,
};

test("an enabled weekly run opens one cycle with planned and actual times", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    return options.method === "POST"
      ? { status: 201, body: { number: 52 } }
      : { status: 200, body: [] };
  };

  const result = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-28T06:23:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "17 6 * * 1",
  });

  assert.equal(result.action, "create");
  assert.equal(result.issueNumber, 52);
  assert.equal(result.startedAt, "2026-09-28T06:23:00Z");
  assert.equal(result.deadline, "2026-09-30T06:23:00Z");
  assert.equal(calls.length, 2);
  assert.match(calls[1].options.body.body, /@renanfranca/);
  assert.match(calls[1].options.body.body, /2026-09-28T06:17:00Z/);
  assert.match(calls[1].options.body.body, /2026-09-28T06:23:00Z/);
});

test("hourly and manual checks join the same open cycle without extending its deadline", async () => {
  const created = [];
  const request = async (url, options = {}) => {
    if (options.method === "POST") {
      created.push(options.body);
      return { status: 201, body: { number: 52 } };
    }
    return {
      status: 200,
      body: created.length
        ? [
            {
              title: "[publisher] Seed4J main snapshot publication cycle",
              number: 52,
              body: created[0].body,
            },
          ]
        : [],
    };
  };
  const first = await beginCycle({
    config,
    event: "workflow_dispatch",
    now: "2026-09-28T10:00:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
  });

  const hourly = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "41 * * * *",
  });
  const manual = await beginCycle({
    config,
    event: "workflow_dispatch",
    now: "2026-09-28T12:00:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
  });

  assert.equal(first.action, "create");
  assert.equal(hourly.action, "join");
  assert.equal(manual.action, "join");
  assert.equal(hourly.issueNumber, first.issueNumber);
  assert.equal(manual.deadline, first.deadline);
  assert.equal(created.length, 1);
});

test("an hourly trigger without an open cycle and a disabled daily trigger stay silent", async () => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    return { status: 200, body: [] };
  };

  const hourly = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-28T11:41:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "41 * * * *",
  });
  const daily = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-29T06:17:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "17 6 * * 0,2-6",
  });

  assert.deepEqual(hourly, { action: "none" });
  assert.deepEqual(daily, { action: "none" });
  assert.equal(calls.length, 1);
});

test("a recoverable attempt records its SHA, decision, evidence, and next check", async () => {
  let issueBody;
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST" && url.endsWith("/issues")) {
      issueBody = options.body.body;
      return { status: 201, body: { number: 52 } };
    }
    if (options.method === "PATCH") {
      issueBody = options.body.body;
      return { status: 200, body: { number: 52 } };
    }
    if (options.method === "POST") return { status: 201, body: {} };
    return url.endsWith("/issues/52")
      ? { status: 200, body: { number: 52, body: issueBody } }
      : { status: 200, body: [] };
  };
  await beginCycle({
    config,
    event: "workflow_dispatch",
    now: "2026-09-28T10:00:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
  });

  const result = await completeCycle({
    issueNumber: 52,
    now: "2026-09-28T10:08:00Z",
    outcome: "retry",
    reason: "Official run failed",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    assessment: {
      criteria: [
        {
          name: "Exact-SHA official CI",
          status: "Rejected",
          observed: "Official run failed",
          evidence: "https://github.com/seed4j/seed4j/actions/runs/12",
        },
      ],
      nextCheck: "2026-09-28T11:08:00Z",
    },
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
    repository,
    request,
  });

  assert.equal(result.action, "retry");
  assert.match(issueBody, /4eebd07bce14c9a6ac70bace157fcc616133e950/);
  assert.match(issueBody, /2026-09-28T11:08:00Z/);
  assert.match(issueBody, /Rejected/);
  assert.match(
    issueBody,
    /https:\/\/github.com\/seed4j\/seed4j\/actions\/runs\/12/,
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/comments")).length,
    1,
  );
});

test("an hourly trigger respects a service retry deadline while manual head checks immediately", async () => {
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: "rate limited",
    nextCheck: "2026-09-28T13:41:00Z",
    attempts: [],
  };
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const request = async () => ({
    status: 200,
    body: [
      {
        title: "[publisher] Seed4J main snapshot publication cycle",
        number: 52,
        body: renderIssue(state),
      },
    ],
  });

  const hourly = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-28T12:41:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "41 * * * *",
  });
  const manual = await beginCycle({
    config,
    event: "workflow_dispatch",
    now: "2026-09-28T12:42:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
  });

  assert.deepEqual(hourly, { action: "none" });
  assert.equal(manual.action, "join");
  assert.equal(manual.deadline, state.deadline);
});

test("the first trigger after 48 hours closes the existing cycle without evaluating or renewing it", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: "Official run pending",
    nextCheck: "2026-09-30T10:41:00Z",
    attempts: [],
  };
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "PATCH") return { status: 200, body: {} };
    if (options.method === "POST") return { status: 201, body: {} };
    return {
      status: 200,
      body: [
        {
          title: "[publisher] Seed4J main snapshot publication cycle",
          number: 52,
          body: renderIssue(state),
        },
      ],
    };
  };

  const result = await beginCycle({
    config,
    event: "schedule",
    now: "2026-09-30T10:41:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
    schedule: "41 * * * *",
  });

  assert.equal(result.action, "expired");
  assert.equal(
    calls.filter((call) => call.options.method === "PATCH").length,
    2,
  );
  assert.match(calls[1].options.body.body, /deadline-expired/);
  assert.equal(calls.at(-1).options.body.state, "closed");
});

test("a failed deploy closes the cycle after recording public artifact observations", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const { encodeIdentity } = require("../scripts/publisher-policy.cjs");
  const identity = {
    artifactId: "seed4j-main-snapshot",
    groupId: "io.github.renanfranca",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    version:
      "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  };
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  };
  let issueBody = renderIssue(state);
  const publicCalls = [];
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      issueBody = options.body.body;
    return {
      status: options.method === "POST" ? 201 : 200,
      body: { body: issueBody },
    };
  };
  const publicRequest = async (url, method) => {
    publicCalls.push({ url, method });
    return url.endsWith("maven-metadata.xml")
      ? {
          status: 200,
          body: `<metadata><versioning><snapshotVersions><snapshotVersion><extension>pom</extension><value>2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-20260928.100000-1</value></snapshotVersion><snapshotVersion><extension>jar</extension><value>2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-20260928.100000-1</value></snapshotVersion><snapshotVersion><classifier>tests</classifier><extension>jar</extension><value>2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-20260928.100000-1</value></snapshotVersion></snapshotVersions></versioning></metadata>`,
        }
      : { status: url.includes("-tests.jar") ? 404 : 200 };
  };

  const result = await completeCycle({
    encodedIdentity: encodeIdentity(identity),
    issueNumber: 52,
    now: "2026-09-28T10:08:00Z",
    outcome: "publish",
    reason: "snapshot-absent",
    upstreamSha: identity.upstreamSha,
    assessment: { criteria: [] },
    buildResult: "success",
    deployResult: "failure",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
    repository,
    request,
    publicRequest,
  });

  assert.equal(result.action, "deployment-unconfirmed");
  assert.equal(publicCalls.length, 4);
  assert.match(issueBody, /POM confirmed/);
  assert.match(issueBody, /main JAR confirmed/);
  assert.match(issueBody, /tests JAR unconfirmed/);
  assert.match(issueBody, /manual inspection/i);
});

test("manual head after an expired cycle closes it and starts a fresh 48-hour cycle", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: "CI pending",
    attempts: [],
  };
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST" && url.endsWith("/issues"))
      return { status: 201, body: { number: 53 } };
    if (options.method === "POST") return { status: 201, body: {} };
    if (options.method === "PATCH") return { status: 200, body: {} };
    return {
      status: 200,
      body: [
        {
          title: "[publisher] Seed4J main snapshot publication cycle",
          number: 52,
          body: renderIssue(state),
        },
      ],
    };
  };

  const result = await beginCycle({
    config,
    event: "workflow_dispatch",
    now: "2026-09-30T11:00:00Z",
    operation: "head",
    ref: "refs/heads/main",
    repository,
    request,
  });

  assert.equal(result.action, "create");
  assert.equal(result.issueNumber, 53);
  assert.equal(result.deadline, "2026-10-02T11:00:00Z");
  assert.equal(
    calls.filter(
      (call) => call.options.method === "POST" && call.url.endsWith("/issues"),
    ).length,
    1,
  );
});

test("a build failure ends the cycle with its actual diagnostic and no deploy claim", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  };
  let issueBody = renderIssue(state);
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      issueBody = options.body.body;
    return {
      status: options.method === "POST" ? 201 : 200,
      body: { body: issueBody },
    };
  };

  const result = await completeCycle({
    assessment: { criteria: [] },
    buildDiagnostic:
      "build/Run complete upstream verification failed: test assertion",
    buildResult: "failure",
    deployResult: "skipped",
    issueNumber: 52,
    now: "2026-09-28T10:08:00Z",
    outcome: "publish",
    reason: "snapshot-absent",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
    repository,
    request,
  });

  assert.equal(result.action, "build-failed");
  assert.match(issueBody, /test assertion/);
  assert.match(issueBody, /Publisher build \| Rejected/);
  assert.match(issueBody, /Deploy\/public artifacts \| Not evaluated/);
});

test("unchanged retry comments stay silent while a changed SHA mentions the owner", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  const state = {
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  };
  let body = renderIssue(state);
  const comments = [];
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      body = options.body.body;
    if (url.endsWith("/comments")) comments.push(options.body.body);
    return { status: options.method === "POST" ? 201 : 200, body: { body } };
  };
  const common = {
    issueNumber: 52,
    outcome: "retry",
    reason: "Official run in progress",
    assessment: { criteria: [], nextCheck: "2026-09-28T15:00:00Z" },
    repository,
    request,
  };

  await completeCycle({
    ...common,
    now: "2026-09-28T11:00:00Z",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
  });
  await completeCycle({
    ...common,
    now: "2026-09-28T12:00:00Z",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/35",
  });
  await completeCycle({
    ...common,
    now: "2026-09-28T13:00:00Z",
    upstreamSha: "a111111111111111111111111111111111111111",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/36",
  });

  assert.equal(comments.length, 3);
  assert.equal(
    comments.filter((comment) => comment.includes("@renanfranca")).length,
    2,
  );
  assert.match(comments[2], /a111111111111111111111111111111111111111/);
  assert.match(comments[0], /actions\/runs\/34/);
  assert.match(comments[1], /actions\/runs\/35/);
  assert.match(comments[2], /actions\/runs\/36/);
});

test("two open cycle issues fail closed before any candidate or new issue is created", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      status: 200,
      body: [52, 53].map((number) => ({
        number,
        title: "[publisher] Seed4J main snapshot publication cycle",
        body: "invalid",
      })),
    };
  };

  await assert.rejects(
    beginCycle({
      config,
      event: "workflow_dispatch",
      now: "2026-09-28T10:00:00Z",
      operation: "head",
      ref: "refs/heads/main",
      repository,
      request,
    }),
    /Duplicate open publication cycles/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, undefined);
});

test("48 hourly attempts remain individually visible without growing the issue body beyond its limit", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  let body = renderIssue({
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  });
  const comments = [];
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      body = options.body.body;
    if (url.endsWith("/comments")) comments.push(options.body.body);
    return { status: options.method === "POST" ? 201 : 200, body: { body } };
  };
  for (let hour = 0; hour < 48; hour++) {
    const checkedAt = new Date(
      Date.parse("2026-09-28T10:00:00Z") + hour * 60 * 60 * 1000,
    )
      .toISOString()
      .replace(".000Z", "Z");
    await completeCycle({
      assessment: {
        criteria: [
          {
            name: "Exact-SHA official CI",
            status: "Rejected",
            observed: "Official run still pending",
            evidence: "https://github.com/seed4j/seed4j/actions/runs/12",
          },
        ],
        nextCheck: new Date(Date.parse(checkedAt) + 60 * 60 * 1000)
          .toISOString()
          .replace(".000Z", "Z"),
      },
      issueNumber: 52,
      now: checkedAt,
      outcome: "retry",
      reason: "Official run still pending",
      upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
      workflowRunUrl: `https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/${100 + hour}`,
      repository,
      request,
    });
  }

  assert.equal(comments.length, 48);
  assert.match(comments[0], /actions\/runs\/100/);
  assert.match(comments[47], /actions\/runs\/147/);
  assert.ok(body.length < 65_000);
  assert.equal(
    comments.filter((comment) => comment.includes("@renanfranca")).length,
    2,
  );
});

test("new CI log details for the same failed-run blocker do not repeat the mention", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  let body = renderIssue({
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  });
  const comments = [];
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      body = options.body.body;
    if (url.endsWith("/comments")) comments.push(options.body.body);
    return { status: options.method === "POST" ? 201 : 200, body: { body } };
  };
  const common = {
    assessment: { criteria: [], nextCheck: "2026-09-28T15:00:00Z" },
    issueNumber: 52,
    outcome: "retry",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    repository,
    request,
  };

  await completeCycle({
    ...common,
    now: "2026-09-28T11:00:00Z",
    reason: "Official run failed: verify / test: observed ENOSPC",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
  });
  await completeCycle({
    ...common,
    now: "2026-09-28T12:00:00Z",
    reason: "Official run failed: verify / test: new log line",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/35",
  });

  assert.equal(comments.length, 2);
  assert.equal(
    comments.filter((comment) => comment.includes("@renanfranca")).length,
    1,
  );
});

test("the cycle issue preserves separate linked diagnostics for multiple failed CI jobs", async () => {
  const { renderIssue } = require("../scripts/publication-cycle.cjs");
  let body = renderIssue({
    startedAt: "2026-09-28T10:00:00Z",
    deadline: "2026-09-30T10:00:00Z",
    plannedAt: "2026-09-28T10:00:00Z",
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  });
  const comments = [];
  const request = async (url, options = {}) => {
    if (options.method === "PATCH" && options.body.body)
      body = options.body.body;
    if (url.endsWith("/comments")) comments.push(options.body.body);
    return { status: options.method === "POST" ? 201 : 200, body: { body } };
  };

  await completeCycle({
    assessment: {
      criteria: [],
      diagnostics: [
        {
          summary:
            "backend / Maven verify: Confirmed cause: storage exhausted (ENOSPC)",
          url: "https://github.com/seed4j/seed4j/actions/runs/12/job/19",
        },
        {
          summary:
            "frontend / npm test: Cause unknown; @evil [login](https://attacker.example)",
          url: "https://github.com/seed4j/seed4j/actions/runs/12/job/20",
        },
        {
          summary: "unexpected external job link",
          url: "https://github.com/attacker/repository/actions/runs/12",
        },
      ],
      nextCheck: "2026-09-28T12:00:00Z",
    },
    issueNumber: 52,
    now: "2026-09-28T11:00:00Z",
    outcome: "retry",
    reason: "Official run failed",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    workflowRunUrl:
      "https://github.com/renanfranca/seed4j-main-snapshots/actions/runs/34",
    repository,
    request,
  });

  assert.match(comments[0], /backend.*\/job\/19/);
  assert.match(comments[0], /frontend.*\/job\/20/);
  assert.doesNotMatch(comments[0], /@evil|\[login\]\(/);
  assert.doesNotMatch(comments[0], /https:\/\/github\.com\/attacker/);
});
