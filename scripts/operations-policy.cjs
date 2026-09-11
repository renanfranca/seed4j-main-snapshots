const {
  FAILURE_STATE_END,
  FAILURE_STATE_START,
} = require("./publisher-policy.cjs");
const FAILURE_HISTORY_START =
  "<!-- seed4j-main-snapshot-publisher-failure-history:start -->";
const FAILURE_HISTORY_END =
  "<!-- seed4j-main-snapshot-publisher-failure-history:end -->";

function failureIssueUpdate({ existingBody, failure }) {
  const history = existingBody ? existingHistory(existingBody) : [];
  history.push(historyEntry(failure));
  return Object.freeze({
    action: existingBody ? "update" : "create",
    assignees: ["renanfranca"],
    body: failureIssueBody(failure, history),
    labels: ["publisher-failure"],
    title: "[publisher] Seed4J main snapshot failure",
  });
}

function failureIssueBody(failure, history) {
  const state = {
    artifactId: failure.identity.artifactId,
    derivedVersion: failure.identity.version,
    groupId: failure.identity.groupId,
    upstreamCommitTimestamp: failure.identity.upstreamCommitTimestamp,
    upstreamPomVersion: failure.identity.upstreamPomVersion,
    upstreamSha: failure.identity.upstreamSha,
  };
  return `@renanfranca the personal Seed4J main snapshot publisher needs attention.

## Latest failure

- Stage: \`${failure.stage}\`
- Workflow run: ${failure.workflowRunUrl}
- Upstream SHA: \`${failure.identity.upstreamSha}\`
- Derived version: \`${failure.identity.version}\`
- Diagnostic: ${singleLine(failure.diagnostic)}

${FAILURE_STATE_START}
\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`
${FAILURE_STATE_END}

## Failure history

${FAILURE_HISTORY_START}
${history.join("\n")}
${FAILURE_HISTORY_END}
`;
}

function existingHistory(body) {
  const start = body.indexOf(FAILURE_HISTORY_START);
  const end = body.indexOf(FAILURE_HISTORY_END);
  if (
    start < 0 ||
    end < 0 ||
    body.lastIndexOf(FAILURE_HISTORY_START) !== start ||
    body.lastIndexOf(FAILURE_HISTORY_END) !== end
  ) {
    throw new Error(
      "Existing publisher failure issue has invalid history markers.",
    );
  }
  return body
    .slice(start + FAILURE_HISTORY_START.length, end)
    .trim()
    .split("\n")
    .filter(Boolean);
}

function historyEntry(failure) {
  return `- ${failure.failedAt} | ${failure.stage} | ${failure.workflowRunUrl} | ${singleLine(failure.diagnostic)}`;
}

function singleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function successIssueResolution({ issueNumber, identity }) {
  return Object.freeze({
    action: "close",
    comment: `Published ${identity.groupId}:${identity.artifactId}:${identity.version} from upstream ${identity.upstreamSha}; closing the publisher failure.`,
    issueNumber,
  });
}

function tokenRotationAction({ openIssueNumber, recordedExpiry, today }) {
  const expiryDate = date(recordedExpiry, "recorded token expiry");
  const todayDate = date(today, "current date");
  const daysUntilExpiry =
    (expiryDate.valueOf() - todayDate.valueOf()) / (24 * 60 * 60 * 1000);
  if (daysUntilExpiry > 30) {
    if (openIssueNumber) {
      return Object.freeze({
        action: "close",
        comment: `The recorded Central token expiry is now ${recordedExpiry}; closing the obsolete rotation warning.`,
        issueNumber: openIssueNumber,
      });
    }
    return Object.freeze({ action: "none" });
  }

  return Object.freeze({
    action: openIssueNumber ? "update" : "create",
    assignees: ["renanfranca"],
    body: `@renanfranca rotate the dedicated Central Portal publisher token before ${recordedExpiry} and update config/publisher.json with the new expiry date.`,
    labels: ["publisher-token-rotation"],
    title: `[publisher] Rotate Central token before ${recordedExpiry}`,
    ...(openIssueNumber ? { issueNumber: openIssueNumber } : {}),
  });
}

function date(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new Error(`Invalid ${label} '${value ?? ""}'.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`Invalid ${label} '${value}'.`);
  }
  return parsed;
}

function validatePublisherConfig(config) {
  const expectedKeys = [
    "centralTokenExpiresOn",
    "pilotCompleted",
    "quotaReview",
    "scheduleMode",
    "schemaVersion",
  ];
  if (
    !config ||
    Array.isArray(config) ||
    Object.keys(config).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error("Publisher config fields do not match the allowlist.");
  }
  if (
    config.schemaVersion !== 1 ||
    typeof config.pilotCompleted !== "boolean"
  ) {
    throw new Error("Publisher config schema or pilot state is invalid.");
  }
  if (config.centralTokenExpiresOn !== null) {
    date(config.centralTokenExpiresOn, "recorded token expiry");
  }
  if (config.scheduleMode === "weekly") {
    return config;
  }
  if (
    config.scheduleMode !== "daily" ||
    !config.pilotCompleted ||
    !validQuotaReview(config.quotaReview)
  ) {
    throw new Error(
      "Daily schedule requires a completed pilot and an explicit quota review at or below 80%.",
    );
  }
  return config;
}

function validQuotaReview(review) {
  if (
    !review ||
    Array.isArray(review) ||
    Object.keys(review).sort().join("\n") !==
      [
        "approvedBy",
        "monthlyReleasePercent",
        "reviewedOn",
        "storedBytesPercent",
      ]
        .sort()
        .join("\n") ||
    review.approvedBy !== "renanfranca" ||
    !validPercent(review.monthlyReleasePercent) ||
    !validPercent(review.storedBytesPercent)
  ) {
    return false;
  }
  try {
    date(review.reviewedOn, "quota review date");
    return true;
  } catch (_) {
    return false;
  }
}

function validPercent(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 80
  );
}

module.exports = {
  failureIssueUpdate,
  successIssueResolution,
  tokenRotationAction,
  validatePublisherConfig,
};
