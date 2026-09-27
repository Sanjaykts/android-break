# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-keepclassmembers class okhttp3.internal.publicsuffix.PublicSuffixDatabase { *; }

# Kotlin coroutines
-dontwarn kotlinx.coroutines.**
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }

# Our wire protocol serialises via org.json and reflection-free field names, but the
# entry points are reached from the manifest so they must survive shrinking.
-keep class dev.breakremote.agent.** { *; }
