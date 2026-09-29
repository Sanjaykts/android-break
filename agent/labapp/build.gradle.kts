import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A separate application, not a variant of the main one. Proposal section 10
// teaches overbroad permissions, and the two apps have deliberately opposite
// permission sets -- sharing a manifest would make that comparison impossible to
// state honestly.
android {
    namespace = "dev.breakremote.lab"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.breakremote.lab"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0-lab"

        buildConfigField("String", "AGENT_TOKEN", "\"dev-agent-token\"")
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
