package dev.watchdsh.protocol

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end frame sealing, byte-compatible with the PC bridge's `protocol.mjs`.
 *
 * Two directional keys are derived so a frame sealed one way can never be
 * replayed the other way:
 *
 *     key = SHA-256("v1:" + direction + ":" + secret)   // UTF-8
 *
 * Sealing is AES-256-GCM with a fresh 12-byte nonce; the 16-byte tag is
 * appended to the ciphertext and the whole blob is base64-encoded. The relay
 * only ever sees [SealedFrame].
 *
 * `android.util.Base64` is deliberately avoided: this code runs in unit tests on
 * the JVM, and `java.util.Base64` produces the same standard alphabet with
 * padding that `Buffer.toString('base64')` does on the Node side.
 */
object Sealing {
    private const val VERSION = "v1"
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    /** Directions. The values are wire contract, not an internal detail. */
    const val WATCH_TO_BRIDGE = "w2b"
    const val BRIDGE_TO_WATCH = "b2w"

    private val random = SecureRandom()
    private val encoder: Base64.Encoder = Base64.getEncoder()
    private val decoder: Base64.Decoder = Base64.getDecoder()

    /** Derive one direction's AES key from the pairing secret. */
    fun deriveKey(secret: String, direction: String): SecretKeySpec {
        val digest = MessageDigest.getInstance("SHA-256")
        val material = digest.digest("$VERSION:$direction:$secret".toByteArray(Charsets.UTF_8))
        return SecretKeySpec(material, "AES")
    }

    /**
     * Seal one plaintext frame.
     * @param key - the key for the sending direction.
     * @param plaintext - the UTF-8 JSON of the inner frame.
     */
    fun seal(key: SecretKeySpec, plaintext: ByteArray): SealedFrame {
        val nonce = ByteArray(NONCE_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
        // GCM appends the authentication tag to the ciphertext, exactly as the
        // Node side does, so no separate tag field is needed on the wire.
        val blob = cipher.doFinal(plaintext)
        return SealedFrame(t = SealedFrame.TYPE, n = encoder.encodeToString(nonce), c = encoder.encodeToString(blob))
    }

    /**
     * Open one sealed frame.
     *
     * @param key - the key for the receiving direction.
     * @param frame - the envelope received from the relay.
     * @return the plaintext bytes, or null when authentication fails. A null
     *   result is not an error to surface: it means the peer is not who this
     *   secret belongs to, or the frame was tampered with in transit.
     */
    fun open(key: SecretKeySpec, frame: SealedFrame): ByteArray? {
        val nonce = try {
            decoder.decode(frame.n)
        } catch (_: IllegalArgumentException) {
            return null
        }
        val blob = try {
            decoder.decode(frame.c)
        } catch (_: IllegalArgumentException) {
            return null
        }
        if (nonce.size != NONCE_BYTES || blob.size < TAG_BITS / 8) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
            cipher.doFinal(blob)
        } catch (_: Exception) {
            // AEADBadTagException is the expected rejection; a malformed key or
            // provider issue lands here too, and both mean "cannot trust this".
            null
        }
    }

    /** Seal a UTF-8 string. */
    fun sealText(key: SecretKeySpec, text: String): SealedFrame = seal(key, text.toByteArray(Charsets.UTF_8))

    /** Open to a UTF-8 string. */
    fun openText(key: SecretKeySpec, frame: SealedFrame): String? =
        open(key, frame)?.toString(Charsets.UTF_8)
}
