const assert = require("node:assert/strict");
const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  decodeIdentity,
  deriveSnapshotIdentity,
  encodeIdentity,
} = require("../scripts/publisher-policy.cjs");
const { prepareUpstream } = require("../scripts/prepare-upstream.cjs");

test("rewrites the reactor parent and intermodule coordinates while preserving the server and package scripts", (context) => {
  const checkout = mkdtempSync(join(tmpdir(), "seed4j-reactor-"));
  context.after(() => rmSync(checkout, { force: true, recursive: true }));
  const identity = deriveSnapshotIdentity({
    artifactId: "seed4j-parent",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
  });
  const modules = [
    "seed4j-api",
    "seed4j-engine",
    "seed4j-test",
    "seed4j-core-modules",
    "seed4j-server",
  ];
  const packageJson =
    '{"scripts":{"test:component:headless":"playwright test"}}';
  writeFileSync(join(checkout, "LICENSE.txt"), "upstream Apache license\n");
  writeFileSync(
    join(checkout, "pom.xml"),
    upstreamPom()
      .replace(
        "<artifactId>seed4j</artifactId>",
        "<artifactId>seed4j-parent</artifactId>",
      )
      .replace("<packaging>jar</packaging>", "<packaging>pom</packaging>")
      .replace(
        "<properties>",
        `<modules>${modules.map((name) => `<module>${name}</module>`).join("")}</modules><properties>`,
      ),
  );
  for (const name of modules) {
    mkdirSync(join(checkout, name));
    writeFileSync(
      join(checkout, name, "pom.xml"),
      `<project><parent><groupId>com.seed4j</groupId><artifactId>seed4j-parent</artifactId><version>2.2.1-SNAPSHOT</version></parent><artifactId>${name === "seed4j-server" ? "seed4j" : name}</artifactId><dependencies><dependency><groupId>com.seed4j</groupId><artifactId>seed4j-api</artifactId>${name === "seed4j-server" ? "<version>2.2.1-SNAPSHOT</version>" : ""}</dependency></dependencies></project>`,
    );
  }
  writeFileSync(join(checkout, "seed4j-server", "package.json"), packageJson);

  prepareUpstream({ checkoutDirectory: checkout, identity });

  const parent = readFileSync(join(checkout, "pom.xml"), "utf8");
  assert.match(parent, /<packaging>pom<\/packaging>/);
  assert.match(parent, /<module>seed4j-server<\/module>/);
  for (const name of modules) {
    const pom = readFileSync(join(checkout, name, "pom.xml"), "utf8");
    assert.doesNotMatch(pom, />com\.seed4j<|>2\.2\.1-SNAPSHOT</);
    assert.ok(pom.includes(`<version>${identity.version}</version>`));
    assert.match(
      pom,
      /<groupId>io\.github\.renanfranca<\/groupId>\s*<artifactId>seed4j-api<\/artifactId>/,
    );
    if (name !== "seed4j-server") {
      const metadata = join(checkout, name, "src/main/resources/META-INF");
      assert.match(
        readFileSync(join(metadata, "seed4j-main-snapshot.properties"), "utf8"),
        new RegExp(`^artifact-id=${name}\n`),
      );
      assert.equal(
        readFileSync(
          join(metadata, "LICENSE-seed4j-main-snapshot.txt"),
          "utf8",
        ),
        "upstream Apache license\n",
      );
    }
  }
  assert.equal(
    readFileSync(join(checkout, "seed4j-server", "package.json"), "utf8"),
    packageJson,
  );
});

test("round-trips a qualified identity as one opaque workflow output and rejects altered identity fields", () => {
  const identity = {
    version:
      "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    groupId: "io.github.renanfranca",
    artifactId: "seed4j-parent",
  };

  const encoded = encodeIdentity(identity);

  assert.deepEqual(decodeIdentity(encoded), {
    artifactId: "seed4j-parent",
    groupId: "io.github.renanfranca",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    version:
      "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  });
  assert.throws(
    () =>
      decodeIdentity(
        Buffer.from(
          JSON.stringify({ ...identity, artifactId: "seed4j" }),
        ).toString("base64url"),
      ),
    /identity/i,
  );
  assert.throws(() => decodeIdentity("not-base64!"), /identity/i);
});

function upstreamPom() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.0.6</version>
  </parent>
  <groupId>com.seed4j</groupId>
  <artifactId>seed4j</artifactId>
  <version>2.2.1-SNAPSHOT</version>
  <name>seed4j</name>
  <description>seed4j</description>
  <packaging>jar</packaging>
  <url>https://github.com/seed4j/seed4j</url>
  <licenses><license><name>Apache License, version 2.0</name></license></licenses>
  <organization><name>seed4j</name></organization>
  <developers><developer><id>upstream</id></developer></developers>
  <scm><url>https://github.com/seed4j/seed4j</url></scm>
  <properties>
    <java.version>25</java.version>
  </properties>
</project>
`;
}
