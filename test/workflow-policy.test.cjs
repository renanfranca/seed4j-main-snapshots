const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const repositoryRoot = resolve(__dirname, "..");
const approvedActions = Object.freeze({
  "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/setup-java": "b6effb05e454b25005698d916606bdc6ffcbf961",
  "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
});

test("pull requests and main pushes run every publisher validation with only pinned read-only actions", () => {
  const workflow = read(".github/workflows/tests.yml");

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(
    workflow,
    /npm ci[\s\S]*npm test[\s\S]*npm run prettier:check[\s\S]*\.\/mvnw --version[\s\S]*npm run dry-run/,
  );
  assert.doesNotMatch(
    workflow,
    /CENTRAL_|environment:|issues: write|contents: write/,
  );
  assert.deepEqual(actions(workflow), [
    approvedAction("actions/checkout"),
    approvedAction("actions/setup-node"),
    approvedAction("actions/setup-java"),
  ]);
});

test("committed publisher defaults keep schedules inert before the observed pilot", () => {
  const config = JSON.parse(read("config/publisher.json"));
  const directory = mkdtempSync(join(tmpdir(), "publisher-config-"));
  const outputPath = join(directory, "github-output");

  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, "scripts/qualify-candidate.cjs"),
      "--config",
      resolve(repositoryRoot, "config/publisher.json"),
    ],
    {
      encoding: "utf8",
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "renanfranca/seed4j-main-snapshots",
        PUBLISHER_EVENT: "schedule",
        PUBLISHER_OPERATION: "head",
        PUBLISHER_REF: "refs/heads/main",
        PUBLISHER_SCHEDULE: "17 6 * * 1",
      },
    },
  );

  assert.deepEqual(config, {
    centralTokenExpiresAt: "2027-03-10",
    pilotCompleted: false,
    quotaReview: null,
    scheduleMode: "weekly",
    schemaVersion: 1,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(outputPath, "utf8"),
    "outcome=skip\nreason=pilot-not-completed\n",
  );
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  rmSync(directory, { force: true, recursive: true });
});

test("publication keeps untrusted build code outside the main-only Central credential boundary", () => {
  const workflow = read(".github/workflows/publish.yml");
  const build = job(workflow, "build");
  const verificationStep = step(build, "Run complete upstream verification");
  const verificationAdapter = read("scripts/run-upstream-verification.cjs");

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /operation:[\s\S]*type: choice[\s\S]*options:\s+- head\s+- retry-last-failed/,
  );
  assert.match(workflow, /cron: ["']17 6 \* \* 1["']/);
  assert.match(workflow, /cron: ["']17 6 \* \* 0,2-6["']/);
  assert.doesNotMatch(
    workflow,
    /pull_request:|pull_request_target:|push:|workflow_call:/,
  );
  assert.match(workflow, /permissions: \{\}/);
  assert.match(
    workflow,
    /concurrency:\s+group: seed4j-main-snapshot-publisher\s+cancel-in-progress: false/,
  );

  assert.match(
    job(workflow, "qualify"),
    /outputs:[\s\S]*outcome:[\s\S]*identity:[\s\S]*reason:[\s\S]*upstreamSha:/,
  );
  assert.match(
    job(workflow, "qualify"),
    /upstreamSha: \$\{\{ steps\.candidate\.outputs\['upstream-sha'\] \}\}/,
  );
  assert.doesNotMatch(workflow, /outputs\.upstream-sha/);
  assert.doesNotMatch(job(workflow, "qualify"), /CENTRAL_|environment:|write/);
  assert.match(build, /if: needs\.qualify\.outputs\.outcome == 'publish'/);
  assert.match(build, /outputs:[\s\S]*diagnostic:/);
  assert.match(build, /repository: seed4j\/seed4j/);
  assert.match(build, /ref: \$\{\{ needs\.qualify\.outputs\.upstreamSha \}\}/);
  assert.match(build, /persist-credentials: false/);
  assert.match(
    build,
    /Apply personal publication overlay and provenance[\s\S]*Install upstream dependencies[\s\S]*npm ci[\s\S]*Format personal POM overlay with upstream Prettier[\s\S]*Run applicable upstream lint[\s\S]*npm run lint:ci[\s\S]*Run complete upstream verification[\s\S]*node publisher\/scripts\/run-upstream-verification\.cjs --checkout upstream[\s\S]*Collect the exact data-only candidate bundle/,
  );
  assert.match(
    verificationStep,
    /node publisher\/scripts\/run-upstream-verification\.cjs --checkout upstream 2>&1 \| tee "\$RUNNER_TEMP\/publisher-build\.log"/,
  );
  assert.doesNotMatch(
    verificationStep,
    /\.\/mvnw|skip|retry|continue-on-error|CENTRAL_|secrets\./i,
  );
  assert.match(
    verificationAdapter,
    /"--batch-mode",\s*"-ntp",\s*"clean",\s*"verify"/,
  );
  assert.doesNotMatch(
    verificationAdapter,
    /-Dskip|skipTests|retry|continue-on-error|CENTRAL_|secrets\./i,
  );
  assert.match(
    build,
    /- name: Format personal POM overlay with upstream Prettier\n        id: format_upstream_pom\n        working-directory: upstream\n        run: \|\n          printf '%s' 'Format personal POM overlay with upstream Prettier' > "\$RUNNER_TEMP\/publisher-build-step"\n          set -o pipefail\n          \.\/node_modules\/\.bin\/prettier --write pom\.xml 2>&1 \| tee "\$RUNNER_TEMP\/publisher-build\.log"/,
  );
  assert.match(
    build,
    /WORKFLOW_STEP_OUTCOMES: .*\["Format personal POM overlay with upstream Prettier","\$\{\{ steps\.format_upstream_pom\.outcome \}\}"\]/,
  );
  assert.doesNotMatch(
    build,
    /\bnpx\b|\bnpm exec\b|prettier --write \.(?:\s|$)|npm run prettier:format/,
  );
  assert.doesNotMatch(build, /continue-on-error:/);
  assert.match(
    build,
    /node-version: 24[\s\S]*java-version: 25[\s\S]*collect-candidate\.cjs[\s\S]*upload-artifact/,
  );
  assert.doesNotMatch(
    build,
    /CENTRAL_|environment:|issues: write|contents: write/,
  );

  assert.match(job(workflow, "deploy"), /github\.ref == 'refs\/heads\/main'/);
  assert.match(job(workflow, "deploy"), /github\.event_name == 'schedule'/);
  assert.match(
    job(workflow, "deploy"),
    /github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(job(workflow, "deploy"), /needs\.build\.result == 'success'/);
  assert.match(job(workflow, "deploy"), /environment: central-snapshots/);
  assert.match(job(workflow, "deploy"), /download-artifact/);
  assert.match(job(workflow, "deploy"), /deploy-candidate\.cjs execute/);
  assert.match(
    job(workflow, "deploy"),
    /PUBLISHER_IDENTITY: \$\{\{ needs\.qualify\.outputs\.identity \}\}/,
  );
  assert.match(job(workflow, "deploy"), /--identity "\$PUBLISHER_IDENTITY"/);
  assert.match(job(workflow, "deploy"), /outputs:[\s\S]*diagnostic:/);
  assert.match(
    job(workflow, "deploy"),
    /CENTRAL_USERNAME: \$\{\{ secrets\.CENTRAL_USERNAME \}\}/,
  );
  assert.match(
    job(workflow, "deploy"),
    /CENTRAL_PASSWORD: \$\{\{ secrets\.CENTRAL_PASSWORD \}\}/,
  );
  assert.doesNotMatch(
    job(workflow, "deploy"),
    /repository: seed4j\/seed4j|working-directory: upstream|\.\/upstream\/mvnw|node upstream|npm run|issues: write/,
  );

  assert.match(job(workflow, "report"), /if: always\(\)/);
  assert.match(job(workflow, "report"), /issues: write/);
  assert.match(
    job(workflow, "report"),
    /BUILD_DIAGNOSTIC: \$\{\{ needs\.build\.outputs\.diagnostic \}\}/,
  );
  assert.match(
    job(workflow, "report"),
    /DEPLOY_DIAGNOSTIC: \$\{\{ needs\.deploy\.outputs\.diagnostic \}\}/,
  );
  assert.match(
    job(workflow, "report"),
    /QUALIFY_RESULT: \$\{\{ needs\.qualify\.result \}\}/,
  );
  assert.doesNotMatch(job(workflow, "report"), /CENTRAL_|environment:/);
  assert.match(job(workflow, "token-rotation"), /issues: write/);
  assert.match(
    job(workflow, "token-rotation"),
    /token-rotation\.cjs --config config\/publisher\.json/,
  );
  assert.doesNotMatch(
    job(workflow, "token-rotation"),
    /CENTRAL_|environment:|seed4j\/seed4j/,
  );

  assert.deepEqual(
    [...new Set(actions(workflow))].sort(),
    Object.keys(approvedActions).map(approvedAction).sort(),
  );
  assertApprovedActions(workflow);
});

test("dependency updates stay pinned, delayed, and require human review", () => {
  const policy = JSON.parse(read("renovate.json"));

  assert.equal(policy.automerge, false);
  assert.equal(policy.rangeStrategy, "pin");
  assert.equal(policy.minimumReleaseAge, "7 days");
  assert.ok(policy.extends.includes("config:recommended"));
  assert.ok(
    policy.packageRules.some(
      (rule) =>
        rule.matchManagers?.includes("github-actions") &&
        rule.pinDigests === true &&
        rule.automerge === false,
    ),
  );
  assert.ok(
    policy.packageRules.some(
      (rule) =>
        rule.matchManagers?.includes("npm") &&
        rule.rangeStrategy === "pin" &&
        rule.automerge === false,
    ),
  );
  assert.ok(
    policy.packageRules.some(
      (rule) =>
        rule.matchManagers?.includes("maven-wrapper") &&
        rule.automerge === false,
    ),
  );
});

test("the operator runbook makes every publication and recovery gate explicit", () => {
  const readme = read("README.md");
  const config = JSON.parse(read("config/publisher.json"));
  const documentedExpiryKey = /record the token expiry as `([^`]+)`/.exec(
    readme,
  )?.[1];

  assert.match(readme, /unofficial/i);
  assert.match(readme, /io\.github\.renanfranca:seed4j-main-snapshot/);
  assert.match(readme, /POM[\s\S]*main JAR[\s\S]*tests/i);
  assert.match(readme, /sources and Javadoc JARs[^\n]*not published/i);
  assert.match(readme, /provenance[\s\S]*exact upstream SHA/i);
  assert.match(readme, /60 days/);
  assert.match(readme, /protected[^\n]*`central-snapshots`[^\n]*Environment/i);
  assert.match(readme, /manually\s+observed pilot/i);
  assert.match(readme, /main[^\n]*only/i);
  assert.match(readme, /180-day/);
  assert.match(readme, /publisher-failure[\s\S]*publisher-token-rotation/);
  assert.match(readme, /Monday[^\n]*06:17 UTC/i);
  assert.match(readme, /daily[\s\S]*80%/i);
  assert.match(readme, /retry-last-failed/);
  assert.match(readme, /monitor/i);
  assert.match(readme, /rollback|disable/i);
  assert.match(
    readme,
    /qualification and build jobs[^\n]*never receive[^\n]*deployment secrets/i,
  );
  assert.equal(documentedExpiryKey, "centralTokenExpiresAt");
  assert.ok(Object.hasOwn(config, documentedExpiryKey));
  assert.doesNotMatch(readme, /centralTokenExpiresOn/);
});

function read(path) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function actions(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
}

function approvedAction(repository) {
  return `${repository}@${approvedActions[repository]}`;
}

function assertApprovedActions(workflow) {
  for (const action of actions(workflow)) {
    const [repository, revision] = action.split("@");
    assert.equal(
      revision,
      approvedActions[repository],
      `${repository} must use its reviewed immutable commit`,
    );
  }
}

function job(workflow, name) {
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]+:\\s*$|(?![\\s\\S]))`,
    "m",
  ).exec(workflow);
  assert.ok(match, `Missing ${name} job`);
  return match[0];
}

function step(workflowJob, name) {
  const match = new RegExp(
    `^      - name: ${name}\\n([\\s\\S]*?)(?=^      - name: |(?![\\s\\S]))`,
    "m",
  ).exec(workflowJob);
  assert.ok(match, `Missing ${name} step`);
  return match[0];
}
