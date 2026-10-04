/**
 * Resolve names through a public resolver for this process only.
 *
 * The router on this network answers `api.cloudflare.com` with addresses in
 * 182.16.61.x, which are not Cloudflare's, so wrangler's API requests time out
 * while `dash.cloudflare.com` resolves correctly and works.
 *
 * Two facts make this necessary rather than decorative:
 *
 *   1. `dns.setServers()` does **not** affect `dns.lookup()`. It only changes
 *      `dns.resolve*()`. Node's `fetch` goes through `lookup`, so setting servers
 *      alone changes nothing that matters here - verified by watching `lookup`
 *      keep returning the poisoned addresses while `resolve4` returned the real
 *      ones.
 *   2. Editing the hosts file needs administrator rights, which a normal shell
 *      does not have.
 *
 * So `lookup` itself is replaced, falling through to the real implementation if
 * the public resolver cannot answer. Nothing outside this process is changed, and
 * certificate verification is left alone: the connection is still verified against
 * a real Cloudflare certificate, which is what proves the address is theirs.
 *
 * Used as: node --import file:///.../tools/resolve-public.mjs <script>
 */

import { lookup as systemLookup, Resolver } from 'node:dns';
import { isIP } from 'node:net';

const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8', '223.5.5.5']);

/**
 * A drop-in `dns.lookup` that asks the public resolver first.
 *
 * The callback contract is Node's own, including the `options.all` form, because
 * undici and Node's net layer call it in both shapes.
 */
function lookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const settings = typeof options === 'function' ? {} : (options ?? {});
  const all = settings.all === true;

  // An address is already an address; asking a resolver about it is pointless.
  if (isIP(hostname) !== 0) {
    return systemLookup(hostname, settings, done);
  }

  const fallback = () => systemLookup(hostname, settings, done);

  resolver.resolve4(hostname, (error, addresses) => {
    if (error || !addresses || addresses.length === 0) return fallback();
    if (all) return done(null, addresses.map((address) => ({ address, family: 4 })));
    return done(null, addresses[0], 4);
  });
}

// Patched on the module object so every importer sees it, including the ones that
// captured a reference after this preload ran.
import dns from 'node:dns';
dns.lookup = lookup;

export { lookup };
