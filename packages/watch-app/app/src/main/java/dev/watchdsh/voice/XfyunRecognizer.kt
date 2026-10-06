package dev.watchdsh.voice

import android.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.net.UnknownHostException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.TreeMap
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Credentials and options for one recognizer. */
data class RecognizerConfig(
    val appId: String,
    val apiKey: String,
    val apiSecret: String,
    /** `zh_cn` or `en_us`. */
    val language: String,
    /** Silence that ends an utterance, in ms. A watch hears short phrases. */
    val endOfSpeechMs: Int = 3000,
) {
    /** Whether all three credentials are present. */
    val isComplete: Boolean
        get() = appId.isNotBlank() && apiKey.isNotBlank() && apiSecret.isNotBlank()
}

/**
 * Streaming speech recognition over a WebSocket.
 *
 * Audio is sent as it is recorded rather than after it is finished, so the text
 * appears while the user is still speaking and there is no upload wait once they
 * stop. That is the whole reason to record here instead of using the system input
 * activity, which only returns text once it is done.
 *
 * Audio must arrive as [AudioRecorder.FRAME_BYTES]-sized frames; closing the
 * channel is what signals the end of speech.
 *
 * Ported from WhaleChat (MIT), github.com/NaOHaminuosi/WhaleChat.
 */
class XfyunRecognizer {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        // The WebSocket's own ping keeps the session alive, so the read timeout
        // has to be off: otherwise a pause mid-sentence trips a local timeout and
        // cuts the connection while the user is still talking.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    /**
     * Send frames as they arrive and return the transcript.
     *
     * @param onPartial - interim text, for showing words as they are recognized.
     *   Called on the caller's dispatcher.
     * @return the final transcript.
     */
    suspend fun transcribe(
        config: RecognizerConfig,
        frames: ReceiveChannel<ByteArray>,
        onPartial: (String) -> Unit = {},
    ): String = coroutineScope {
        // The socket's callbacks arrive on OkHttp's thread while onPartial writes
        // Compose state, so partials are funnelled through a channel and emitted
        // from the caller's dispatcher.
        val partials = Channel<String>(Channel.CONFLATED)
        val pump = launch { for (text in partials) onPartial(text) }

        val finalText = try {
            withContext(Dispatchers.IO) { runSession(config, frames, partials) }
        } finally {
            partials.close()
        }

        pump.join()
        finalText
    }

    private suspend fun runSession(
        config: RecognizerConfig,
        frames: ReceiveChannel<ByteArray>,
        partials: Channel<String>,
    ): String {
        val opened = CompletableDeferred<Unit>()
        val finished = CompletableDeferred<String>()
        val accumulator = TranscriptAccumulator()

        val listener = object : WebSocketListener() {

            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Unit)
            }

            /**
             * No exception may escape here.
             *
             * OkHttp's reader thread has no handler for a throw out of a listener,
             * so one becomes an uncaught exception and takes the process with it -
             * which the user sees as the app vanishing, not as a failed request.
             */
            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { handleMessage(text, accumulator, partials, finished) }
                    .onFailure { cause ->
                        finished.completeExceptionally(
                            SpeechException("could not read the recognizer's reply", cause.message),
                        )
                    }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val error = SpeechException(connectHint(response?.code, t), t.message)
                // A failure before the handshake - DNS, refused, rejected - must
                // fail `opened` immediately, or the caller waits out the full OPEN
                // timeout showing a listening screen that nothing is happening on.
                opened.completeExceptionally(error)
                finished.completeExceptionally(error)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // A normal finish has already completed `finished`; completing an
                // already-completed deferred is a no-op, so this is just a backstop.
                val error = SpeechException("the recognizer closed early ($code)")
                opened.completeExceptionally(error)
                finished.completeExceptionally(error)
            }
        }

        // Building the socket is inside the backstop too: a malformed URL throws
        // synchronously, and that would otherwise surface as something other than
        // a SpeechException.
        val socket = runCatching {
            http.newWebSocket(
                Request.Builder().url(authUrl(config)).build(),
                listener,
            )
        }.getOrElse { throw SpeechException("the recognizer's address is invalid", it.message) }

        try {
            if (withTimeoutOrNull(OPEN_TIMEOUT_MS) { opened.await() } == null) {
                throw SpeechException("the recognizer did not answer, check the watch's network")
            }

            var seq = 1
            var sentAny = false
            for (frame in frames) {
                val status = if (sentAny) 1 else 0
                if (!socket.send(frameMessage(config, seq, status, frame))) {
                    throw SpeechException("the recognizer's connection dropped")
                }
                seq++
                sentAny = true
            }

            // Nothing was sent - the recording was too short - still needs a first
            // frame, or the service rejects the frame sequence.
            if (!sentAny) {
                socket.send(frameMessage(config, seq, 0, ByteArray(0)))
                seq++
            }
            socket.send(lastMessage())

            return withTimeoutOrNull(RESULT_TIMEOUT_MS) { finished.await() }
                ?.takeIf { it.isNotBlank() }
                ?: run {
                    // On timeout, hand over whatever did arrive: the user spoke,
                    // and a partial sentence beats making them say it again.
                    val soFar = accumulator.text()
                    if (soFar.isNotBlank()) soFar else throw SpeechException("could not make out any words")
                }
        } catch (e: SpeechException) {
            throw e
        } catch (e: Exception) {
            throw SpeechException("recognition failed", e.message ?: "unknown error")
        } finally {
            runCatching { socket.close(1000, null) }
        }
    }

    /** One result frame. Runs under [WebSocketListener.onMessage]'s runCatching. */
    private fun handleMessage(
        text: String,
        accumulator: TranscriptAccumulator,
        partials: Channel<String>,
        finished: CompletableDeferred<String>,
    ) {
        val body = JSONObject(text)
        val data = body.optJSONObject("data")

        val code = body.optInt("code", 0)
        if (code != 0) {
            finished.completeExceptionally(
                SpeechException(mapCode(code, body.stringOrBlank("message"))),
            )
            return
        }

        data?.optJSONObject("result")?.let { result ->
            partials.trySend(accumulator.accept(result))
        }

        if (data?.optInt("status", -1) == 2) {
            finished.complete(accumulator.text())
        }
    }

    /**
     * The first frame carries `common` and `business`; later frames carry only
     * `data`, because repeating the parameters is rejected as a duplicate.
     */
    private fun frameMessage(
        config: RecognizerConfig,
        seq: Int,
        status: Int,
        audio: ByteArray,
    ): String = JSONObject()
        .apply {
            if (status == 0) {
                put("common", JSONObject().put("app_id", config.appId))
                put(
                    "business",
                    JSONObject()
                        .put("language", config.language)
                        .put("domain", "iat")
                        .put("accent", "mandarin")
                        // wpgs makes the service send corrections as well as
                        // appends, which is what keeps interim text accurate.
                        .put("dwa", "wpgs")
                        .put("eos", config.endOfSpeechMs),
                )
            }
            put(
                "data",
                JSONObject()
                    .put("status", status)
                    .put("format", FORMAT_16K)
                    .put("encoding", "raw")
                    .put("audio", base64(audio)),
            )
        }
        .toString()

    /** The end frame is a bare status=2 with no audio. */
    private fun lastMessage(): String = JSONObject()
        .put("data", JSONObject().put("status", 2))
        .toString()

    private fun mapCode(code: Int, message: String): String = when (code) {
        10005 -> "the recognizer app does not have this service enabled"
        10043 -> "the recognizer could not decode the audio"
        10114, 10014, 10019, 10200 -> "the recognition session timed out, try again"
        10160, 10161 -> "the recognizer rejected the request format"
        10163 -> "the recognizer says a required parameter is missing"
        10165 -> "the recognizer says the audio frames are out of order"
        10404 -> "this recognizer app has no route for this service"
        11200 -> "the recognition quota is used up or not authorized"
        11201 -> "today's recognition calls are used up"
        11202 -> "too many recognition calls, try again shortly"
        11203 -> "the recognizer's authorization expired"
        else -> "recognition failed ($code${if (message.isBlank()) "" else ": $message"})"
    }

    private companion object {
        const val FORMAT_16K = "audio/L16;rate=16000"
        const val OPEN_TIMEOUT_MS = 15_000L

        /** Waiting for the last result. Normally a few hundred ms. */
        const val RESULT_TIMEOUT_MS = 20_000L

        fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

        /**
         * A sentence for the screen when the connection fails.
         *
         * On a watch the common case is DNS failing outright - out of range, or
         * only reachable over Bluetooth - and that is a completely different
         * problem from being rejected. Saying which one saves a hunt through the
         * credentials.
         */
        fun connectHint(code: Int?, cause: Throwable): String = when {
            code == 401 || code == 403 -> "the recognizer rejected the credentials"
            code == 404 -> "the recognizer's address is wrong (404)"
            cause is UnknownHostException -> "cannot reach the recognizer (DNS failed), check the watch's network"
            cause is SocketTimeoutException || cause is ConnectException ->
                "cannot reach the recognizer (timed out), check the watch's network"
            else -> "cannot reach the recognition service"
        }
    }
}

/**
 * Assembles the recognized sentence from result fragments.
 *
 * With `dwa=wpgs` the service sends two kinds of fragment: `apd` appends to what
 * is there, and `rpl` **replaces** fragments rg[0]..rg[1] - it corrects something
 * it got wrong earlier. Handling the replacement is what keeps a misheard word
 * from staying on screen for the rest of the sentence.
 *
 * `sn` is the service's own index, so using it as the key both de-duplicates and
 * orders the fragments.
 *
 * **Must be locked**: `accept` runs on OkHttp's reader thread while `text()` can
 * be read from the caller's thread on the timeout path, and a `TreeMap` is not
 * thread-safe - a concurrent read and write throws
 * `ConcurrentModificationException`, and on OkHttp's thread that ends the process.
 */
private class TranscriptAccumulator {

    private val lock = Any()
    private val segments = TreeMap<Int, String>()

    fun accept(result: JSONObject): String = synchronized(lock) {
        val text = words(result)
        val sn = result.optInt("sn", segments.size)

        if (result.stringOrBlank("pgs") == "rpl") {
            val range = result.optJSONArray("rg")
            val from = range?.optInt(0, sn) ?: sn
            val to = range?.optInt(1, sn) ?: sn
            for (i in from..to) segments.remove(i)
        }

        if (text.isNotEmpty()) segments[sn] = text
        text()
    }

    fun text(): String = synchronized(lock) { segments.values.joinToString("") }

    /** `ws[].cw[0].w` joined is this fragment's text. */
    private fun words(result: JSONObject): String {
        val ws = result.optJSONArray("ws") ?: return ""
        val builder = StringBuilder()
        for (i in 0 until ws.length()) {
            val candidates = ws.optJSONObject(i)?.optJSONArray("cw") ?: continue
            builder.append(candidates.optJSONObject(0)?.stringOrBlank("w").orEmpty())
        }
        return builder.toString()
    }
}

/**
 * The signed URL for one session.
 *
 * Three lines are signed - `host:`, `date:` and the request line - with the API
 * secret as an HMAC-SHA256 key, then base64 encoded twice: once for the signature
 * and once for the whole authorization value. The service allows 300 seconds of
 * clock skew.
 */
private fun authUrl(config: RecognizerConfig): String {
    val date = rfc1123()
    val origin = "host: $HOST\ndate: $date\nGET $PATH HTTP/1.1"
    val signature = base64(hmacSha256(origin, config.apiSecret))

    val authorizationOrigin =
        "api_key=\"${config.apiKey}\", algorithm=\"hmac-sha256\", " +
            "headers=\"host date request-line\", signature=\"$signature\""

    val query = listOf(
        "authorization" to base64(authorizationOrigin.toByteArray(Charsets.UTF_8)),
        "date" to date,
        "host" to HOST,
    ).joinToString("&") { (name, value) -> "$name=${encode(value)}" }

    return "wss://$HOST$PATH?$query"
}

private const val HOST = "iat-api.xfyun.cn"
private const val PATH = "/v2/iat"

/**
 * RFC1123 in GMT, like `Tue, 14 May 2024 08:46:48 GMT`.
 *
 * The Locale **must** be pinned: under a Chinese default locale this formats the
 * day name in Chinese, the signature stops matching, and all the service says is
 * "HMAC signature does not match", which is a hard thing to trace back here.
 */
private fun rfc1123(): String = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss z", Locale.US)
    .apply { timeZone = TimeZone.getTimeZone("GMT") }
    .format(Date())

private fun hmacSha256(data: String, key: String): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(data.toByteArray(Charsets.UTF_8))
}

private fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

/**
 * `URLEncoder` turns a space into `+`, but a query needs `%20` - and the date is
 * nothing but spaces, so leaving this out breaks the signature too.
 */
private fun encode(value: String): String =
    URLEncoder.encode(value, "UTF-8").replace("+", "%20")

/** An explicit JSON null otherwise reads back as the literal string "null". */
private fun JSONObject.stringOrBlank(key: String): String =
    if (isNull(key)) "" else optString(key).orEmpty()
