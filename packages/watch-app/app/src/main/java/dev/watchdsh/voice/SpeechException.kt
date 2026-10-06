package dev.watchdsh.voice

/**
 * A recognition failure whose message is fit to show on the watch.
 *
 * The distinction matters on a watch: "cannot reach the recognizer (DNS failed)"
 * and "the recognizer rejected the credentials" need different actions from the
 * user, and a raw exception message gives neither. Every failure raised in this
 * package carries a sentence written for the screen.
 */
class SpeechException(
    val hint: String,
    val detail: String? = null,
) : Exception(if (detail.isNullOrBlank()) hint else "$hint: $detail")
