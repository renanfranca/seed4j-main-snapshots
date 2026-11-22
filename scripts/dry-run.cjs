const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} = require("node:fs");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createCandidateManifest } = require("./artifact-policy.cjs");
const { buildDeploymentPlan } = require("./deploy-candidate.cjs");
const {
  notice,
  personalPomMetadata,
  provenance,
} = require("./prepare-upstream.cjs");
const {
  deriveSnapshotIdentity,
  encodeIdentity,
} = require("./publisher-policy.cjs");
const {
  artifactDefinitions,
  PARENT_ARTIFACT_ID,
} = require("./snapshot-layout.cjs");
const { createStoredZip } = require("./zip-policy.cjs");

const dryRunRoot = mkdtempSync(
  join(tmpdir(), "seed4j-main-snapshots-dry-run-"),
);
const evidenceDirectory = join(dryRunRoot, "candidate");
const settingsPath = join(dryRunRoot, "central-settings.xml");
const license = "upstream Apache license\n";
const identity = deriveSnapshotIdentity({
  artifactId: PARENT_ARTIFACT_ID,
  upstreamCommitTimestamp: "2026-11-21T21:55:24Z",
  upstreamLicenseSha256: createHash("sha256").update(license).digest("hex"),
  upstreamPomVersion: "2.4.1-SNAPSHOT",
  upstreamSha: "7805dd517f11234e958cfc638f75d3bd8fc47260",
});

mkdirSync(evidenceDirectory);
for (const { artifactId, extension, fileName } of artifactDefinitions(
  identity,
)) {
  const content =
    extension === "pom"
      ? dryRunPom(artifactId)
      : createStoredZip({
          "META-INF/LICENSE-seed4j-main-snapshot.txt": license,
          "META-INF/NOTICE-seed4j-main-snapshot.txt": notice(identity),
          "META-INF/seed4j-main-snapshot.properties": provenance(
            identity,
            artifactId,
          ),
        });
  writeFileSync(join(evidenceDirectory, fileName), content);
}
const manifest = createCandidateManifest({
  candidateDirectory: evidenceDirectory,
  identity,
});
writeFileSync(
  join(evidenceDirectory, "candidate-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const deploymentPlan = buildDeploymentPlan({
  bundleDirectory: evidenceDirectory,
  encodedIdentity: encodeIdentity(identity),
  settingsPath,
});
if (existsSync(settingsPath))
  throw new Error("Dry run unexpectedly created Maven settings.");
console.log(
  JSON.stringify({ deploymentPlan, evidenceDirectory, manifest }, null, 2),
);

function dryRunPom(artifactId) {
  const fields =
    artifactId === PARENT_ARTIFACT_ID
      ? personalPomMetadata(identity)
      : `<parent><groupId>${identity.groupId}</groupId><artifactId>${PARENT_ARTIFACT_ID}</artifactId><version>${identity.version}</version></parent><artifactId>${artifactId}</artifactId>`;
  return `<project><modelVersion>4.0.0</modelVersion>${fields}</project>\n`;
}
