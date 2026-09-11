const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { inflateRawSync } = require("node:zlib");
const { collectCandidate } = require("./artifact-policy.cjs");
const { notice, provenance } = require("./prepare-upstream.cjs");
const {
  decodeIdentity,
  requireDerivedIdentity,
} = require("./publisher-policy.cjs");

const PROVENANCE_ENTRY = "META-INF/seed4j-main-snapshot.properties";
const MAX_PROVENANCE_BYTES = 16 * 1024;

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

function readZipEntry(zipPath, expectedName) {
  const archive = readFileSync(zipPath);
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    archive.readUInt16LE(endOffset + 4) !== 0 ||
    archive.readUInt16LE(endOffset + 6) !== 0 ||
    archive.readUInt16LE(endOffset + 8) !== entryCount ||
    centralOffset + centralSize > endOffset
  ) {
    throw new Error("Main JAR is not a supported single-disk ZIP archive.");
  }
  let offset = centralOffset;
  let match;
  for (let index = 0; index < entryCount; index++) {
    requireRange(archive, offset, 46);
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Main JAR central directory is invalid.");
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(archive, offset, recordLength);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (name === expectedName) {
      if (match) {
        throw new Error(
          `Main JAR contains duplicate '${expectedName}' entries.`,
        );
      }
      match = {
        compressedSize: archive.readUInt32LE(offset + 20),
        crc: archive.readUInt32LE(offset + 16),
        flags: archive.readUInt16LE(offset + 8),
        localOffset: archive.readUInt32LE(offset + 42),
        method: archive.readUInt16LE(offset + 10),
        uncompressedSize: archive.readUInt32LE(offset + 24),
      };
    }
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize || !match) {
    throw new Error(
      `Main JAR does not contain exact embedded provenance '${expectedName}'.`,
    );
  }
  return readLocalEntry(archive, expectedName, match);
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset--) {
    if (
      archive.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
    ) {
      return offset;
    }
  }
  throw new Error("Main JAR does not contain a valid ZIP central directory.");
}

function readLocalEntry(archive, expectedName, entry) {
  if (
    (entry.flags & 1) !== 0 ||
    ![0, 8].includes(entry.method) ||
    entry.uncompressedSize > MAX_PROVENANCE_BYTES
  ) {
    throw new Error(
      "Main JAR embedded provenance uses an unsupported ZIP representation.",
    );
  }
  requireRange(archive, entry.localOffset, 30);
  if (archive.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("Main JAR embedded provenance local header is invalid.");
  }
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  requireRange(
    archive,
    entry.localOffset,
    30 + nameLength + extraLength + entry.compressedSize,
  );
  if (
    archive
      .subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength)
      .toString("utf8") !== expectedName
  ) {
    throw new Error("Main JAR embedded provenance local filename is invalid.");
  }
  const compressed = archive.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );
  const content =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: MAX_PROVENANCE_BYTES });
  if (
    content.length !== entry.uncompressedSize ||
    crc32(content) !== entry.crc
  ) {
    throw new Error("Main JAR embedded provenance integrity check failed.");
  }
  return content;
}

function requireRange(buffer, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error("Main JAR ZIP structure is out of bounds.");
  }
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
