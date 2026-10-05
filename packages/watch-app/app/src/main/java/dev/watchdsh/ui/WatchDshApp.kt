package dev.watchdsh.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.TimeText
import dev.watchdsh.net.LinkState

/** The screens this app has. Navigation is a single enum: there are only four. */
enum class Screen { Setup, Sessions, Chat, Settings }

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
    var screen by rememberSaveable {
        mutableStateOf(if (state.settings.isConfigured) Screen.Sessions else Screen.Setup)
    }
    var showSettings by remember { mutableStateOf(false) }

    // A configured watch whose token was rejected must go back to setup: no
    // amount of retrying fixes a wrong token.
    LaunchedEffect(state.link) {
        if (state.link == LinkState.Unauthorized) {
            showSettings = true
            screen = Screen.Setup
        }
    }

    MaterialTheme {
        // AppScaffold is the app-level container; it owns the system time text
        // that Wear requires at the top of a round display.
        AppScaffold(timeText = { TimeText() }) {
            when {
                showSettings && screen != Screen.Chat -> SettingsScreen(
                    state = state,
                    onSave = { url, lanUrl, token, secret, pcId ->
                        viewModel.saveConnection(url, token, secret, pcId, lanUrl)
                        showSettings = false
                        screen = Screen.Sessions
                    },
                    onForget = {
                        viewModel.forgetConnection()
                        showSettings = false
                        screen = Screen.Setup
                    },
                    onBack = { showSettings = false },
                )

                screen == Screen.Setup -> SetupScreen(
                    state = state,
                    onSaveManual = { url, lanUrl, token, secret, pcId ->
                        viewModel.saveConnection(url, token, secret, pcId, lanUrl)
                        // The session list is where a successful connection lands; a
                        // failure surfaces there as a status line rather than
                        // trapping the user on this screen.
                        screen = Screen.Sessions
                    },
                )

                screen == Screen.Chat -> ConversationScreen(
                    state = state,
                    onBack = { screen = Screen.Sessions },
                    onSend = viewModel::send,
                    onCancel = viewModel::cancel,
                    onVoiceResult = viewModel::send,
                    onAllow = viewModel::allow,
                    onReject = viewModel::reject,
                )

                else -> SessionsScreen(
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
