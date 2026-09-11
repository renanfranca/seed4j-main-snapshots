const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  decodeIdentity,
  requireDerivedIdentity,
} = require("./publisher-policy.cjs");

const CENTRAL_SNAPSHOT_REPOSITORY =
  "https://central.sonatype.com/repository/maven-snapshots/";

function prepareUpstream({ checkoutDirectory, identity }) {
  requireDerivedIdentity(identity);
  const pomPath = join(checkoutDirectory, "pom.xml");
  const pom = readFileSync(pomPath, "utf8");
  const metadataRegion = /(<\/parent>\s*\n)([\s\S]*?)(  <properties>\s*\n)/;
  const match = metadataRegion.exec(pom);
  if (!match) {
    throw new Error(
      "Upstream POM does not contain the expected top-level metadata region.",
    );
  }
  if (
    !match[2].includes("<groupId>com.seed4j</groupId>") ||
    !match[2].includes("<artifactId>seed4j</artifactId>") ||
    !match[2].includes(`<version>${identity.upstreamPomVersion}</version>`)
  ) {
    throw new Error(
      "Upstream POM identity does not match the qualified candidate.",
    );
  }
  const preparedPom = pom.replace(
    metadataRegion,
    `$1${personalPomMetadata(identity)}$3`,
  );
  writeFileSync(pomPath, preparedPom);

  const metadataDirectory = join(
    checkoutDirectory,
    "src/main/resources/META-INF",
  );
  mkdirSync(metadataDirectory, { recursive: true });
  writeFileSync(
    join(metadataDirectory, "LICENSE-seed4j-main-snapshot.txt"),
    readFileSync(join(checkoutDirectory, "LICENSE.txt")),
  );
  writeFileSync(
    join(metadataDirectory, "seed4j-main-snapshot.properties"),
    provenance(identity),
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
  <description>An unofficial rebuild of Seed4J main at ${identity.upstreamSha}, published by renanfranca for experimental seed4j-cli compatibility testing.</description>
  <packaging>jar</packaging>
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
      <url>${CENTRAL_SNAPSHOT_REPOSITORY}</url>
    </snapshotRepository>
  </distributionManagement>
`;
}

function provenance(identity) {
  return `artifact-id=${identity.artifactId}
group-id=${identity.groupId}
publisher=renanfranca
release-channel=unofficial-main-snapshot
upstream-commit=${identity.upstreamSha}
upstream-commit-timestamp=${identity.upstreamCommitTimestamp}
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

module.exports = { notice, parseRequest, prepareUpstream, provenance };
