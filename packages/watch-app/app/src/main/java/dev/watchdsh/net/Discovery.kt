package dev.watchdsh.net

import android.content.Context
import android.net.wifi.WifiManager
import dev.watchdsh.data.Diag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InterfaceAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Finds PCs running the bridge on the local network.
 *
 * Typing a relay address and a 43-character token on a watch keyboard is the
 * worst part of setting this up, and on a LAN none of it is necessary: the bridge
 * is already reachable, so it can answer a probe and hand the values over. See
 * `packages/dsh-bridge/src/discovery.mjs` for the other half, including the
 * argument for what the answer does and does not contain.
 *
 * Two mechanisms, because broadcast alone is not dependable. Plenty of routers
 * silently drop traffic between wireless clients while passing unicast through,
 * and on such a network a broadcast probe is sent, never seen, and the scan looks
 * like it simply did nothing. So a broadcast is tried first (cheap, reaches every
 * host), and any addresses already known are probed directly as well - unicast
 * crosses the routers that drop broadcast.
 */
object Discovery {
    /** Wire values; these must match the bridge's constants exactly. */
    const val MAGIC = "watch-dsh"
    const val VERSION = 1

    /** UDP port the bridge answers on. */
    private const val PORT = 8788

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Broadcast a probe and collect the answers.
     *
     * @param context - needed for the multicast lock; see below.
     * @param knownHosts - addresses that answered before, probed by unicast as
     *   well as by broadcast, so a router that drops broadcast does not make the
     *   PC undiscoverable.
     * @param timeoutMs - how long to listen. Long enough for a slow Wi-Fi round
     *   trip, short enough that a tap still feels responsive.
     * @returns one entry per distinct pc id, in the order the answers arrived.
     */
    suspend fun findBridges(
        context: Context,
        knownHosts: List<String> = emptyList(),
        timeoutMs: Long = 2500,
    ): List<DiscoveredBridge> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, DiscoveredBridge>()

        // Android's Wi-Fi stack filters broadcast and multicast traffic unless a
        // MulticastLock is held. Without it the probe leaves the device and the
        // answer is dropped before it ever reaches the socket. Released in the
        // finally block: holding it forever would cost battery.
        val multicastLock = acquireMulticastLock(context)
        try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 400
                val probe = json.encodeToString(DiscoveryProbe()).toByteArray(Charsets.UTF_8)

                val targets = LinkedHashSet<InetAddress>()
                targets.addAll(broadcastTargets())
                for (host in knownHosts) {
                    runCatching { targets.add(InetAddress.getByName(host)) }
                }

                for (target in targets) {
                    runCatching {
                        socket.send(DatagramPacket(probe, probe.size, target, PORT))
                    }.onFailure {
                        Diag.log(context, "discovery: send to $target failed: ${it.message}")
                    }
                }
                Diag.log(
                    context,
                    "discovery: probed ${targets.size} address(es) " +
                        "(${broadcastTargets().size} broadcast, ${knownHosts.size} remembered)",
                )

                withTimeoutOrNull(timeoutMs) {
                    val buffer = ByteArray(4096)
                    while (true) {
                        val packet = DatagramPacket(buffer, buffer.size)
                        try {
                            socket.receive(packet)
                        } catch (_: SocketTimeoutException) {
                            // Keep waiting until the overall timeout elapses: the
                            // probe may have gone out before the radio was fully up.
                            continue
                        }
                        val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                        val answer = runCatching { json.decodeFromString<DiscoveredBridge>(text) }.getOrNull() ?: continue
                        if (!answer.isUsable) continue
                        found[answer.pcId] = answer
                        Diag.log(context, "discovery: ${answer.pcId} answered from ${packet.address.hostAddress}")
                    }
                }
            }
        } finally {
            releaseQuietly(multicastLock)
        }
        found.values.toList()
    }

    /**
     * Take the Wi-Fi multicast lock, or null if it is unavailable.
     *
     * A device without Wi-Fi, or a missing permission, must not break discovery
     * outright: it only means the reply may not arrive, which the caller already
     * reports as "no PC answered".
     */
    private fun acquireMulticastLock(context: Context): WifiManager.MulticastLock? = runCatching {
        val manager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        manager.createMulticastLock("watch-dsh:discovery").apply {
            setReferenceCounted(false)
            acquire()
        }
    }.onFailure {
        Diag.log(context, "discovery: no multicast lock (${it.message})")
    }.getOrNull()

    private fun releaseQuietly(lock: WifiManager.MulticastLock?) {
        if (lock == null) return
        runCatching { if (lock.isHeld) lock.release() }
    }

    /**
     * Every broadcast address worth probing.
     *
     * The subnet-directed address of each up, non-loopback IPv4 interface is
     * included, and the limited broadcast address is kept as a fallback for a
     * device whose interface reports no broadcast address.
     */
    private fun broadcastTargets(): List<InetAddress> {
        val targets = LinkedHashSet<InetAddress>()
        runCatching {
            for (iface in NetworkInterface.getNetworkInterfaces().toList()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (address: InterfaceAddress in iface.interfaceAddresses) {
                    val broadcast = address.broadcast ?: continue
                    if (address.address is Inet4Address) targets.add(broadcast)
                }
            }
        }
        if (targets.isEmpty()) {
            runCatching { targets.add(InetAddress.getByName("255.255.255.255")) }
        }
        return targets.toList()
    }

    /**
     * Whether the watch is on a real local network.
     *
     * A broadcast cannot succeed without one, and the most common failure is a
     * watch reaching the internet through its phone over Bluetooth instead, which
     * cannot carry a LAN broadcast at all.
     */
    suspend fun hasLocalNetwork(): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            NetworkInterface.getNetworkInterfaces().toList().any { iface ->
                iface.isUp && !iface.isLoopback && iface.inetAddresses.toList().any { address ->
                    // A 169.254.x.x address means no DHCP lease, so nothing is
                    // reachable through that interface.
                    val host = address.hostAddress ?: return@any false
                    !host.startsWith("127.") && !host.startsWith("169.254.")
                }
            }
        }.getOrDefault(false)
    }
}

/** The probe the watch broadcasts. */
@Serializable
private data class DiscoveryProbe(
    val dsh: String = Discovery.MAGIC,
    val v: Int = Discovery.VERSION,
    val probe: Boolean = true,
)

/** A bridge that answered the probe. */
@Serializable
data class DiscoveredBridge(
    val dsh: String = "",
    val v: Int = 0,
    val pcId: String = "",
    val relayUrl: String = "",
    val relayToken: String = "",
) {
    /**
     * Whether this answer is usable.
     *
     * A datagram on this port could be anything, so an answer is only trusted
     * when it identifies itself and carries everything needed to connect.
     */
    val isUsable: Boolean
        get() = dsh == Discovery.MAGIC && v == Discovery.VERSION &&
            pcId.isNotBlank() && relayUrl.isNotBlank() && relayToken.isNotBlank()
}
