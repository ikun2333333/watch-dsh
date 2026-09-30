plugins {
    // AGP 9 and later provide Kotlin support directly, so the standalone
    // `org.jetbrains.kotlin.android` plugin must not be applied.
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
