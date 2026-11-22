const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");

function runUpstreamVerification(checkout) {
  const result = spawnSync(
    join(checkout, process.platform === "win32" ? "mvnw.cmd" : "mvnw"),
    ["--batch-mode", "-ntp", "clean", "verify"],
    { cwd: checkout, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `Upstream clean verification failed with exit code ${result.status ?? "unknown"}.`,
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

try {
  const [option, checkout, ...extra] = process.argv.slice(2);
  if (
    option !== "--checkout" ||
    !checkout ||
    checkout.startsWith("--") ||
    extra.length
  ) {
    throw new Error(
      "Upstream verification requires exactly --checkout <directory>.",
    );
  }
  runUpstreamVerification(resolve(checkout));
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
