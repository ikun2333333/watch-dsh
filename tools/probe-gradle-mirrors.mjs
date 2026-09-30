/**
 * Probe which Gradle distribution mirrors are reachable from this network.
 *
 * `services.gradle.org` redirects to GitHub releases, which is intermittently
 * unreachable here while other hosts are fine, so the reachable host has to be
 * measured rather than assumed.
 *
 * Usage: node tools/probe-gradle-mirrors.mjs [version]
 */

const version = process.argv[2] ?? '9.8.0';
const candidates = [
  ['gradle services', `https://services.gradle.org/distributions/gradle-${version}-bin.zip`],
  ['github releases', `https://github.com/gradle/gradle-distributions/releases/download/v${version}/gradle-${version}-bin.zip`],
  ['tencent mirror', `https://mirrors.cloud.tencent.com/gradle/gradle-${version}-bin.zip`],
  ['aliyun mirror', `https://mirrors.aliyun.com/macports/distfiles/gradle/gradle-${version}-bin.zip`],
];

for (const [name, url] of candidates) {
  const started = Date.now();
  try {
    // Range keeps the probe cheap: one byte proves reachability and redirects.
    const response = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    const length = response.headers.get('content-range') ?? response.headers.get('content-length') ?? '?';
    const type = response.headers.get('content-type') ?? '?';
    console.log(
      `${name.padEnd(16)} HTTP ${String(response.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  len=${length}  type=${type}  final=${response.url.slice(0, 90)}`,
    );
    await response.arrayBuffer().catch(() => undefined);
  } catch (error) {
    console.log(`${name.padEnd(16)} FAILED  ${String(Date.now() - started).padStart(6)}ms  ${error.message}`);
  }
}
