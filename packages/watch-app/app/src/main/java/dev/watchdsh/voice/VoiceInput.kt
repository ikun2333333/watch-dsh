package dev.watchdsh.voice

import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import androidx.activity.result.ActivityResultLauncher
import androidx.wear.input.RemoteInputIntentHelper

/**
 * Voice input for a Wear OS app.
 *
 * The watch offers apps no recognition API: the supported path is to launch the
 * system input activity with a [RemoteInput] and read the transcribed text back
 * out of the result intent. Transcription therefore stays on the platform,
 * which keeps it off this app's battery and permission surface and works on a
 * watch with no keyboard.
 */
object VoiceInput {
    /** Result key matching the [RemoteInput] this app sends. */
    private const val RESULT_KEY = "watch-dsh-voice"

    /**
     * Launch the system voice-input activity.
     *
     * @param launcher - a launcher registered for the input activity's result.
     * @param prompt - the label the watch shows while listening.
     */
    fun launch(launcher: ActivityResultLauncher<Intent>, prompt: String) {
        launcher.launch(createIntent(prompt))
    }

    /**
     * Build the intent that opens system input with a voice-capable field.
     *
     * Free-form input stays enabled so a user with a keyboard-equipped watch can
     * type instead, which is the same activity either way.
     */
    fun createIntent(prompt: String): Intent {
        val remoteInput = RemoteInput.Builder(RESULT_KEY)
            .setLabel(prompt)
            .setAllowFreeFormInput(true)
            .build()
        return RemoteInputIntentHelper.createActionRemoteInputIntent().apply {
            RemoteInputIntentHelper.putRemoteInputsExtra(this, listOf(remoteInput))
        }
    }

    /**
     * Read the transcript from an input result.
     *
     * @param intent - the result intent delivered to the activity.
     * @return the recognized text, or null when the user cancelled or the
     *   recognizer produced nothing.
     */
    fun extractText(intent: Intent?): String? {
        if (intent == null) return null
        // The platform returns results in the intent's extras, and on some Wear
        // releases also in its clip data; both are checked so the app behaves the
        // same across the API levels it supports.
        val results: Bundle = RemoteInput.getResultsFromIntent(intent) ?: Bundle()
        results.getCharSequence(RESULT_KEY)?.toString()?.takeIf { it.isNotBlank() }?.let { return it.trim() }
        return intent.clipData
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.text
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?.trim()
    }
}
