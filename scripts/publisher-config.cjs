const { readFileSync } = require("node:fs");
const { validatePublisherConfig } = require("./operations-policy.cjs");

function readPublisherConfig(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const expectedKeys = [
    "centralTokenExpiresAt",
    "pilotCompleted",
    "quotaReview",
    "scheduleMode",
    "schemaVersion",
  ];
  if (
    !config ||
    Array.isArray(config) ||
    Object.keys(config).sort().join("\n") !== expectedKeys.join("\n")
  ) {
    throw new Error(
      "Publisher workflow config fields do not match the allowlist.",
    );
  }
  return validatePublisherConfig({
    centralTokenExpiresOn: config.centralTokenExpiresAt,
    pilotCompleted: config.pilotCompleted,
    quotaReview: config.quotaReview,
    scheduleMode: config.scheduleMode,
    schemaVersion: config.schemaVersion,
  });
}

module.exports = { readPublisherConfig };
