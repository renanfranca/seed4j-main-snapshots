const { appendFileSync } = require("node:fs");
const {
  canonicalPublisherTimestamp,
  sanitizeDiagnostic,
  validatePublisherConfig,
} = require("./operations-policy.cjs");
const { readPublisherConfig } = require("./publisher-config.cjs");
const { decodeIdentity } = require("./publisher-policy.cjs");
const {
  inspectPublicArtifacts,
  fetchPublic,
} = require("./public-artifact-observation.cjs");

const API = "https://api.github.com";
const REPOSITORY = "renanfranca/seed4j-main-snapshots";
const TITLE = "[publisher] Seed4J main snapshot publication cycle";
const START = "<!-- seed4j-publisher-cycle-state:start -->";
const END = "<!-- seed4j-publisher-cycle-state:end -->";
const WEEKLY = "17 6 * * 1";
const DAILY = "17 6 * * 0,2-6";
const HOURLY = "41 * * * *";
const WINDOW = 48 * 60 * 60 * 1000;

async function beginCycle({
  config,
  event,
  now,
  operation,
  ref,
  repository,
  request,
  schedule,
}) {
  const validated = validatePublisherConfig(config);
  if (repository !== REPOSITORY)
    throw new Error("Publisher cycle must run in the trusted repository.");
  if (ref !== "refs/heads/main" || operation === "retry-last-failed")
    return { action: "none" };
  if (event === "schedule") {
    if (![WEEKLY, DAILY, HOURLY].includes(schedule))
      throw new Error("Unsupported publication schedule.");
    if (
      schedule !== HOURLY &&
      (!validated.pilotCompleted ||
        (schedule === DAILY && validated.scheduleMode !== "daily"))
    )
      return { action: "none" };
  } else if (event !== "workflow_dispatch" || operation !== "head") {
    throw new Error("Unsupported publication cycle invocation.");
  }
  const actual = canonicalPublisherTimestamp(now);
  const open = await openCycles(repository, request);
  if (open.length > 1)
    throw new Error("Duplicate open publication cycles require manual repair.");
  if (open.length === 1) {
    const state = parseState(open[0].body);
    if (Date.parse(actual) >= Date.parse(state.deadline)) {
      await closeExpiredCycle(open[0].number, state, repository, request);
      if (schedule === HOURLY)
        return { action: "expired", issueNumber: open[0].number, ...state };
    } else {
      if (
        schedule === HOURLY &&
        state.nextCheck &&
        Date.parse(actual) < Date.parse(state.nextCheck)
      )
        return { action: "none" };
      return { action: "join", issueNumber: open[0].number, ...state };
    }
  }
  if (schedule === HOURLY) return { action: "none" };
  const deadline = new Date(Date.parse(actual) + WINDOW)
    .toISOString()
    .replace(".000Z", "Z");
  const plannedAt =
    event === "schedule" ? plannedTime(actual, schedule) : actual;
  const state = {
    startedAt: actual,
    deadline,
    plannedAt,
    lastSha: null,
    lastBlocker: null,
    attempts: [],
  };
  const created = await request(`${API}/repos/${repository}/issues`, {
    method: "POST",
    body: {
      title: TITLE,
      assignees: ["renanfranca"],
      body: renderIssue(state),
    },
  });
  requireStatus(created, 201, "create publication cycle");
  if (!Number.isInteger(created.body?.number))
    throw new Error("Created publication cycle lacks an issue number.");
  return { action: "create", issueNumber: created.body.number, ...state };
}

async function openCycles(repository, request) {
  const open = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(
      `${API}/repos/${repository}/issues?state=open&per_page=100&page=${page}`,
    );
    requireStatus(response, 200, "open publication cycles");
    if (!Array.isArray(response.body))
      throw new Error("Invalid publication cycle issue list.");
    open.push(
      ...response.body.filter(
        (issue) => issue.title === TITLE && !issue.pull_request,
      ),
    );
    if (open.length > 1 || response.body.length < 100) return open;
  }
  throw new Error("Open publication cycle scan exceeded the issue page limit.");
}

async function closeExpiredCycle(issueNumber, state, repository, request) {
  const last = state.latest ?? state.attempts.at(-1);
  const final = {
    checkedAt: state.deadline,
    workflowRunUrl:
      last?.workflowRunUrl ?? "No publisher run evaluated a candidate",
    sha: last?.sha ?? "Unavailable",
    decision: "deadline-expired",
    blocker:
      "The 48-hour cycle window ended before an eligible publication was confirmed",
    nextCheck: null,
    criteria: last?.criteria ?? completeCriteria([], {}),
  };
  const updated = await request(
    `${API}/repos/${repository}/issues/${issueNumber}`,
    { method: "PATCH", body: { body: renderIssue(state, renderFinal(final)) } },
  );
  requireStatus(updated, 200, "finalize expired publication cycle");
  const commented = await request(
    `${API}/repos/${repository}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      body: {
        body: `@renanfranca publication cycle deadline expired at ${state.deadline}. Inspect the final report before starting another cycle.`,
      },
    },
  );
  requireStatus(commented, 201, "comment on expired publication cycle");
  const closed = await request(
    `${API}/repos/${repository}/issues/${issueNumber}`,
    { method: "PATCH", body: { state: "closed", state_reason: "completed" } },
  );
  requireStatus(closed, 200, "close expired publication cycle");
}

async function completeCycle({
  assessment = {},
  buildDiagnostic,
  buildResult,
  deployDiagnostic,
  deployResult,
  encodedIdentity,
  issueNumber,
  now,
  outcome,
  reason,
  upstreamSha,
  workflowRunUrl,
  repository,
  request,
  publicRequest = fetchPublic,
}) {
  if (repository !== REPOSITORY || !Number.isInteger(issueNumber))
    throw new Error("Invalid publication cycle target.");
  const response = await request(
    `${API}/repos/${repository}/issues/${issueNumber}`,
  );
  requireStatus(response, 200, "read publication cycle");
  if (response.body?.title && response.body.title !== TITLE)
    throw new Error("Publication cycle issue title does not match.");
  const state = parseState(response.body?.body);
  const checkedAt = canonicalPublisherTimestamp(now);
  if (
    !/^https:\/\/github\.com\/renanfranca\/seed4j-main-snapshots\/actions\/runs\/\d+(?:\?attempt=\d+)?$/.test(
      workflowRunUrl ?? "",
    )
  )
    throw new Error("Invalid publisher workflow run URL.");
  if (
    state.attempts.some((attempt) => attempt.workflowRunUrl === workflowRunUrl)
  )
    return { action: "duplicate", issueNumber };
  const deadlinePassed = Date.parse(checkedAt) >= Date.parse(state.deadline);
  const requestedCheck = assessment.nextCheck
    ? canonicalPublisherTimestamp(assessment.nextCheck)
    : new Date(Date.parse(checkedAt) + 60 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");
  const retryWithinWindow =
    outcome === "retry" &&
    !deadlinePassed &&
    Date.parse(requestedCheck) < Date.parse(state.deadline);
  const action = retryWithinWindow
    ? "retry"
    : finalAction({ outcome, buildResult, deployResult, deadlinePassed });
  const blocker = sanitizeDiagnostic(
    action === "build-failed"
      ? buildDiagnostic || "Publisher build failed; inspect the linked run"
      : action === "deployment-unconfirmed"
        ? deployDiagnostic ||
          "Deploy result is unconfirmed; inspect public artifacts"
        : reason || action,
  );
  const sha = /^[0-9a-f]{40}$/.test(upstreamSha ?? "")
    ? upstreamSha
    : undefined;
  const publicObservation =
    action === "deployment-unconfirmed" && encodedIdentity
      ? await inspectPublicArtifacts(
          decodeIdentity(encodedIdentity),
          publicRequest,
        )
      : undefined;
  const criteria = completeCriteria(assessment.criteria, {
    outcome,
    buildResult,
    deployResult,
    action,
    workflowRunUrl,
    publicObservation,
    buildDiagnostic,
    deployDiagnostic,
  });
  const attempt = {
    checkedAt,
    workflowRunUrl,
    sha: sha ?? "Unavailable",
    decision: action,
    blocker,
    nextCheck: retryWithinWindow ? requestedCheck : null,
    criteria,
    diagnostics: (assessment.diagnostics ?? [])
      .slice(0, 5)
      .map((diagnostic) => ({
        summary: sanitizeDiagnostic(diagnostic.summary),
        url: safeEvidence(diagnostic.url),
      })),
  };
  const oldSha = state.lastSha;
  const oldBlocker = state.lastBlocker;
  const currentBlocker = blockerKey(action, blocker);
  state.attempts.push({ checkedAt, workflowRunUrl, sha: attempt.sha });
  state.latest = attempt;
  state.lastSha = sha ?? null;
  state.lastBlocker = currentBlocker;
  state.nextCheck = attempt.nextCheck;
  const finalReport = retryWithinWindow ? "" : renderFinal(attempt);
  const updated = await request(
    `${API}/repos/${repository}/issues/${issueNumber}`,
    { method: "PATCH", body: { body: renderIssue(state, finalReport) } },
  );
  requireStatus(updated, 200, "update publication cycle");
  const mention =
    oldSha !== state.lastSha ||
    oldBlocker !== currentBlocker ||
    !retryWithinWindow
      ? "@renanfranca\n\n"
      : "";
  const comment = await request(
    `${API}/repos/${repository}/issues/${issueNumber}/comments`,
    { method: "POST", body: { body: `${mention}${renderAttempt(attempt)}` } },
  );
  requireStatus(comment, 201, "comment on publication cycle");
  if (!retryWithinWindow) {
    const closed = await request(
      `${API}/repos/${repository}/issues/${issueNumber}`,
      { method: "PATCH", body: { state: "closed", state_reason: "completed" } },
    );
    requireStatus(closed, 200, "close publication cycle");
  }
  return { action, issueNumber };
}

function blockerKey(action, reason) {
  if (action !== "retry") return action;
  for (const state of [
    "Missing official run",
    "Official run in progress",
    "Official run cancelled",
    "Official run failed",
  ]) {
    if (reason.startsWith(state)) return state;
  }
  return reason.replace(/:.*$/, "");
}

function finalAction({ outcome, buildResult, deployResult, deadlinePassed }) {
  if (
    outcome === "publish" &&
    buildResult === "success" &&
    deployResult === "success"
  )
    return "published";
  if (outcome === "publish" && buildResult !== "success") return "build-failed";
  if (outcome === "publish") return "deployment-unconfirmed";
  if (deadlinePassed || outcome === "retry") return "deadline-expired";
  if (outcome === "skip") return "skipped";
  return "blocked";
}

function completeCriteria(
  criteria = [],
  {
    outcome,
    buildResult,
    deployResult,
    action,
    workflowRunUrl,
    publicObservation,
    buildDiagnostic,
    deployDiagnostic,
  },
) {
  const names = [
    "Qualification",
    "Official main SHA",
    "Exact-SHA official CI",
    "Central token",
    "Retention",
    "Publisher build",
    "Deploy/public artifacts",
  ];
  const observed = new Map(
    criteria.map((criterion) => [criterion.name, criterion]),
  );
  if (outcome === "publish") {
    observed.set("Publisher build", {
      name: "Publisher build",
      status: buildResult === "success" ? "Accepted" : "Rejected",
      observed:
        buildResult === "success"
          ? "Build succeeded"
          : buildDiagnostic || buildResult || "No result",
      evidence: workflowRunUrl,
    });
    observed.set("Deploy/public artifacts", {
      name: "Deploy/public artifacts",
      status:
        deployResult === "success"
          ? "Accepted"
          : ["skipped", undefined].includes(deployResult)
            ? "Not evaluated"
            : "Rejected",
      observed:
        publicObservation?.summary ??
        deployDiagnostic ??
        deployResult ??
        "No result",
      evidence: publicObservation?.evidence ?? workflowRunUrl,
    });
  }
  return names.map((name) => {
    const criterion = observed.get(name) ?? {
      name,
      status: "Not evaluated",
      observed: "Not reached",
      evidence: "No observation",
    };
    if (!["Accepted", "Rejected", "Not evaluated"].includes(criterion.status))
      throw new Error("Invalid publication criterion status.");
    return {
      name,
      status: criterion.status,
      observed: sanitizeDiagnostic(criterion.observed),
      evidence: safeEvidence(criterion.evidence),
    };
  });
}

function safeEvidence(value) {
  const evidence = String(value ?? "No evidence");
  return /^https:\/\/(?:github\.com\/(?:seed4j\/seed4j|renanfranca\/seed4j-main-snapshots)|central\.sonatype\.com\/repository\/maven-snapshots)\/[a-zA-Z0-9/.-]+(?:\?[-a-zA-Z0-9=&]+)?$/.test(
    evidence,
  )
    ? evidence
    : sanitizeDiagnostic(evidence).replace(/https?:\/\//gi, "https[:]//");
}

function renderAttempt(attempt) {
  const diagnostics = attempt.diagnostics?.length
    ? `\n\nFailed official jobs:\n${attempt.diagnostics.map((diagnostic) => `- ${diagnostic.summary} — ${diagnostic.url}`).join("\n")}`
    : "";
  return `### ${attempt.checkedAt}\n\n- Commit evaluated: \`${attempt.sha}\`\n- Workflow run: ${attempt.workflowRunUrl}\n- Decision: \`${attempt.decision}\` — ${attempt.blocker}\n- Next check: ${attempt.nextCheck ?? "None"}\n\n| Criterion | Status | Observed | Evidence |\n| --- | --- | --- | --- |\n${attempt.criteria.map((criterion) => `| ${criterion.name} | ${criterion.status} | ${criterion.observed.replaceAll("|", "¦")} | ${criterion.evidence.replaceAll("|", "¦")} |`).join("\n")}${diagnostics}`;
}

function renderFinal(attempt) {
  return `Outcome: **${attempt.decision}**. ${attempt.blocker}. Commit ${attempt.sha} ${attempt.decision === "published" ? "was published" : attempt.decision === "skipped" ? "was dispensed by eligibility policy" : "could not be published"}.\n\n${renderAttempt(attempt)}`;
}

function plannedTime(actual, schedule) {
  const time = new Date(actual);
  time.setUTCHours(6, 17, 0, 0);
  if (schedule === WEEKLY)
    time.setUTCDate(time.getUTCDate() - ((time.getUTCDay() + 6) % 7));
  return time.toISOString().replace(".000Z", "Z");
}

function parseState(body) {
  const start = body?.indexOf(START) ?? -1;
  const end = body?.indexOf(END) ?? -1;
  if (
    start < 0 ||
    end <= start ||
    body.lastIndexOf(START) !== start ||
    body.lastIndexOf(END) !== end
  )
    throw new Error("Publication cycle state markers are invalid.");
  let state;
  try {
    state = JSON.parse(body.slice(start + START.length, end).trim());
  } catch (_) {
    throw new Error("Publication cycle state is invalid JSON.");
  }
  if (
    !state ||
    !Array.isArray(state.attempts) ||
    typeof state.startedAt !== "string" ||
    typeof state.deadline !== "string" ||
    typeof state.plannedAt !== "string" ||
    ![null, "string"].includes(
      state.lastSha === null ? null : typeof state.lastSha,
    ) ||
    ![null, "string"].includes(
      state.lastBlocker === null ? null : typeof state.lastBlocker,
    )
  )
    throw new Error("Publication cycle state shape is invalid.");
  canonicalPublisherTimestamp(state.startedAt);
  canonicalPublisherTimestamp(state.deadline);
  canonicalPublisherTimestamp(state.plannedAt);
  if (Date.parse(state.deadline) - Date.parse(state.startedAt) !== WINDOW)
    throw new Error("Publication cycle deadline is invalid.");
  return state;
}

function renderIssue(state, finalReport = "") {
  return `@renanfranca publication cycle started.\n\n- Planned trigger: ${state.plannedAt}\n- Actual start: ${state.startedAt}\n- Deadline: ${state.deadline}\n- Status: ${finalReport ? "Closed" : "Open"}\n- Attempts: ${state.attempts.length} (see issue comments for every attempt)\n\n## Latest attempt\n\n${state.latest ? renderAttempt(state.latest) : "No evaluation completed yet."}\n\n${finalReport ? `## Final report\n\n${finalReport}\n\n` : ""}${START}\n${JSON.stringify(state)}\n${END}\n`;
}

function requireStatus(response, status, action) {
  if (response?.status !== status)
    throw new Error(`${action} returned status '${response?.status ?? ""}'.`);
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "seed4j-main-snapshot-publisher",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

async function run() {
  const [command, flag, configPath] = process.argv.slice(2);
  let result;
  if (command === "start" && flag === "--config" && configPath) {
    result = await beginCycle({
      config: readPublisherConfig(configPath),
      event: process.env.PUBLISHER_EVENT,
      now: new Date().toISOString(),
      operation: process.env.PUBLISHER_OPERATION,
      ref: process.env.PUBLISHER_REF,
      repository: process.env.GITHUB_REPOSITORY,
      request: githubRequest,
      schedule: process.env.PUBLISHER_SCHEDULE,
    });
  } else if (command === "finish" && process.env.PUBLISHER_CYCLE_ISSUE) {
    const assessment = process.env.PUBLISHER_ASSESSMENT
      ? JSON.parse(
          Buffer.from(process.env.PUBLISHER_ASSESSMENT, "base64url").toString(
            "utf8",
          ),
        )
      : {};
    result = await completeCycle({
      assessment,
      buildDiagnostic: process.env.BUILD_DIAGNOSTIC,
      buildResult: process.env.BUILD_RESULT,
      deployDiagnostic: process.env.DEPLOY_DIAGNOSTIC,
      deployResult: process.env.DEPLOY_RESULT,
      encodedIdentity: process.env.PUBLISHER_IDENTITY,
      issueNumber: Number(process.env.PUBLISHER_CYCLE_ISSUE),
      now: new Date().toISOString(),
      outcome: process.env.PUBLISHER_OUTCOME,
      reason: process.env.PUBLISHER_REASON,
      upstreamSha: process.env.PUBLISHER_UPSTREAM_SHA,
      workflowRunUrl: process.env.WORKFLOW_RUN_URL,
      repository: process.env.GITHUB_REPOSITORY,
      request: githubRequest,
    });
  } else
    throw new Error(
      "Usage: publication-cycle.cjs start --config <path> | finish",
    );
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries({
      action: result.action,
      issue: result.issueNumber ?? "",
      deadline: result.deadline ?? "",
    }))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  else console.log(result);
}

if (require.main === module)
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = {
  beginCycle,
  completeCycle,
  parseState,
  renderIssue,
  githubRequest,
  HOURLY,
};
