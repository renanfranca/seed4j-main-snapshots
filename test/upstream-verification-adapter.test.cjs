const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const adapterPath = resolve(
  __dirname,
  "../scripts/run-upstream-verification.cjs",
);

test("runs complete reactor verification with the upstream Playwright configuration", (context) => {
  const { checkout, packageJson } = upstreamFixture(context);

  const result = spawnSync(
    process.execPath,
    [adapterPath, "--checkout", checkout],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(readFileSync(join(checkout, "maven-observation.json"), "utf8")),
    {
      arguments: ["--batch-mode", "-ntp", "clean", "verify"],
      serverPackage: packageJson,
    },
  );
  assert.equal(
    readFileSync(join(checkout, "seed4j-server/package.json"), "utf8"),
    packageJson,
  );
});

test("propagates a failing reactor verification exit code", (context) => {
  const { checkout } = upstreamFixture(context);

  const result = spawnSync(
    process.execPath,
    [adapterPath, "--checkout", checkout],
    {
      encoding: "utf8",
      env: { ...process.env, FAKE_MAVEN_EXIT_CODE: "19" },
    },
  );

  assert.equal(result.status, 19);
  assert.match(
    result.stderr,
    /Upstream clean verification failed with exit code 19/,
  );
});

function upstreamFixture(context) {
  const checkout = mkdtempSync(join(tmpdir(), "publisher-upstream-"));
  context.after(() => rmSync(checkout, { force: true, recursive: true }));
  const packageJson =
    '{"scripts":{"test:component:headless":"playwright test -c src/test/webapp/component/playwright.config.ts"}}\n';
  mkdirSync(join(checkout, "seed4j-server"));
  writeFileSync(join(checkout, "seed4j-server/package.json"), packageJson);
  writeFileSync(
    join(checkout, "mvnw"),
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
writeFileSync("maven-observation.json", JSON.stringify({
  arguments: process.argv.slice(2),
  serverPackage: readFileSync("seed4j-server/package.json", "utf8"),
}));
process.exit(Number(process.env.FAKE_MAVEN_EXIT_CODE || "0"));
`,
    { mode: 0o755 },
  );
  return { checkout, packageJson };
}
