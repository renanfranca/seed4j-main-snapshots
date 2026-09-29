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
  canonicalPublisherTimestamp,
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
  cycleIssueNumber,
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
  let upstreamSha;
  let criteria = unevaluatedCriteria();
  let pending = {
    name: "Qualification",
    evidence: "Official candidate provenance",
  };
  try {
    if (operation === "head") {
      pending = {
        name: "Official main SHA",
        evidence: "https://github.com/seed4j/seed4j/commits/main",
      };
      const commitResponse = await request(
        `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/commits/main`,
      );
      requireStatus(commitResponse, 200, "official main commit");
      if (!/^[0-9a-f]{40}$/.test(commitResponse.body?.sha ?? ""))
        throw new Error("Invalid official main SHA.");
      upstreamSha = commitResponse.body.sha;
      criteria = observeCriterion(
        criteria,
        pending.name,
        "Accepted",
        upstreamSha,
        `https://github.com/seed4j/seed4j/commit/${upstreamSha}`,
      );
      pending = {
        name: "Qualification",
        evidence: `https://github.com/seed4j/seed4j/commit/${upstreamSha}`,
      };
      resolved = await resolveHeadCandidate(commitResponse, request);
    } else {
      resolved = await resolveRetryCandidate({ publisherRepository, request });
    }
    const commitUrl = `https://github.com/seed4j/seed4j/commit/${resolved.identity.upstreamSha}`;
    criteria = observeCriterion(
      criteria,
      "Qualification",
      "Accepted",
      "Official candidate identity resolved",
      commitUrl,
    );
    criteria = observeCriterion(
      criteria,
      "Official main SHA",
      "Accepted",
      resolved.identity.upstreamSha,
      commitUrl,
    );
    if (cycleIssueNumber) {
      pending = { name: "Central token", evidence: "config/publisher.json" };
      requireUsableRecordedToken(
        validatedConfig.centralTokenExpiresOn,
        canonicalPublisherTimestamp(now),
      );
      criteria = observeCriterion(
        criteria,
        pending.name,
        "Accepted",
        "Recorded expiry is valid",
        pending.evidence,
      );
    }
    pending = {
      name: "Exact-SHA official CI",
      evidence:
        "https://github.com/seed4j/seed4j/actions/workflows/github-actions.yml",
    };
    const upstreamCheck = await officialWorkflowCheck(
      resolved.identity.upstreamSha,
      request,
    );
    const qualification = qualifyCandidate({
      candidate: resolved.identity,
      operation,
      retryIssueBody: resolved.retryIssueBody,
      retryReachable: resolved.retryReachable,
      upstreamCheck,
    });
    if (qualification.outcome === "skip") {
      if (cycleIssueNumber && operation === "head") {
        return await cycleRetryResult(
          resolved.identity,
          upstreamCheck,
          now,
          request,
          criteria,
        );
      }
      return qualification;
    }
    criteria = observeCriterion(
      criteria,
      pending.name,
      "Accepted",
      "Completed successfully for exact SHA",
      upstreamCheck?.url ?? pending.evidence,
    );
    pending = { name: "Central token", evidence: "config/publisher.json" };
    const publisherTimestamp = canonicalPublisherTimestamp(now);
    requireUsableRecordedToken(
      validatedConfig.centralTokenExpiresOn,
      publisherTimestamp,
    );
    criteria = observeCriterion(
      criteria,
      pending.name,
      "Accepted",
      "Recorded expiry is valid",
      pending.evidence,
    );
    pending = {
      name: "Retention",
      evidence: centralMetadataUrl(resolved.identity),
    };
    const retention = retentionDecision({
      centralMetadata: await centralMetadata(resolved.identity, request),
      identity: resolved.identity,
      now: publisherTimestamp,
    });
    criteria = observeCriterion(
      criteria,
      pending.name,
      retention.outcome === "publish" ? "Accepted" : "Rejected",
      retention.reason,
      pending.evidence,
    );
    return Object.freeze({
      ...(retention.outcome === "publish"
        ? { identity: resolved.identity }
        : {}),
      ...retention,
      upstreamSha: resolved.identity.upstreamSha,
      ...(cycleIssueNumber
        ? {
            assessment: { criteria },
          }
        : {}),
    });
  } catch (error) {
    if (resolved?.identity) {
      error.identity = resolved.identity;
    }
    error.upstreamSha = upstreamSha ?? resolved?.identity.upstreamSha;
    error.assessment = {
      criteria: observeCriterion(
        criteria,
        pending.name,
        "Rejected",
        `${sanitizeExternalText(error.message)}${pending.name === "Retention" ? "; retention eligibility remains unknown" : ""}`,
        pending.evidence,
      ),
    };
    throw error;
  }
}

async function qualificationResult(invocation) {
  try {
    return await qualifyPublication(invocation);
  } catch (error) {
    const retry = invocation.cycleIssueNumber && retryableExternalError(error);
    const assessment = error.assessment ?? {
      criteria: observeCriterion(
        unevaluatedCriteria(),
        "Qualification",
        "Rejected",
        sanitizeExternalText(error.message),
        "Publisher qualification run",
      ),
    };
    return Object.freeze({
      ...(!retry && error.identity ? { identity: error.identity } : {}),
      outcome: retry ? "retry" : "failure",
      reason: sanitizeDiagnostic(error.message),
      ...(error.upstreamSha ? { upstreamSha: error.upstreamSha } : {}),
      ...(invocation.cycleIssueNumber
        ? {
            assessment: {
              ...assessment,
              ...(retry
                ? {
                    nextCheck: nextCheck(
                      invocation.now,
                      error.retryAt,
                      error.retryDelayMs,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    });
  }
}

function unevaluatedCriteria() {
  return [
    "Qualification",
    "Official main SHA",
    "Exact-SHA official CI",
    "Central token",
    "Retention",
  ].map((name) => ({
    name,
    status: "Not evaluated",
    observed: "Not reached",
    evidence: "No evaluation performed",
  }));
}

function observeCriterion(criteria, name, status, observed, evidence) {
  return criteria.map((criterion) =>
    criterion.name === name ? { name, status, observed, evidence } : criterion,
  );
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
    ![WEEKLY_SCHEDULE, DAILY_SCHEDULE, "41 * * * *"].includes(schedule)
  ) {
    throw new Error(`Unsupported publisher schedule '${schedule ?? ""}'.`);
  }
}

function scheduledPublicationDecision({ config, event, schedule }) {
  if (event !== "schedule") {
    return undefined;
  }
  if (schedule === "41 * * * *") {
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

async function resolveHeadCandidate(commitResponse, request) {
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
  if (!Array.isArray(response.body?.workflow_runs))
    throw new Error("Invalid official workflow runs response.");
  const runs = response.body.workflow_runs;
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
        ...(run.id ? { id: run.id } : {}),
        ...(run.html_url ? { url: run.html_url } : {}),
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

function centralMetadataUrl(identity) {
  const groupPath = identity.groupId.replaceAll(".", "/");
  return `${CENTRAL_ROOT}/${groupPath}/${identity.artifactId}/${identity.version}/maven-metadata.xml`;
}

async function centralMetadata(identity, request) {
  const response = await request(centralMetadataUrl(identity));
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
    const error = new Error(
      `${label} request returned status '${response?.status ?? ""}'.`,
    );
    error.retryable =
      response?.status === 429 ||
      response?.status >= 500 ||
      (response?.status === 403 &&
        (response.headers?.get?.("x-ratelimit-remaining") === "0" ||
          response.headers?.get?.("retry-after")));
    const retryAfter = response?.headers?.get?.("retry-after");
    const reset = response?.headers?.get?.("x-ratelimit-reset");
    if (retryAfter && /^\d+$/.test(retryAfter))
      error.retryDelayMs = Number(retryAfter) * 1000;
    else if (retryAfter && !Number.isNaN(Date.parse(retryAfter)))
      error.retryAt = new Date(retryAfter).toISOString();
    else if (reset && /^\d+$/.test(reset))
      error.retryAt = new Date(Number(reset) * 1000).toISOString();
    throw error;
  }
}

function retryableExternalError(error) {
  return error.retryable === true;
}

function nextCheck(now, retryAt, retryDelayMs = 0) {
  const hourly = Date.parse(now) + 60 * 60 * 1000;
  return new Date(
    Math.max(hourly, Date.parse(retryAt) || 0, Date.parse(now) + retryDelayMs),
  )
    .toISOString()
    .replace(".000Z", "Z");
}

async function cycleRetryResult(identity, check, now, request, criteria) {
  const state = !check
    ? "Missing official run"
    : check.status !== "completed"
      ? "Official run in progress"
      : check.conclusion === "cancelled"
        ? "Official run cancelled"
        : "Official run failed";
  const diagnostic =
    state === "Official run failed"
      ? await officialFailureEvidence(check, request)
      : undefined;
  const observed = diagnostic ? `${state}: ${diagnostic.summary}` : state;
  return Object.freeze({
    outcome: "retry",
    reason: observed,
    upstreamSha: identity.upstreamSha,
    assessment: {
      criteria: observeCriterion(
        criteria,
        "Exact-SHA official CI",
        "Rejected",
        sanitizeExternalText(observed),
        diagnostic?.url ??
          check?.url ??
          "https://github.com/seed4j/seed4j/actions/workflows/github-actions.yml",
      ),
      nextCheck: nextCheck(now),
      ...(diagnostic?.diagnostics
        ? { diagnostics: diagnostic.diagnostics }
        : {}),
    },
  });
}

async function officialFailureEvidence(check, request) {
  if (!Number.isInteger(check.id)) return undefined;
  try {
    const response = await request(
      `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/actions/runs/${check.id}/jobs?per_page=100`,
    );
    requireStatus(response, 200, "official CI jobs");
    if (!Array.isArray(response.body?.jobs))
      return { summary: "cause unknown; invalid job response", url: check.url };
    const jobs = response.body.jobs.filter(
      (candidate) => candidate.conclusion === "failure",
    );
    if (jobs.length === 0)
      return {
        summary: "cause unknown; no failed job was returned",
        url: check.url,
      };
    const diagnostics = [];
    for (const job of jobs.slice(0, 5)) {
      const step =
        job.steps?.find((candidate) => candidate.conclusion === "failure")
          ?.name ?? "unknown step";
      let excerpt = "cause unknown; no relevant log excerpt available";
      if (Number.isInteger(job.id)) {
        try {
          const logs = await request(
            `${API_ROOT}/repos/${OFFICIAL_REPOSITORY}/actions/jobs/${job.id}/logs`,
          );
          if (logs.status === 200 && typeof logs.body === "string") {
            excerpt = `${logs.logReadComplete === false ? "Incomplete log read; analysis limited to received tail; " : ""}${relevantLogExcerpt(logs.body)}`;
          } else {
            excerpt = "cause unknown; job logs unavailable";
          }
        } catch (_) {
          excerpt = "cause unknown; job logs unavailable";
        }
      }
      diagnostics.push({
        summary: sanitizeExternalText(
          `${job.name ?? "unknown job"} / ${step}: ${excerpt}`,
        ),
        url: job.html_url ?? check.url,
      });
    }
    return {
      summary:
        jobs.length > 1
          ? `${jobs.length} failed jobs${jobs.length > 5 ? "; showing first 5" : ""}; ${diagnostics[0].summary}`
          : diagnostics[0].summary,
      url: jobs.length > 1 ? check.url : diagnostics[0].url,
      diagnostics,
    };
  } catch (_) {
    return {
      summary: "cause unknown; job diagnostics unavailable",
      url: check.url,
    };
  }
}

function relevantLogExcerpt(log) {
  const lines = String(log).split(/\r?\n/);
  const codes = /\b(ENOSPC|EACCES|ENOENT|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/;
  const generic =
    /process completed with exit code|command .*exited with (?:code|status)|process failed without a diagnostic code/i;
  const line =
    lines.findLast((value) => codes.test(value)) ??
    lines.findLast(
      (value) =>
        /\b(error|failed|failure|fatal|exception)\b/i.test(value) &&
        !generic.test(value),
    ) ??
    lines.findLast((value) => generic.test(value));
  if (!line) return "cause unknown; no error line found";
  const code = /\b(ENOSPC|EACCES|ENOENT|ETIMEDOUT|ECONNRESET|EAI_AGAIN)\b/.exec(
    line,
  )?.[1];
  const confirmed =
    code === "ENOSPC" && /no space left on device/i.test(line)
      ? "Confirmed cause: storage exhausted (ENOSPC)"
      : code === "EACCES" && /permission denied/i.test(line)
        ? "Confirmed cause: access denied (EACCES)"
        : code === "ENOENT" && /no such file or directory/i.test(line)
          ? "Confirmed cause: missing file (ENOENT)"
          : undefined;
  return `${confirmed ?? `Cause unknown${code ? `; observed error code ${code}` : ""}`}; ${sanitizeExternalText(line)}`;
}

function sanitizeExternalText(value) {
  return sanitizeDiagnostic(value).replace(/https?:\/\//gi, "https[:]//");
}

async function requestWithGitHubToken(url) {
  const logRequest = /\/actions\/jobs\/\d+\/logs$/.test(url);
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
  let response = await fetchExternal(url, {
    headers,
    redirect: logRequest ? "manual" : "follow",
  });
  if (logRequest && response.status === 302) {
    const location = response.headers.get("location");
    if (!location || !location.startsWith("https://"))
      throw new Error("Official job logs redirect is invalid.");
    response = await fetchExternal(location, {
      headers: { "User-Agent": "seed4j-main-snapshot-publisher" },
    });
  }
  const log = logRequest
    ? await boundedResponseText(response, 64 * 1024)
    : undefined;
  const text = log ? log.text : await response.text();
  let body = text;
  if (url.startsWith(API_ROOT) && text && !logRequest) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      throw new Error(`GitHub returned non-JSON content for ${url}.`);
    }
  }
  return {
    body,
    status: response.status,
    headers: response.headers,
    ...(log ? { logReadComplete: log.complete } : {}),
  };
}

async function fetchExternal(url, options) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    const error = new Error("External network request failed or timed out.");
    error.retryable = true;
    throw error;
  }
}

async function boundedResponseText(response, limit) {
  if (!response.body) return { text: "", complete: false };
  const reader = response.body.getReader();
  const tail = Buffer.alloc(limit);
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        break;
      }
      const chunk = part.value;
      if (chunk.length >= limit) {
        tail.set(chunk.subarray(chunk.length - limit));
        length = limit;
      } else {
        const retained = Math.min(length, limit - chunk.length);
        tail.copyWithin(0, length - retained, length);
        tail.set(chunk, retained);
        length = retained + chunk.length;
      }
    }
  } catch (_) {
    complete = false;
  } finally {
    try {
      await reader.cancel();
    } catch (_) {
      complete = false;
    } finally {
      reader.releaseLock();
    }
  }
  return { text: tail.subarray(0, length).toString("utf8"), complete };
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
        cycleIssueNumber: process.env.PUBLISHER_CYCLE_ISSUE
          ? Number(process.env.PUBLISHER_CYCLE_ISSUE)
          : undefined,
        event: process.env.PUBLISHER_EVENT,
        now: new Date().toISOString(),
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
    ...(result.assessment
      ? {
          assessment: Buffer.from(JSON.stringify(result.assessment)).toString(
            "base64url",
          ),
        }
      : {}),
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
