const { existsSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createCandidateManifest } = require("./artifact-policy.cjs");
const { buildDeploymentPlan } = require("./deploy-candidate.cjs");

const dryRunRoot = join(tmpdir(), "seed4j-main-snapshots-dry-run");
const evidenceDirectory = join(dryRunRoot, "candidate");
const settingsPath = join(dryRunRoot, "central-settings.xml");
const identity = Object.freeze({
  artifactId: "seed4j-main-snapshot",
  groupId: "io.github.renanfranca",
  upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
  upstreamPomVersion: "2.2.1-SNAPSHOT",
  upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
  version: "2.2.1-main.20260907.055800.4eebd07bce14-SNAPSHOT",
});

rmSync(dryRunRoot, { force: true, recursive: true });
mkdirSync(evidenceDirectory, { recursive: true });
const prefix = join(
  evidenceDirectory,
  `${identity.artifactId}-${identity.version}`,
);
writeFileSync(`${prefix}.pom`, dryRunPom());
writeFileSync(`${prefix}.jar`, "credential-free dry-run main JAR\n");
writeFileSync(`${prefix}-tests.jar`, "credential-free dry-run tests JAR\n");
const manifest = createCandidateManifest({
  candidateDirectory: evidenceDirectory,
  identity,
});
writeFileSync(
  join(evidenceDirectory, "candidate-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const deploymentPlan = buildDeploymentPlan({
  bundleDirectory: evidenceDirectory,
  settingsPath,
});
if (existsSync(settingsPath)) {
  throw new Error(
    "Credential-free dry run unexpectedly created a Maven settings file.",
  );
}
console.log(
  JSON.stringify({ deploymentPlan, evidenceDirectory, manifest }, null, 2),
);

function dryRunPom() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.0.6</version>
  </parent>
  <groupId>${identity.groupId}</groupId>
  <artifactId>${identity.artifactId}</artifactId>
  <version>${identity.version}</version>
  <name>Unofficial Seed4J main snapshot</name>
  <distributionManagement>
    <snapshotRepository>
      <id>central-snapshots</id>
      <url>https://central.sonatype.com/repository/maven-snapshots/</url>
    </snapshotRepository>
  </distributionManagement>
  <properties />
</project>
`;
}
