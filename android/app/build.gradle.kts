plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Keep Android's release identity in sync with the web/PWA version in ../package.json.
val packageJson = rootProject.file("../package.json").readText()
val appVersion = Regex(""""version"\s*:\s*"([^"]+)"""")
    .find(packageJson)?.groupValues?.get(1) ?: error("package.json version is missing")
val versionParts = appVersion.split(".").map { it.toIntOrNull() ?: 0 }
val synchronizedVersionCode = (versionParts.getOrElse(0) { 0 } * 10_000) +
    (versionParts.getOrElse(1) { 0 } * 100) + versionParts.getOrElse(2) { 0 }

android {
    namespace = "com.samredwings.multihf"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.samredwings.multihf"
        minSdk = 24
        targetSdk = 35
        versionCode = synchronizedVersionCode
        versionName = appVersion
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
