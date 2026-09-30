/**
 * dsh-client: a local client for a running DeepSeek Harness web server.
 *
 * Why this exists
 * ---------------
 * `dsh web` binds loopback only and refuses `--host 0.0.0.0` on purpose, and its
 * browser auth is an HttpOnly, authority-bound signed cookie. A watch on mobile
 * data can never present that cookie, so the bridge owns the browser-session
 * credential locally and speaks the DSH RPC protocol on the watch's behalf.
 *
 * Auth model (verified against @deepseek-ai/dsh-client-connection):
 *   cookie name  = "dsh-auth-" + base64url(sha256(authority))
 *   cookie value = "v1." + base64url(JSON payload) + "." + base64url(hmac_sha256(secret, body))
 *   payload      = { version: 1, authority, issuedAt, expiresAt }
 *   authority    = the WHATWG `host` of the request (host:port)
 * The secret is the owner-scoped `client-connection/browser-session` grant record
 * persisted in $DSH_HOME/.credentials.yaml. Verification only requires the
 * payload authority to equal the request Host header, so a locally minted cookie
 * for the loopback authority is exactly as valid as the browser's own.
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWebSocket } from './deps.mjs';

const { WebSocket } = loadWebSocket();

const COOKIE_PREFIX = 'dsh-auth-';
const COOKIE_PAYLOAD_VERSION = 1;
const DAY_MS = 1440 * 60 * 1000;
/** Exact WebSocket route carrying every Typert Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux';

/** base64url without padding, matching the host's own encoder. */
function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Read one scalar out of a tiny YAML file without pulling in a YAML parser. */
function readScalar(text, key) {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'mu').exec(text);
  return match?.[1];
}

/**
 * Load the browser-session signing secret from a Harness home.
 * @param dshHome - `$DSH_HOME`, e.g. `C:\Users\me\.dsh`.
 * @returns the raw 32-byte secret.
 */
export function loadBrowserSessionSecret(dshHome) {
  const path = join(dshHome, '.credentials.yaml');
  const text = readFileSync(path, 'utf8');
  // The record key is owner-scoped, so match on its stable suffix rather than a
  // fixed literal; `refs:` lists it again, and requires the longest match.
  const keys = [...text.matchAll(/^\s{2}(\S+)\s*:\s*$/gmu)].map((m) => m[1]);
  const recordKey = keys.find((key) => key.endsWith('/browser-session') || key.endsWith('browser-session'));
  if (recordKey === undefined) {
    throw new Error(`dsh-client: no browser-session record found in ${path}`);
  }
  const recordIndex = text.indexOf(`${recordKey}:`);
  const tail = text.slice(recordIndex);
  const secret = readScalar(tail, 'secret');
  if (secret === undefined) {
    throw new Error(`dsh-client: browser-session record in ${path} has no secret`);
  }
  const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (decoded.byteLength !== 32) {
    throw new Error(`dsh-client: browser-session secret is ${String(decoded.byteLength)} bytes, expected 32`);
  }
  return decoded;
}

/** The canonical request authority used as the cookie name and signed audience. */
export function cookieAuthority(baseUrl) {
  return new URL(baseUrl).host;
}

/**
 * Mint a host-only browser-session cookie for one authority.
 * @param secret - raw signing secret from the credential record.
 * @param authority - `host:port` the request will carry in its Host header.
 * @param maxAgeDays - cookie lifetime; defaults to the host's own 30 days.
 * @returns the `name=value` cookie pair, without attributes.
 */
export function mintSessionCookie(secret, authority, maxAgeDays = 30) {
  const name = COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + maxAgeDays * DAY_MS;
  const payload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = encodeBase64Url(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

/**
 * A minimal, dependency-light DSH web client: unary `/api` RPC plus the
 * `/api/remote.mux` logical-stream WebSocket.
 */
export class DshClient {
  #baseUrl;
  #authority;
  #cookie;
  #descriptors;
  #rpcSeq = 0;
  #streamSeq = 0;
  #socket;
  #socketReady;
  #streams = new Map();
  #closed = false;

  /**
   * @param options - base URL of the running `dsh web`, and either a secret or an explicit cookie.
   *   `descriptors` (from `loadDescriptors`) supplies exact argument names.
   */
  constructor({ baseUrl, secret, cookie, maxAgeDays = 30, descriptors } = {}) {
    this.#baseUrl = new URL(baseUrl);
    this.#authority = this.#baseUrl.host;
    this.#descriptors = descriptors;
    if (cookie !== undefined) this.#cookie = cookie;
    else if (secret !== undefined) this.#cookie = mintSessionCookie(secret, this.#authority, maxAgeDays);
    else throw new Error('dsh-client: pass either `secret` or `cookie`');
  }

  /** Facts about the connected server, for diagnostics. */
  get baseUrl() {
    return `${this.#baseUrl.protocol}//${this.#authority}`;
  }

  /** Host header / cookie audience this client authenticates as. */
  get authority() {
    return this.#authority;
  }

  /** Headers every authenticated request must carry. */
  #headers(extra = {}) {
    return {
      host: this.#authority,
      cookie: this.#cookie,
      'content-type': 'application/json',
      ...extra,
    };
  }

  /**
   * Call one unary Remote endpoint on the shared `/api` channel.
   *
   * The physical route is `POST /api/<endpoint>` and the logical endpoint name
   * travels both in the path and in the envelope's `method` field; the Host
   * derives the endpoint from the path, so both must agree. The payload is
   * wrapped as `{ args }`, which is the one shape the Gateway accepts.
   * @param method - endpoint such as `session/list`.
   * @param args - the endpoint's named arguments.
   * @param options - optional abort signal and timeout.
   * @returns the decoded `ConnectionRpcResult`.
   */
  async call(method, args = {}, { signal, timeoutMs = 120_000 } = {}) {
    const rpcId = `bridge-${++this.#rpcSeq}-${Date.now().toString(36)}`;
    const named = this.#descriptors === undefined ? args : this.#descriptors.argsFor(method, args);
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: named } });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetch(new URL(`/api/${method}`, this.#baseUrl), {
      method: 'POST',
      headers: this.#headers(),
      body,
      signal: combined,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { ok: false, error: { code: `http/${String(response.status)}`, message: text.slice(0, 400), details: {} } };
    }
    const envelope = await response.json();
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
      return {
        ok: false,
        error: { code: 'bridge/envelope', message: `unexpected response envelope: ${JSON.stringify(envelope).slice(0, 400)}`, details: {} },
      };
    }
    return envelope.result;
  }

  /** Open (or reuse) the Remote stream mux WebSocket. */
  async #ensureSocket() {
    if (this.#closed) throw new Error('dsh-client: client is closed');
    if (this.#socketReady !== undefined) return this.#socketReady;
    const url = new URL(REMOTE_STREAM_MUX_PATH, this.#baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.#socketReady = new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: this.#headers() });
      this.#socket = socket;
      socket.once('open', () => { resolve(socket); });
      socket.once('unexpected-response', (_request, response) => {
        this.#socketReady = undefined;
        reject(new Error(`dsh-client: stream mux upgrade rejected with HTTP ${String(response.statusCode)}`));
      });
      socket.once('error', (error) => {
        this.#socketReady = undefined;
        reject(error);
      });
      socket.on('message', (data) => { this.#onMessage(data.toString()); });
      socket.on('close', () => { this.#failAllStreams(new Error('dsh-client: stream mux closed')); });
    });
    return this.#socketReady;
  }

  #onMessage(text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    const stream = this.#streams.get(frame.streamId);
    if (stream === undefined) return;
    if (frame.type === 'item') stream.push(frame.value);
    else if (frame.type === 'end') { stream.end(); this.#streams.delete(frame.streamId); }
    else if (frame.type === 'error') {
      stream.fail(Object.assign(new Error(frame.error?.message ?? 'remote stream failed'), { code: frame.error?.code, details: frame.error?.details }));
      this.#streams.delete(frame.streamId);
    }
  }

  #failAllStreams(error) {
    for (const stream of this.#streams.values()) stream.fail(error);
    this.#streams.clear();
    this.#socketReady = undefined;
  }

  /**
   * Open one logical Remote stream over the mux WebSocket.
   * @param endpoint - stream endpoint name, or the internal `$events` source.
   * @param args - the endpoint's named arguments; the internal `$events` source takes `{}`.
   * @param options - optional abort signal.
   * @returns an async iterator of decoded stream values.
   */
  async *stream(endpoint, args = {}, { signal } = {}) {
    const socket = await this.#ensureSocket();
    const streamId = `s-${++this.#streamSeq}-${Date.now().toString(36)}`;
    const queue = [];
    let resolveNext;
    let finished = false;
    let failure;
    const wake = () => { resolveNext?.(); resolveNext = undefined; };
    this.#streams.set(streamId, {
      push: (value) => { queue.push({ value }); wake(); },
      end: () => { finished = true; wake(); },
      fail: (error) => { failure = error; finished = true; wake(); },
    });
    // `$events` is a Gateway-internal logical endpoint whose payload is always
    // `{ args: {} }`, so it bypasses endpoint argument naming.
    const named = endpoint === '$events' || this.#descriptors === undefined ? args : this.#descriptors.argsFor(endpoint, args);
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args: named } }));
    const abort = () => { socket.send(JSON.stringify({ type: 'cancel', streamId })); finished = true; wake(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift().value;
        if (failure !== undefined) throw failure;
        if (finished) return;
        await new Promise((resolve) => { resolveNext = resolve; });
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.#streams.has(streamId)) {
        this.#streams.delete(streamId);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
      }
    }
  }

  /** Close the mux socket and fail everything in flight. */
  close() {
    this.#closed = true;
    this.#failAllStreams(new Error('dsh-client: closed'));
    this.#socket?.close();
    this.#socket = undefined;
  }
}
