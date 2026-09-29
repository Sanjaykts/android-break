# The lab app has no reflection, no serialization library, and no third-party
# dependencies, so there is nothing to keep beyond the entry points.
-keep class dev.breakremote.lab.** { *; }
-dontwarn org.json.**
