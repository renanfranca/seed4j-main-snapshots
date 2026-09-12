const assert = require("node:assert/strict");
const test = require("node:test");

const {
  workflowFailureDiagnostic,
} = require("../scripts/workflow-diagnostic.cjs");

test("reports the actual failed step and a bounded sanitized latest log line", () => {
  const diagnostic = workflowFailureDiagnostic({
    latestLog:
      "downloading\nAuthorization: Bearer secret-value\nregistry returned 503\u0000".repeat(
        10,
      ),
    latestStep: "Install upstream dependencies",
    outcomes: [
      ["Checkout trusted publisher", "success"],
      ["Install upstream dependencies", "failure"],
      ["Upload candidate", "skipped"],
    ],
    redactions: ["another-secret"],
    stage: "build",
  });

  assert.match(diagnostic, /^build\/Install upstream dependencies failed: /);
  assert.match(diagnostic, /registry returned 503/);
  assert.doesNotMatch(diagnostic, /secret-value|another-secret|[\r\n\u0000]/);
  assert.ok(diagnostic.length <= 240);
});

test("reports an action failure without reusing an earlier successful step log", () => {
  assert.equal(
    workflowFailureDiagnostic({
      latestLog: "candidate collected successfully",
      latestStep: "Collect candidate",
      outcomes: [
        ["Collect candidate", "success"],
        ["Upload candidate", "failure"],
      ],
      stage: "build",
    }),
    "build/Upload candidate failed; inspect the linked workflow run for the action diagnostic.",
  );
});
