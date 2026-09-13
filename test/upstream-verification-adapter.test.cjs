const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const {
  KNOWN_HEADLESS_RUNNER,
} = require("../scripts/run-upstream-verification.cjs");

const repositoryRoot = resolve(__dirname, "..");
const adapterPath = resolve(
  repositoryRoot,
  "scripts/run-upstream-verification.cjs",
);

test("applies the preview runner only during the complete Maven verification", (context) => {
  const fixture = upstreamFixture(context);

  const result = runAdapter(fixture);

  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(readFileSync(fixture.capturePath, "utf8"));
  assert.deepEqual(observation.arguments, [
    "--batch-mode",
    "-ntp",
    "clean",
    "verify",
  ]);
  assert.deepEqual(observation.packageDefinition, {
    ...fixture.packageDefinition,
    scripts: {
      ...fixture.packageDefinition.scripts,
      "test:component:headless": observation.temporaryRunner,
    },
  });
  assert.match(observation.temporaryRunner, /concurrently -k -s first/);
  assert.match(
    observation.temporaryRunner,
    /vite:istanbul[\s\S]*emptyOutDir: true/,
  );
  assert.match(observation.temporaryRunner, /tikui-core preview/);
  assert.match(
    observation.temporaryRunner,
    /vite preview --port 9000 --strictPort/,
  );
  assert.match(
    observation.temporaryRunner,
    /wait-on --timeout 30000 http-get:\/\/localhost:9000\/style\/tikui\.css/,
  );
  assert.match(
    observation.temporaryRunner,
    /cypress run --headless --config-file src\/test\/webapp\/component\/cypress-config\.ts/,
  );
  assert.doesNotMatch(observation.temporaryRunner, /npm run dev/);
  assert.equal(
    observation.packageDefinition.scripts["test:coverage:check"],
    fixture.packageDefinition.scripts["test:coverage:check"],
  );
  assert.equal(observation.npmConfigSave, "false");
  assert.equal(
    readFileSync(fixture.cypressConfigurationPath, "utf8"),
    fixture.cypressConfiguration,
  );
  assertRestored(fixture);
});

test("restores both manifests after Maven fails and propagates its exit code", (context) => {
  const fixture = upstreamFixture(context);

  const result = runAdapter(fixture, {
    FAKE_MAVEN_EXIT_CODE: "19",
    FAKE_MAVEN_MUTATE_PACKAGE: "true",
  });

  assert.equal(result.status, 19);
  assert.match(
    result.stderr,
    /Upstream clean verification failed with exit code 19/,
  );
  assertRestored(fixture);
});

test("rejects an unexpected upstream watcher contract before Maven runs", (context) => {
  const fixture = upstreamFixture(context);
  fixture.packageDefinition.scripts["test:component:headless"] += " --changed";
  fixture.originalPackage = Buffer.from(
    `${JSON.stringify(fixture.packageDefinition, null, 2)}\n`,
  );
  writeFileSync(fixture.packagePath, fixture.originalPackage);

  const result = runAdapter(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /known Seed4J headless runner contract/);
  assert.equal(existsSync(fixture.capturePath), false);
  assertRestored(fixture);
});

test("detects and restores a lockfile changed by Maven", (context) => {
  const fixture = upstreamFixture(context);

  const result = runAdapter(fixture, {
    FAKE_MAVEN_MUTATE_LOCKFILE: "true",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /package-lock\.json changed during clean verification/,
  );
  assertRestored(fixture);
});

function upstreamFixture(context) {
  const checkout = mkdtempSync(join(tmpdir(), "publisher-upstream-"));
  context.after(() => rmSync(checkout, { force: true, recursive: true }));
  const packageDefinition = {
    name: "seed4j",
    version: "2.2.1-SNAPSHOT",
    type: "module",
    scripts: {
      build: "npm-run-all build:*",
      "test:component:headless": KNOWN_HEADLESS_RUNNER,
      "test:coverage:check":
        "npm-run-all test:coverage:clean test:coverage:copy:* test:coverage:merge test:coverage:report",
    },
  };
  const packagePath = join(checkout, "package.json");
  const lockfilePath = join(checkout, "package-lock.json");
  const originalPackage = Buffer.from(
    `${JSON.stringify(packageDefinition, null, 2)}\n`,
  );
  const originalLockfile = Buffer.from(
    `${JSON.stringify(
      {
        name: "seed4j",
        version: "2.2.1-SNAPSHOT",
        lockfileVersion: 3,
        packages: {
          "": { name: "seed4j", version: "2.2.1-SNAPSHOT" },
        },
      },
      null,
      2,
    )}\n`,
  );
  const cypressConfigurationPath = join(
    checkout,
    "src/test/webapp/component/cypress-config.ts",
  );
  const cypressConfiguration =
    "export default { coverage: true, specPattern: '**/*.spec.ts' };\n";
  const capturePath = join(checkout, "maven-observation.json");

  mkdirSync(resolve(cypressConfigurationPath, ".."), { recursive: true });
  writeFileSync(packagePath, originalPackage);
  writeFileSync(lockfilePath, originalLockfile);
  writeFileSync(
    join(checkout, "tikuiconfig.json"),
    '{"dist":"target/classes/public/style","port":9005}\n',
  );
  writeFileSync(cypressConfigurationPath, cypressConfiguration);
  writeFileSync(join(checkout, "mvnw"), fakeMavenWrapper(), { mode: 0o755 });

  return {
    capturePath,
    checkout,
    cypressConfiguration,
    cypressConfigurationPath,
    lockfilePath,
    originalLockfile,
    originalPackage,
    packageDefinition,
    packagePath,
  };
}

function fakeMavenWrapper() {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const checkout = process.cwd();
const packageDefinition = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
writeFileSync(
  process.env.FAKE_MAVEN_CAPTURE,
  JSON.stringify({
    arguments: process.argv.slice(2),
    packageDefinition,
    npmConfigSave: process.env.npm_config_save,
    temporaryRunner: packageDefinition.scripts["test:component:headless"],
  }),
);
if (process.env.FAKE_MAVEN_MUTATE_PACKAGE === "true") {
  appendFileSync(join(checkout, "package.json"), "mutated");
}
if (process.env.FAKE_MAVEN_MUTATE_LOCKFILE === "true") {
  appendFileSync(join(checkout, "package-lock.json"), "mutated");
}
process.exit(Number(process.env.FAKE_MAVEN_EXIT_CODE || "0"));
`;
}

function runAdapter(fixture, environment = {}) {
  return spawnSync(
    process.execPath,
    [adapterPath, "--checkout", fixture.checkout],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_MAVEN_CAPTURE: fixture.capturePath,
        ...environment,
      },
    },
  );
}

function assertRestored(fixture) {
  assert.deepEqual(readFileSync(fixture.packagePath), fixture.originalPackage);
  assert.deepEqual(
    readFileSync(fixture.lockfilePath),
    fixture.originalLockfile,
  );
}
