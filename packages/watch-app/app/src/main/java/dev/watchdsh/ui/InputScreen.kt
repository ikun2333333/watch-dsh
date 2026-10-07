package dev.watchdsh.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.Card
import androidx.wear.compose.material3.CardDefaults
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import dev.watchdsh.data.Settings
import dev.watchdsh.voice.VoicePhase
import dev.watchdsh.voice.rememberVoiceCapture

/**
 * A full-screen page for writing one piece of text, by keyboard or by voice.
 *
 * ## Why this page exists at all
 *
 * The watch could previously only be talked to. Speech is fast but it is misheard,
 * and there was nowhere to fix a word: the only text entry went out to the system
 * input activity, which is a different app, gives no cursor, and cannot be handed
 * an existing value to correct. Typing a prompt, or repairing one, needs a real
 * editable field on this screen.
 *
 * ## What the platform does to a page like this
 *
 * On Wear OS the system keyboard takes over the whole display - it does not sit
 * below the content - so almost nothing of this page is visible while typing. That
 * makes two things load-bearing rather than nice to have:
 *
 *  1. **Nothing typed may be lost.** Every way of leaving submits: the confirm
 *     button, the back gesture, and the edge-swipe that dismisses without ever
 *     reaching `BackHandler`. Cancelling is a deliberate act that disables all of
 *     them, so "cancel" cannot quietly do the opposite.
 *  2. **The enter key cannot be trusted.** On Wear's Gboard it does not deliver
 *     `ImeAction.Send`; it inserts a newline into the field instead. Left alone, a
 *     user types a sentence, presses enter, and nothing happens. See [InputScreen]'s
 *     newline interception below.
 *
 * @param title - what is being written, shown above the field.
 * @param placeholder - shown while empty; where a length limit exists, say so here,
 *   because that is the only place the user will look.
 * @param confirmLabel - the verb for the confirm button.
 * @param initial - text to start from. A draft from voice, or the value being
 *   corrected. The cursor starts at the end of it, for the reason below.
 * @param settings - the voice settings, which decide which recognizer runs.
 * @param onVoiceMessage - a sentence to show when recognition fails.
 * @param onSubmit - receives the trimmed text. Never called with a blank value.
 * @param onCancel - the user explicitly abandoned the edit.
 */
@Composable
fun InputScreen(
    title: String,
    placeholder: String,
    confirmLabel: String,
    initial: String,
    settings: Settings,
    onVoiceMessage: (String) -> Unit,
    onSubmit: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val keyboard = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }

    /**
     * The field's contents, carrying its selection.
     *
     * `TextFieldValue` rather than a bare `String`, because the cursor has to be
     * placed explicitly. The `String` overload of `BasicTextField` wraps the value
     * itself and defaults the selection to 0 - **the caret at the very start**.
     * Coming in with a draft to correct, that is the difference between fixing the
     * last word and dragging a caret across a watch screen first.
     */
    var field by remember {
        mutableStateOf(TextFieldValue(initial, TextRange(initial.length)))
    }

    /** Set once the text has been handed over, so the fallbacks below stand down. */
    var submitted by remember { mutableStateOf(false) }

    /** A local failure notice. Rarely visible, because the keyboard covers this page. */
    var hint by remember { mutableStateOf<String?>(null) }

    /** Hand the text over, exactly once. */
    fun submit(raw: String = field.text) {
        val value = raw.trim()
        // A blank field is not a submission. On this page leaving is submitting, and
        // an empty field is most often a slip - so there is nothing to send.
        if (value.isEmpty()) return
        submitted = true
        keyboard?.hide()
        onSubmit(value)
    }

    // Voice fills the field rather than sending.
    //
    // Deliberately different from the conversation screen's microphone, which sends
    // what it hears. There, there is no field and the user is waiting for an answer.
    // Here they are already on an editing page with a keyboard up, so words appearing
    // in the field are not an interruption - they are the point. Speech is misheard
    // often enough that being able to fix one word beats saying the whole sentence
    // again.
    val voice = rememberVoiceCapture(
        settings = settings,
        onResult = { spoken -> field = TextFieldValue(spoken, TextRange(spoken.length)) },
        onMessage = { message -> hint = message },
        onEditResult = { spoken -> field = TextFieldValue(spoken, TextRange(spoken.length)) },
        // Words as they are recognized, so a wrong result is visible immediately
        // rather than only at the end.
        onPartial = { partial -> field = TextFieldValue(partial, TextRange(partial.length)) },
    )

    // ------------------------------------------------------------------ leaving
    //
    // The confirm button is under the keyboard, and on Wear the enter key and the
    // send arrow are both unreliable. Back is the one gesture that always reaches
    // the app, so leaving is defined as submitting: with text in the field, the back
    // gesture sends it rather than discarding it. A user who wants to abandon the
    // edit deletes the text, or presses Cancel - which sets the flag first.
    BackHandler(enabled = !submitted && field.text.isNotBlank()) { submit() }

    // The edge-swipe that dismisses a screen does not always go through
    // `BackHandler`, so the same rule is applied as the page is disposed. The text is
    // read from `field` here rather than captured: `onDispose` runs once, on the way
    // out, and a value captured during composition would be whatever was in the box
    // when the page first appeared - every later keystroke would be dropped.
    // Data only, no navigation: popping a back stack from `onDispose` is undefined.
    DisposableEffect(Unit) {
        onDispose {
            if (!submitted && field.text.isNotBlank()) {
                submitted = true
                onSubmit(field.text.trim())
            }
        }
    }

    ScreenScaffold { contentPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(contentPadding)
                .padding(horizontal = 14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                // Tapping the card re-opens the keyboard, for the case where the
                // system did not raise it on entry.
                Card(
                    onClick = { focusRequester.requestFocus() },
                    modifier = Modifier.weight(1f),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    ),
                ) {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = title,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        BasicTextField(
                            value = field,
                            onValueChange = { value ->
                                // Wear's Gboard sends a newline for the enter key
                                // instead of `ImeAction.Send`, so a user who types and
                                // presses enter watches nothing happen. The newline is
                                // taken as the enter it was meant to be: submit, and
                                // keep it out of the field.
                                //
                                // This is also why `singleLine` is deliberately NOT
                                // set. `singleLine` strips the newline before the
                                // callback, so the interception below would never fire
                                // and the enter key would be dead again. The field
                                // still reads as one line, because a newline never
                                // survives this branch.
                                if ('\n' in value.text) {
                                    submit(value.text)
                                } else {
                                    field = value
                                }
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .focusRequester(focusRequester),
                            textStyle = MaterialTheme.typography.bodyLarge.copy(
                                color = MaterialTheme.colorScheme.onSurface,
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            // Real keyboards and the phone-side IMEs do deliver these,
                            // so both paths work where they exist.
                            keyboardActions = KeyboardActions(
                                onSend = { submit() },
                                onDone = { submit() },
                            ),
                            decorationBox = { innerTextField ->
                                Box {
                                    if (field.text.isEmpty()) {
                                        Text(
                                            text = placeholder,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    innerTextField()
                                }
                            },
                        )
                    }
                }

                Button(
                    onClick = {
                        if (voice.phase == VoicePhase.Recording) voice.stop() else voice.start()
                    },
                    // Nothing to cancel once the audio is already being transcribed,
                    // so it is disabled rather than looking tappable and doing nothing.
                    enabled = voice.phase != VoicePhase.Transcribing,
                    modifier = Modifier.size(48.dp),
                ) {
                    Icon(
                        imageVector = if (voice.phase == VoicePhase.Recording) AppIcons.Close else AppIcons.Mic,
                        contentDescription = if (voice.phase == VoicePhase.Recording) {
                            "Finish and transcribe"
                        } else {
                            "Dictate"
                        },
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            hint?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.fillMaxWidth(),
                    textAlign = TextAlign.Center,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Button(
                    onClick = { submit() },
                    modifier = Modifier.weight(1f),
                ) {
                    Icon(
                        imageVector = AppIcons.Check,
                        contentDescription = null,
                        modifier = Modifier
                            .size(18.dp)
                            .padding(end = 4.dp),
                    )
                    Text(
                        text = when {
                            voice.phase == VoicePhase.Transcribing -> "Recognizing"
                            voice.phase == VoicePhase.Recording -> "Listening"
                            else -> confirmLabel
                        },
                        maxLines = 1,
                    )
                }

                Button(
                    // Cancel means cancel: the flag is set before leaving so the back
                    // handler and the dispose fallback skip their submission. Without
                    // it, "cancel" would quietly save the text anyway.
                    onClick = {
                        submitted = true
                        keyboard?.hide()
                        onCancel()
                    },
                    modifier = Modifier.width(76.dp),
                ) {
                    Text("Cancel", maxLines = 1, textAlign = TextAlign.Center)
                }
            }
        }
    }

    // Raise the keyboard on entry, so typing starts without a tap first. If the
    // system declines, tapping the field is the fallback.
    LaunchedEffect(Unit) {
        focusRequester.requestFocus()
        keyboard?.show()
    }
}
