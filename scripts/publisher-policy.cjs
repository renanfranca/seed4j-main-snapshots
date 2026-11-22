const LEGACY_ARTIFACT_ID = "seed4j-main-snapshot";
const { PARENT_ARTIFACT_ID } = require("./snapshot-layout.cjs");
const PERSONAL_GROUP_ID = "io.github.renanfranca";
const MAX_MAVEN_VERSION_LENGTH = 256;
const FAILURE_STATE_START =
  "<!-- seed4j-main-snapshot-publisher-failure-state:start -->";
const FAILURE_STATE_END =
  "<!-- seed4j-main-snapshot-publisher-failure-state:end -->";

function deriveSnapshotIdentity({
  artifactId = PARENT_ARTIFACT_ID,
  upstreamCommitTimestamp,
  upstreamLicenseSha256,
  upstreamPomVersion,
  upstreamSha,
}) {
  if (![PARENT_ARTIFACT_ID, LEGACY_ARTIFACT_ID].includes(artifactId)) {
    throw new Error("Unsupported snapshot artifact identity.");
  }
  requireUpstreamSha(upstreamSha);
  requireUpstreamTimestamp(upstreamCommitTimestamp);
  requireUpstreamLicenseSha256(upstreamLicenseSha256);
  requireUpstreamPomVersion(upstreamPomVersion);
  const timestamp = new Date(upstreamCommitTimestamp);
  const compactTimestamp = timestamp
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", ".")
    .slice(0, 15);
  const upstreamBase = upstreamPomVersion.replace(/-SNAPSHOT$/, "");
  const version = `${upstreamBase}-main.${compactTimestamp}.${upstreamSha}-SNAPSHOT`;
  if (version.length > MAX_MAVEN_VERSION_LENGTH) {
    throw new Error(
      `Derived Maven version must not exceed ${MAX_MAVEN_VERSION_LENGTH} characters.`,
    );
  }

  return Object.freeze({
    artifactId,
    groupId: PERSONAL_GROUP_ID,
    upstreamCommitTimestamp,
    upstreamLicenseSha256,
    upstreamPomVersion,
    upstreamSha,
    version,
  });
}

function encodeIdentity(identity) {
  const qualifiedIdentity = requireDerivedIdentity(identity);
  return Buffer.from(JSON.stringify(qualifiedIdentity), "utf8").toString(
    "base64url",
  );
}

function decodeIdentity(encodedIdentity) {
  if (!/^[A-Za-z0-9_-]+$/.test(encodedIdentity ?? "")) {
    throw new Error("Publisher identity is not valid base64url.");
  }
  let identity;
  try {
    const decoded = Buffer.from(encodedIdentity, "base64url");
    if (decoded.toString("base64url") !== encodedIdentity) {
      throw new Error("non-canonical base64url");
    }
    identity = JSON.parse(decoded.toString("utf8"));
  } catch (_) {
    throw new Error("Publisher identity is not valid base64url JSON.");
  }
  return requireDerivedIdentity(identity);
}

function requireDerivedIdentity(identity) {
  const expectedKeys = [
    "artifactId",
    "groupId",
    "upstreamCommitTimestamp",
    "upstreamLicenseSha256",
    "upstreamPomVersion",
    "upstreamSha",
    "version",
  ];
  if (
    !identity ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error("Publisher identity fields do not match the allowlist.");
  }
  const derived = deriveSnapshotIdentity(identity);
  if (
    identity.artifactId !== derived.artifactId ||
    identity.groupId !== derived.groupId ||
    identity.version !== derived.version
  ) {
    throw new Error(
      "Publisher identity does not match immutable upstream facts.",
    );
  }
  return derived;
}

function requireModularIdentity(identity) {
  const qualified = requireDerivedIdentity(identity);
  if (qualified.artifactId !== PARENT_ARTIFACT_ID) {
    throw new Error("Publication requires a modular snapshot.");
  }
  return qualified;
}

function qualifyCandidate({
  candidate,
  operation,
  retryIssueBody,
  retryReachable,
  upstreamCheck,
}) {
  if (operation !== "head" && operation !== "retry-last-failed") {
    throw new Error(`Unsupported publisher operation '${operation ?? ""}'.`);
  }
  const identity =
    operation === "head"
      ? deriveSnapshotIdentity(candidate)
      : retryIdentity(retryIssueBody, retryReachable);
  if (!successfulOfficialUpstreamBuild(identity.upstreamSha, upstreamCheck)) {
    return Object.freeze({
      openFailureIssue: false,
      outcome: "skip",
      reason: "official-upstream-build-not-successful",
      upstreamSha: identity.upstreamSha,
    });
  }

  return Object.freeze({ identity, outcome: "qualified" });
}

function retryIdentity(retryIssueBody, retryReachable) {
  const identity = identityFromFailureState(retryIssueBody);
  if (retryReachable !== true) {
    throw new Error(
      `Retry SHA ${identity.upstreamSha} is not reachable from official upstream.`,
    );
  }
  return identity;
}

function identityFromFailureState(retryIssueBody) {
  const state = failureState(retryIssueBody);
  const identity = deriveSnapshotIdentity({
    artifactId: state.artifactId,
    upstreamCommitTimestamp: state.upstreamCommitTimestamp,
    upstreamLicenseSha256: state.upstreamLicenseSha256,
    upstreamPomVersion: state.upstreamPomVersion,
    upstreamSha: state.upstreamSha,
  });
  if (
    state.groupId !== identity.groupId ||
    state.artifactId !== identity.artifactId ||
    state.derivedVersion !== identity.version
  ) {
    throw new Error(
      "Recorded publisher failure identity does not match re-derived upstream identity.",
    );
  }
  return identity;
}

function failureState(issueBody) {
  const body = issueBody ?? "";
  const start = body.indexOf(FAILURE_STATE_START);
  const end = body.indexOf(FAILURE_STATE_END);
  if (
    start < 0 ||
    end < 0 ||
    body.lastIndexOf(FAILURE_STATE_START) !== start ||
    body.lastIndexOf(FAILURE_STATE_END) !== end
  ) {
    throw new Error(
      "Retry requires exactly one publisher failure state markers block.",
    );
  }
  const markedContent = body
    .slice(start + FAILURE_STATE_START.length, end)
    .trim();
  const match = /^```json\n([\s\S]+)\n```$/.exec(markedContent);
  if (!match) {
    throw new Error("Retry requires valid publisher failure state markers.");
  }
  let state;
  try {
    state = JSON.parse(match[1]);
  } catch (_) {
    throw new Error("Retry requires valid publisher failure state markers.");
  }
  const expectedKeys = [
    "artifactId",
    "derivedVersion",
    "groupId",
    "upstreamCommitTimestamp",
    "upstreamLicenseSha256",
    "upstreamPomVersion",
    "upstreamSha",
  ];
  if (
    !state ||
    Array.isArray(state) ||
    Object.keys(state).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error("Retry requires valid publisher failure state markers.");
  }
  return state;
}

function successfulOfficialUpstreamBuild(upstreamSha, upstreamCheck) {
  return (
    upstreamCheck?.workflow === "github-actions.yml" &&
    upstreamCheck.headSha === upstreamSha &&
    upstreamCheck.event === "push" &&
    upstreamCheck.status === "completed" &&
    upstreamCheck.conclusion === "success"
  );
}

function retentionDecision({ now, observedSnapshot, operation }) {
  requireUpstreamTimestamp(now);
  if (observedSnapshot.status === "absent")
    return { outcome: "publish", reason: "snapshot-absent" };
  if (observedSnapshot.status === "partial") {
    return operation === "retry-last-failed"
      ? { outcome: "publish", reason: "partial-snapshot-retry" }
      : {
          outcome: "skip",
          reason: "partial-snapshot-requires-retry",
          openFailureIssue: false,
        };
  }
  if (observedSnapshot.status !== "complete")
    throw new Error("Public snapshot availability is unknown.");
  const oldest = Math.min(
    ...observedSnapshot.visible.map(({ publishedAt }) => publishedAt.valueOf()),
  );
  return retentionForPublication(oldest, now);
}

function retentionForPublication(publishedAt, now) {
  const sixtyDays = 60 * 24 * 60 * 60 * 1000;
  if (new Date(now).valueOf() - publishedAt < sixtyDays) {
    return Object.freeze({
      openFailureIssue: false,
      outcome: "skip",
      reason: "snapshot-published-within-60-days",
    });
  }

  return Object.freeze({ outcome: "publish", reason: "retention-refresh" });
}

function centralTimestamp(value) {
  if (!/^\d{14}$/.test(value ?? "")) {
    throw new Error(`Invalid Central lastUpdated timestamp '${value ?? ""}'.`);
  }
  const timestamp = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(
    10,
    12,
  )}:${value.slice(12, 14)}Z`;
  requireUpstreamTimestamp(timestamp);
  return new Date(timestamp);
}

function requireUpstreamSha(upstreamSha) {
  if (!/^[0-9a-f]{40}$/.test(upstreamSha ?? "")) {
    throw new Error(`Invalid upstream SHA '${upstreamSha ?? ""}'.`);
  }
}

function requireUpstreamTimestamp(upstreamCommitTimestamp) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
      upstreamCommitTimestamp ?? "",
    )
  ) {
    throw new Error(
      `Invalid upstream commit timestamp '${upstreamCommitTimestamp ?? ""}'.`,
    );
  }
  const parsedTimestamp = new Date(upstreamCommitTimestamp);
  if (
    Number.isNaN(parsedTimestamp.valueOf()) ||
    parsedTimestamp.toISOString().replace(".000Z", "Z") !==
      upstreamCommitTimestamp
  ) {
    throw new Error(
      `Invalid upstream commit timestamp '${upstreamCommitTimestamp}'.`,
    );
  }
}

function requireUpstreamLicenseSha256(upstreamLicenseSha256) {
  if (!/^[0-9a-f]{64}$/.test(upstreamLicenseSha256 ?? "")) {
    throw new Error(
      `Invalid upstream license SHA-256 '${upstreamLicenseSha256 ?? ""}'.`,
    );
  }
}

function requireUpstreamPomVersion(upstreamPomVersion) {
  const mavenVersion =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
  const snapshotCount = (upstreamPomVersion?.match(/SNAPSHOT/g) ?? []).length;
  if (!mavenVersion.test(upstreamPomVersion ?? "") || snapshotCount > 1) {
    throw new Error(
      `Invalid upstream POM version '${upstreamPomVersion ?? ""}'.`,
    );
  }
}

module.exports = {
  FAILURE_STATE_END,
  FAILURE_STATE_START,
  PARENT_ARTIFACT_ID,
  centralTimestamp,
  decodeIdentity,
  deriveSnapshotIdentity,
  encodeIdentity,
  identityFromFailureState,
  qualifyCandidate,
  requireDerivedIdentity,
  requireModularIdentity,
  retentionDecision,
};
