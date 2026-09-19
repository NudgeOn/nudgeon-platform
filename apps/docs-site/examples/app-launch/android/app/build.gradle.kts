plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "io.nudgeon.launchexample"
    compileSdk = 34
    defaultConfig {
        applicationId = "io.nudgeon.launchexample"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("io.nudgeon:nudgeon-sdk:0.2.5")
    implementation("io.nudgeon:nudgeon-inapp:0.2.5")
}
