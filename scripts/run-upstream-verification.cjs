const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const HEADLESS_SCRIPT = "test:component:headless";
const KNOWN_HEADLESS_RUNNER =
  'concurrently -k -s first -n dev,test "npm run dev" "wait-on http://localhost:9000 && cypress run --headless --config-file src/test/webapp/component/cypress-config.ts"';
const PREPARE_INSTRUMENTED_PREVIEW = String.raw`node --input-type=module --eval 'process.env.NODE_ENV = "development"; const { build, loadConfigFromFile } = await import("./node_modules/vite/dist/node/index.js"); const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, undefined, process.cwd()); const istanbul = loaded.config.plugins.find(plugin => plugin.name === "vite:istanbul"); if (!istanbul) throw new Error("Missing expected vite:istanbul plugin."); istanbul.apply = () => true; await build({ ...loaded.config, build: { ...loaded.config.build, emptyOutDir: true } });'`;
const TEMPORARY_HEADLESS_RUNNER = String.raw`${PREPARE_INSTRUMENTED_PREVIEW} && concurrently -k -s first -n tikui,vite,test "./node_modules/.bin/tikui-core preview" "./node_modules/.bin/vite preview --port 9000 --strictPort" "./node_modules/.bin/wait-on --timeout 30000 http-get://localhost:9000/style/tikui.css && bytes=\$(curl --fail --silent http://localhost:9000/style/tikui.css | wc -c) && test \"\$bytes\" -gt 0 && printf 'Resolved TikUI CSS bytes: %s\\n' \"\$bytes\" && ./node_modules/.bin/cypress run --headless --config-file src/test/webapp/component/cypress-config.ts"`;
const MAVEN_ARGUMENTS = Object.freeze([
  "--batch-mode",
  "-ntp",
  "clean",
  "verify",
]);

function runUpstreamVerification({
  checkoutDirectory,
  executeMaven = spawnSync,
}) {
  const checkout = resolve(checkoutDirectory);
  const packagePath = join(checkout, "package.json");
  const lockfilePath = join(checkout, "package-lock.json");
  const originalPackage = readFileSync(packagePath);
  const originalLockfile = readFileSync(lockfilePath);
  const packageDefinition = parseJson(originalPackage, "package.json");
  const lockfileDefinition = parseJson(originalLockfile, "package-lock.json");

  validateUpstreamContract({
    checkout,
    lockfileDefinition,
    packageDefinition,
  });

  const temporaryPackage = {
    ...packageDefinition,
    scripts: {
      ...packageDefinition.scripts,
      [HEADLESS_SCRIPT]: TEMPORARY_HEADLESS_RUNNER,
    },
  };
  const manifests = [
    { contents: originalPackage, name: "package.json", path: packagePath },
    {
      contents: originalLockfile,
      name: "package-lock.json",
      path: lockfilePath,
    },
  ];
  let verificationFailure;
  let restorationFailure;

  try {
    writeFileSync(
      packagePath,
      Buffer.from(`${JSON.stringify(temporaryPackage, null, 2)}\n`),
    );
    console.log(
      "Running ./mvnw --batch-mode -ntp clean verify with the temporary watcher-free component runner.",
    );
    const result = executeMaven(
      join(checkout, process.platform === "win32" ? "mvnw.cmd" : "mvnw"),
      MAVEN_ARGUMENTS,
      {
        cwd: checkout,
        env: { ...process.env, npm_config_save: "false" },
        stdio: "inherit",
      },
    );

    if (!readFileSync(lockfilePath).equals(originalLockfile)) {
      throw new Error(
        "Upstream package-lock.json changed during clean verification.",
      );
    }
    if (result.error) {
      throw new Error(
        `Unable to execute the upstream Maven Wrapper: ${result.error.message}`,
      );
    }
    if (result.status !== 0) {
      const error = new Error(
        `Upstream clean verification failed with exit code ${result.status ?? "unknown"}.`,
      );
      if (Number.isInteger(result.status) && result.status > 0) {
        error.exitCode = result.status;
      }
      throw error;
    }
  } catch (error) {
    verificationFailure = error;
  } finally {
    try {
      restoreManifests(manifests);
    } catch (error) {
      restorationFailure = error;
    }
  }

  if (restorationFailure) {
    const priorFailure = verificationFailure
      ? ` Verification also failed: ${verificationFailure.message}`
      : "";
    throw new Error(`${restorationFailure.message}${priorFailure}`);
  }
  if (verificationFailure) {
    throw verificationFailure;
  }
}

function parseJson(contents, name) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`Upstream ${name} is not valid JSON.`);
  }
}

function validateUpstreamContract({
  checkout,
  lockfileDefinition,
  packageDefinition,
}) {
  if (
    packageDefinition.name !== "seed4j" ||
    packageDefinition.scripts?.[HEADLESS_SCRIPT] !== KNOWN_HEADLESS_RUNNER
  ) {
    throw new Error(
      "Upstream package.json does not match the known Seed4J headless runner contract.",
    );
  }
  if (
    lockfileDefinition.name !== "seed4j" ||
    lockfileDefinition.packages?.[""]?.name !== "seed4j"
  ) {
    throw new Error(
      "Upstream package-lock.json does not match the expected Seed4J package.",
    );
  }
  const tikuiConfiguration = parseJson(
    readFileSync(join(checkout, "tikuiconfig.json")),
    "tikuiconfig.json",
  );
  if (
    !Number.isInteger(tikuiConfiguration.port) ||
    tikuiConfiguration.port < 1 ||
    tikuiConfiguration.port > 65_535
  ) {
    throw new Error(
      "Upstream tikuiconfig.json does not define a valid TikUI preview port.",
    );
  }
}

function restoreManifests(manifests) {
  const problems = [];

  for (const manifest of manifests) {
    try {
      writeFileSync(manifest.path, manifest.contents);
    } catch (error) {
      problems.push(`${manifest.name}: ${error.message}`);
    }
  }
  for (const manifest of manifests) {
    try {
      if (!readFileSync(manifest.path).equals(manifest.contents)) {
        problems.push(`${manifest.name}: restored bytes differ`);
      }
    } catch (error) {
      problems.push(`${manifest.name}: ${error.message}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Upstream manifest restoration failed: ${problems.join("; ")}`,
    );
  }
}

function parseRequest(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== "--checkout" ||
    !arguments_[1] ||
    arguments_[1].startsWith("--")
  ) {
    throw new Error(
      "Upstream verification requires exactly --checkout <directory>.",
    );
  }
  return { checkoutDirectory: arguments_[1] };
}

function run() {
  runUpstreamVerification(parseRequest(process.argv.slice(2)));
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}

module.exports = {
  KNOWN_HEADLESS_RUNNER,
  MAVEN_ARGUMENTS,
  PREPARE_INSTRUMENTED_PREVIEW,
  TEMPORARY_HEADLESS_RUNNER,
  parseRequest,
  runUpstreamVerification,
};
