import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Proposal section 10 asks for "an intentionally vulnerable toy application or a
// purpose-built training target". One app with five clearly-labelled activities
// beats five packages: the analyst installs once and walks five lessons, and a
// single mis-installed package is far easier to spot than five.
//
// Every flaw here is real. Every *effect* is local and harmless -- no toy activity
// writes outside its own sandbox, and none of them sends anything off the device.
// The point is to show the class of bug, not to weaponise it, which is what
// proposal section 3 and section 10 both require.
android {
    namespace = "dev.breakremote.toylab"
    compileSdk = 34

    defaultConfig {
        // Loopback by default. 10.0.2.2 is the host as seen from an emulator, so
        // a device-run demonstration needs this pointed at it; both are loopback
        // from the device's point of view and neither can leave the host.
        buildConfigField(
            "String",
            "TOYLAB_TLS_URL",
            "\"" + (System.getenv("TOYLAB_TLS_URL") ?: "https://127.0.0.1:8443/lab/health") + "\"",
        )

        applicationId = "dev.breakremote.toylab"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0-training"
    }

    signingConfigs {
        create("release") {
            val props = Properties().apply {
                val f = rootProject.file("keystore.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }
            val p = props.getProperty("KEYSTORE_PATH")
            if (p != null && file(p).exists()) {
                storeFile = file(p)
                storePassword = props.getProperty("KEYSTORE_PASSWORD")
                keyAlias = props.getProperty("KEY_ALIAS")
                keyPassword = props.getProperty("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false   // keep the flaws legible in a decompiler during the demo
            val p = Properties().apply {
                val f = rootProject.file("keystore.properties")
                if (f.exists()) f.inputStream().use { load(it) }
            }.getProperty("KEYSTORE_PATH")
            if (p != null && file(p).exists()) signingConfig = signingConfigs.getByName("release")
        }
        debug { applicationIdSuffix = ".debug" }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
