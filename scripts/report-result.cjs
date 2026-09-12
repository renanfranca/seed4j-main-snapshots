const { decodeIdentity } = require("./publisher-policy.cjs");
const {
  failureIssueUpdate,
  successIssueResolution,
} = require("./operations-policy.cjs");

const API_ROOT = "https://api.github.com";
const PUBLISHER_REPOSITORY = "renanfranca/seed4j-main-snapshots";
const FAILURE_TITLE = "[publisher] Seed4J main snapshot failure";

async function reportPublisherResult({
  buildDiagnostic,
  buildResult,
  deployDiagnostic,
  deployResult,
  encodedIdentity,
  now,
  outcome,
  qualifyResult,
  reason,
  repository,
  request,
  workflowRunUrl,
}) {
  const qualification = reportedQualification({
    outcome,
    qualifyResult,
    reason,
  });
  if (qualification.outcome === "skip") {
    return Object.freeze({ action: "none", reason: "expected-skip" });
  }
  if (repository !== PUBLISHER_REPOSITORY) {
    throw new Error(
      `Publisher reporting must run only in '${PUBLISHER_REPOSITORY}'.`,
    );
  }
  const identity = encodedIdentity
    ? decodeIdentity(encodedIdentity)
    : undefined;
  const issue = await openFailureIssue(repository, request);
  if (
    outcome === "publish" &&
    buildResult === "success" &&
    deployResult === "success"
  ) {
    if (!identity) {
      throw new Error(
        "Successful publication reporting requires a qualified identity.",
      );
    }
    if (!issue) {
      return Object.freeze({ action: "none", reason: "no-open-failure" });
    }
    const resolution = successIssueResolution({
      identity,
      issueNumber: issue.number,
    });
    await requireResponse(
      request(
        `${API_ROOT}/repos/${repository}/issues/${issue.number}/comments`,
        {
          body: { body: resolution.comment },
          method: "POST",
        },
      ),
      201,
      "failure issue resolution comment",
    );
    await requireResponse(
      request(`${API_ROOT}/repos/${repository}/issues/${issue.number}`, {
        body: { state: "closed", state_reason: "completed" },
        method: "PATCH",
      }),
      200,
      "failure issue closure",
    );
    return Object.freeze({ action: "close", issueNumber: issue.number });
  }

  const stage = failureStage({
    buildResult,
    outcome: qualification.outcome,
  });
  const result = failureIssueUpdate({
    existingBody: issue?.body,
    failure: {
      diagnostic: failureDiagnostic({
        buildDiagnostic,
        buildResult,
        deployDiagnostic,
        deployResult,
        outcome: qualification.outcome,
        reason: qualification.reason,
        stage,
      }),
      failedAt: now,
      identity,
      stage,
      workflowRunUrl,
    },
  });
  const response = await request(
    issue
      ? `${API_ROOT}/repos/${repository}/issues/${issue.number}`
      : `${API_ROOT}/repos/${repository}/issues`,
    {
      body: {
        assignees: result.assignees,
        body: result.body,
        labels: result.labels,
        title: result.title,
      },
      method: issue ? "PATCH" : "POST",
    },
  );
  requireStatus(
    response,
    issue ? 200 : 201,
    `${result.action} publisher failure issue`,
  );
  return Object.freeze({
    action: result.action,
    issueNumber: issue?.number ?? response.body?.number,
  });
}

function reportedQualification({ outcome, qualifyResult, reason }) {
  if (["failure", "publish"].includes(outcome)) {
    return Object.freeze({ outcome, reason });
  }
  if (outcome === "skip" && (!qualifyResult || qualifyResult === "success")) {
    return Object.freeze({ outcome, reason });
  }
  if (
    ["success", "failure", "cancelled", "skipped"].includes(qualifyResult) &&
    (!outcome || outcome === "skip")
  ) {
    return Object.freeze({
      outcome: "failure",
      reason: `Qualification job ended with result '${qualifyResult}' before candidate outputs were produced.`,
    });
  }
  throw new Error(`Unsupported publisher outcome '${outcome ?? ""}'.`);
}

function failureStage({ buildResult, outcome }) {
  if (outcome === "failure") {
    return "qualify";
  }
  return buildResult === "success" ? "deploy" : "build";
}

function failureDiagnostic({
  buildDiagnostic,
  buildResult,
  deployDiagnostic,
  deployResult,
  outcome,
  reason,
  stage,
}) {
  if (stage === "qualify") {
    return reason || "Qualification failed before a diagnostic was captured.";
  }
  const diagnostic = stage === "build" ? buildDiagnostic : deployDiagnostic;
  const result = stage === "build" ? buildResult : deployResult;
  return (
    diagnostic ||
    `${stage} job failed with result '${result ?? "missing"}' before an adapter diagnostic was captured.`
  );
}

async function openFailureIssue(repository, request) {
  const response = await request(
    `${API_ROOT}/repos/${repository}/issues?state=open&labels=publisher-failure&per_page=100`,
  );
  requireStatus(response, 200, "open publisher failure issues");
  const matching = Array.isArray(response.body)
    ? response.body.filter(
        (issue) => issue.title === FAILURE_TITLE && !issue.pull_request,
      )
    : [];
  if (matching.length > 1) {
    throw new Error(
      `Expected at most one open publisher failure issue; found ${matching.length}.`,
    );
  }
  return matching[0];
}

async function requireResponse(promise, expectedStatus, label) {
  requireStatus(await promise, expectedStatus, label);
}

function requireStatus(response, expectedStatus, label) {
  if (response?.status !== expectedStatus) {
    throw new Error(
      `${label} request returned status '${response?.status ?? ""}'.`,
    );
  }
}

async function githubRequest(url, options = {}) {
  if (!process.env.GH_TOKEN) {
    throw new Error("GH_TOKEN is required for publisher issue reporting.");
  }
  const response = await fetch(url, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "seed4j-main-snapshot-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    method: options.method ?? "GET",
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : undefined, status: response.status };
}

async function run() {
  const result = await reportPublisherResult({
    buildDiagnostic: process.env.BUILD_DIAGNOSTIC,
    buildResult: process.env.BUILD_RESULT,
    deployDiagnostic: process.env.DEPLOY_DIAGNOSTIC,
    deployResult: process.env.DEPLOY_RESULT,
    encodedIdentity: process.env.PUBLISHER_IDENTITY,
    now: new Date().toISOString().replace(".000Z", "Z"),
    outcome: process.env.PUBLISHER_OUTCOME,
    qualifyResult: process.env.QUALIFY_RESULT,
    reason: process.env.PUBLISHER_REASON,
    repository: process.env.GITHUB_REPOSITORY,
    request: githubRequest,
    workflowRunUrl: process.env.WORKFLOW_RUN_URL,
  });
  console.log(`Publisher reporting action: ${result.action}.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { reportPublisherResult };
