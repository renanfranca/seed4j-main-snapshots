const { closeSync, openSync, unlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { verifyCandidateBundle } = require("./artifact-policy.cjs");
const { decodeIdentity } = require("./publisher-policy.cjs");

function buildDeploymentPlan({
  bundleDirectory,
  encodedIdentity,
  settingsPath,
}) {
  const manifest = verifyCandidateBundle(
    bundleDirectory,
    decodeIdentity(encodedIdentity),
  );
  const prefix = join(
    bundleDirectory,
    `${manifest.publication.artifactId}-${manifest.publication.version}`,
  );
  return Object.freeze({
    arguments: [
      "--batch-mode",
      "-ntp",
      `--settings=${settingsPath}`,
      "org.apache.maven.plugins:maven-deploy-plugin:3.1.4:deploy-file",
      `-Durl=${manifest.publication.repositoryUrl}`,
      "-DrepositoryId=central-snapshots",
      `-DgroupId=${manifest.publication.groupId}`,
      `-DartifactId=${manifest.publication.artifactId}`,
      `-Dversion=${manifest.publication.version}`,
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
}

function executeDeployment({
  bundleDirectory,
  encodedIdentity,
  environment = process.env,
  password,
  repositoryDirectory = resolve(__dirname, ".."),
  settingsPath,
  stdio = "inherit",
  username,
}) {
  requireCredentials(username, password);
  const plan = buildDeploymentPlan({
    bundleDirectory,
    encodedIdentity,
    settingsPath,
  });
  writePrivateSettings({ password, settingsPath, username });
  const {
    CENTRAL_PASSWORD: _password,
    CENTRAL_USERNAME: _username,
    ...childEnvironment
  } = environment;
  try {
    const result = spawnSync(plan.command, plan.arguments, {
      cwd: repositoryDirectory,
      env: childEnvironment,
      stdio,
    });
    if (result.error) {
      throw result.error;
    }
    return result;
  } finally {
    unlinkSync(settingsPath);
  }
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
  if (operation !== "dry-run" && operation !== "execute") {
    throw new Error(`Unsupported deployment operation '${operation ?? ""}'.`);
  }
  const values = {};
  for (let index = 0; index < options.length; index += 2) {
    const option = options[index];
    const value = options[index + 1];
    if (
      !["--bundle", "--identity", "--settings"].includes(option) ||
      !value ||
      value.startsWith("--") ||
      values[option]
    ) {
      throw new Error(`Invalid deployment option '${option ?? ""}'.`);
    }
    values[option] = value;
  }
  if (!values["--bundle"] || !values["--identity"] || !values["--settings"]) {
    throw new Error(
      "Deployment requires --bundle, --identity, and --settings.",
    );
  }
  return {
    bundleDirectory: values["--bundle"],
    encodedIdentity: values["--identity"],
    operation,
    settingsPath: values["--settings"],
  };
}

function run() {
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
  const result = executeDeployment({
    bundleDirectory: request.bundleDirectory,
    encodedIdentity: request.encodedIdentity,
    password: process.env.CENTRAL_PASSWORD,
    settingsPath: request.settingsPath,
    username: process.env.CENTRAL_USERNAME,
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildDeploymentPlan, executeDeployment, parseRequest };
