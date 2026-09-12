const {
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  statSync,
} = require("node:fs");
const { sanitizeDiagnostic } = require("./operations-policy.cjs");

const MAX_LOG_BYTES = 64 * 1024;

function workflowFailureDiagnostic({
  latestLog,
  latestStep,
  outcomes,
  redactions = [],
  stage,
}) {
  const failedStep = [...outcomes]
    .reverse()
    .find(([, outcome]) => outcome === "failure")?.[0];
  const step = failedStep || `${stage} job`;
  const latestLine =
    failedStep === latestStep ? lastNonemptyLine(latestLog) : undefined;
  return sanitizeDiagnostic(
    latestLine
      ? `${stage}/${step} failed: ${latestLine}`
      : `${stage}/${step} failed; inspect the linked workflow run for the action diagnostic.`,
    { redactions },
  );
}

function lastNonemptyLine(log) {
  return String(log ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function readTail(path) {
  if (!path || !existsSync(path)) {
    return "";
  }
  const size = statSync(path).size;
  const length = Math.min(size, MAX_LOG_BYTES);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    readSync(descriptor, buffer, 0, length, size - length);
  } finally {
    closeSync(descriptor);
  }
  return buffer.toString("utf8");
}

function parseOutcomes(value) {
  let outcomes;
  try {
    outcomes = JSON.parse(value);
  } catch (_) {
    throw new Error("Workflow step outcomes are not valid JSON.");
  }
  if (
    !Array.isArray(outcomes) ||
    outcomes.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry.some((value) => typeof value !== "string"),
    )
  ) {
    throw new Error("Workflow step outcomes do not match the allowlist shape.");
  }
  return outcomes;
}

function run() {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    throw new Error("GITHUB_OUTPUT is required for workflow diagnostics.");
  }
  const diagnostic = workflowFailureDiagnostic({
    latestLog: readTail(process.env.WORKFLOW_LOG_PATH),
    latestStep: process.env.WORKFLOW_LATEST_STEP_PATH
      ? readFileSync(process.env.WORKFLOW_LATEST_STEP_PATH, "utf8")
      : undefined,
    outcomes: parseOutcomes(process.env.WORKFLOW_STEP_OUTCOMES),
    redactions: [process.env.CENTRAL_USERNAME, process.env.CENTRAL_PASSWORD],
    stage: process.env.WORKFLOW_STAGE,
  });
  appendFileSync(output, `diagnostic=${diagnostic}\n`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { workflowFailureDiagnostic };
