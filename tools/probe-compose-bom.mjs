/**
 * Resolve which Compose BOM versions are usable with a released SDK platform.
 *
 * The BOM pins every Compose artifact, and recent BOMs ship Compose libraries
 * that require compiling against a preview API level. This prints each BOM's
 * `androidx.compose.foundation` pin so the newest API-36-compatible one can be
 * chosen from data rather than by trial and error.
 *
 * Usage: node tools/probe-compose-bom.mjs [maxVersions]
 */

const limit = Number(process.argv[2] ?? 12);

const metadata = await (await fetch('https://dl.google.com/dl/android/maven2/androidx/compose/compose-bom/maven-metadata.xml')).text();
const versions = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
const stable = versions.filter((version) => !/alpha|beta|rc|dev/i.test(version)).slice(-limit).reverse();

console.log('compose-bom        foundation pin');
for (const version of stable) {
  const pomUrl = `https://dl.google.com/dl/android/maven2/androidx/compose/compose-bom/${version}/compose-bom-${version}.pom`;
  try {
    const pom = await (await fetch(pomUrl)).text();
    const pin = /<artifactId>foundation<\/artifactId>\s*<version>([^<]+)<\/version>/.exec(pom)?.[1] ?? '?';
    console.log(`${version.padEnd(18)} ${pin}`);
  } catch (error) {
    console.log(`${version.padEnd(18)} ERR ${error.message}`);
  }
}
