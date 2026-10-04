/**
 * config: a portable description of how to reach one bridge.
 *
 * Discovery solves this on a LAN, where nothing needs to be typed. A relay on the
 * internet has nothing to discover, so the values have to come from somewhere —
 * and a file is a better answer than a watch keyboard: the bridge writes it, and
 * the watch imports it with a single `adb push`.
 *
 * The file is also what makes a remote setup reproducible: keeping it next to the
 * bridge means a rebuilt watch, or a second watch, pairs without anyone retyping
 * a 43-character secret.
 *
 * Safety
 * ------
 * This file contains the relay token and the pairing secret, so it is a
 * credential and is written under the gitignored state directory. It is exactly
 * as sensitive as the watch's own stored settings.
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** Config format version; a reader refuses anything it does not understand. */
export const CONFIG_VERSION = 1;

/** Magic value identifying this file, so an unrelated JSON file is rejected. */
const MAGIC = 'watch-dsh-config';

/**
 * Build a config object.
 *
 * A config may carry two relay addresses, and the reason is that neither is right
 * in both places. `relayUrl` is where the bridge is attached - a public relay for
 * the away-from-home setup. `lanRelayUrl` is this machine's own address on the
 * local network, which is faster at home and keeps working with no internet.
 *
 * The watch tries the local one first and falls back to the public one. That is
 * deliberately not decided by a broadcast: a broadcast only reaches the local
 * network, which would make it a natural way to detect "at home", but plenty of
 * routers drop traffic between wireless clients, and this project has measured one
 * that does. A fallback that depends on a packet the network may discard is a
 * fallback that silently does not happen.
 *
 * @param values - the connection values plus the format marker.
 * @returns the config, ready to serialize.
 */
export function buildConfig({ relayUrl, lanRelayUrl, relayToken, pairingSecret, pcId }) {
  return {
    dsh: MAGIC,
    v: CONFIG_VERSION,
    pcId,
    relayUrl,
    // Omitted rather than null when there is no local address, so a config written
    // on a machine with no LAN does not claim one.
    ...(lanRelayUrl === undefined ? {} : { lanRelayUrl }),
    relayToken,
    pairingSecret,
  };
}

/**
 * Write a config file.
 * @param path - where to write.
 * @param values - the config's contents.
 */
export function writeConfig(path, values) {
  writeFileSync(path, `${JSON.stringify(buildConfig(values), null, 2)}\n`, { mode: 0o600 });
}

/**
 * Read a config file.
 *
 * @param path - the file to read.
 * @returns the parsed config, or undefined when the file is missing or is not a
 *   config this build understands. An unreadable config degrades to "no config"
 *   rather than aborting startup, so a stale file cannot stop a bridge that would
 *   otherwise run.
 */
export function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.error(`config: ${path} is not valid JSON: ${error.message}`);
    return undefined;
  }
  if (parsed?.dsh !== MAGIC) {
    console.error(`config: ${path} is not a watch-dsh config`);
    return undefined;
  }
  if (parsed.v !== CONFIG_VERSION) {
    console.error(`config: ${path} has version ${String(parsed.v)}, this build reads version ${String(CONFIG_VERSION)}`);
    return undefined;
  }
  return {
    pcId: String(parsed.pcId ?? ''),
    relayUrl: String(parsed.relayUrl ?? ''),
    // Absent in a config written by an earlier build, and absent is meaningful, so
    // it is left undefined rather than becoming the empty string.
    lanRelayUrl: typeof parsed.lanRelayUrl === 'string' ? parsed.lanRelayUrl : undefined,
    relayToken: String(parsed.relayToken ?? ''),
    pairingSecret: String(parsed.pairingSecret ?? ''),
  };
}
