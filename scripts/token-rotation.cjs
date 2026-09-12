const {
  tokenRotationAction,
  validatePublisherConfig,
} = require("./operations-policy.cjs");
const { readPublisherConfig } = require("./publisher-config.cjs");

const API_ROOT = "https://api.github.com";
const PUBLISHER_REPOSITORY = "renanfranca/seed4j-main-snapshots";

async function manageTokenRotation({ config, repository, request, today }) {
  const validatedConfig = validatePublisherConfig(config);
  if (validatedConfig.centralTokenExpiresOn === null) {
    return Object.freeze({ action: "none", reason: "expiry-not-recorded" });
  }
  if (repository !== PUBLISHER_REPOSITORY) {
    throw new Error(
      `Token rotation management must run only in '${PUBLISHER_REPOSITORY}'.`,
    );
  }
  const issue = await openRotationIssue(repository, request);
  const action = tokenRotationAction({
    openIssueNumber: issue?.number,
    recordedExpiry: validatedConfig.centralTokenExpiresOn,
    today,
  });
  if (action.action === "none") {
    return action;
  }
  if (action.action === "close") {
    await requireResponse(
      request(
        `${API_ROOT}/repos/${repository}/issues/${issue.number}/comments`,
        {
          body: { body: action.comment },
          method: "POST",
        },
      ),
      201,
      "token rotation issue resolution comment",
    );
    await requireResponse(
      request(`${API_ROOT}/repos/${repository}/issues/${issue.number}`, {
        body: { state: "closed", state_reason: "completed" },
        method: "PATCH",
      }),
      200,
      "token rotation issue closure",
    );
    return Object.freeze({ action: "close", issueNumber: issue.number });
  }
  const response = await request(
    issue
      ? `${API_ROOT}/repos/${repository}/issues/${issue.number}`
      : `${API_ROOT}/repos/${repository}/issues`,
    {
      body: {
        assignees: action.assignees,
        body: action.body,
        labels: action.labels,
        title: action.title,
      },
      method: issue ? "PATCH" : "POST",
    },
  );
  requireStatus(
    response,
    issue ? 200 : 201,
    `${action.action} token rotation issue`,
  );
  return Object.freeze({
    action: action.action,
    issueNumber: issue?.number ?? response.body?.number,
  });
}

async function openRotationIssue(repository, request) {
  const response = await request(
    `${API_ROOT}/repos/${repository}/issues?state=open&labels=publisher-token-rotation&per_page=100`,
  );
  requireStatus(response, 200, "open token rotation issues");
  const matching = Array.isArray(response.body)
    ? response.body.filter(
        (issue) =>
          issue.title?.startsWith("[publisher] Rotate Central token before ") &&
          !issue.pull_request,
      )
    : [];
  if (matching.length > 1) {
    throw new Error(
      `Expected at most one open publisher token rotation issue; found ${matching.length}.`,
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
    throw new Error(
      "GH_TOKEN is required for token rotation issue management.",
    );
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

function parseRequest(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--config" ||
    !arguments_[1] ||
    arguments_[1].startsWith("--")
  ) {
    throw new Error(
      "Token rotation management requires exactly --config <publisher-config>.",
    );
  }
  return { configPath: arguments_[1] };
}

async function run() {
  const { configPath } = parseRequest(process.argv.slice(2));
  const result = await manageTokenRotation({
    config: readPublisherConfig(configPath),
    repository: process.env.GITHUB_REPOSITORY,
    request: githubRequest,
    today: new Date().toISOString().slice(0, 10),
  });
  console.log(`Token rotation action: ${result.action}.`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { manageTokenRotation };
