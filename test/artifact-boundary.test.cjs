const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  collectCandidate,
  createCandidateManifest,
  verifyCandidateBundle,
} = require("../scripts/artifact-policy.cjs");
const {
  collectQualifiedCandidate,
} = require("../scripts/collect-candidate.cjs");
const {
  buildDeploymentPlan,
  executeDeployment,
} = require("../scripts/deploy-candidate.cjs");
const { notice, provenance } = require("../scripts/prepare-upstream.cjs");
const { encodeIdentity } = require("../scripts/publisher-policy.cjs");

const identity = Object.freeze({
  artifactId: "seed4j-main-snapshot",
  groupId: "io.github.renanfranca",
  upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
  upstreamLicenseSha256:
    "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  upstreamPomVersion: "2.2.1-SNAPSHOT",
  upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  version:
    "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
});

test("manifests exactly the POM, main JAR, and tests JAR with deterministic sizes and hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);

  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });

  assert.deepEqual(manifest, {
    artifacts: [
      {
        fileName:
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT.pom",
        role: "pom",
        sha256:
          "7dfb78ef92796886e2af44fe980ba3a449e283a0498fee9192907299b34fbd77",
        size: 2013,
      },
      {
        fileName:
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT.jar",
        role: "main",
        sha256:
          "a10eac5e9d8cdebb65019efd9ae5d9a01e22b36912ecf600a05b6dda9b5d9354",
        size: 1289,
      },
      {
        fileName:
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT-tests.jar",
        role: "tests",
        sha256:
          "1fb7b3066bfca407857efaa2be98a05104e2048a29a5ec997c121791790200b8",
        size: 9,
      },
    ],
    publication: {
      artifactId: "seed4j-main-snapshot",
      groupId: "io.github.renanfranca",
      repositoryUrl: "https://central.sonatype.com/repository/maven-snapshots/",
      version:
        "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
    },
    schemaVersion: 1,
    upstream: {
      commitTimestamp: "2026-09-07T05:58:00Z",
      licenseSha256:
        "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
      pomVersion: "2.2.1-SNAPSHOT",
      sha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    },
  });

  rmSync(directory, { force: true, recursive: true });
});

test("rejects sources, Javadocs, and every file outside the three-artifact allowlist", () => {
  for (const unexpectedFile of [
    `seed4j-main-snapshot-${identity.version}-sources.jar`,
    `seed4j-main-snapshot-${identity.version}-javadoc.jar`,
    "unexpected.txt",
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
    writeCandidateFiles(directory);
    writeFileSync(join(directory, unexpectedFile), "unexpected");

    assert.throws(
      () =>
        createCandidateManifest({ candidateDirectory: directory, identity }),
      new RegExp(
        `Unexpected candidate artifacts: ${escapeRegularExpression(unexpectedFile)}`,
      ),
    );

    rmSync(directory, { force: true, recursive: true });
  }
});

test("a privileged verifier accepts the complete data-only bundle and rejects tampering or extras", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  writeFileSync(
    join(directory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.deepEqual(verifyCandidateBundle(directory, identity), manifest);

  const mainJar = join(
    directory,
    `seed4j-main-snapshot-${identity.version}.jar`,
  );
  writeFileSync(mainJar, "tampered-main-jar");
  assert.throws(
    () => verifyCandidateBundle(directory, identity),
    /SHA-256 mismatch.*main/,
  );
  writeFileSync(mainJar, storedZip(packagedMetadata()));
  writeFileSync(join(directory, "unexpected.sh"), "exit 0");
  assert.throws(
    () => verifyCandidateBundle(directory, identity),
    /Unexpected bundle files: unexpected\.sh/,
  );

  rmSync(directory, { force: true, recursive: true });
});

test("the privileged verifier rejects artifact symlinks at the data-only boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  writeFileSync(
    join(directory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const mainJar = join(
    directory,
    `seed4j-main-snapshot-${identity.version}.jar`,
  );
  const externalMainJar = join(directory, "..", `${identity.upstreamSha}.jar`);
  writeFileSync(externalMainJar, storedZip(packagedMetadata()));
  unlinkSync(mainJar);
  symlinkSync(externalMainJar, mainJar);

  assert.throws(
    () => verifyCandidateBundle(directory, identity),
    /regular file/i,
  );

  rmSync(externalMainJar, { force: true });
  rmSync(directory, { force: true, recursive: true });
});

test("rejects manifest fields, coordinates, repositories, names, and classifiers outside the allowlist", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  const invalidManifests = [
    { ...manifest, unexpected: true },
    { ...manifest, schemaVersion: 2 },
    {
      ...manifest,
      publication: { ...manifest.publication, groupId: "com.seed4j" },
    },
    {
      ...manifest,
      publication: { ...manifest.publication, artifactId: "seed4j" },
    },
    {
      ...manifest,
      publication: {
        ...manifest.publication,
        repositoryUrl: "https://repo.example.test/",
      },
    },
    {
      ...manifest,
      upstream: {
        ...manifest.upstream,
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    },
    {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) =>
        artifact.role === "tests" ? { ...artifact, role: "sources" } : artifact,
      ),
    },
    {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) =>
        artifact.role === "tests"
          ? {
              ...artifact,
              fileName: artifact.fileName.replace("-tests.jar", "-sources.jar"),
            }
          : artifact,
      ),
    },
  ];

  for (const invalidManifest of invalidManifests) {
    writeFileSync(
      join(directory, "candidate-manifest.json"),
      `${JSON.stringify(invalidManifest, null, 2)}\n`,
    );

    assert.throws(
      () => verifyCandidateBundle(directory, identity),
      /manifest|trusted qualified identity/i,
    );
  }

  rmSync(directory, { force: true, recursive: true });
});

test("rejects an internally consistent bundle whose published POM does not use the personal coordinate", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const pomPath = join(
    directory,
    `seed4j-main-snapshot-${identity.version}.pom`,
  );
  writeFileSync(
    pomPath,
    candidatePom().replace(
      "<groupId>io.github.renanfranca</groupId>",
      "<groupId>com.seed4j</groupId>",
    ),
  );
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  writeFileSync(
    join(directory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  assert.throws(
    () => verifyCandidateBundle(directory, identity),
    /published POM/i,
  );

  rmSync(directory, { force: true, recursive: true });
});

test("plans only Maven Wrapper deploy-file 3.1.4 after mandatory POM formatting", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  writeFileSync(
    join(directory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const prefix = join(directory, `seed4j-main-snapshot-${identity.version}`);

  const plan = buildDeploymentPlan({
    bundleDirectory: directory,
    encodedIdentity: encodeIdentity(identity),
    settingsPath: "/trusted/settings.xml",
  });

  assert.deepEqual(plan, {
    arguments: [
      "--batch-mode",
      "-ntp",
      "--settings=/trusted/settings.xml",
      "org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy-file",
      "-Durl=https://central.sonatype.com/repository/maven-snapshots/",
      "-DrepositoryId=central-snapshots",
      "-DgroupId=io.github.renanfranca",
      "-DartifactId=seed4j-main-snapshot",
      `-Dversion=${identity.version}`,
      "-Dpackaging=jar",
      `-DpomFile=${prefix}.pom`,
      `-Dfile=${prefix}.jar`,
      `-Dfiles=${prefix}-tests.jar`,
      "-Dclassifiers=tests",
      "-Dtypes=jar",
      "-DgeneratePom=false",
      "-DretryFailedDeploymentCount=3",
    ],
    command: "./mvnw",
  });
  assert.doesNotMatch(JSON.stringify(plan), /sources|javadoc/);

  rmSync(directory, { force: true, recursive: true });
});

test("dry run verifies the bundle and prints its deployment plan without credentials or side effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-candidate-"));
  writeCandidateFiles(directory);
  const manifest = createCandidateManifest({
    candidateDirectory: directory,
    identity,
  });
  writeFileSync(
    join(directory, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const settingsPath = join(directory, "must-not-exist-settings.xml");

  const result = spawnSync(
    process.execPath,
    [
      join(__dirname, "../scripts/deploy-candidate.cjs"),
      "dry-run",
      "--bundle",
      directory,
      "--identity",
      encodeIdentity(identity),
      "--settings",
      settingsPath,
    ],
    {
      encoding: "utf8",
      env: {},
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    buildDeploymentPlan({
      bundleDirectory: directory,
      encodedIdentity: encodeIdentity(identity),
      settingsPath,
    }),
  );
  assert.equal(result.stderr, "");
  assert.equal(existsSync(settingsPath), false);

  rmSync(directory, { force: true, recursive: true });
});

test("execute writes credentials only to a private temporary settings file and removes it after the pinned wrapper exits", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-deploy-"));
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  writeCandidateFiles(bundle);
  const manifest = createCandidateManifest({
    candidateDirectory: bundle,
    identity,
  });
  writeFileSync(
    join(bundle, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const settingsPath = join(directory, "central-settings.xml");
  const capturedSettingsPath = join(directory, "captured-settings.xml");
  const capturedModePath = join(directory, "captured-mode.txt");
  const wrapper = join(directory, "mvnw");
  writeFileSync(
    wrapper,
    `#!/bin/sh
cp "${settingsPath}" "${capturedSettingsPath}"
stat -c %a "${settingsPath}" > "${capturedModePath}"
exit 0
`,
  );
  chmodSync(wrapper, 0o700);

  const result = executeDeployment({
    bundleDirectory: bundle,
    encodedIdentity: encodeIdentity(identity),
    password: "p<&ssword",
    repositoryDirectory: directory,
    settingsPath,
    stdio: "pipe",
    username: "user<&name",
  });

  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(existsSync(settingsPath), false);
  assert.equal(readFileSync(capturedModePath, "utf8").trim(), "600");
  assert.equal(
    readFileSync(capturedSettingsPath, "utf8"),
    `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <servers>
    <server>
      <id>central-snapshots</id>
      <username>user&lt;&amp;name</username>
      <password>p&lt;&amp;ssword</password>
    </server>
  </servers>
</settings>
`,
  );
  assert.throws(
    () =>
      executeDeployment({
        bundleDirectory: bundle,
        encodedIdentity: encodeIdentity(identity),
        repositoryDirectory: directory,
        settingsPath,
      }),
    /credentials/i,
  );
  assert.equal(existsSync(settingsPath), false);

  rmSync(directory, { force: true, recursive: true });
});

test("privileged deployment rejects self-consistent identity, POM, provenance, or legal tampering before credentials have side effects", () => {
  const directory = mkdtempSync(join(tmpdir(), "seed4j-deploy-boundary-"));
  const bundle = join(directory, "bundle");
  const settingsPath = join(directory, "central-settings.xml");
  const invocationPath = join(directory, "maven-invoked.txt");
  const wrapper = join(directory, "mvnw");
  mkdirSync(bundle);
  writeFileSync(wrapper, `#!/bin/sh\ntouch "${invocationPath}"\nexit 0\n`);
  chmodSync(wrapper, 0o700);

  const mutations = [
    {
      expected: /trusted qualified identity/i,
      identity: Object.freeze({
        ...identity,
        upstreamSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        version:
          "2.2.1-main.20260907.055800.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-SNAPSHOT",
      }),
    },
    {
      expected: /nonofficial publication metadata/i,
      pom: trustedCandidatePom(identity).replace(
        "Unofficial Seed4J main snapshot",
        "Official Seed4J snapshot",
      ),
    },
    {
      entries: {
        ...packagedMetadata(),
        "META-INF/seed4j-main-snapshot.properties": `${provenance(identity)}tampered=true\n`,
      },
      expected: /embedded provenance/i,
    },
    {
      entries: {
        ...packagedMetadata(),
        "META-INF/LICENSE-seed4j-main-snapshot.txt": "different license\n",
      },
      expected: /embedded legal metadata/i,
    },
  ];

  for (const mutation of mutations) {
    rmSync(bundle, { force: true, recursive: true });
    mkdirSync(bundle);
    const bundleIdentity = mutation.identity ?? identity;
    writeQualifiedBundleFiles({
      bundle,
      entries: mutation.entries ?? packagedMetadata(),
      identity: bundleIdentity,
      pom: mutation.pom ?? trustedCandidatePom(bundleIdentity),
    });

    assert.throws(
      () =>
        executeDeployment({
          bundleDirectory: bundle,
          encodedIdentity: encodeIdentity(identity),
          password: "secret",
          repositoryDirectory: directory,
          settingsPath,
          stdio: "pipe",
          username: "publisher",
        }),
      mutation.expected,
    );
    assert.equal(existsSync(settingsPath), false);
    assert.equal(existsSync(invocationPath), false);
  }

  rmSync(directory, { force: true, recursive: true });
});

test("collects only the three allowed artifacts from a qualified upstream build", () => {
  const checkout = mkdtempSync(join(tmpdir(), "seed4j-built-upstream-"));
  const target = join(checkout, "target");
  const bundle = join(checkout, "publisher-bundle");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(checkout, "pom.xml"), candidatePom());
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}.jar`),
    storedZip(packagedMetadata()),
  );
  writeFileSync(join(target, "unexpected-output.jar"), "ignored");
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}-tests.jar`),
    "tests-jar",
  );
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}-sources.jar`),
    "sources",
  );
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}-javadoc.jar`),
    "javadocs",
  );

  const manifest = collectCandidate({
    checkoutDirectory: checkout,
    identity,
    outputDirectory: bundle,
  });

  assert.deepEqual(readdirNames(bundle), [
    "candidate-manifest.json",
    `seed4j-main-snapshot-${identity.version}-tests.jar`,
    `seed4j-main-snapshot-${identity.version}.jar`,
    `seed4j-main-snapshot-${identity.version}.pom`,
  ]);
  assert.deepEqual(verifyCandidateBundle(bundle, identity), manifest);
  assert.doesNotMatch(
    readdirNames(bundle).join("\n"),
    /sources|javadoc|ignored/,
  );

  rmSync(checkout, { force: true, recursive: true });
});

test("collects a build only when its main JAR embeds exact provenance and legal metadata", () => {
  const checkout = mkdtempSync(join(tmpdir(), "seed4j-built-upstream-"));
  const target = join(checkout, "target");
  const bundle = join(checkout, "publisher-bundle");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(checkout, "pom.xml"), candidatePom());
  writeFileSync(join(checkout, "LICENSE.txt"), "upstream Apache license\n");
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}.jar`),
    storedZip(packagedMetadata()),
  );
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}-tests.jar`),
    "tests-jar",
  );

  const manifest = collectQualifiedCandidate({
    checkoutDirectory: checkout,
    identity,
    outputDirectory: bundle,
  });

  assert.deepEqual(verifyCandidateBundle(bundle, identity), manifest);
  rmSync(bundle, { force: true, recursive: true });
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}.jar`),
    storedZip({
      ...packagedMetadata(),
      "META-INF/seed4j-main-snapshot.properties": `${provenance(identity)}tampered=true\n`,
    }),
  );
  assert.throws(
    () =>
      collectQualifiedCandidate({
        checkoutDirectory: checkout,
        identity,
        outputDirectory: bundle,
      }),
    /embedded provenance/i,
  );
  writeFileSync(
    join(target, `${identity.artifactId}-${identity.version}.jar`),
    storedZip({
      ...packagedMetadata(),
      "META-INF/LICENSE-seed4j-main-snapshot.txt": "different license\n",
    }),
  );
  assert.throws(
    () =>
      collectQualifiedCandidate({
        checkoutDirectory: checkout,
        identity,
        outputDirectory: bundle,
      }),
    /embedded legal metadata/i,
  );

  rmSync(checkout, { force: true, recursive: true });
});

function packagedMetadata() {
  return {
    "META-INF/LICENSE-seed4j-main-snapshot.txt": "upstream Apache license\n",
    "META-INF/NOTICE-seed4j-main-snapshot.txt": notice(identity),
    "META-INF/seed4j-main-snapshot.properties": provenance(identity),
  };
}

function writeQualifiedBundleFiles({ bundle, entries, identity, pom }) {
  const prefix = join(bundle, `${identity.artifactId}-${identity.version}`);
  writeFileSync(`${prefix}.pom`, pom);
  writeFileSync(`${prefix}.jar`, storedZip(entries));
  writeFileSync(`${prefix}-tests.jar`, "tests-jar");
  const manifest = createCandidateManifest({
    candidateDirectory: bundle,
    identity,
  });
  writeFileSync(
    join(bundle, "candidate-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function writeCandidateFiles(directory) {
  const prefix = join(directory, `seed4j-main-snapshot-${identity.version}`);
  writeFileSync(`${prefix}.pom`, candidatePom());
  writeFileSync(`${prefix}.jar`, storedZip(packagedMetadata()));
  writeFileSync(`${prefix}-tests.jar`, "tests-jar");
}

function candidatePom() {
  return trustedCandidatePom(identity);
}

function trustedCandidatePom(candidateIdentity) {
  const sourceUrl = `https://github.com/seed4j/seed4j/tree/${candidateIdentity.upstreamSha}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.0.6</version>
  </parent>
  <groupId>${candidateIdentity.groupId}</groupId>
  <artifactId>${candidateIdentity.artifactId}</artifactId>
  <version>${candidateIdentity.version}</version>
  <name>Unofficial Seed4J main snapshot</name>
  <description>
    An unofficial rebuild of Seed4J main at ${candidateIdentity.upstreamSha}, published by renanfranca for experimental seed4j-cli
    compatibility testing.
  </description>
  <packaging>jar</packaging>
  <url>${sourceUrl}</url>
  <licenses>
    <license>
      <name>Apache License, version 2.0</name>
      <url>https://github.com/seed4j/seed4j/blob/${candidateIdentity.upstreamSha}/LICENSE.txt</url>
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
    <tag>${candidateIdentity.upstreamSha}</tag>
    <url>${sourceUrl}</url>
  </scm>
  <distributionManagement>
    <snapshotRepository>
      <id>central-snapshots</id>
      <name>Central Portal snapshots</name>
      <url>https://central.sonatype.com/repository/maven-snapshots/</url>
    </snapshotRepository>
  </distributionManagement>
  <properties />
</project>
`;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readdirNames(directory) {
  return readdirSync(directory).sort();
}

function storedZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(value);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, nameBuffer, content);
    centralRecords.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
