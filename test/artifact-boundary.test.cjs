const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
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
const { join, resolve } = require("node:path");
const test = require("node:test");

const {
  createCandidateManifest,
  verifyCandidateBundle,
} = require("../scripts/artifact-policy.cjs");
const {
  collectQualifiedCandidate,
} = require("../scripts/collect-candidate.cjs");
const {
  buildDeploymentPlan,
  executeDeployment,
  publishDeployment,
} = require("../scripts/deploy-candidate.cjs");
const {
  notice,
  personalPomMetadata,
  provenance,
} = require("../scripts/prepare-upstream.cjs");
const { encodeIdentity } = require("../scripts/publisher-policy.cjs");
const { createStoredZip } = require("../scripts/zip-policy.cjs");

const identity = Object.freeze({
  artifactId: "seed4j-parent",
  groupId: "io.github.renanfranca",
  upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
  upstreamLicenseSha256:
    "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  upstreamPomVersion: "2.2.1-SNAPSHOT",
  upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  version:
    "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
});

test("collects exactly five published reactor POMs and four ordinary JARs", (context) => {
  const { checkoutDirectory, candidateDirectory } = modularBuild(context);

  const manifest = collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });

  assert.deepEqual(
    manifest.artifacts.map(({ artifactId, extension }) => [
      artifactId,
      extension,
    ]),
    [
      ["seed4j-parent", "pom"],
      ["seed4j-api", "pom"],
      ["seed4j-api", "jar"],
      ["seed4j-engine", "pom"],
      ["seed4j-engine", "jar"],
      ["seed4j-test", "pom"],
      ["seed4j-test", "jar"],
      ["seed4j-core-modules", "pom"],
      ["seed4j-core-modules", "jar"],
    ],
  );
  assert.equal(readdirSync(candidateDirectory).length, 10);
  assert.deepEqual(
    verifyCandidateBundle(candidateDirectory, identity),
    manifest,
  );
});

test("rejects an invalid modular manifest before creating Maven settings", (context) => {
  const { checkoutDirectory, candidateDirectory, temp } = modularBuild(context);
  const manifest = collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  manifest.artifacts.pop();
  writeFileSync(
    join(candidateDirectory, "candidate-manifest.json"),
    JSON.stringify(manifest),
  );
  const settingsPath = join(temp, "settings.xml");

  assert.throws(
    () =>
      executeDeployment({
        bundleDirectory: candidateDirectory,
        encodedIdentity: encodeIdentity(identity),
        settingsPath,
        username: "user",
        password: "secret",
      }),
    /exactly five POMs and four JARs/,
  );
  assert.equal(existsSync(settingsPath), false);
});

test("deploys the parent first and stops at the first failed module", (context) => {
  const { checkoutDirectory, candidateDirectory, temp } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const log = join(temp, "maven.log");
  const settingsPath = join(temp, "settings.xml");
  writeFileSync(
    join(temp, "mvnw"),
    String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_MAVEN_LOG, JSON.stringify(args) + "\n");
if (args.includes("-DartifactId=seed4j-engine")) process.exit(17);
`,
    { mode: 0o755 },
  );

  const result = executeDeployment({
    bundleDirectory: candidateDirectory,
    encodedIdentity: encodeIdentity(identity),
    environment: { ...process.env, TEST_MAVEN_LOG: log },
    repositoryDirectory: temp,
    settingsPath,
    username: "user",
    password: "secret",
  });

  assert.equal(result.status, 17);
  const invocations = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    invocations.map((args) =>
      args.find((arg) => arg.startsWith("-DartifactId=")),
    ),
    [
      "-DartifactId=seed4j-parent",
      "-DartifactId=seed4j-api",
      "-DartifactId=seed4j-engine",
    ],
  );
  assert.ok(invocations[0].includes("-Dpackaging=pom"));
  assert.ok(
    invocations[0].includes(
      `-Dfile=${join(candidateDirectory, `seed4j-parent-${identity.version}.pom`)}`,
    ),
  );
  assert.ok(invocations[1].includes("-Dpackaging=jar"));
  assert.ok(
    invocations[1].includes(
      `-DpomFile=${join(candidateDirectory, `seed4j-api-${identity.version}.pom`)}`,
    ),
  );
  assert.equal(existsSync(settingsPath), false);
});

test("reports failure when Maven exits successfully but Sonatype only confirms part of the set", async (context) => {
  const { checkoutDirectory, candidateDirectory, temp } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const settingsPath = join(temp, "settings.xml");
  const log = join(temp, "maven.log");
  writeFileSync(
    join(temp, "mvnw"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.TEST_MAVEN_LOG, ".");
`,
    { mode: 0o755 },
  );
  let parentReads = 0;

  await assert.rejects(
    async () =>
      publishDeployment({
        bundleDirectory: candidateDirectory,
        encodedIdentity: encodeIdentity(identity),
        environment: { ...process.env, TEST_MAVEN_LOG: log },
        publicationOperation: "head",
        repositoryDirectory: temp,
        settingsPath,
        username: "user",
        password: "secret",
        wait: async () => {},
        publicRequest: async (url, method) => {
          if (!url.includes("/seed4j-parent/")) return { status: 404 };
          if (method === "HEAD") return { status: 200 };
          if (++parentReads === 1) return { status: 404 };
          return {
            status: 200,
            body: `<metadata><groupId>io.github.renanfranca</groupId><artifactId>seed4j-parent</artifactId><version>${identity.version}</version><versioning><snapshotVersions><snapshotVersion><extension>pom</extension><value>${identity.version.replace("SNAPSHOT", "20261121.230000-1")}</value><updated>20261121230000</updated></snapshotVersion></snapshotVersions></versioning></metadata>`,
          };
        },
      }),
    /Public files 1\/9: seed4j-parent.pom/,
  );
  assert.equal(readFileSync(log, "utf8"), ".....");
  assert.equal(existsSync(settingsPath), false);
});

test("rejects extra bundle files and artifact symlinks before reading contents", (context) => {
  const { checkoutDirectory, candidateDirectory } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const extra = join(
    candidateDirectory,
    `seed4j-api-${identity.version}-sources.jar`,
  );
  writeFileSync(extra, "sources");

  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /Unexpected bundle files/,
  );
  unlinkSync(extra);
  const jar = join(candidateDirectory, `seed4j-api-${identity.version}.jar`);
  unlinkSync(jar);
  symlinkSync(
    join(
      checkoutDirectory,
      "seed4j-api",
      "target",
      `seed4j-api-${identity.version}.jar`,
    ),
    jar,
  );
  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /not a regular file/,
  );
});

test("rejects tampered contents, even when coordinates or provenance are rehashed", (context) => {
  const { checkoutDirectory, candidateDirectory } = modularBuild(context);
  const manifest = collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const manifestPath = join(candidateDirectory, "candidate-manifest.json");
  const api = join(candidateDirectory, `seed4j-api-${identity.version}.pom`);
  const originalPom = readFileSync(api, "utf8");
  writeFileSync(
    api,
    originalPom.replace(
      "<artifactId>seed4j-api</artifactId>",
      "<artifactId>seed4j-test</artifactId>",
    ),
  );

  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /trusted coordinates and integrity/,
  );
  unlinkSync(manifestPath);
  writeFileSync(
    manifestPath,
    JSON.stringify(createCandidateManifest({ candidateDirectory, identity })),
  );
  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /POM coordinates/,
  );
  writeFileSync(api, originalPom);
  const jar = join(candidateDirectory, `seed4j-test-${identity.version}.jar`);
  writeFileSync(
    jar,
    createStoredZip({
      "META-INF/LICENSE-seed4j-main-snapshot.txt": "upstream Apache license\n",
      "META-INF/NOTICE-seed4j-main-snapshot.txt": notice(identity),
      "META-INF/seed4j-main-snapshot.properties": provenance(
        identity,
        "seed4j-engine",
      ),
    }),
  );
  unlinkSync(manifestPath);
  writeFileSync(
    manifestPath,
    JSON.stringify(createCandidateManifest({ candidateDirectory, identity })),
  );
  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /embedded provenance/,
  );
  writeFileSync(
    jar,
    createStoredZip({
      "META-INF/LICENSE-seed4j-main-snapshot.txt": "modified license\n",
      "META-INF/NOTICE-seed4j-main-snapshot.txt": notice(identity),
      "META-INF/seed4j-main-snapshot.properties": provenance(
        identity,
        "seed4j-test",
      ),
    }),
  );
  unlinkSync(manifestPath);
  writeFileSync(
    manifestPath,
    JSON.stringify(createCandidateManifest({ candidateDirectory, identity })),
  );
  assert.throws(
    () => verifyCandidateBundle(candidateDirectory, identity),
    /embedded legal metadata/,
  );
  assert.equal(manifest.artifacts.length, 9);
});

test("prints a credential-free deployment plan with five Maven invocations", (context) => {
  const { checkoutDirectory, candidateDirectory, temp } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const settingsPath = join(temp, "settings.xml");

  const result = spawnSync(
    process.execPath,
    [
      resolve(__dirname, "../scripts/deploy-candidate.cjs"),
      "dry-run",
      "--bundle",
      candidateDirectory,
      "--identity",
      encodeIdentity(identity),
      "--settings",
      settingsPath,
    ],
    { encoding: "utf8", env: {} },
  );

  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.command, "./mvnw");
  assert.equal(plan.deployments.length, 5);
  assert.ok(
    plan.deployments.every((args) =>
      args.includes(
        "org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy-file",
      ),
    ),
  );
  assert.equal(existsSync(settingsPath), false);
});

test("refuses a historical monolithic identity at the deployment boundary", (context) => {
  const { checkoutDirectory, candidateDirectory } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });

  assert.throws(
    () =>
      buildDeploymentPlan({
        bundleDirectory: candidateDirectory,
        encodedIdentity: encodeIdentity({
          ...identity,
          artifactId: "seed4j-main-snapshot",
        }),
        settingsPath: "/tmp/unused-settings.xml",
      }),
    /requires a modular snapshot/,
  );
});

test("protected deployment confirms all nine files before success", async (context) => {
  const { publish, uploads, settingsPath } = protectedDeployment(context);
  const checked = [];
  const snapshot = publicSnapshot();

  const result = await publish(async (url, method) => {
    if (uploads().length === 0) return { status: 404 };
    if (method === "HEAD") {
      const [, artifactId, extension] =
        /\/([^/]+)\/[^/]+\/[^/]+\.(pom|jar)$/.exec(url);
      checked.push(`${artifactId}.${extension}`);
    }
    return snapshot(url, method);
  });

  assert.equal(result.status, 0);
  assert.equal(result.identity.version, identity.version);
  assert.deepEqual(checked, [
    "seed4j-parent.pom",
    "seed4j-api.pom",
    "seed4j-api.jar",
    "seed4j-engine.pom",
    "seed4j-engine.jar",
    "seed4j-test.pom",
    "seed4j-test.jar",
    "seed4j-core-modules.pom",
    "seed4j-core-modules.jar",
  ]);
  assert.match(result.observation.summary, /Public files 9\/9/);
  assert.equal(uploads().length, 5);
  assert.equal(existsSync(settingsPath), false);
});

test("protected retry of a partial snapshot uploads all five components in order", async (context) => {
  const { publish, uploads } = protectedDeployment(context);
  const partial = publicSnapshot({
    missing: [
      "seed4j-engine.pom",
      "seed4j-engine.jar",
      "seed4j-test.pom",
      "seed4j-test.jar",
      "seed4j-core-modules.pom",
      "seed4j-core-modules.jar",
    ],
  });
  const complete = publicSnapshot();

  const result = await publish(
    (url, method) => (uploads().length === 0 ? partial : complete)(url, method),
    { operation: "retry-last-failed" },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(uploads(), [
    "seed4j-parent",
    "seed4j-api",
    "seed4j-engine",
    "seed4j-test",
    "seed4j-core-modules",
  ]);
  assert.match(result.observation.summary, /Public files 9\/9/);
});

test("protected deployment of a recent complete snapshot uploads nothing", async (context) => {
  const { publish, uploads, settingsPath } = protectedDeployment(context);

  const result = await publish(publicSnapshot());

  assert.equal(result.status, 0);
  assert.match(result.observation.summary, /Public files 9\/9/);
  assert.deepEqual(uploads(), []);
  assert.equal(existsSync(settingsPath), false);
});

test("protected retention refresh waits for nine files inside the retention window", async (context) => {
  const { publish, uploads } = protectedDeployment(context);
  const fresh = centralTime(new Date());
  const expired = centralTime(new Date(Date.now() - 61 * 24 * 60 * 60 * 1000));
  const staleFile = "seed4j-core-modules.jar";
  const priorPublication = publicSnapshot({ updated: expired });
  const afterUpload = [
    publicSnapshot({
      updated: (file) => (file === staleFile ? expired : fresh),
    }),
    publicSnapshot({ missing: [staleFile] }),
    publicSnapshot({ updated: fresh }),
  ];
  const waits = [];

  const result = await publish(
    (url, method) =>
      (uploads().length === 0 ? priorPublication : afterUpload[waits.length])(
        url,
        method,
      ),
    { wait: async (milliseconds) => waits.push(milliseconds) },
  );

  assert.equal(result.status, 0);
  assert.match(result.observation.summary, /Public files 9\/9/);
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.equal(uploads().length, 5);
});

test("protected retention refresh fails when the ninth file stays unavailable after polling", async (context) => {
  const { publish, uploads, settingsPath } = protectedDeployment(context);
  const expired = centralTime(new Date(Date.now() - 61 * 24 * 60 * 60 * 1000));
  const priorPublication = publicSnapshot({ updated: expired });
  const incomplete = publicSnapshot({ missing: ["seed4j-core-modules.jar"] });
  const waits = [];

  await assert.rejects(
    publish(
      (url, method) =>
        (uploads().length === 0 ? priorPublication : incomplete)(url, method),
      { wait: async (milliseconds) => waits.push(milliseconds) },
    ),
    /Public snapshot confirmation failed\. Public files 8\/9/,
  );

  assert.deepEqual(waits, [15_000, 15_000, 15_000]);
  assert.equal(uploads().length, 5);
  assert.equal(existsSync(settingsPath), false);
});

function protectedDeployment(context) {
  const { checkoutDirectory, candidateDirectory, temp } = modularBuild(context);
  collectQualifiedCandidate({
    checkoutDirectory,
    outputDirectory: candidateDirectory,
    identity,
  });
  const settingsPath = join(temp, "settings.xml");
  const log = join(temp, "maven.log");
  writeFileSync(
    join(temp, "mvnw"),
    String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from "node:fs";
const settings = process.argv.find((arg) => arg.startsWith("--settings=")).slice("--settings=".length);
if (process.env.CENTRAL_PASSWORD || process.env.CENTRAL_USERNAME) process.exit(19);
if ((statSync(settings).mode & 0o777) !== 0o600 || !readFileSync(settings, "utf8").includes("<password>password&amp;value</password>")) process.exit(20);
const artifact = process.argv.find((arg) => arg.startsWith("-DartifactId="));
appendFileSync(process.env.TEST_MAVEN_LOG, artifact.slice("-DartifactId=".length) + "\n");
`,
    { mode: 0o755 },
  );
  return {
    publish: (
      publicRequest,
      { operation = "head", wait = async () => {} } = {},
    ) =>
      publishDeployment({
        bundleDirectory: candidateDirectory,
        encodedIdentity: encodeIdentity(identity),
        environment: {
          ...process.env,
          TEST_MAVEN_LOG: log,
          CENTRAL_USERNAME: "user",
          CENTRAL_PASSWORD: "password&value",
        },
        publicationOperation: operation,
        repositoryDirectory: temp,
        settingsPath,
        username: "user",
        password: "password&value",
        wait,
        publicRequest,
      }),
    uploads: () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    settingsPath,
  };
}

function centralTime(date) {
  return date
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
}

function publicSnapshot({
  updated = centralTime(new Date()),
  missing = [],
} = {}) {
  return async (url, method) => {
    const [, artifactId] = /\/([^/]+)\/[^/]+\/[^/]+$/.exec(url);
    if (method === "HEAD") {
      const file = `${artifactId}.${url.split(".").at(-1)}`;
      return { status: missing.includes(file) ? 404 : 200 };
    }
    const extensions =
      artifactId === "seed4j-parent" ? ["pom"] : ["pom", "jar"];
    return {
      status: 200,
      body: `<metadata><groupId>io.github.renanfranca</groupId><artifactId>${artifactId}</artifactId><version>${identity.version}</version><versioning><snapshotVersions>${extensions
        .map((extension) => {
          const updatedAt =
            typeof updated === "function"
              ? updated(`${artifactId}.${extension}`)
              : updated;
          const publishedVersion = identity.version.replace(
            "SNAPSHOT",
            updatedAt.slice(0, 8) + "." + updatedAt.slice(8) + "-1",
          );
          return `<snapshotVersion><extension>${extension}</extension><value>${publishedVersion}</value><updated>${updatedAt}</updated></snapshotVersion>`;
        })
        .join("")}</snapshotVersions></versioning></metadata>`,
    };
  };
}

function modularBuild(context) {
  const temp = mkdtempSync(join(tmpdir(), "seed4j-modular-candidate-"));
  context.after(() => rmSync(temp, { recursive: true, force: true }));
  const checkoutDirectory = join(temp, "upstream");
  const candidateDirectory = join(temp, "bundle");
  mkdirSync(checkoutDirectory);
  writeFileSync(
    join(checkoutDirectory, "pom.xml"),
    `<project>${personalPomMetadata(identity)}</project>`,
  );
  writeFileSync(
    join(checkoutDirectory, "LICENSE.txt"),
    "upstream Apache license\n",
  );
  for (const module of [
    "seed4j-api",
    "seed4j-engine",
    "seed4j-test",
    "seed4j-core-modules",
    "seed4j-server",
  ]) {
    const directory = join(checkoutDirectory, module);
    mkdirSync(join(directory, "target"), { recursive: true });
    writeFileSync(
      join(directory, "pom.xml"),
      `<project><parent><groupId>io.github.renanfranca</groupId><artifactId>seed4j-parent</artifactId><version>${identity.version}</version></parent><artifactId>${module}</artifactId><packaging>jar</packaging></project>`,
    );
    writeFileSync(
      join(directory, "target", `${module}-${identity.version}.jar`),
      createStoredZip({
        "META-INF/LICENSE-seed4j-main-snapshot.txt":
          "upstream Apache license\n",
        "META-INF/NOTICE-seed4j-main-snapshot.txt": notice(identity),
        "META-INF/seed4j-main-snapshot.properties": provenance(
          identity,
          module,
        ),
      }),
    );
  }
  return { checkoutDirectory, candidateDirectory, temp };
}
