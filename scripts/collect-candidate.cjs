const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { collectCandidate } = require("./artifact-policy.cjs");
const { notice, provenance } = require("./prepare-upstream.cjs");
const {
  decodeIdentity,
  requireDerivedIdentity,
} = require("./publisher-policy.cjs");
const { readZipEntry } = require("./zip-policy.cjs");

const PROVENANCE_ENTRY = "META-INF/seed4j-main-snapshot.properties";

function collectQualifiedCandidate({
  checkoutDirectory,
  identity,
  outputDirectory,
}) {
  requireDerivedIdentity(identity);
  const mainJar = join(
    checkoutDirectory,
    "target",
    `${identity.artifactId}-${identity.version}.jar`,
  );
  const embeddedProvenance = readZipEntry(mainJar, PROVENANCE_ENTRY);
  if (embeddedProvenance.toString("utf8") !== provenance(identity)) {
    throw new Error(
      "Main JAR embedded provenance does not match the qualified candidate.",
    );
  }
  requireEmbeddedLegalMetadata({ checkoutDirectory, identity, mainJar });
  return collectCandidate({ checkoutDirectory, identity, outputDirectory });
}

function requireEmbeddedLegalMetadata({
  checkoutDirectory,
  identity,
  mainJar,
}) {
  let embeddedLicense;
  let embeddedNotice;
  try {
    embeddedLicense = readZipEntry(
      mainJar,
      "META-INF/LICENSE-seed4j-main-snapshot.txt",
    );
    embeddedNotice = readZipEntry(
      mainJar,
      "META-INF/NOTICE-seed4j-main-snapshot.txt",
    );
  } catch (error) {
    throw new Error(
      `Main JAR embedded legal metadata is invalid: ${error.message}`,
    );
  }
  if (
    !embeddedLicense.equals(
      readFileSync(join(checkoutDirectory, "LICENSE.txt")),
    ) ||
    embeddedNotice.toString("utf8") !== notice(identity)
  ) {
    throw new Error(
      "Main JAR embedded legal metadata does not match the qualified checkout.",
    );
  }
}

function parseRequest(arguments_) {
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--checkout", "--identity", "--output"].includes(option) ||
      !value ||
      value.startsWith("--") ||
      values[option]
    ) {
      throw new Error(`Invalid candidate collection option '${option ?? ""}'.`);
    }
    values[option] = value;
  }
  if (!values["--checkout"] || !values["--identity"] || !values["--output"]) {
    throw new Error(
      "Candidate collection requires --checkout, --identity, and --output.",
    );
  }
  return {
    checkoutDirectory: values["--checkout"],
    identity: decodeIdentity(values["--identity"]),
    outputDirectory: values["--output"],
  };
}

function run() {
  collectQualifiedCandidate(parseRequest(process.argv.slice(2)));
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { collectQualifiedCandidate, parseRequest, readZipEntry };
