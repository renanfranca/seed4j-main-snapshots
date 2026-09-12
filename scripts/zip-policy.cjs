const { readFileSync } = require("node:fs");
const { inflateRawSync } = require("node:zlib");

const MAX_METADATA_BYTES = 16 * 1024;

function createStoredZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const content = Buffer.from(value);
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, nameBuffer, content);
    centralRecords.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
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
      `Main JAR does not contain exact embedded metadata '${expectedName}'.`,
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
    entry.uncompressedSize > MAX_METADATA_BYTES
  ) {
    throw new Error(
      "Main JAR embedded metadata uses an unsupported ZIP representation.",
    );
  }
  requireRange(archive, entry.localOffset, 30);
  if (archive.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("Main JAR embedded metadata local header is invalid.");
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
    throw new Error("Main JAR embedded metadata local filename is invalid.");
  }
  const compressed = archive.subarray(
    dataOffset,
    dataOffset + entry.compressedSize,
  );
  const content =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: MAX_METADATA_BYTES });
  if (
    content.length !== entry.uncompressedSize ||
    crc32(content) !== entry.crc
  ) {
    throw new Error("Main JAR embedded metadata integrity check failed.");
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

module.exports = { createStoredZip, readZipEntry };
