/**
 * relay-core: the transport-agnostic heart of the relay.
 *
 * Both the Node server (`relay.mjs`) and the Cloudflare Worker
 * (`relay-worker.mjs`) drive this one class, so the pairing and routing rules
 * cannot drift between deployments. It owns only peer bookkeeping and frame
 * routing; it never sees plaintext, because every payload it moves is a sealed
 * envelope.
 *
 * The relay is deliberately trust-free: it forwards bytes between a PC and its
 * watches, and holds no key. A compromised relay can drop or delay traffic, but
 * it cannot read a prompt or forge an approval.
 */

/** Peer roles a relay connection may claim. */
export const PC_ROLE = 'pc';
export const WATCH_ROLE = 'watch';

/**
 * One relay's state: which PC ids are online and which watches are attached.
 *
 * Routing rule: a PC id maps to at most one PC peer and any number of watches.
 * The PC side addresses a specific watch, because one relay link carries every
 * watch of that PC; the watch side sends PCA-ward frames that get stamped with
 * the sender's identity so the PC can keep per-watch state.
 */
export class RelayCore {
  /** @type {Map<string, {pc: object|undefined, watches: Map<string, object>}>} */
  #peers = new Map();
  #nextId = 0;

  /** Mint a process-unique watch identity. */
  newWatchId() {
    this.#nextId += 1;
    return `w${String(this.#nextId)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  #bucket(pcId) {
    let entry = this.#peers.get(pcId);
    if (entry === undefined) {
      entry = { pc: undefined, watches: new Map() };
      this.#peers.set(pcId, entry);
    }
    return entry;
  }

  /** Snapshot for health checks and diagnostics. */
  describe() {
    return [...this.#peers].map(([pcId, entry]) => ({
      pcId,
      pcOnline: entry.pc !== undefined,
      watches: [...entry.watches.keys()],
    }));
  }

  /**
   * Register a peer.
   *
   * @param peer - the transport peer: it must expose `send(text)` and `close(code, reason)`.
   * @param role - {@link PC_ROLE} or {@link WATCH_ROLE}.
   * @param pcId - the machine identity this peer belongs to.
   * @param reuseWatchId - an existing watch id to re-register, used when a
   *   transport rebuilds its peer table after a restart or hibernation. Joining
   *   an id that already maps to the same peer is a no-op that emits no notices,
   *   which is what makes rehydration idempotent.
   * @returns the peer's watch id (`undefined` for a PC), the pc's online state,
   *   and the notices the join implies, each already resolved to a destination peer.
   */
  join(peer, role, pcId, reuseWatchId) {
    const entry = this.#bucket(pcId);
    const watchId = role === WATCH_ROLE ? reuseWatchId ?? this.newWatchId() : undefined;

    if (role === PC_ROLE) {
      if (entry.pc === peer) return { watchId, pcOnline: true, notices: [] };
      // One PC per id: a restarted bridge must not be shadowed by its own dead
      // socket, so the newcomer wins and the old socket is told why.
      if (entry.pc !== undefined) {
        try {
          entry.pc.close(4000, 'replaced by a newer connection');
        } catch {
          // A transport that is already gone needs no closing.
        }
      }
      entry.pc = peer;
    } else {
      if (entry.watches.get(watchId) === peer) {
        return { watchId, pcOnline: entry.pc !== undefined, notices: [] };
      }
      entry.watches.set(watchId, peer);
    }

    // A PC that just arrived learns about watches already waiting on it; a new
    // watch tells its PC that it exists, so the PC can build per-watch state.
    const notices = [];
    if (role === PC_ROLE) {
      for (const id of entry.watches.keys()) notices.push({ peer, text: JSON.stringify({ t: 'watch-online', from: id }) });
      // And the waiting watches learn the PC is back, which is the other half of
      // `peer-offline`. Without it a watch that was told the PC had gone had no way
      // to find out it had returned: it sat on "PC not running" while a working link
      // was one handshake away, because nothing ever prompted the retry. The frame
      // name is distinct from `watch-online` on purpose - that one travels to the
      // PC and means the opposite thing, and one name for two directions is how the
      // first attempt at this went wrong.
      for (const watchPeer of entry.watches.values()) {
        notices.push({ peer: watchPeer, text: JSON.stringify({ t: 'pc-online' }) });
      }
    } else if (entry.pc !== undefined) {
      notices.push({ peer: entry.pc, text: JSON.stringify({ t: 'watch-online', from: watchId }) });
    }

    return { watchId, pcOnline: entry.pc !== undefined, notices };
  }

  /**
   * Remove a peer and compute the notices its departure implies.
   * @param peer - the departing peer.
   * @param role - its role.
   * @param pcId - its machine identity.
   * @param watchId - the watch id assigned at join time.
   * @returns notices already resolved to a destination peer.
   */
  leave(peer, role, pcId, watchId) {
    const entry = this.#peers.get(pcId);
    if (entry === undefined) return [];
    const notices = [];
    if (role === PC_ROLE) {
      if (entry.pc === peer) entry.pc = undefined;
      // Watches must learn the machine went away, so their UI can say so
      // instead of spinning forever.
      for (const watch of entry.watches.values()) {
        notices.push({ peer: watch, text: JSON.stringify({ t: 'peer-offline' }) });
      }
    } else if (watchId !== undefined) {
      entry.watches.delete(watchId);
      if (entry.pc !== undefined) notices.push({ peer: entry.pc, text: JSON.stringify({ t: 'watch-offline', from: watchId }) });
    }
    if (entry.pc === undefined && entry.watches.size === 0) this.#peers.delete(pcId);
    return notices;
  }

  /**
   * Route one frame.
   *
   * @param peer - the sending peer.
   * @param role - its role.
   * @param pcId - its machine identity.
   * @param watchId - the sender's watch id, when it is a watch.
   * @param text - the raw frame text.
   * @returns the frames to deliver, each already resolved to a destination peer.
   */
  route(peer, role, pcId, watchId, text) {
    const entry = this.#peers.get(pcId);
    if (entry === undefined) return [];

    if (role === PC_ROLE) {
      // The PC addresses one watch; forward only to it.
      let target;
      try {
        target = JSON.parse(text).from;
      } catch {
        return [];
      }
      const watch = target === undefined ? undefined : entry.watches.get(String(target));
      if (watch === undefined) return [];
      return [{ peer: watch, text }];
    }

    // Watch → PC: stamp the sender so the PC can multiplex per-watch state.
    if (entry.pc === undefined) return [];
    let stamped;
    try {
      const parsed = JSON.parse(text);
      parsed.from = watchId;
      stamped = JSON.stringify(parsed);
    } catch {
      return [];
    }
    return [{ peer: entry.pc, text: stamped }];
  }
}
