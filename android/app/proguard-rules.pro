# Keep methods invoked from JavaScript by name through WebView's bridge.
-keepclassmembers class com.samredwings.multihf.** {
    @android.webkit.JavascriptInterface <methods>;
}

# AndroidX WebKit and WebView bridge annotations/reflection.
-keep class androidx.webkit.** { *; }
-keep class android.webkit.** { *; }

# Kotlin metadata and stdlib references used by the activity and AndroidX.
-keep class kotlin.** { *; }
-keep class kotlin.Metadata { *; }
-dontwarn kotlin.**

# Activity Result APIs.
-keep class androidx.activity.** { *; }
