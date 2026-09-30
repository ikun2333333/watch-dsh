/**
 * Dependency resolution for the bridge.
 *
 * The workspace deliberately has no install step: `ws` is already present inside
 * the Harness profile's hoisted `node_modules`, so the bridge resolves it from
 * there rather than duplicating a dependency tree. That keeps
 * `git clone && node src/main.mjs` working with nothing installed.
 *
 * Resolution must be self-sufficient, because the bridge is started in ways that
 * do not share a shell with the Harness: a shortcut, a `.cmd` wrapper, or Task
 * Scheduler all produce a process with no `DSH_HOME` in its environment. An
 * earlier version trusted that variable and failed with "cannot resolve ws"
 * exactly when the launcher was double-clicked.
 *
 * Order of attempts:
 *   1. ordinary resolution, correct whenever `ws` sits next to the bridge
 *   2. a walk up from this file looking for `node_modules/ws`
 *   3. the Harness profile, from `DSH_HOME` or from the default home
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Every location tried, so a failure can name them instead of only stating the fact. */
const attempted = [];

/** Why the most recent candidate failed, when it did. */
let lastLoadError;

/** Whether a directory looks like it holds an installed `ws`. */
function holdsWs(nodeModulesDir) {
  return existsSync(join(nodeModulesDir, 'ws', 'package.json'));
}

/**
 * Resolve `ws` as if the code lived in `nodeModulesDir`.
 *
 * The resolver is rooted at the directory rather than pointed at `ws/index.js`:
 * `createRequire` takes a module specifier, and on Windows an absolute path
 * handed to it is treated as a package name and fails with "Cannot find module
 * 'file:///...'". Rooting it correctly also respects the package's `exports` map,
 * which is what a plain `require('ws')` is supposed to do.
 */
function loadFrom(nodeModulesDir) {
  attempted.push(join(nodeModulesDir, 'ws'));
  if (!holdsWs(nodeModulesDir)) return undefined;
  try {
    return createRequire(join(nodeModulesDir, '__bridge_resolver__.cjs'))('ws');
  } catch (error) {
    lastLoadError = `${join(nodeModulesDir, 'ws')}: ${error.message}`;
    return undefined;
  }
}

/**
 * Walk up from this file looking for an installed `ws`.
 *
 * This covers `node_modules` being a directory of, or above, the repository,
 * which is what any `npm install ws` at or above this directory produces.
 */
function walkUpwards() {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const found = loadFrom(join(directory, 'node_modules'));
    if (found !== undefined) return found;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/**
 * Directories that may hold the Harness profile's hoisted modules.
 *
 * The default location is tried as well as `DSH_HOME`, so a double-clicked
 * launcher needs no environment at all.
 */
function profileRoots() {
  const roots = [];
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv !== '') roots.push(join(fromEnv, 'profiles', 'node_modules'));
  const home = homedir();
  if (home !== '') {
    const fallback = join(home, '.dsh', 'profiles', 'node_modules');
    if (!roots.includes(fallback)) roots.push(fallback);
  }
  return roots;
}

/**
 * Load the `ws` WebSocket implementation.
 * @returns the module namespace of `ws`.
 * @throws when no copy can be found, naming every location that was tried.
 */
export function loadWebSocket() {
  // 1. Ordinary resolution first: correct whenever the bridge has its own
  //    dependency tree, and free when it does not.
  try {
    return require('ws');
  } catch {
    attempted.push('ws (ordinary module resolution)');
  }

  // 2. Anything installed at or above this repository.
  const nearby = walkUpwards();
  if (nearby !== undefined) return nearby;

  // 3. The Harness profile, whose hoisted tree already contains it.
  for (const root of profileRoots()) {
    const found = loadFrom(root);
    if (found !== undefined) return found;
  }

  throw new Error(
    'deps: cannot resolve "ws". Tried:\n' +
      attempted.map((entry) => `  - ${entry}`).join('\n') +
      (lastLoadError === undefined ? '' : `\nLast load error:\n  ${lastLoadError}`) +
      '\nInstall it with `npm install ws` in packages/dsh-bridge, or set DSH_HOME to your Harness home.',
  );
}
