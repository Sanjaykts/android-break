import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A separate application, not a variant of the main one. Proposal section 10
// teaches overbroad permissions, and the two apps have deliberately opposite
// permission sets -- sharing a manifest would make that comparison impossible to
// state honestly.

// Same resolution order the main app uses (agent/app/build.gradle.kts):
// gitignored keystore.properties, then the environment, then a dev default.
// The lab app previously hardcoded "dev-agent-token" with no override at all,
// which meant a release APK could only ever talk to loopback. It now takes both
// the token and the relay URL from the build, so a real lab build points at the
// real lab server and a developer's local build still just works.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

fun secret(name: String, default: String = ""): String =
    (keystoreProps.getProperty(name) ?: System.getenv(name) ?: default).trim()

// 10.0.2.2 is the host loopback as seen from an Android emulator. 127.0.0.1
// inside the emulator is the emulator itself, which is why the default differs
// from the main app's.
val defaultRelay = if (System.getenv("ANDROID_EMULATOR") != null) {
    "http://10.0.2.2:8787"
} else {
    "http://127.0.0.1:8787"
}

android {
    namespace = "dev.breakremote.lab"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.breakremote.lab"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0-lab"

        buildConfigField("String", "AGENT_TOKEN", "\"${secret("LAB_AGENT_TOKEN", "dev-agent-token")}\"")
        // Named RELAY_URL so CI and the lab runbook pass the same variable the
        // main app already uses.
        buildConfigField("String", "RELAY_URL", "\"${secret("RELAY_URL", defaultRelay)}\"")
        buildConfigField("String", "CONSOLE_TOKEN", "\"${secret("CONSOLE_TOKEN", "dev-console-token")}\"")
    }

    signingConfigs {
        create("release") {
            // Falls back to the same keystore.properties mechanism as the main
            // app, so one key signs both. Deliberately a different applicationId
            // so the two can be installed side by side for comparison.
            val props = Properties().apply {
                val f = rootProject.file("keystore.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }
            val path = props.getProperty("KEYSTORE_PATH")
            if (path != null && file(path).exists()) {
                storeFile = file(path)
                storePassword = props.getProperty("KEYSTORE_PASSWORD")
                keyAlias = props.getProperty("KEY_ALIAS")
                keyPassword = props.getProperty("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            val path = Properties().apply {
                val f = rootProject.file("keystore.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }.getProperty("KEYSTORE_PATH")
            if (path != null && file(path).exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures { buildConfig = true }
}

dependencies {
    // No third-party dependencies at all. The fewer libraries on the device, the
    // cleaner the network capture as evidence, which proposal section 11 requires.
    testImplementation("junit:junit:4.13.2")
}
