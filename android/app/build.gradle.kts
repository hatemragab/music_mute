import java.util.Properties
import java.net.URI

plugins {
    alias(libs.plugins.google.services)
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val uploadSigningProperties =
    Properties().apply {
        val propertiesFile = rootProject.file("key.properties")
        if (propertiesFile.isFile) {
            propertiesFile.inputStream().use { load(it) }
        }
    }

// Public endpoint configuration only. Credentials belong to Firebase's SDK, never BuildConfig.
val authApiUrl = providers.gradleProperty("authApiUrl").orElse("")
val sentryDsn = providers.gradleProperty("sentryDsn").orElse(
    "https://7d5590c16d82bd80ec386e86a78acd37@o4506288965943296.ingest.us.sentry.io/4512142565638144"
)
val sentryEnabled = providers.gradleProperty("sentryEnabled").orElse("true")
require(sentryEnabled.get() in setOf("true", "false")) { "sentryEnabled must be true or false" }
require(runCatching {
    URI(sentryDsn.get()).let {
        it.scheme == "https" && !it.host.isNullOrBlank() && !it.rawUserInfo.isNullOrBlank() &&
            it.rawQuery == null && it.rawFragment == null
    }
}.getOrDefault(false)) { "sentryDsn must be a public HTTPS Sentry DSN" }

fun buildConfigString(value: String) =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.hatem.musicmute"
    compileSdk = 36

    flavorDimensions += "distribution"

    defaultConfig {
        fun publicPage(property: String): String {
            val value = providers.gradleProperty(property).orElse("").get()
            require(value.isBlank() || runCatching {
                URI(value).let { it.scheme == "https" && !it.host.isNullOrBlank() && it.rawUserInfo == null && it.rawQuery == null && it.rawFragment == null }
            }.getOrDefault(false)) { "$property must be an HTTPS public page URL" }
            return buildConfigString(value)
        }
        buildConfigField("String", "PRIVACY_URL", publicPage("privacyUrl"))
        buildConfigField("String", "DELETION_URL", publicPage("deletionUrl"))
        applicationId = "com.hatem.musicmute"
        minSdk = 26
        targetSdk = 36
        testInstrumentationRunner = "com.hatem.musicmute.processing.MediaPreparationTestRunner"
        versionCode = 10
        versionName = "0.1.9"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64") }
    }

    signingConfigs {
        create("upload") {
            storeFile =
                file(uploadSigningProperties.getProperty("storeFile", "upload-keystore.jks"))
            storePassword = uploadSigningProperties.getProperty("storePassword")
            keyAlias = uploadSigningProperties.getProperty("keyAlias")
            keyPassword = uploadSigningProperties.getProperty("keyPassword")
            storeType = "JKS"
        }
    }
    buildTypes {
        getByName("debug") {
            buildConfigField("boolean", "SENTRY_ENABLED", "false")
            buildConfigField("String", "SENTRY_DSN", buildConfigString(sentryDsn.get()))
            buildConfigField(
                "String",
                "AUTH_API_URL",
                buildConfigString(authApiUrl.get().ifBlank { "http://127.0.0.1:3000" }),
            )
            buildConfigField(
                "String",
                "AUTH_EMULATOR_HOST",
                buildConfigString(providers.gradleProperty("authEmulatorHost").orElse("").get()),
            )
            buildConfigField(
                "int",
                "AUTH_EMULATOR_PORT",
                providers.gradleProperty("authEmulatorPort").orElse("9099").get(),
            )
        }
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            buildConfigField("boolean", "SENTRY_ENABLED", sentryEnabled.get())
            buildConfigField("String", "SENTRY_DSN", buildConfigString(sentryDsn.get()))
            signingConfig = signingConfigs.getByName("upload")
            buildConfigField("String", "AUTH_API_URL", buildConfigString(authApiUrl.get()))
            buildConfigField("String", "AUTH_EMULATOR_HOST", "\"\"")
            buildConfigField("int", "AUTH_EMULATOR_PORT", "9099")
        }
        create("authE2e") {
            initWith(getByName("debug"))
            buildConfigField("boolean", "SENTRY_ENABLED", "false")
            applicationIdSuffix = ".authtest"
            matchingFallbacks += "debug"
            buildConfigField("String", "AUTH_API_URL", "\"http://127.0.0.1:48080\"")
            buildConfigField("String", "AUTH_EMULATOR_HOST", "\"127.0.0.1\"")
            buildConfigField("int", "AUTH_EMULATOR_PORT", "49099")
        }
    }

    productFlavors {
        create("direct") {
            dimension = "distribution"
            buildConfigField("String", "UPDATE_DISTRIBUTION", "\"direct\"")
        }
        create("play") {
            dimension = "distribution"
            buildConfigField("String", "UPDATE_DISTRIBUTION", "\"play\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        jniLibs.useLegacyPackaging = true
    }
}

kotlin { jvmToolchain(17) }

dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.common)
    implementation(libs.firebase.auth)
    implementation(libs.firebase.messaging)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services)
    implementation(libs.googleid)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons)
    implementation(libs.compose.preview)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.lifecycle.savedstate)
    implementation(libs.navigation.compose)
    implementation(libs.datastore.preferences)
    implementation(libs.appcompat)
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)
    implementation(libs.work.runtime)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.sentry.android)
    "directImplementation"(libs.azhon.appupdate)
    "playImplementation"(libs.play.appupdate)
    "playImplementation"(libs.play.appupdate.ktx)
    debugImplementation(libs.compose.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
