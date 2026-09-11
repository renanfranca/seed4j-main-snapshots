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

const identity = Object.freeze({
  artifactId: "seed4j-main-snapshot",
  groupId: "io.github.renanfranca",
  upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
  upstreamPomVersion: "2.2.1-SNAPSHOT",
  upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  version: "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
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
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT.pom",
        role: "pom",
        sha256:
          "2aee408f79653f6ed59e032e84908638b9dc4bb386e587fdee73215de554cccc",
        size: 654,
      },
      {
        fileName:
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT.jar",
        role: "main",
        sha256:
          "ce663f104742f48f14768209efc92eadb5cfd50a45c366c3d5f44b8faf44a775",
        size: 8,
      },
      {
        fileName:
          "seed4j-main-snapshot-2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT-tests.jar",
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
      version: "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
    },
    schemaVersion: 1,
    upstream: {
      commitTimestamp: "2026-09-07T05:58:00Z",
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

  assert.deepEqual(verifyCandidateBundle(directory), manifest);

  const mainJar = join(
    directory,
    `seed4j-main-snapshot-${identity.version}.jar`,
  );
  writeFileSync(mainJar, "tampered-main-jar");
  assert.throws(
    () => verifyCandidateBundle(directory),
    /SHA-256 mismatch.*main/,
  );
  writeFileSync(mainJar, "main-jar");
  writeFileSync(join(directory, "unexpected.sh"), "exit 0");
  assert.throws(
    () => verifyCandidateBundle(directory),
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
  writeFileSync(externalMainJar, "main-jar");
  unlinkSync(mainJar);
  symlinkSync(externalMainJar, mainJar);

  assert.throws(() => verifyCandidateBundle(directory), /regular file/i);

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

    assert.throws(() => verifyCandidateBundle(directory), /manifest/i);
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

  assert.throws(() => verifyCandidateBundle(directory), /published POM/i);

  rmSync(directory, { force: true, recursive: true });
});

test("plans only Maven Wrapper deploy-file 3.1.4 with the POM, main JAR, and tests JAR", () => {
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
    buildDeploymentPlan({ bundleDirectory: directory, settingsPath }),
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
        repositoryDirectory: directory,
        settingsPath,
      }),
    /credentials/i,
  );
  assert.equal(existsSync(settingsPath), false);

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
    "main-jar",
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
  assert.deepEqual(verifyCandidateBundle(bundle), manifest);
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

  assert.deepEqual(verifyCandidateBundle(bundle), manifest);
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

function writeCandidateFiles(directory) {
  const prefix = join(directory, `seed4j-main-snapshot-${identity.version}`);
  writeFileSync(`${prefix}.pom`, candidatePom());
  writeFileSync(`${prefix}.jar`, "main-jar");
  writeFileSync(`${prefix}-tests.jar`, "tests-jar");
}

function candidatePom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.0.6</version>
  </parent>
  <groupId>${identity.groupId}</groupId>
  <artifactId>${identity.artifactId}</artifactId>
  <version>${identity.version}</version>
  <name>Unofficial Seed4J main snapshot</name>
  <distributionManagement>
    <snapshotRepository>
      <id>central-snapshots</id>
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
