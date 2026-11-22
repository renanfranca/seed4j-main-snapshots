const { collectCandidate } = require("./artifact-policy.cjs");
const { decodeIdentity } = require("./publisher-policy.cjs");

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
  collectCandidate(parseRequest(process.argv.slice(2)));
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { collectQualifiedCandidate: collectCandidate };
