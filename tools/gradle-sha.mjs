/**
 * Fetch the published SHA-256 for a Gradle distribution and print it.
 *
 * Gradle's own Gradle build verifies the distribution wrapper checksum, so the
 * value has to come from the publisher rather than be computed locally.
 *
 * Usage: node tools/gradle-sha.mjs 9.8.0
 */

const version = process.argv[2] ?? '9.8.0';
const url = `https://services.gradle.org/distributions/gradle-${version}-bin.zip.sha256`;
const response = await fetch(url);
if (!response.ok) {
  console.error(`gradle-sha: ${url} -> HTTP ${String(response.status)}`);
  process.exit(1);
}
const text = (await response.text()).trim();
console.log(text);
