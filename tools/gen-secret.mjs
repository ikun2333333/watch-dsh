/**
 * Generate the shared secrets this project needs.
 *
 * `Get-Random` is not a CSPRNG (and `-Count 40` over a 36-character alphabet
 * silently yields 36 characters), so the relay token — which is the trust anchor
 * for who may drive the agent — is generated here with `crypto.randomBytes`.
 *
 * Usage:
 *   node tools/gen-secret.mjs token    # 32 bytes, base64url (43 chars)
 *   node tools/gen-secret.mjs pairing  # 32 bytes, base64url (43 chars)
 */

import { randomBytes } from 'node:crypto';

const kind = process.argv[2] ?? 'token';
if (kind !== 'token' && kind !== 'pairing') {
  console.error('usage: node tools/gen-secret.mjs [token|pairing]');
  process.exit(2);
}

// 32 bytes of base64url is 43 characters and carries 256 bits of entropy: far
// beyond guessing, and short enough to type on a watch once.
process.stdout.write(randomBytes(32).toString('base64url'));
