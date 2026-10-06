package dev.watchdsh.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.sqrt

/**
 * Records from the watch's microphone.
 *
 * The watch offers no recognition API of its own, and the supported path - the
 * system input activity - hands the audio to whichever recognition service the
 * device has installed. That service chooses for itself whether to run locally or
 * over the network, and decides whether it works at all, so the app can neither
 * see the audio nor pick the engine. Recording here is what makes the engine a
 * choice: the audio is ours, so it can go anywhere.
 *
 * Fixed at 16 kHz, mono, 16-bit PCM, which is what cloud recognizers ask for and
 * also the smallest of the usual sample rates: a full [MAX_SECONDS] recording is
 * about 1.9 MB, which a watch can hold in memory while it records.
 *
 * Two uses, both supported:
 *  - with no [onFrame], the whole thing comes back as one WAV for a batch endpoint;
 *  - with [onFrame], frames are handed out as they are filled, for a streaming
 *    endpoint that transcribes while the user is still speaking.
 *
 * Ported from WhaleChat (MIT), github.com/NaOHaminuosi/WhaleChat.
 */
class AudioRecorder {

    private val stopRequested = AtomicBoolean(false)
    private var active: AudioRecord? = null

    private var lastLevel = 0f
    private var lastLevelAt = 0L

    private val _level = MutableStateFlow(0f)

    /** Live input level, 0..1, for a meter. Only meaningful while recording. */
    val level: StateFlow<Float> = _level.asStateFlow()

    /**
     * Record until [requestStop] is called or [MAX_SECONDS] is reached.
     *
     * @param onFrame - when given, called with [FRAME_BYTES]-sized slices as they
     *   fill, for a streaming recognizer. **Called on an IO thread**, so it must
     *   not touch Compose state; hand the bytes to a channel instead.
     * @return the recording with a WAV header prepended.
     */
    @SuppressLint("MissingPermission")
    suspend fun record(onFrame: ((ByteArray) -> Unit)? = null): ByteArray =
        withContext(Dispatchers.IO) {
            check(active == null) { "already recording" }
            stopRequested.set(false)
            _level.value = 0f
            lastLevel = 0f
            lastLevelAt = 0L

            val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
            if (minBuffer <= 0) throw SpeechException("this watch cannot record 16 kHz mono")
            // Raised past 200ms: below that a watch drops frames easily, and a
            // dropped frame shows up as a missing word rather than as an error.
            val bufferBytes = maxOf(minBuffer, SAMPLE_RATE * BYTES_PER_SAMPLE / 5)

            val instance = open(bufferBytes)
            active = instance

            val samples = ShortArray(bufferBytes / BYTES_PER_SAMPLE)
            val pcm = ByteArrayOutputStream(MAX_PCM_BYTES)

            // Accumulator for the streaming slices: the driver decides how many
            // bytes a read returns, which does not line up with FRAME_BYTES, so
            // slices have to be assembled here. Sending ragged frames is rejected
            // by the service as an illegal frame sequence.
            val frame = ByteArray(FRAME_BYTES)
            var frameFill = 0

            try {
                instance.startRecording()
                while (!stopRequested.get() && pcm.size() < MAX_PCM_BYTES) {
                    val read = instance.read(samples, 0, samples.size)
                    if (read <= 0) continue

                    var sum = 0.0
                    val chunk = ByteArray(read * BYTES_PER_SAMPLE)
                    for (i in 0 until read) {
                        val value = samples[i].toInt()
                        sum += value.toDouble() * value
                        // Little endian: WAV is defined that way.
                        chunk[i * 2] = (value and 0xFF).toByte()
                        chunk[i * 2 + 1] = ((value shr 8) and 0xFF).toByte()
                    }

                    if (onFrame != null) {
                        var offset = 0
                        while (offset < chunk.size) {
                            val take = minOf(FRAME_BYTES - frameFill, chunk.size - offset)
                            System.arraycopy(chunk, offset, frame, frameFill, take)
                            frameFill += take
                            offset += take
                            if (frameFill == FRAME_BYTES) {
                                onFrame(frame.copyOf())
                                frameFill = 0
                            }
                        }
                    }

                    // The meter only has to look continuous, so updates are
                    // throttled to about 12 a second, with an exception for a
                    // large jump so the start of speech is not missed. Without
                    // the throttle this rebuilt the level 20 times a second,
                    // which on a watch is pure battery for no visible gain.
                    val next = dbfs(sqrt(sum / read))
                    val now = System.nanoTime() / 1_000_000
                    if (now - lastLevelAt >= LEVEL_INTERVAL_MS ||
                        abs(next - lastLevel) >= LEVEL_JUMP
                    ) {
                        lastLevel = next
                        lastLevelAt = now
                        _level.value = next
                    }
                    pcm.write(chunk)
                }
            } finally {
                runCatching { instance.stop() }
                instance.release()
                active = null
                _level.value = 0f
            }

            // A trailing partial slice still has to go out, or the last word is
            // never sent.
            if (onFrame != null && frameFill > 0) {
                onFrame(frame.copyOf(frameFill))
            }

            val data = pcm.toByteArray()
            // Under 0.4s is almost always a mis-tap, and sending it costs a
            // request and a wait to be told there was nothing to hear.
            if (data.size < SAMPLE_RATE * BYTES_PER_SAMPLE * 4 / 10) {
                throw SpeechException("that was too short to recognize")
            }
            wav(data)
        }

    /** Ask the record loop to finish. Safe to call repeatedly, and when idle. */
    fun requestStop() {
        stopRequested.set(true)
    }

    companion object {
        const val SAMPLE_RATE = 16_000

        /** One recording's ceiling. Matches the recognizer's own 60-second limit. */
        const val MAX_SECONDS = 60

        /**
         * Slice size a streaming endpoint expects: 1280 bytes is
         * 16000 Hz x 2 bytes x 40ms, which is the interval the API documents.
         */
        const val FRAME_BYTES = 1280

        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        private const val BYTES_PER_SAMPLE = 2
        private const val MAX_PCM_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_SECONDS

        /** Minimum gap between meter updates, about 12 a second. */
        private const val LEVEL_INTERVAL_MS = 80L

        /** A jump this large updates the meter immediately - speech starting. */
        private const val LEVEL_JUMP = 0.15f

        /**
         * Prefer VOICE_RECOGNITION: the system routes it as speech, which sounds
         * better than MIC and is less likely to treat music or vibration as a
         * voice. Not every device has it, so this falls through rather than
         * choosing one.
         */
        private fun open(bufferBytes: Int): AudioRecord {
            val sources = intArrayOf(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.MIC,
            )
            for (source in sources) {
                val instance = AudioRecord(source, SAMPLE_RATE, CHANNEL, ENCODING, bufferBytes)
                if (instance.state == AudioRecord.STATE_INITIALIZED) return instance
                instance.release()
            }
            throw SpeechException("the microphone is unavailable, possibly in use")
        }

        /**
         * RMS to 0..1.
         *
         * Through dB rather than linearly: on a linear scale ordinary speech only
         * moves a meter a little past the left edge, which reads as no input at
         * all. Mapping -60dB..0dB is what matches expectation.
         */
        private fun dbfs(rms: Double): Float {
            if (rms < 1.0) return 0f
            val db = 20.0 * log10(rms / 32768.0)
            return ((db + 60.0) / 60.0).coerceIn(0.0, 1.0).toFloat()
        }

        /**
         * Prepend the 44-byte WAV header.
         *
         * A batch endpoint guesses the format from the magic bytes and rejects
         * raw PCM, or reads it as noise. Writing the header is 44 bytes, which is
         * not worth a dependency.
         */
        private fun wav(pcm: ByteArray): ByteArray {
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray(Charsets.US_ASCII))
            header.putInt(36 + pcm.size)
            header.put("WAVE".toByteArray(Charsets.US_ASCII))
            header.put("fmt ".toByteArray(Charsets.US_ASCII))
            header.putInt(16)
            header.putShort(1.toShort())
            header.putShort(1.toShort())
            header.putInt(SAMPLE_RATE)
            header.putInt(SAMPLE_RATE * BYTES_PER_SAMPLE)
            header.putShort(BYTES_PER_SAMPLE.toShort())
            header.putShort(16.toShort())
            header.put("data".toByteArray(Charsets.US_ASCII))
            header.putInt(pcm.size)
            return header.array() + pcm
        }
    }
}
