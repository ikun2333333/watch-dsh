/**
 * relay-worker: the relay deployed to Cloudflare Workers, for people who have
 * nowhere to run `relay.mjs`.
 *
 * Why this exists
 * ---------------
 * A watch on mobile data cannot reach a PC behind NAT. Something with a public
 * address has to forward frames, and the Workers free plan can do that with no
 * server to rent and no credit card: Durable Objects are available on the free
 * tier (SQLite-backed) and WebSocket Hibernation means an idle connection is not
 * billed for duration.
 *
 * Shape
 * -----
 * One Durable Object instance per PC id owns that machine's connections:
 *
 *   /pc?token=…&pc=<id>      the bridge dials out and stays attached
 *   /watch?token=…&pc=<id>   each watch dials out
 *
 * Routing is delegated to the same `relay-core` the Node relay uses, so the two
 * deployments cannot drift. The Worker holds no sealing key: frames are opaque
 * END-TO-END sealed blobs, so a compromised relay can drop or delay traffic but
 * cannot read a prompt or forge an approval.
 *
 * Deploying
 * ---------
 *   cd packages/dsh-bridge
 *   npx wrangler secret put RELAY_TOKEN     # the shared token, same on both sides
 *   npx wrangler deploy
 *
 * The Durable Object class must be declared in wrangler.toml:
 *
 *   [[durable_objects.bindings]]
 *   name = "RELAY"
 *   class_name = "RelayRoom"
 *
 *   [[migrations]]
 *   tag = "v1"
 *   new_sqlite_classes = ["RelayRoom"]
 *
 * Cost notes
 * ----------
 * The free plan allows 100k requests/day and 13k GB-s/day. Incoming WebSocket
 * messages bill at a 20:1 ratio and protocol-level pings are free, so an
 * always-attached bridge plus occasional watch traffic stays far inside the
 * limits as long as the hibernation API is used — which is why this Worker calls
 * `acceptWebSocket` rather than holding sockets in memory.
 */

import { PC_ROLE, RelayCore, WATCH_ROLE } from './relay-core.mjs';

/** Bytes-correct token check. */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    diff |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

export default {
  /**
   * Route an incoming request.
   * @param request - the incoming request.
   * @param env - bindings, including the `RELAY` Durable Object namespace and `RELAY_TOKEN`.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, protocol: 1 });
    }

    const role = url.pathname === '/pc' ? PC_ROLE : url.pathname === '/watch' ? WATCH_ROLE : undefined;
    if (role === undefined) {
      return new Response('watch-dsh relay: connect at /pc or /watch\n', { status: 404 });
    }
    if (!tokenMatches(url.searchParams.get('token') ?? '', env.RELAY_TOKEN ?? '')) {
      return new Response('unauthorized\n', { status: 401 });
    }
    const pcId = url.searchParams.get('pc') ?? '';
    if (pcId === '') return new Response('pc id required\n', { status: 400 });
    if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade\n', { status: 426 });
    }

    // One Durable Object per PC id: it is the single meeting point for that
    // machine, and its id is derived from the pc id so both sides land on it.
    const id = env.RELAY.idFromName(pcId);
    const stub = env.RELAY.get(id);
    return stub.fetch(new Request(`https://relay.internal/${role}?pc=${encodeURIComponent(pcId)}`, request));
  },
};

/**
 * One machine's relay room.
 *
 * Thin on purpose: the routing rules live in {@link RelayCore}, and this class
 * only adapts Cloudflare's hibernatable WebSocket API to the transport surface
 * that core expects.
 */
export class RelayRoom {
  #core = new RelayCore();
  #state;
  #env;
  /**
   * One adapter per socket.
   *
   * {@link RelayCore} identifies peers by object identity, and a hibernated
   * object is woken for every frame, so building a fresh adapter each time would
   * make the core treat one socket as many. The map also keeps each send path
   * bound to its own socket.
   */
  #adapters = new WeakMap();

  constructor(state, env) {
    this.#state = state;
    this.#env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.pathname === '/pc' ? PC_ROLE : WATCH_ROLE;
    const pcId = url.searchParams.get('pc') ?? '';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation is what keeps an idle bridge connection affordable: the socket
    // is not held in memory between messages, and `webSocketMessage` runs only
    // when a frame arrives.
    this.#state.acceptWebSocket(server);

    // The watch id lives in the socket's tag, which the platform persists across
    // hibernation. Attachment state is per-socket too, but a tag is also
    // readable without the socket, so rehydration can rebuild an identical id.
    const watchId = role === WATCH_ROLE ? this.#core.newWatchId() : undefined;
    if (watchId !== undefined) this.#state.setTag(server, 'watchId', watchId);

    const peer = this.#peerFor(server);
    const { pcOnline, notices } = this.#core.join(peer, role, pcId, watchId);

    server.send(JSON.stringify({
      t: 'ready',
      role,
      pcId,
      pcOnline,
      ...(watchId === undefined ? {} : { from: watchId }),
    }));
    for (const notice of notices) this.#send(notice.peer, notice.text);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Wrap a Cloudflare WebSocket in the small transport surface the core needs. */
  #peerFor(socket) {
    let peer = this.#adapters.get(socket);
    if (peer !== undefined) return peer;
    peer = {
      socket,
      send: (text) => {
        try {
          socket.send(text);
        } catch {
          // A closed socket needs no delivery report; the close handler cleans up.
        }
      },
      close: (code, reason) => socket.close(code, reason),
    };
    this.#adapters.set(socket, peer);
    return peer;
  }

  /** Send to one peer if it is still open. */
  #send(peer, text) {
    peer.send(text);
  }

  /**
   * Rebuild the core's view of who is attached after a hibernation wake-up.
   *
   * A woken object has no memory of its peer objects, so every live socket is
   * rejoined with the identity its tag and attachment preserved. Rejoining an
   * id that already maps to the same peer emits nothing, so this is safe to run
   * on every frame.
   */
  #rehydrate() {
    for (const socket of this.#state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() ?? {};
      if (attachment.pcId === undefined || attachment.role === undefined) continue;
      const watchId = this.#state.getTags(socket).watchId;
      this.#core.join(this.#peerFor(socket), attachment.role, attachment.pcId, watchId);
    }
  }

  /**
   * Handle one frame.
   */
  async webSocketMessage(socket, message) {
    this.#rehydrate();
    const attachment = socket.deserializeAttachment() ?? {};
    const { role, pcId } = attachment;
    if (role === undefined || pcId === undefined) return;
    const watchId = this.#state.getTags(socket).watchId;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const peer = this.#peerFor(socket);
    for (const frame of this.#core.route(peer, role, pcId, watchId, text)) {
      this.#send(frame.peer, frame.text);
    }
  }

  /** Clean up when a peer goes away. */
  async webSocketClose(socket) {
    const attachment = socket.deserializeAttachment() ?? {};
    const { role, pcId } = attachment;
    if (role === undefined || pcId === undefined) return;
    const watchId = this.#state.getTags(socket).watchId;
    const peer = this.#peerFor(socket);
    for (const notice of this.#core.leave(peer, role, pcId, watchId)) {
      this.#send(notice.peer, notice.text);
    }
  }

  /** Same cleanup for a transport error. */
  async webSocketError(socket) {
    await this.webSocketClose(socket);
  }
}
