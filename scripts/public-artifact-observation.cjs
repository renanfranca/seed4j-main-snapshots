const { child, elements, value, xmlRoot } = require("./maven-xml.cjs");
const { centralTimestamp } = require("./publisher-policy.cjs");
const {
  artifactDefinitions,
  CENTRAL_REPOSITORY,
  JAR_MODULES,
  PARENT_ARTIFACT_ID,
} = require("./snapshot-layout.cjs");
async function inspectPublicArtifacts(identity, publicRequest) {
  return observePublicSnapshot(identity, publicRequest, {
    tolerateErrors: true,
  });
}

function snapshotMetadataUrl(identity, artifactId = identity.artifactId) {
  const group = identity.groupId.replaceAll(".", "/");
  return `${CENTRAL_REPOSITORY}${group}/${artifactId}/${identity.version}/maven-metadata.xml`;
}

async function observePublicSnapshot(
  identity,
  request,
  { requireStatus = requirePublicStatus, tolerateErrors = false } = {},
) {
  const visible = [];
  let metadataPresent = false;
  let uncertain = false;
  const definitions = artifactDefinitions(identity);
  for (const artifactId of [PARENT_ARTIFACT_ID, ...JAR_MODULES]) {
    try {
      const url = snapshotMetadataUrl(identity, artifactId);
      const response = await request(url, "GET");
      if (response.status === 404) continue;
      requireStatus(response, 200, "public Central snapshot metadata");
      metadataPresent = true;
      const metadata = xmlRoot(response.body, "metadata");
      if (
        value(metadata, "groupId") !== identity.groupId ||
        value(metadata, "artifactId") !== artifactId ||
        value(metadata, "version") !== identity.version
      )
        throw new Error(
          `Public Central metadata coordinates do not match ${artifactId}.`,
        );
      const versions = elements(
        child(child(metadata, "versioning"), "snapshotVersions"),
        "snapshotVersion",
      );
      for (const { extension } of definitions.filter(
        (artifact) => artifact.artifactId === artifactId,
      )) {
        try {
          const matching = versions.filter(
            (entry) =>
              value(entry, "extension") === extension &&
              !value(entry, "classifier"),
          );
          if (matching.length === 0) continue;
          const version = value(matching[0], "value");
          const prefix = identity.version.slice(0, -"SNAPSHOT".length);
          if (
            matching.length !== 1 ||
            !version?.startsWith(prefix) ||
            !/^\d{8}\.\d{6}-[1-9]\d*$/.test(version.slice(prefix.length))
          )
            throw new Error(
              `Invalid public Central snapshot entry for ${artifactId}.${extension}.`,
            );
          const artifactUrl = new URL(
            `${artifactId}-${version}.${extension}`,
            url,
          ).href;
          const file = await request(artifactUrl, "HEAD");
          if (file.status === 404) continue;
          requireStatus(file, 200, "public Central snapshot file");
          const publishedAt = centralTimestamp(value(matching[0], "updated"));
          visible.push({ artifactId, extension, publishedAt });
        } catch (error) {
          if (!tolerateErrors) throw error;
          uncertain = true;
        }
      }
    } catch (error) {
      if (!tolerateErrors) throw error;
      uncertain = true;
    }
  }
  const status = uncertain
    ? "unknown"
    : visible.length === definitions.length
      ? "complete"
      : metadataPresent
        ? "partial"
        : "absent";
  return {
    status,
    visible,
    summary: `Public files ${visible.length}/${definitions.length}: ${visible.map(({ artifactId, extension }) => `${artifactId}.${extension}`).join(", ") || "none confirmed"}${uncertain ? " (check incomplete)" : ""}`,
    evidence: snapshotMetadataUrl(identity),
  };
}

function requirePublicStatus(response, expected, label) {
  if (response?.status !== expected) {
    throw new Error(`${label} returned HTTP ${response?.status}.`);
  }
}

async function fetchPublic(url, method) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    headers: { "User-Agent": "seed4j-main-snapshot-publisher" },
    signal: AbortSignal.timeout(10_000),
  });
  return {
    status: response.status,
    body:
      method === "GET"
        ? (await response.text()).slice(0, 64 * 1024)
        : undefined,
  };
}

module.exports = {
  inspectPublicArtifacts,
  fetchPublic,
  observePublicSnapshot,
  snapshotMetadataUrl,
};
