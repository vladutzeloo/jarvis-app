# Keep JNI entrypoints — names are referenced by C++.
-keep class com.jarvis.localchat.llm.LlamaBridge { *; }
-keepclassmembers class com.jarvis.localchat.llm.LlamaBridge {
    native <methods>;
}

# Compose / Kotlin reflection minimal keep
-dontwarn org.jetbrains.annotations.**
