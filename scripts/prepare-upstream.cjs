const { XMLSerializer } = require("@xmldom/xmldom");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  decodeIdentity,
  requireModularIdentity,
} = require("./publisher-policy.cjs");

const { child, elements, value, xmlRoot } = require("./maven-xml.cjs");
const {
  CENTRAL_REPOSITORY,
  JAR_MODULES,
  PARENT_ARTIFACT_ID,
} = require("./snapshot-layout.cjs");

function prepareUpstream({ checkoutDirectory, identity }) {
  requireModularIdentity(identity);
  const root = xmlRoot(
    readFileSync(join(checkoutDirectory, "pom.xml"), "utf8"),
    "project",
  );
  const moduleDirectories = [...JAR_MODULES, "seed4j-server"];
  const modules = elements(child(root, "modules"), "module").map((module) =>
    module.textContent.trim(),
  );
  if (
    value(root, "groupId") !== "com.seed4j" ||
    value(root, "artifactId") !== PARENT_ARTIFACT_ID ||
    value(root, "version") !== identity.upstreamPomVersion ||
    value(root, "packaging") !== "pom" ||
    [...modules].sort().join("\n") !== [...moduleDirectories].sort().join("\n")
  ) {
    throw new Error(
      "Upstream POM does not match the qualified Seed4J reactor.",
    );
  }
  const modulePoms = moduleDirectories.map((directory) => {
    const path = join(checkoutDirectory, directory, "pom.xml");
    const project = xmlRoot(readFileSync(path, "utf8"), "project");
    const parent = child(project, "parent");
    const expectedId = directory === "seed4j-server" ? "seed4j" : directory;
    if (
      value(project, "artifactId") !== expectedId ||
      value(parent, "groupId") !== "com.seed4j" ||
      value(parent, "artifactId") !== PARENT_ARTIFACT_ID ||
      value(parent, "version") !== identity.upstreamPomVersion
    ) {
      throw new Error(
        `Unexpected upstream reactor coordinates in ${directory}.`,
      );
    }
    return { path, project };
  });
  const publication = xmlRoot(
    `<project${root.namespaceURI ? ` xmlns="${root.namespaceURI}"` : ""}>${personalPomMetadata(identity)}</project>`,
    "project",
  );
  for (const metadata of elements(publication)) {
    const previous = child(root, metadata.tagName);
    const replacement = root.ownerDocument.importNode(metadata, true);
    if (previous) root.replaceChild(replacement, previous);
    else root.insertBefore(replacement, child(root, "modules"));
  }
  const serializer = new XMLSerializer();
  for (const { path, project } of [
    { path: join(checkoutDirectory, "pom.xml"), project: root },
    ...modulePoms,
  ]) {
    rewriteInternalCoordinates(project, identity);
    writeFileSync(path, serializer.serializeToString(project.ownerDocument));
  }
  const license = readFileSync(join(checkoutDirectory, "LICENSE.txt"));
  for (const module of JAR_MODULES) {
    writeJarMetadata(
      join(checkoutDirectory, module),
      identity,
      module,
      license,
    );
  }
}

function rewriteInternalCoordinates(project, identity) {
  for (const group of Array.from(project.getElementsByTagName("groupId"))) {
    if (group.textContent.trim() !== "com.seed4j") continue;
    const coordinate = group.parentNode;
    if (
      ![PARENT_ARTIFACT_ID, ...JAR_MODULES, "seed4j"].includes(
        value(coordinate, "artifactId"),
      )
    ) {
      throw new Error("Unexpected com.seed4j reactor coordinate.");
    }
    group.textContent = identity.groupId;
    const version = child(coordinate, "version");
    if (version) {
      if (
        ![identity.upstreamPomVersion, "${project.version}"].includes(
          version.textContent.trim(),
        )
      ) {
        throw new Error(
          "Unexpected version on an internal Seed4J reactor coordinate.",
        );
      }
      version.textContent = identity.version;
    }
  }
}

function writeJarMetadata(checkoutDirectory, identity, artifactId, license) {
  const metadataDirectory = join(
    checkoutDirectory,
    "src/main/resources/META-INF",
  );
  mkdirSync(metadataDirectory, { recursive: true });
  writeFileSync(
    join(metadataDirectory, "LICENSE-seed4j-main-snapshot.txt"),
    license,
  );
  writeFileSync(
    join(metadataDirectory, "seed4j-main-snapshot.properties"),
    provenance(identity, artifactId),
  );
  writeFileSync(
    join(metadataDirectory, "NOTICE-seed4j-main-snapshot.txt"),
    notice(identity),
  );
}

function personalPomMetadata(identity) {
  const sourceUrl = `https://github.com/seed4j/seed4j/tree/${identity.upstreamSha}`;
  return `  <groupId>${identity.groupId}</groupId>
  <artifactId>${identity.artifactId}</artifactId>
  <version>${identity.version}</version>
  <name>Unofficial Seed4J main snapshot</name>
  <description>
    An unofficial rebuild of Seed4J main at ${identity.upstreamSha}, published by renanfranca for experimental seed4j-cli
    compatibility testing.
  </description>
  <packaging>pom</packaging>
  <url>${sourceUrl}</url>
  <licenses>
    <license>
      <name>Apache License, version 2.0</name>
      <url>https://github.com/seed4j/seed4j/blob/${identity.upstreamSha}/LICENSE.txt</url>
      <distribution>repo</distribution>
    </license>
  </licenses>
  <organization>
    <name>Renan França personal publisher</name>
    <url>https://github.com/renanfranca</url>
  </organization>
  <developers>
    <developer>
      <id>renanfranca</id>
      <name>Renan França</name>
      <url>https://github.com/renanfranca</url>
      <roles>
        <role>unofficial snapshot publisher</role>
      </roles>
    </developer>
  </developers>
  <scm>
    <connection>scm:git:https://github.com/seed4j/seed4j.git</connection>
    <developerConnection>scm:git:https://github.com/seed4j/seed4j.git</developerConnection>
    <tag>${identity.upstreamSha}</tag>
    <url>${sourceUrl}</url>
  </scm>
  <distributionManagement>
    <snapshotRepository>
      <id>central-snapshots</id>
      <name>Central Portal snapshots</name>
      <url>${CENTRAL_REPOSITORY}</url>
    </snapshotRepository>
  </distributionManagement>
`;
}

function provenance(identity, artifactId) {
  return `artifact-id=${artifactId}
group-id=${identity.groupId}
publisher=renanfranca
release-channel=unofficial-main-snapshot
upstream-commit=${identity.upstreamSha}
upstream-commit-timestamp=${identity.upstreamCommitTimestamp}
upstream-license-sha256=${identity.upstreamLicenseSha256}
upstream-pom-version=${identity.upstreamPomVersion}
upstream-repository=https://github.com/seed4j/seed4j
version=${identity.version}
`;
}

function notice(identity) {
  return `This is not an official Seed4J publication.
It is an unofficial rebuild of https://github.com/seed4j/seed4j at ${identity.upstreamSha}.
Published by renanfranca only for the experimental seed4j-cli channel.
The upstream Apache-2.0 license remains authoritative.
`;
}

function parseRequest(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--checkout", "--identity"].includes(option) ||
      !value ||
      value.startsWith("--") ||
      values[option]
    ) {
      throw new Error(`Invalid upstream preparation option '${option ?? ""}'.`);
    }
    values[option] = value;
  }
  if (!values["--checkout"] || !values["--identity"]) {
    throw new Error("Upstream preparation requires --checkout and --identity.");
  }
  return {
    checkoutDirectory: values["--checkout"],
    identity: decodeIdentity(values["--identity"]),
  };
}

function run() {
  prepareUpstream(parseRequest(process.argv.slice(2)));
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  notice,
  parseRequest,
  personalPomMetadata,
  prepareUpstream,
  provenance,
};
