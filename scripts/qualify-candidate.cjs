const { createHash } = require("node:crypto");
const { appendFileSync } = require("node:fs");
const {
  deriveSnapshotIdentity,
  encodeIdentity,
  identityFromFailureState,
  qualifyCandidate,
  retentionDecision,
} = require("./publisher-policy.cjs");
const {
  sanitizeDiagnostic,
  validatePublisherConfig,
} = require("./operations-policy.cjs");
const { readPublisherConfig } = require("./publisher-config.cjs");

const API_ROOT = "https://api.github.com";
const CENTRAL_ROOT = "https://central.sonatype.com/repository/maven-snapshots";
const OFFICIAL_REPOSITORY = "seed4j/seed4j";
const PUBLISHER_REPOSITORY = "renanfranca/seed4j-main-snapshots";
const WEEKLY_SCHEDULE = "17 6 * * 1";
const DAILY_SCHEDULE = "17 6 * * 0,2-6";

async function qualifyPublication({
  config,
  event,
  now,
  operation,
  publisherRepository,
  ref,
  request,
  schedule,
}) {
  const validatedConfig = validatePublisherConfig(config);
  requireInvocation({ event, operation, publisherRepository, schedule });
  if (ref !== "refs/heads/main") {
    return Object.freeze({
      openFailureIssue: false,
      outcome: "skip",
      reason: "publisher-ref-not-main",
    });
  }
  const scheduleDecision = scheduledPublicationDecision({
    config: validatedConfig,
    event,
    schedule,
  });
  if (scheduleDecision) {
    return scheduleDecision;
  }

  let resolved;
  try {
    resolved =
      operation === "head"
        ? await resolveHeadCandidate(request)
        : await resolveRetryCandidate({ publisherRepository, request });
    const qualification = qualifyCandidate({
      candidate: resolved.identity,
      operation,
      retryIssueBody: resolved.retryIssueBody,
      retryReachable: resolved.retryReachable,
      upstreamCheck: await officialWorkflowCheck(
        resolved.identity.upstreamSha,
        request,
      ),
    });
    if (qualification.outcome === "skip") {
      return qualification;
    }
    requireUsableRecordedToken(validatedConfig.centralTokenExpiresOn, now);
    const retention = retentionDecision({
      centralMetadata: await centralMetadata(resolved.identity, request),
      identity: resolved.identity,
      now,
    });
    return Object.freeze({
      ...(retention.outcome === "publish"
        ? { identity: resolved.identity }
        : {}),
      ...retention,
      upstreamSha: resolved.identity.upstreamSha,
    });
  } catch (error) {
    if (resolved?.identity) {
      error.identity = resolved.identity;
    }
    throw error;
  }
}

async function qualificationResult(invocation) {
  try {
    return await qualifyPublication(invocation);
  } catch (error) {
    return Object.freeze({
      ...(error.identity ? { identity: error.identity } : {}),
      outcome: "failure",
      reason: sanitizeDiagnostic(error.message),
      ...(error.identity ? { upstreamSha: error.identity.upstreamSha } : {}),
    });
  }
}

function requireInvocation({
  event,
  operation,
  publisherRepository,
  schedule,
}) {
  if (!["schedule", "workflow_dispatch"].includes(event)) {
    throw new Error(`Unsupported publisher event '${event ?? ""}'.`);
  }
  if (!["head", "retry-last-failed"].includes(operation)) {
    throw new Error(`Unsupported publisher operation '${operation ?? ""}'.`);
  }
  if (publisherRepository !== PUBLISHER_REPOSITORY) {
    throw new Error(`Publisher must run only in '${PUBLISHER_REPOSITORY}'.`);
  }
  if (
    event === "schedule" &&
    ![WEEKLY_SCHEDULE, DAILY_SCHEDULE].includes(schedule)
  ) {
    throw new Error(`Unsupported publisher schedule '${schedule ?? ""}'.`);
  }
}

function scheduledPublicationDecision({ config, event, schedule }) {
  if (event !== "schedule") {
    return undefined;
  }
  if (!config.pilotCompleted) {
    return Object.freeze({
      openFailureIssue: false,
      outcome: "skip",
      reason: "pilot-not-completed",
    });
  }
  if (schedule === DAILY_SCHEDULE && config.scheduleMode !== "daily") {
    return Object.freeze({
      openFailureIssue: false,
      outcome: "skip",
      reason: "daily-schedule-not-enabled",
    });
  }
  return undefined;
}

async function resolveHeadCandidate(request) {
  const commitResponse = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/commits/main`,
  );
  requireStatus(commitResponse, 200, "official main commit");
  const upstreamSha = commitResponse.body?.sha;
  const upstreamCommitTimestamp = commitResponse.body?.commit?.committer?.date;
  const upstreamPomVersion = await officialPomVersion(upstreamSha, request);
  const upstreamLicenseSha256 = await officialLicenseSha256(
    upstreamSha,
    request,
  );
  return Object.freeze({
    identity: deriveSnapshotIdentity({
      upstreamCommitTimestamp,
      upstreamLicenseSha256,
      upstreamPomVersion,
      upstreamSha,
    }),
  });
}

async function resolveRetryCandidate({ publisherRepository, request }) {
  const issuesResponse = await request(
    `${API_ROOT}/repos/${publisherRepository}/issues?state=open&labels=publisher-failure&per_page=100`,
  );
  requireStatus(issuesResponse, 200, "publisher failure issues");
  const matchingIssues = Array.isArray(issuesResponse.body)
    ? issuesResponse.body.filter(
        (issue) =>
          issue.title === "[publisher] Seed4J main snapshot failure" &&
          !issue.pull_request,
      )
    : [];
  if (matchingIssues.length !== 1) {
    throw new Error(
      `Retry requires exactly one open marked publisher failure issue; found ${matchingIssues.length}.`,
    );
  }
  const retryIssueBody = matchingIssues[0].body;
  const recordedIdentity = identityFromFailureState(retryIssueBody);
  const commitResponse = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/commits/${recordedIdentity.upstreamSha}`,
  );
  requireStatus(commitResponse, 200, "recorded official upstream commit");
  const upstreamPomVersion = await officialPomVersion(
    recordedIdentity.upstreamSha,
    request,
  );
  const upstreamLicenseSha256 = await officialLicenseSha256(
    recordedIdentity.upstreamSha,
    request,
  );
  const officialIdentity = deriveSnapshotIdentity({
    upstreamCommitTimestamp: commitResponse.body?.commit?.committer?.date,
    upstreamLicenseSha256,
    upstreamPomVersion,
    upstreamSha: commitResponse.body?.sha,
  });
  if (encodeIdentity(officialIdentity) !== encodeIdentity(recordedIdentity)) {
    throw new Error(
      "Recorded retry identity does not match re-fetched official upstream facts.",
    );
  }
  const comparison = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/compare/${recordedIdentity.upstreamSha}...main`,
  );
  requireStatus(comparison, 200, "official upstream reachability");
  const retryReachable = ["ahead", "identical"].includes(
    comparison.body?.status,
  );
  return Object.freeze({
    identity: officialIdentity,
    retryIssueBody,
    retryReachable,
  });
}

async function officialPomVersion(upstreamSha, request) {
  const pomResponse = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/contents/pom.xml?ref=${upstreamSha}`,
  );
  requireStatus(pomResponse, 200, "official upstream POM");
  if (
    pomResponse.body?.encoding !== "base64" ||
    typeof pomResponse.body?.content !== "string"
  ) {
    throw new Error("Official upstream POM response is not base64 content.");
  }
  const pom = Buffer.from(
    pomResponse.body.content.replace(/\s/g, ""),
    "base64",
  ).toString("utf8");
  const metadata = /<\/parent>([\s\S]*?)<properties(?:\s|>)/.exec(pom)?.[1];
  if (!metadata) {
    throw new Error(
      "Official upstream POM does not expose the expected top-level metadata.",
    );
  }
  if (
    xmlValue(metadata, "groupId") !== "com.seed4j" ||
    xmlValue(metadata, "artifactId") !== "seed4j"
  ) {
    throw new Error(
      "Official upstream POM coordinates are not com.seed4j:seed4j.",
    );
  }
  return xmlValue(metadata, "version");
}

async function officialLicenseSha256(upstreamSha, request) {
  const licenseResponse = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/contents/LICENSE.txt?ref=${upstreamSha}`,
  );
  requireStatus(licenseResponse, 200, "official upstream license");
  if (
    licenseResponse.body?.encoding !== "base64" ||
    typeof licenseResponse.body?.content !== "string"
  ) {
    throw new Error(
      "Official upstream license response is not base64 content.",
    );
  }
  const license = Buffer.from(
    licenseResponse.body.content.replace(/\s/g, ""),
    "base64",
  );
  return createHash("sha256").update(license).digest("hex");
}

function xmlValue(fragment, element) {
  const matches = [
    ...fragment.matchAll(new RegExp(`<${element}>([^<]+)<\\/${element}>`, "g")),
  ];
  if (matches.length !== 1) {
    throw new Error(
      `Official upstream POM must contain exactly one top-level ${element}.`,
    );
  }
  return matches[0][1].trim();
}

async function officialWorkflowCheck(upstreamSha, request) {
  const response = await request(
    `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/actions/workflows/github-actions.yml/runs?event=push&head_sha=${upstreamSha}&per_page=100`,
  );
  requireStatus(response, 200, "official upstream workflow runs");
  const runs = Array.isArray(response.body?.workflow_runs)
    ? response.body.workflow_runs
    : [];
  const run = runs.find(
    (candidate) =>
      candidate.head_sha === upstreamSha && candidate.event === "push",
  );
  return run
    ? {
        conclusion: run.conclusion,
        event: run.event,
        headSha: run.head_sha,
        status: run.status,
        workflow: "github-actions.yml",
      }
    : undefined;
}

function requireUsableRecordedToken(recordedExpiry, now) {
  if (recordedExpiry === null) {
    throw new Error(
      "Central token expiry must be recorded before publication.",
    );
  }
  const expiry = new Date(`${recordedExpiry}T23:59:59Z`);
  if (new Date(now).valueOf() > expiry.valueOf()) {
    throw new Error(`Recorded Central token expired on ${recordedExpiry}.`);
  }
}

async function centralMetadata(identity, request) {
  const groupPath = identity.groupId.replaceAll(".", "/");
  const url = `${CENTRAL_ROOT}/${groupPath}/${identity.artifactId}/${identity.version}/maven-metadata.xml`;
  const response = await request(url);
  if (response.status === 404) {
    return { status: 404 };
  }
  requireStatus(response, 200, "public Central snapshot metadata");
  if (typeof response.body !== "string") {
    throw new Error("Public Central snapshot metadata is not XML text.");
  }
  return {
    lastUpdated: xmlValue(response.body, "lastUpdated"),
    status: 200,
    version: xmlValue(response.body, "version"),
  };
}

function requireStatus(response, expectedStatus, label) {
  if (response?.status !== expectedStatus) {
    throw new Error(
      `${label} request returned status '${response?.status ?? ""}'.`,
    );
  }
}

async function requestWithGitHubToken(url) {
  const headers = {
    Accept: url.startsWith(API_ROOT)
      ? "application/vnd.github+json"
      : "application/xml",
    "User-Agent": "seed4j-main-snapshot-publisher",
  };
  if (url.startsWith(API_ROOT)) {
    if (!process.env.GH_TOKEN) {
      throw new Error(
        "GH_TOKEN is required for GitHub qualification requests.",
      );
    }
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  const response = await fetch(url, { headers });
  const text = await response.text();
  let body = text;
  if (url.startsWith(API_ROOT) && text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      throw new Error(`GitHub returned non-JSON content for ${url}.`);
    }
  }
  return { body, status: response.status };
}

function parseRequest(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--config" ||
    !arguments_[1] ||
    arguments_[1].startsWith("--")
  ) {
    throw new Error(
      "Qualification requires exactly --config <publisher-config>.",
    );
  }
  return { configPath: arguments_[1] };
}

async function run() {
  const { configPath } = parseRequest(process.argv.slice(2));
  try {
    writeResult(
      await qualificationResult({
        config: readPublisherConfig(configPath),
        event: process.env.PUBLISHER_EVENT,
        now: new Date().toISOString().replace(".000Z", "Z"),
        operation: process.env.PUBLISHER_OPERATION,
        publisherRepository: process.env.GITHUB_REPOSITORY,
        ref: process.env.PUBLISHER_REF,
        request: requestWithGitHubToken,
        schedule: process.env.PUBLISHER_SCHEDULE,
      }),
    );
  } catch (error) {
    writeResult({
      outcome: "failure",
      reason: sanitizeDiagnostic(error.message),
    });
  }
}

function writeResult(result) {
  const output = {
    ...(result.identity ? { identity: encodeIdentity(result.identity) } : {}),
    outcome: result.outcome,
    reason: result.reason,
    ...(result.upstreamSha ? { "upstream-sha": result.upstreamSha } : {}),
  };
  if (!process.env.GITHUB_OUTPUT) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(output)) {
    if (String(value).includes("\n")) {
      throw new Error(`Qualification output '${key}' is not a single line.`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseRequest, qualificationResult, qualifyPublication };
