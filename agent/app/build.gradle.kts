import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is supplied entirely by the environment so that no key material
// ever enters the repository. Locally we fall back to the debug key, which is fine
// for compile checks -- only the CI-signed APK is the shipping artifact.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

fun secret(name: String, default: String = ""): String =
    (keystoreProps.getProperty(name) ?: System.getenv(name) ?: default).trim()

val hasReleaseKeystore = secret("KEYSTORE_PATH").isNotEmpty() &&
    secret("KEYSTORE_PASSWORD").isNotEmpty()

android {
    namespace = "dev.breakremote.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.breakremote.agent"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // Overridable on the enrollment screen at runtime for testing against a
        // different Worker. The APK is pinned to the rolling release URL's worker.
        buildConfigField(
            "String",
            "RELAY_URL",
            "\"${secret("RELAY_URL", "wss://android-break-relay.example.workers.dev")}\""
        )
        // Two distinct tokens: the agent token is baked into the APK and therefore
        // only rotates on the next release; the console token can be rotated
        // independently in a Worker secret without touching the phone.
        buildConfigField("String", "AGENT_TOKEN", "\"${secret("AGENT_TOKEN", "dev-agent-token")}\"")
        buildConfigField("String", "CONSOLE_TOKEN", "\"${secret("CONSOLE_TOKEN", "dev-console-token")}\"")
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(secret("KEYSTORE_PATH"))
                storePassword = secret("KEYSTORE_PASSWORD")
                keyAlias = secret("KEY_ALIAS")
                keyPassword = secret("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/DEPENDENCIES"
        )
    }
}

dependencies {
    // Plan section 6.1: okhttp3 + kotlinx-coroutines-android. Nothing else.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
