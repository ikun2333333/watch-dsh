package dev.watchdsh.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.dynamicColorScheme

/**
 * The system's own palette, if this watch has one.
 *
 * Null when the platform has no dynamic colour - an older watch, or a launcher
 * without it - which is why the caller keeps its baseline and only swaps when this
 * returns something.
 */
@Composable
private fun rememberDynamicColorScheme(enabled: Boolean): ColorScheme? {
    val context = LocalContext.current
    return remember(enabled, context) {
        if (enabled) dynamicColorScheme(context) else null
    }
}

/**
 * The app's theme.
 *
 * Wear Material 3's baseline palette, replaced by the watch's own colours when it
 * offers them. The nesting looks redundant and is not: Wear M3 has no
 * `darkColorScheme()` to fall back on, so the baseline has to be read *from* a
 * `MaterialTheme` before it can be passed to the same composable with a different
 * scheme. Reading it inside the first `MaterialTheme` is what makes the fallback
 * possible at all.
 *
 * Worth having on this app specifically because the screens are almost all surfaces
 * and text: the palette is most of what the user sees, and following the watch's
 * theme is the difference between an app that looks like part of the system and one
 * that looks like it was installed on it.
 */
@Composable
fun WatchDshTheme(content: @Composable () -> Unit) {
    MaterialTheme {
        val baseline = MaterialTheme.colorScheme
        val dynamic = rememberDynamicColorScheme(enabled = true)
        MaterialTheme(colorScheme = dynamic ?: baseline, content = content)
    }
}
