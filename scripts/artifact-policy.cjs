const { createHash } = require("node:crypto");
const {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const {
  notice,
  personalPomMetadata,
  provenance,
} = require("./prepare-upstream.cjs");
const {
  deriveSnapshotIdentity,
  encodeIdentity,
  requireDerivedIdentity,
} = require("./publisher-policy.cjs");
const { readZipEntry } = require("./zip-policy.cjs");

const CENTRAL_SNAPSHOT_REPOSITORY =
  "https://central.sonatype.com/repository/maven-snapshots/";

function collectCandidate({ checkoutDirectory, identity, outputDirectory }) {
  mkdirSync(outputDirectory);
  const prefix = `${identity.artifactId}-${identity.version}`;
  copyFileSync(
    join(checkoutDirectory, "pom.xml"),
    join(outputDirectory, `${prefix}.pom`),
  );
  copyFileSync(
    join(checkoutDirectory, "target", `${prefix}.jar`),
    join(outputDirectory, `${prefix}.jar`),
  );
  copyFileSync(
    join(checkoutDirectory, "target", `${prefix}-tests.jar`),
    join(outputDirectory, `${prefix}-tests.jar`),
  );
  const manifest = createCandidateManifest({
    candidateDirectory: outputDirectory,
    identity,
  });
  writeFileSync(
    join(outputDirectory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function createCandidateManifest({ candidateDirectory, identity }) {
  const expectedArtifacts = artifactDefinitions(identity);
  requireExactArtifactSet(candidateDirectory, expectedArtifacts);
  const artifacts = expectedArtifacts.map(({ fileName, role }) => {
    const path = join(candidateDirectory, fileName);
    const content = readFileSync(path);
    return Object.freeze({
      fileName,
      role,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: statSync(path).size,
    });
  });

  return Object.freeze({
    artifacts,
    publication: Object.freeze({
      artifactId: identity.artifactId,
      groupId: identity.groupId,
      repositoryUrl: CENTRAL_SNAPSHOT_REPOSITORY,
      version: identity.version,
    }),
    schemaVersion: 1,
    upstream: Object.freeze({
      commitTimestamp: identity.upstreamCommitTimestamp,
      licenseSha256: identity.upstreamLicenseSha256,
      pomVersion: identity.upstreamPomVersion,
      sha: identity.upstreamSha,
    }),
  });
}

function requireExactArtifactSet(candidateDirectory, expectedArtifacts) {
  const expectedFileNames = new Set(
    expectedArtifacts.map((artifact) => artifact.fileName),
  );
  const actualFileNames = readdirSync(candidateDirectory).sort();
  const unexpected = actualFileNames.filter(
    (fileName) => !expectedFileNames.has(fileName),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected candidate artifacts: ${unexpected.join(", ")}`);
  }
  const missing = [...expectedFileNames].filter(
    (fileName) => !actualFileNames.includes(fileName),
  );
  if (missing.length > 0) {
    throw new Error(`Missing candidate artifacts: ${missing.join(", ")}`);
  }
}

function artifactDefinitions(identity) {
  const prefix = `${identity.artifactId}-${identity.version}`;
  return [
    { fileName: `${prefix}.pom`, role: "pom" },
    { fileName: `${prefix}.jar`, role: "main" },
    { fileName: `${prefix}-tests.jar`, role: "tests" },
  ];
}

function verifyCandidateBundle(bundleDirectory, expectedIdentity) {
  const trustedIdentity = requireDerivedIdentity(expectedIdentity);
  requireRegularFile(join(bundleDirectory, "candidate-manifest.json"));
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(bundleDirectory, "candidate-manifest.json"), "utf8"),
    );
  } catch (_) {
    throw new Error("Candidate manifest is missing or is not valid JSON.");
  }
  const identity = requireValidManifest(manifest);
  if (encodeIdentity(identity) !== encodeIdentity(trustedIdentity)) {
    throw new Error(
      "Candidate manifest does not match the trusted qualified identity.",
    );
  }
  requirePublicationPom({ bundleDirectory, identity, manifest });
  const expectedFileNames = new Set([
    "candidate-manifest.json",
    ...manifest.artifacts.map((artifact) => artifact.fileName),
  ]);
  const actualFileNames = readdirSync(bundleDirectory).sort();
  const unexpected = actualFileNames.filter(
    (fileName) => !expectedFileNames.has(fileName),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unexpected bundle files: ${unexpected.join(", ")}`);
  }
  const missing = [...expectedFileNames].filter(
    (fileName) => !actualFileNames.includes(fileName),
  );
  if (missing.length > 0) {
    throw new Error(`Missing bundle files: ${missing.join(", ")}`);
  }
  for (const artifact of manifest.artifacts) {
    const path = join(bundleDirectory, artifact.fileName);
    requireRegularFile(path);
    const content = readFileSync(path);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== artifact.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${artifact.role} artifact '${artifact.fileName}'.`,
      );
    }
    if (statSync(path).size !== artifact.size) {
      throw new Error(
        `Size mismatch for ${artifact.role} artifact '${artifact.fileName}'.`,
      );
    }
  }
  requireEmbeddedPublicationMetadata({ bundleDirectory, identity, manifest });
  return manifest;
}

function requireRegularFile(path) {
  let regularFile = false;
  try {
    regularFile = lstatSync(path).isFile();
  } catch (_) {
    throw new Error(
      `Candidate bundle entry '${path}' is missing or is not a regular file.`,
    );
  }
  if (!regularFile) {
    throw new Error(`Candidate bundle entry '${path}' is not a regular file.`);
  }
}

function requireValidManifest(manifest) {
  requireKeys(
    manifest,
    ["artifacts", "publication", "schemaVersion", "upstream"],
    "manifest",
  );
  if (manifest.schemaVersion !== 1) {
    throw new Error(
      `Candidate manifest schema version '${manifest.schemaVersion}' is not supported.`,
    );
  }
  requireKeys(
    manifest.publication,
    ["artifactId", "groupId", "repositoryUrl", "version"],
    "manifest publication",
  );
  requireKeys(
    manifest.upstream,
    ["commitTimestamp", "licenseSha256", "pomVersion", "sha"],
    "manifest upstream",
  );
  const identity = deriveSnapshotIdentity({
    upstreamCommitTimestamp: manifest.upstream.commitTimestamp,
    upstreamLicenseSha256: manifest.upstream.licenseSha256,
    upstreamPomVersion: manifest.upstream.pomVersion,
    upstreamSha: manifest.upstream.sha,
  });
  if (
    manifest.publication.groupId !== identity.groupId ||
    manifest.publication.artifactId !== identity.artifactId ||
    manifest.publication.version !== identity.version ||
    manifest.publication.repositoryUrl !== CENTRAL_SNAPSHOT_REPOSITORY
  ) {
    throw new Error(
      "Candidate manifest publication identity is outside the personal snapshot allowlist.",
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 3) {
    throw new Error("Candidate manifest must declare exactly three artifacts.");
  }
  const expectedArtifacts = artifactDefinitions(identity);
  for (let index = 0; index < expectedArtifacts.length; index++) {
    const artifact = manifest.artifacts[index];
    requireKeys(
      artifact,
      ["fileName", "role", "sha256", "size"],
      `manifest artifact ${index}`,
    );
    if (
      artifact.fileName !== expectedArtifacts[index].fileName ||
      artifact.role !== expectedArtifacts[index].role
    ) {
      throw new Error(
        `Candidate manifest artifact ${index} is outside the filename and classifier allowlist.`,
      );
    }
    if (
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 0 ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")
    ) {
      throw new Error(
        `Candidate manifest artifact ${index} has invalid integrity fields.`,
      );
    }
  }
  return identity;
}

function requirePublicationPom({ bundleDirectory, identity, manifest }) {
  const pomArtifact = manifest.artifacts.find(
    (artifact) => artifact.role === "pom",
  );
  const pomPath = join(bundleDirectory, pomArtifact.fileName);
  requireRegularFile(pomPath);
  const pom = readFileSync(pomPath, "utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(pom)) {
    throw new Error(
      "Candidate published POM must not contain a document type or entity declaration.",
    );
  }
  const metadata = /<\/parent>\s*([\s\S]*?)<properties(?:\s|>)/.exec(pom)?.[1];
  if (!metadata || metadata.trim() !== personalPomMetadata(identity).trim()) {
    throw new Error(
      "Candidate published POM nonofficial publication metadata does not match the trusted policy.",
    );
  }
}

function requireEmbeddedPublicationMetadata({
  bundleDirectory,
  identity,
  manifest,
}) {
  const mainArtifact = manifest.artifacts.find(
    (artifact) => artifact.role === "main",
  );
  const mainJar = join(bundleDirectory, mainArtifact.fileName);
  let embeddedProvenance;
  try {
    embeddedProvenance = readZipEntry(
      mainJar,
      "META-INF/seed4j-main-snapshot.properties",
    );
  } catch (error) {
    throw new Error(
      `Main JAR embedded provenance is invalid: ${error.message}`,
    );
  }
  if (embeddedProvenance.toString("utf8") !== provenance(identity)) {
    throw new Error(
      "Main JAR embedded provenance does not match the trusted qualified identity.",
    );
  }
  let embeddedLicense;
  let embeddedNotice;
  try {
    embeddedLicense = readZipEntry(
      mainJar,
      "META-INF/LICENSE-seed4j-main-snapshot.txt",
    );
    embeddedNotice = readZipEntry(
      mainJar,
      "META-INF/NOTICE-seed4j-main-snapshot.txt",
    );
  } catch (error) {
    throw new Error(
      `Main JAR embedded legal metadata is invalid: ${error.message}`,
    );
  }
  if (
    createHash("sha256").update(embeddedLicense).digest("hex") !==
      identity.upstreamLicenseSha256 ||
    embeddedNotice.toString("utf8") !== notice(identity)
  ) {
    throw new Error(
      "Main JAR embedded legal metadata does not match the trusted qualified facts.",
    );
  }
}

function requireKeys(value, expectedKeys, label) {
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...expectedKeys].sort().join("\n")
  ) {
    throw new Error(`Candidate ${label} fields do not match the allowlist.`);
  }
}

module.exports = {
  collectCandidate,
  createCandidateManifest,
  verifyCandidateBundle,
};
