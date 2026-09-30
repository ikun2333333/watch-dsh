package dev.watchdsh.net

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * Finds PCs running the bridge on the local network.
 *
 * Typing a relay address and a 43-character token on a watch keyboard is the
 * worst part of setting this up, and on a LAN none of it is necessary: the
 * bridge is already reachable, so it can answer a broadcast and hand the values
 * over. See `packages/dsh-bridge/src/discovery.mjs` for the other half, including
 * the argument for what the answer does and does not contain.
 *
 * This is the app's only UDP use, and it is deliberately tiny: one broadcast, a
 * short listen, then the socket closes.
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
     * @param timeoutMs - how long to listen. Long enough for a slow Wi-Fi round
     *   trip, short enough that a tap still feels responsive.
     * @returns one entry per distinct pc id, in the order the answers arrived.
     */
    suspend fun findBridges(timeoutMs: Long = 2500): List<DiscoveredBridge> = withContext(Dispatchers.IO) {
        val found = LinkedHashMap<String, DiscoveredBridge>()
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 400
            val probe = json.encodeToString(DiscoveryProbe()).toByteArray(Charsets.UTF_8)

            // The limited broadcast address reaches this subnet on whichever
            // interface has a lease, without having to enumerate interfaces here.
            runCatching {
                socket.send(DatagramPacket(probe, probe.size, InetAddress.getByName("255.255.255.255"), PORT))
            }

            withTimeoutOrNull(timeoutMs) {
                val buffer = ByteArray(4096)
                while (true) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        socket.receive(packet)
                    } catch (_: SocketTimeoutException) {
                        // Keep waiting until the overall timeout elapses: the probe
                        // may have gone out before the radio was fully up.
                        continue
                    }
                    val text = String(packet.data, 0, packet.length, Charsets.UTF_8)
                    val answer = runCatching { json.decodeFromString<DiscoveredBridge>(text) }.getOrNull() ?: continue
                    if (!answer.isUsable) continue
                    found[answer.pcId] = answer
                }
            }
        }
        found.values.toList()
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
            java.net.NetworkInterface.getNetworkInterfaces().toList().any { iface ->
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
