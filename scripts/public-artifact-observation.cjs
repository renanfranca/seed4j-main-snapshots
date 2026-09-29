const { sanitizeDiagnostic } = require("./operations-policy.cjs");

async function inspectPublicArtifacts(identity, publicRequest) {
  const root = `https://central.sonatype.com/repository/maven-snapshots/${identity.groupId.replaceAll(".", "/")}/${identity.artifactId}/${identity.version}`;
  const metadataUrl = `${root}/maven-metadata.xml`;
  try {
    const metadata = await publicRequest(metadataUrl, "GET");
    if (metadata.status !== 200 || typeof metadata.body !== "string")
      return {
        summary: `Public metadata unconfirmed (HTTP ${metadata.status}); manual inspection required before retry-last-failed`,
        evidence: metadataUrl,
      };
    const versions = [
      ...metadata.body.matchAll(
        /<snapshotVersion>([\s\S]*?)<\/snapshotVersion>/g,
      ),
    ].map((match) => ({
      extension: xmlTag(match[1], "extension"),
      classifier: xmlTag(match[1], "classifier"),
      value: xmlTag(match[1], "value"),
    }));
    const roles = [
      { name: "POM", extension: "pom", classifier: undefined },
      { name: "main JAR", extension: "jar", classifier: undefined },
      { name: "tests JAR", extension: "jar", classifier: "tests" },
    ];
    const observations = [];
    for (const role of roles) {
      const version = versions.find(
        (candidate) =>
          candidate.extension === role.extension &&
          candidate.classifier === role.classifier,
      );
      const prefix = identity.version.replace(/-SNAPSHOT$/, "-");
      if (
        !version ||
        !version.value?.startsWith(prefix) ||
        !/^[A-Za-z0-9.-]+$/.test(version.value)
      ) {
        observations.push(`${role.name} unconfirmed`);
        continue;
      }
      const filename = `${identity.artifactId}-${version.value}${role.classifier ? `-${role.classifier}` : ""}.${role.extension}`;
      const response = await publicRequest(`${root}/${filename}`, "HEAD");
      observations.push(
        `${role.name} ${response.status === 200 ? "confirmed" : "unconfirmed"}`,
      );
    }
    return {
      summary: `${observations.join("; ")}; manual inspection required before retry-last-failed`,
      evidence: metadataUrl,
    };
  } catch (error) {
    return {
      summary: `Public artifact check unavailable: ${sanitizeDiagnostic(error.message)}; manual inspection required`,
      evidence: metadataUrl,
    };
  }
}

function xmlTag(xml, tag) {
  return new RegExp(`<${tag}>([^<]+)<\\/${tag}>`).exec(xml)?.[1];
}

async function fetchPublic(url, method) {
  const response = await fetch(url, {
    method,
    headers: { "User-Agent": "seed4j-main-snapshot-publisher" },
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body:
      method === "GET"
        ? (await response.text()).slice(0, 64 * 1024)
        : undefined,
  };
}

module.exports = { inspectPublicArtifacts, fetchPublic };
