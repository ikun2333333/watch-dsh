package dev.watchdsh.voice

import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.result.ActivityResultLauncher
import androidx.wear.input.RemoteInputIntentHelper
import java.util.Locale

/**
 * The platform's voice input, used when this app is not doing the recognition.
 *
 * Two ways in, and which one works is a property of the watch rather than a
 * choice: the support library's Wear remote-input intent, and the standard
 * recognition intent. On the watch this was developed against the first resolves
 * to no activity at all while the second reaches Samsung's remote-input screen -
 * the same screen, reached by a route that is actually registered - so both are
 * offered and the first that resolves is used.
 *
 * Letting the platform do this keeps transcription off this app's battery and
 * permission surface, at the cost of having no say in which engine runs. That
 * trade is why [VoiceCapture] can bypass it entirely.
 */
object VoiceInput {
    /** Result key matching the [RemoteInput] this app sends. */
    private const val RESULT_KEY = "watch-dsh-voice"

    /**
     * Launch the system voice-input activity.
     *
     * @param launcher - a launcher registered for the input activity's result.
     * @param context - used to choose a route that resolves on this device.
     * @param prompt - the label the watch shows while listening.
     */
    fun launch(launcher: ActivityResultLauncher<Intent>, context: Context, prompt: String) {
        launcher.launch(createIntent(context, prompt))
    }

    /**
     * Build an intent the platform will actually answer.
     *
     * The Wear remote-input intent is preferred where it resolves, because it is
     * the documented Wear path and carries the prompt. It is not assumed: on a
     * watch where nothing handles it, launching it does nothing visible, which
     * looks like a dead button rather than a missing capability.
     */
    fun createIntent(context: Context, prompt: String): Intent {
        val wear = wearIntent(prompt)
        if (wear.resolveActivity(context.packageManager) != null) return wear
        return recognizerIntent(prompt)
    }

    /**
     * Whether any route exists at all, so a caller can say so instead of opening
     * nothing.
     */
    fun isAvailable(context: Context): Boolean =
        wearIntent("").resolveActivity(context.packageManager) != null ||
            recognizerIntent("").resolveActivity(context.packageManager) != null

    private fun wearIntent(prompt: String): Intent {
        val remoteInput = RemoteInput.Builder(RESULT_KEY)
            .setLabel(prompt)
            .setAllowFreeFormInput(true)
            .build()
        return RemoteInputIntentHelper.createActionRemoteInputIntent().apply {
            RemoteInputIntentHelper.putRemoteInputsExtra(this, listOf(remoteInput))
        }
    }

    /**
     * The standard recognition intent.
     *
     * The language follows the system rather than being pinned to Chinese: a
     * watch set to English would otherwise have everything heard as Chinese. The
     * prompt is passed as the recognition prompt, which is what the screen shows
     * while it listens.
     */
    private fun recognizerIntent(prompt: String): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, systemLanguage())
            if (prompt.isNotBlank()) putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }

    /**
     * Read the transcript from an input result.
     *
     * Both result shapes are checked, because which one arrives depends on which
     * route was taken: the remote-input extra, the recognition intent's result
     * list, and finally the clip data some Wear releases use. Opening a route
     * whose result this could not read would be worse than not offering it.
     *
     * @param intent - the result intent delivered to the activity.
     * @return the recognized text, or null when the user cancelled or nothing was
     *   recognized.
     */
    fun extractText(intent: Intent?): String? {
        if (intent == null) return null

        RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(RESULT_KEY)
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?.let { return it.trim() }

        intent.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }
            ?.let { return it.trim() }

        return intent.clipData
            ?.takeIf { it.itemCount > 0 }
            ?.getItemAt(0)
            ?.text
            ?.toString()
            ?.takeIf { it.isNotBlank() }
            ?.trim()
    }

    /** The system language tag, falling back to Chinese when it cannot be read. */
    private fun systemLanguage(): String =
        Locale.getDefault().toLanguageTag().takeIf { !it.isNullOrBlank() && it != "und" } ?: "zh-CN"
}
