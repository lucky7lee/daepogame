# Keep JavaScriptInterface methods for WebView bridge
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class io.github.lucky7lee.tankclash.** { *; }
