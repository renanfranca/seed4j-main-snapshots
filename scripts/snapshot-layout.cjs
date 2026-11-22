const PARENT_ARTIFACT_ID = "seed4j-parent";
const JAR_MODULES = Object.freeze([
  "seed4j-api",
  "seed4j-engine",
  "seed4j-test",
  "seed4j-core-modules",
]);
const CENTRAL_REPOSITORY =
  "https://central.sonatype.com/repository/maven-snapshots/";

function artifactDefinitions({ version }) {
  return [PARENT_ARTIFACT_ID, ...JAR_MODULES].flatMap((artifactId) =>
    (artifactId === PARENT_ARTIFACT_ID ? ["pom"] : ["pom", "jar"]).map(
      (extension) => ({
        artifactId,
        extension,
        fileName: `${artifactId}-${version}.${extension}`,
      }),
    ),
  );
}

module.exports = {
  artifactDefinitions,
  CENTRAL_REPOSITORY,
  JAR_MODULES,
  PARENT_ARTIFACT_ID,
};
