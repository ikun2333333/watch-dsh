package dev.watchdsh

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import dev.watchdsh.ui.WatchDshApp

/**
 * The app's only activity.
 *
 * Wear OS apps are single-activity by convention: navigation lives in Compose,
 * which keeps the back stack and the round-display layout in one place.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setContent {
            WatchDshApp()
        }
    }
}
