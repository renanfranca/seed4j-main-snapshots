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
  encodeIdentity,
} = require("../scripts/publisher-policy.cjs");
const { prepareUpstream } = require("../scripts/prepare-upstream.cjs");

test("applies only personal publication metadata and immutable provenance to an exact upstream checkout", () => {
  const checkout = mkdtempSync(join(tmpdir(), "seed4j-upstream-"));
  mkdirSync(join(checkout, "src/main/java"), { recursive: true });
  writeFileSync(join(checkout, "pom.xml"), upstreamPom());
  writeFileSync(
    join(checkout, "package.json"),
    '{"name":"seed4j","version":"2.2.1-SNAPSHOT"}\n',
  );
  writeFileSync(join(checkout, "LICENSE.txt"), "upstream Apache license\n");
  writeFileSync(
    join(checkout, "src/main/java/App.java"),
    "final class App {}\n",
  );
  const identity = {
    artifactId: "seed4j-main-snapshot",
    groupId: "io.github.renanfranca",
    upstreamCommitTimestamp: "2026-09-07T05:58:00Z",
    upstreamLicenseSha256:
      "d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e",
    upstreamPomVersion: "2.2.1-SNAPSHOT",
    upstreamSha: "4eebd07bce14c9a6ac70bace157fcc616133e950",
    version:
      "2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT",
  };

  prepareUpstream({ checkoutDirectory: checkout, identity });

  const preparedPom = readFileSync(join(checkout, "pom.xml"), "utf8");
  assert.match(preparedPom, /<groupId>io\.github\.renanfranca<\/groupId>/);
  assert.match(preparedPom, /<artifactId>seed4j-main-snapshot<\/artifactId>/);
  assert.match(
    preparedPom,
    /<version>2\.2\.1-main\.20260907\.055800\.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT<\/version>/,
  );
  assert.match(preparedPom, /<name>Unofficial Seed4J main snapshot<\/name>/);
  assert.match(preparedPom, /unofficial rebuild of Seed4J main/);
  assert.match(
    preparedPom,
    /github\.com\/seed4j\/seed4j\/tree\/4eebd07bce14c9a6ac70bace157fcc616133e950/,
  );
  assert.match(preparedPom, /<id>renanfranca<\/id>/);
  assert.match(
    preparedPom,
    /<tag>4eebd07bce14c9a6ac70bace157fcc616133e950<\/tag>/,
  );
  assert.match(
    preparedPom,
    /https:\/\/central\.sonatype\.com\/repository\/maven-snapshots\//,
  );
  assert.doesNotMatch(
    preparedPom,
    /<groupId>com\.seed4j<\/groupId>\s*<artifactId>seed4j<\/artifactId>/,
  );
  assert.equal(
    readFileSync(join(checkout, "package.json"), "utf8"),
    '{"name":"seed4j","version":"2.2.1-SNAPSHOT"}\n',
  );
  assert.equal(
    readFileSync(join(checkout, "LICENSE.txt"), "utf8"),
    "upstream Apache license\n",
  );
  assert.equal(
    readFileSync(join(checkout, "src/main/java/App.java"), "utf8"),
    "final class App {}\n",
  );
  assert.equal(
    readFileSync(
      join(
        checkout,
        "src/main/resources/META-INF/seed4j-main-snapshot.properties",
      ),
      "utf8",
    ),
    `artifact-id=seed4j-main-snapshot
group-id=io.github.renanfranca
publisher=renanfranca
release-channel=unofficial-main-snapshot
upstream-commit=4eebd07bce14c9a6ac70bace157fcc616133e950
upstream-commit-timestamp=2026-09-07T05:58:00Z
upstream-license-sha256=d6088ea4fccd10711c8d58cacd766816b34d6f514aa835dd0d6c14cb22acf42e
upstream-pom-version=2.2.1-SNAPSHOT
upstream-repository=https://github.com/seed4j/seed4j
version=2.2.1-main.20260907.055800.4eebd07bce14c9a6ac70bace157fcc616133e950-SNAPSHOT
`,
  );
  assert.match(
    readFileSync(
      join(
        checkout,
        "src/main/resources/META-INF/NOTICE-seed4j-main-snapshot.txt",
      ),
      "utf8",
    ),
    /not an official Seed4J publication/,
  );
  assert.equal(
    readFileSync(
      join(
        checkout,
        "src/main/resources/META-INF/LICENSE-seed4j-main-snapshot.txt",
      ),
      "utf8",
    ),
    "upstream Apache license\n",
  );

  rmSync(checkout, { force: true, recursive: true });
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
    artifactId: "seed4j-main-snapshot",
  };

  const encoded = encodeIdentity(identity);

  assert.deepEqual(decodeIdentity(encoded), {
    artifactId: "seed4j-main-snapshot",
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
