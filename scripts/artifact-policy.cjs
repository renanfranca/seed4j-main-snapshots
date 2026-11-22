const { createHash } = require("node:crypto");
const {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { child, value, xmlRoot } = require("./maven-xml.cjs");
const { notice, provenance } = require("./prepare-upstream.cjs");
const {
  artifactDefinitions,
  CENTRAL_REPOSITORY,
  JAR_MODULES,
  PARENT_ARTIFACT_ID,
} = require("./snapshot-layout.cjs");
const { requireModularIdentity } = require("./publisher-policy.cjs");
const { readZipEntry } = require("./zip-policy.cjs");

const MANIFEST_FILE = "candidate-manifest.json";

function collectCandidate({ checkoutDirectory, identity, outputDirectory }) {
  requireModularIdentity(identity);
  mkdirSync(outputDirectory);
  for (const { artifactId, extension, fileName } of artifactDefinitions(
    identity,
  )) {
    const module =
      artifactId === PARENT_ARTIFACT_ID
        ? checkoutDirectory
        : join(checkoutDirectory, artifactId);
    const source =
      extension === "pom"
        ? join(module, "pom.xml")
        : join(module, "target", fileName);
    copyFileSync(source, join(outputDirectory, fileName));
  }
  const manifest = createCandidateManifest({
    candidateDirectory: outputDirectory,
    identity,
  });
  writeFileSync(
    join(outputDirectory, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return verifyCandidateBundle(outputDirectory, identity);
}

function createCandidateManifest({ candidateDirectory: directory, identity }) {
  requireModularIdentity(identity);
  requireExactBundle(
    directory,
    artifactDefinitions(identity).map(({ fileName }) => fileName),
  );
  return manifestFromFiles(directory, identity);
}

function verifyCandidateBundle(directory, identity) {
  requireModularIdentity(identity);
  const definitions = artifactDefinitions(identity);
  requireExactBundle(directory, [
    MANIFEST_FILE,
    ...definitions.map(({ fileName }) => fileName),
  ]);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, MANIFEST_FILE), "utf8"));
  } catch {
    throw new Error("Candidate manifest is not valid JSON.");
  }
  if (!isDeepStrictEqual(manifest, manifestFromFiles(directory, identity))) {
    throw new Error(
      "Candidate manifest does not match the trusted coordinates and integrity of exactly five POMs and four JARs.",
    );
  }
  for (const artifact of definitions) {
    if (artifact.extension === "pom")
      requireReactorPom(directory, identity, artifact);
    else requireReactorJar(directory, identity, artifact);
  }
  return manifest;
}

function requireExactBundle(directory, expectedFiles) {
  const actual = readdirSync(directory);
  const extra = actual.filter((name) => !expectedFiles.includes(name));
  const missing = expectedFiles.filter((name) => !actual.includes(name));
  if (extra.length)
    throw new Error(`Unexpected bundle files: ${extra.join(", ")}.`);
  if (missing.length)
    throw new Error(`Missing bundle files: ${missing.join(", ")}.`);
  for (const name of expectedFiles) {
    if (!lstatSync(join(directory, name)).isFile()) {
      throw new Error(
        `Candidate bundle entry '${name}' is not a regular file.`,
      );
    }
  }
}

function manifestFromFiles(directory, identity) {
  return {
    artifacts: artifactDefinitions(identity).map((artifact) => {
      const data = readFileSync(join(directory, artifact.fileName));
      return { ...artifact, sha256: hash(data), size: data.length };
    }),
    publication: {
      groupId: identity.groupId,
      repositoryUrl: CENTRAL_REPOSITORY,
      version: identity.version,
    },
    schemaVersion: 2,
    upstream: {
      commitTimestamp: identity.upstreamCommitTimestamp,
      licenseSha256: identity.upstreamLicenseSha256,
      pomVersion: identity.upstreamPomVersion,
      sha: identity.upstreamSha,
    },
  };
}

function hash(data) {
  return createHash("sha256").update(data).digest("hex");
}

function requireReactorPom(directory, identity, { artifactId, fileName }) {
  const pom = xmlRoot(
    readFileSync(join(directory, fileName), "utf8"),
    "project",
  );
  const parent = child(pom, "parent");
  const root = artifactId === PARENT_ARTIFACT_ID;
  if (
    value(pom, "artifactId") !== artifactId ||
    (value(pom, "packaging") ?? "jar") !== (root ? "pom" : "jar") ||
    (value(pom, "groupId") ?? value(parent, "groupId")) !== identity.groupId ||
    (value(pom, "version") ?? value(parent, "version")) !== identity.version ||
    (!root &&
      (value(parent, "groupId") !== identity.groupId ||
        value(parent, "artifactId") !== PARENT_ARTIFACT_ID ||
        value(parent, "version") !== identity.version))
  ) {
    throw new Error(
      `Candidate POM coordinates do not match the qualified reactor: ${artifactId}.`,
    );
  }
  for (const group of Array.from(pom.getElementsByTagName("groupId"))) {
    const coordinate = group.parentNode;
    const groupId = group.textContent.trim();
    const version = value(coordinate, "version");
    if (
      groupId === "com.seed4j" ||
      (groupId === identity.groupId &&
        (![PARENT_ARTIFACT_ID, ...JAR_MODULES].includes(
          value(coordinate, "artifactId"),
        ) ||
          (version !== undefined && version !== identity.version)))
    ) {
      throw new Error(
        `Candidate POM contains an invalid internal coordinate: ${artifactId}.`,
      );
    }
  }
  if (root) {
    const license = child(child(pom, "licenses"), "license");
    const scm = child(pom, "scm");
    if (
      value(license, "name") !== "Apache License, version 2.0" ||
      value(license, "url") !==
        `https://github.com/seed4j/seed4j/blob/${identity.upstreamSha}/LICENSE.txt` ||
      value(scm, "tag") !== identity.upstreamSha ||
      value(scm, "url") !==
        `https://github.com/seed4j/seed4j/tree/${identity.upstreamSha}` ||
      value(
        child(child(pom, "distributionManagement"), "snapshotRepository"),
        "url",
      ) !== CENTRAL_REPOSITORY
    ) {
      throw new Error(
        "Candidate parent POM license or provenance does not match the qualified reactor.",
      );
    }
  }
}

function requireReactorJar(directory, identity, { artifactId, fileName }) {
  const path = join(directory, fileName);
  const embedded = (name) => readZipEntry(path, `META-INF/${name}`);
  if (
    embedded("seed4j-main-snapshot.properties").toString("utf8") !==
    provenance(identity, artifactId)
  ) {
    throw new Error(
      `Candidate JAR embedded provenance does not match the qualified reactor: ${artifactId}.`,
    );
  }
  if (
    hash(embedded("LICENSE-seed4j-main-snapshot.txt")) !==
      identity.upstreamLicenseSha256 ||
    embedded("NOTICE-seed4j-main-snapshot.txt").toString("utf8") !==
      notice(identity)
  ) {
    throw new Error(
      `Candidate JAR embedded legal metadata does not match the qualified reactor: ${artifactId}.`,
    );
  }
}

module.exports = {
  collectCandidate,
  createCandidateManifest,
  verifyCandidateBundle,
};
