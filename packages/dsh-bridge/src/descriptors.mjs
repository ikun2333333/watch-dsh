/**
 * descriptors: the exact argument vocabulary of every mounted Remote endpoint.
 *
 * The Gateway validates named arguments against a generated descriptor and
 * rejects anything else (`missing "_request"`, `unknown field`). The names are
 * not uniform across packages — most endpoints name their single argument
 * `request` while `session/list` names it `_request` — so the argument shape is
 * read from the shipped generated artifacts instead of being guessed or
 * hardcoded.
 *
 * Usage:
 *   const descriptors = loadDescriptors();
 *   descriptors.argsFor('session/list', {})   // -> { _request: {} }
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locate every generated Typert host artifact in the installed packages.
 * @param dshHome - `$DSH_HOME`.
 * @returns absolute paths of the artifacts.
 */
function generatedArtifacts(dshHome) {
  const root = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai');
  const paths = [];
  let packages;
  try {
    packages = readdirSync(root);
  } catch {
    return paths;
  }
  for (const name of packages) {
    const lib = join(root, name, 'lib');
    try {
      if (!statSync(lib).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(lib)) {
      if (file === 'typert.host.js') paths.push(join(lib, file));
    }
  }
  return paths;
}

/**
 * Read one artifact's descriptor blocks.
 * @param text - generated artifact source.
 * @returns endpoint → parameter names, plus whether the endpoint is cancellable.
 */
function readArtifact(text) {
  const found = new Map();
  // Descriptors live in a flat array; each entry starts at a fixed indentation
  // and carries `id`, then `parameters`, then `cancellation` in that order.
  const pattern = /id:\s*'([^']+)#([^']+)'([\s\S]*?)(?=\n\s{4}\{\n\s{6}id:|\n\s{4}\}\n\s{2}\],)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const endpoint = match[2];
    const body = match[3];
    const parameters = /parameters:\s*\[([\s\S]*?)\n\s{6}\],/.exec(body);
    const names = parameters === null ? [] : [...parameters[1].matchAll(/name:\s*'([^']+)'/g)].map((entry) => entry[1]);
    const cancellation = /cancellation:\s*\{\s*parameter:\s*'([^']+)'/.exec(body);
    const stream = /mode:\s*'stream'/.test(body);
    found.set(endpoint, { names, cancellation: cancellation?.[1], stream });
  }
  return found;
}

/**
 * Build the endpoint descriptor catalog for a Harness home.
 * @param dshHome - `$DSH_HOME`.
 * @returns an object with `argsFor`, `has`, and `all`.
 */
export function loadDescriptors(dshHome) {
  const byEndpoint = new Map();
  for (const path of generatedArtifacts(dshHome)) {
    for (const [endpoint, descriptor] of readArtifact(readFileSync(path, 'utf8'))) {
      byEndpoint.set(endpoint, descriptor);
    }
  }

  return {
    /** Every known endpoint. */
    get all() {
      return [...byEndpoint.keys()].sort();
    },
    /**
     * Whether an endpoint is mounted by this composition.
     * @param endpoint - logical endpoint name.
     */
    has(endpoint) {
      return byEndpoint.has(endpoint);
    },
    /**
     * Describe one endpoint.
     * @param endpoint - logical endpoint name.
     */
    describe(endpoint) {
      return byEndpoint.get(endpoint);
    },
    /**
     * Convert natural arguments into the exact named-argument object.
     *
     * Three shapes are accepted, matching how the generated descriptors are
     * declared: no parameters (`{}`), one parameter (a bare value, or an object
     * already keyed by that parameter's name), and several parameters (a fully
     * keyed object).
     * @param endpoint - logical endpoint name.
     * @param value - the caller's natural argument.
     * @returns the object to send as `payload.args`.
     */
    argsFor(endpoint, value = {}) {
      const descriptor = byEndpoint.get(endpoint);
      if (descriptor === undefined) {
        // Unknown endpoints are still sent: the Host owns the error message, and
        // a newly added endpoint should not require a bridge change to try.
        return value;
      }
      const names = descriptor.names;
      if (names.length === 0) return {};
      if (names.length === 1) {
        const [only] = names;
        if (value !== null && typeof value === 'object' && only in value) return value;
        return { [only]: value };
      }
      return value;
    },
  };
}
