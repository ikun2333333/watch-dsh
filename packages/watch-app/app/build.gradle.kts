import java.util.Properties

plugins {
    // Kotlin support is built into AGP 9; the Compose and serialization compiler
    // plugins are still applied separately.
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Signing configuration for release builds, read from
 * `packages/watch-app/keystore.properties` which `tools/make-keystore.ps1` writes.
 *
 * The release variant matters on a watch: R8 both shrinks it from ~39 MiB to
 * ~2.5 MiB and optimises it, which is what makes startup and scrolling
 * acceptable. Without a key the release APK would be unsigned and therefore
 * uninstallable, so a missing config degrades to an unsigned build rather than
 * failing the whole build. Both files are gitignored.
 */
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { stream -> load(stream) }
    }
}

android {
    namespace = "dev.watchdsh"

    // AndroidX and OkHttp currently require compiling against API 37, which this
    // SDK channel publishes only as a preview platform; AGP names that platform
    // by its numeric preview identifier. Compiling against a preview affects the
    // compile classpath only, and `targetSdk` below stays on a released level so
    // the app opts in to no untested runtime behaviour.
    compileSdk = 37
    compileSdkPreview = "CinnamonBun"

    defaultConfig {
        applicationId = "dev.watchdsh"
        // Wear OS 3 (API 30) is the floor: it is the first Wear release with a
        // stable Compose story, and the Galaxy Watch 6 ships well above it.
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Signing is declared inside the android block, which is where the
    // signingConfigs container lives.
    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                // Resolved against the module directory, where the keystore lives.
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed only when a key exists, so the build still produces an APK
            // (unsigned) on a machine that has not run make-keystore.ps1.
            if (keystorePropertiesFile.exists()) signingConfig = signingConfigs.getByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        }
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            // OkHttp ships these and they add nothing to an app.
            excludes += "/META-INF/*.kotlin_module"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.core.splashscreen)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.wear.compose.material3)
    implementation(libs.androidx.wear.compose.foundation)
    implementation(libs.androidx.wear.compose.navigation)
    implementation(libs.androidx.wear.input)

    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
