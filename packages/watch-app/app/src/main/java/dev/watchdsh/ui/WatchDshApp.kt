package dev.watchdsh.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.TimeText
import dev.watchdsh.data.Diag
import dev.watchdsh.net.LinkState
import dev.watchdsh.ui.theme.WatchDshTheme

/** The screens this app has. Navigation is a single enum: there are only four. */
enum class Screen { Setup, Sessions, Chat, Settings }

/**
 * How long a screen takes to crossfade.
 *
 * Wear Material 3's own effects spec rather than a hand-picked duration. The spec
 * carries the framework's decisions about pacing on a low-power device and follows
 * the theme; a `tween` restates one number and throws the rest away.
 */
@Composable
private fun screenFade(): FiniteAnimationSpec<Float> =
    MaterialTheme.motionScheme.defaultEffectsSpec()

/**
 * Root of the app.
 *
 * Navigation is deliberately a plain state value rather than a nav graph: the app
 * has four screens and no deep links, so a graph would add indirection without
 * buying anything.
 */
@Composable
fun WatchDshApp() {
    val viewModel: WatchViewModel = viewModel()
    val state by viewModel.state.collectAsStateWithLifecycle()

    // First run goes to setup; afterwards the user lands on the session list, so
    // a missing link is visible immediately alongside the reconnect action.
    //
    // The starting screen cannot be decided in an initialiser, because settings
    // load asynchronously and the initialiser runs once with the empty default: it
    // would read `isConfigured` as false on every cold start and drop a configured
    // watch on the setup form. So the screen starts on the session list, and this
    // effect sends an unconfigured watch to setup once - but only once the settings
    // have actually arrived. `landed` is set only then, because setting it on the
    // first emission would latch the empty default and never re-run.
    // In-memory, not saved. Restoring a screen across process death means a value
    // chosen under a bug - or simply a screen the user had already left - comes
    // back as if it were current, and the landing effect cannot correct it without
    // overriding a deliberate choice. Which screen to open on is decided fresh
    // each run, and the cost of not restoring is one tap.
    var screen by remember { mutableStateOf(Screen.Sessions) }
    var showSettings by remember { mutableStateOf(false) }
    var landed by remember { mutableStateOf(false) }

    /**
     * The text being written, or null when the composer is closed.
     *
     * A nullable string rather than another entry in [Screen]: the composer is not a
     * place in the app, it is a piece of text being worked on, and it can be opened
     * from more than one screen. Keeping it separate also means the screen underneath
     * is unchanged when the composer closes, so the user returns to where they were
     * rather than to a screen chosen by the navigation.
     */
    var composerDraft by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(state.settings.isConfigured, state.settingsLoaded) {
        // Stay once the user has moved. A later settings change is not a reason to
        // yank them back to a screen they left.
        if (landed) return@LaunchedEffect
        if (state.settings.isConfigured) {
            // The default is already the right screen, so only landing is recorded.
            landed = true
        } else if (state.settingsLoaded) {
            // Setup is only the answer once the stored settings have actually been
            // read and are still empty. Acting on the empty initial value instead is
            // what put a configured watch on the setup form at every cold start.
            screen = Screen.Setup
            landed = true
        }
    }

    // A configured watch whose token was rejected must go back to setup: no
    // amount of retrying fixes a wrong token.
    LaunchedEffect(state.link) {
        if (state.link == LinkState.Unauthorized) {
            showSettings = true
            screen = Screen.Setup
        }
    }

    WatchDshTheme {
        // The system back gesture and button are how a watch user expects to leave
        // a screen, and without this they leave the app instead: back from a
        // conversation dropped the whole activity, so returning meant reopening and
        // waiting to reconnect. Back now steps outward one screen at a time.
        //
        // Disabled while the composer is open, because that page defines back as
        // "submit what I wrote" - two handlers would fight, and the wrong one winning
        // means the text is silently thrown away.
        BackHandler(enabled = composerDraft == null && (showSettings || screen == Screen.Chat)) {
            if (showSettings) showSettings = false else screen = Screen.Sessions
        }

        // Which screen is actually composed, recorded as it changes. A freeze
        // during navigation leaves the last frame on screen, so the display alone
        // cannot say whether the old screen was still composed or the new one
        // never finished; this log can.
        val app = LocalContext.current.applicationContext
        DisposableEffect(screen, showSettings) {
            Diag.log(app, "ui screen=$screen settings=$showSettings")
            onDispose { Diag.log(app, "ui left screen=$screen") }
        }

        // AppScaffold is the app-level container; it owns the system time text
        // that Wear requires at the top of a round display.
        AppScaffold(timeText = { TimeText() }) {
            // The composer covers everything while it is open. It is not crossfaded,
            // because the keyboard is about to take the whole display anyway and an
            // animation underneath it is only a delay.
            val draft = composerDraft
            if (draft != null) {
                InputScreen(
                    title = "Ask",
                    placeholder = "Type here, or dictate",
                    confirmLabel = "Send",
                    initial = draft,
                    settings = state.settings,
                    onVoiceMessage = viewModel::showNotice,
                    onSubmit = { text ->
                        composerDraft = null
                        viewModel.send(text)
                    },
                    onCancel = { composerDraft = null },
                )
                return@AppScaffold
            }

            // Screens crossfade. Without this a switch is a single-frame swap,
            // which on a round display reads as the app jumping rather than
            // moving: the eye gets no cue about which screen it is now looking at,
            // and a switch that happens while the previous screen was mid-scroll
            // is especially hard to follow.
            Crossfade(
                targetState = visibleScreen(screen, showSettings),
                animationSpec = screenFade(),
            ) { shown ->
                when (shown) {
                    Screen.Settings -> SettingsScreen(
                        state = state,
                        onSave = { url, lanUrl, token, secret, pcId ->
                            viewModel.saveConnection(url, token, secret, pcId, lanUrl)
                            showSettings = false
                            screen = Screen.Sessions
                        },
                        onSaveRecognizer = viewModel::saveRecognizer,
                        onNotice = viewModel::showNotice,
                        onForget = {
                            viewModel.forgetConnection()
                            showSettings = false
                            screen = Screen.Setup
                        },
                        onBack = { showSettings = false },
                    )

                    Screen.Setup -> SetupScreen(
                        state = state,
                        onSaveManual = { url, lanUrl, token, secret, pcId ->
                            viewModel.saveConnection(url, token, secret, pcId, lanUrl)
                            // The session list is where a successful connection
                            // lands; a failure surfaces there as a status line
                            // rather than trapping the user on this screen.
                            screen = Screen.Sessions
                        },
                    )

                    Screen.Chat -> ConversationScreen(
                        state = state,
                        onBack = { screen = Screen.Sessions },
                        onSend = viewModel::send,
                        onCancel = viewModel::cancel,
                        onVoiceResult = viewModel::send,
                        onVoiceMessage = viewModel::showNotice,
                        onType = { draft -> composerDraft = draft },
                        onAllow = viewModel::allow,
                        onReject = viewModel::reject,
                    )

                    Screen.Sessions -> SessionsScreen(
                        state = state,
                        onOpen = { sessionId ->
                            viewModel.openSession(sessionId)
                            screen = Screen.Chat
                        },
                        onNew = {
                            viewModel.startNewSession()
                            screen = Screen.Chat
                        },
                        onRefresh = viewModel::refreshSessions,
                        onReconnect = viewModel::reconnect,
                        onSettings = { showSettings = true },
                    )
                }
            }
        }
    }
}

/**
 * Which screen is actually shown, from the two things that decide it.
 *
 * Settings is a panel over the list rather than a peer of the conversation, so it
 * is ignored while a conversation is open. Keeping this as one expression gives
 * the crossfade a single value to animate between, instead of it having to infer
 * a screen from a chain of conditions.
 */
private fun visibleScreen(screen: Screen, showSettings: Boolean): Screen =
    if (showSettings && screen != Screen.Chat) Screen.Settings else screen
