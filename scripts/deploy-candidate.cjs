const {
  appendFileSync,
  closeSync,
  openSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyCandidateBundle } = require("./artifact-policy.cjs");
const {
  CENTRAL_REPOSITORY,
  JAR_MODULES,
  PARENT_ARTIFACT_ID,
} = require("./snapshot-layout.cjs");
const {
  decodeIdentity,
  requireModularIdentity,
  retentionDecision,
} = require("./publisher-policy.cjs");
const { canonicalPublisherTimestamp } = require("./operations-policy.cjs");
const {
  fetchPublic,
  observePublicSnapshot,
} = require("./public-artifact-observation.cjs");
const { setTimeout: delay } = require("node:timers/promises");

function buildDeploymentPlan({
  bundleDirectory,
  encodedIdentity,
  settingsPath,
  fileRepository,
}) {
  const identity = decodeIdentity(encodedIdentity);
  verifyCandidateBundle(bundleDirectory, identity);
  const repository =
    fileRepository === undefined
      ? CENTRAL_REPOSITORY
      : localRepositoryUrl(fileRepository);
  return {
    command: "./mvnw",
    deployments: [PARENT_ARTIFACT_ID, ...JAR_MODULES].map((artifactId) => {
      const packaging = artifactId === PARENT_ARTIFACT_ID ? "pom" : "jar";
      const prefix = resolve(
        bundleDirectory,
        `${artifactId}-${identity.version}`,
      );
      return [
        "--batch-mode",
        "-ntp",
        ...(settingsPath ? [`--settings=${settingsPath}`] : []),
        "org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy-file",
        `-Durl=${repository}`,
        "-DrepositoryId=central-snapshots",
        `-DgroupId=${identity.groupId}`,
        `-DartifactId=${artifactId}`,
        `-Dversion=${identity.version}`,
        `-Dpackaging=${packaging}`,
        `-DpomFile=${prefix}.pom`,
        `-Dfile=${prefix}.${packaging}`,
        "-DgeneratePom=false",
        "-DretryFailedDeploymentCount=1",
      ];
    }),
  };
}

function localRepositoryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "file:" || url.host || url.search || url.hash) {
    throw new Error(
      "Local deployment requires an absolute file:// repository URL.",
    );
  }
  return url.href;
}

function executeDeployment({
  bundleDirectory,
  encodedIdentity,
  environment = process.env,
  fileRepository,
  password,
  repositoryDirectory = resolve(__dirname, ".."),
  settingsPath,
  stdio = "inherit",
  username,
}) {
  if (fileRepository === undefined) requireCredentials(username, password);
  const plan = buildDeploymentPlan({
    bundleDirectory,
    encodedIdentity,
    fileRepository,
    settingsPath,
  });
  if (fileRepository === undefined)
    writePrivateSettings({ password, settingsPath, username });
  const {
    CENTRAL_PASSWORD: _password,
    CENTRAL_USERNAME: _username,
    ...childEnvironment
  } = environment;
  try {
    let result;
    for (const arguments_ of plan.deployments) {
      result = spawnSync(plan.command, arguments_, {
        cwd: repositoryDirectory,
        env: childEnvironment,
        stdio,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) break;
    }
    return result;
  } finally {
    if (fileRepository === undefined) unlinkSync(settingsPath);
  }
}

async function publishDeployment({
  publicationOperation,
  publicRequest = fetchPublic,
  wait = delay,
  ...deployment
}) {
  if (!["head", "retry-last-failed"].includes(publicationOperation)) {
    throw new Error(
      "Central deployment requires the qualified publisher operation.",
    );
  }
  const identity = requireModularIdentity(
    decodeIdentity(deployment.encodedIdentity),
  );
  const before = await observePublicSnapshot(identity, publicRequest);
  const now = () => canonicalPublisherTimestamp(new Date().toISOString());
  const eligibility = retentionDecision({
    observedSnapshot: before,
    now: now(),
    operation: publicationOperation,
  });
  if (eligibility.reason === "partial-snapshot-requires-retry") {
    throw new Error(
      `${before.summary}. Use retry-last-failed to recover this SHA.`,
    );
  }
  if (eligibility.outcome === "skip")
    return { status: 0, observation: before, identity };

  const result = executeDeployment(deployment);
  if (result.status !== 0) return result;

  let after;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await wait(15_000);
    after = await observePublicSnapshot(identity, publicRequest, {
      tolerateErrors: true,
    });
    if (
      after.status === "complete" &&
      retentionDecision({
        observedSnapshot: after,
        now: now(),
        operation: publicationOperation,
      }).outcome === "skip"
    ) {
      return { status: 0, observation: after, identity };
    }
  }
  throw new Error(`Public snapshot confirmation failed. ${after.summary}.`);
}

function requireCredentials(username, password) {
  if (
    typeof username !== "string" ||
    username.length === 0 ||
    typeof password !== "string" ||
    password.length === 0
  ) {
    throw new Error("Central deployment credentials are required.");
  }
}

function writePrivateSettings({ password, settingsPath, username }) {
  const descriptor = openSync(settingsPath, "wx", 0o600);
  try {
    writeFileSync(
      descriptor,
      `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <servers>
    <server>
      <id>central-snapshots</id>
      <username>${xml(username)}</username>
      <password>${xml(password)}</password>
    </server>
  </servers>
</settings>
`,
    );
  } finally {
    closeSync(descriptor);
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseRequest(arguments_) {
  const [operation, ...options] = arguments_;
  if (!["dry-run", "execute", "execute-local"].includes(operation)) {
    throw new Error(`Unsupported deployment operation '${operation ?? ""}'.`);
  }
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (
      !["--bundle", "--identity", "--settings", "--repository"].includes(
        option,
      ) ||
      !value ||
      value.startsWith("--") ||
      values[option]
    ) {
      throw new Error(`Invalid deployment option '${option ?? ""}'.`);
    }
    values[option] = value;
  }
  const local = operation === "execute-local";
  if (
    !values["--bundle"] ||
    !values["--identity"] ||
    (local
      ? !values["--repository"] || values["--settings"]
      : !values["--settings"] || values["--repository"])
  ) {
    throw new Error(
      "Deployment requires --bundle, --identity, and --settings (or execute-local with --repository file://...).",
    );
  }
  return {
    bundleDirectory: values["--bundle"],
    encodedIdentity: values["--identity"],
    fileRepository: values["--repository"],
    operation,
    settingsPath: values["--settings"],
  };
}

async function run() {
  const request = parseRequest(process.argv.slice(2));
  if (request.operation === "dry-run") {
    console.log(
      JSON.stringify(
        buildDeploymentPlan({
          bundleDirectory: request.bundleDirectory,
          encodedIdentity: request.encodedIdentity,
          settingsPath: request.settingsPath,
        }),
        null,
        2,
      ),
    );
    return;
  }
  const deployment = {
    bundleDirectory: request.bundleDirectory,
    encodedIdentity: request.encodedIdentity,
    fileRepository: request.fileRepository,
    password: process.env.CENTRAL_PASSWORD,
    settingsPath: request.settingsPath,
    username: process.env.CENTRAL_USERNAME,
  };
  const result =
    request.operation === "execute-local"
      ? executeDeployment(deployment)
      : await publishDeployment({
          ...deployment,
          publicationOperation: process.env.PUBLISHER_OPERATION,
        });
  if (result.observation) {
    const summary = `Confirmed ${result.identity.groupId} at ${result.identity.version}. ${result.observation.summary}.`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildDeploymentPlan, executeDeployment, publishDeployment };
