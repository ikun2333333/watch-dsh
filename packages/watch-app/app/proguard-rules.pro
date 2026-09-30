# The app talks to one configured host over a WebSocket, so no reflection-heavy
# framework needs to survive shrinking.
-keepattributes *Annotation*, InnerClasses

# kotlinx.serialization keeps generated serializers referenced only by name.
-keepclassmembers class **$$serializer { *; }
-keepclasseswithmembers class dev.watchdsh.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp platform probes reference optional JDK classes that Android lacks.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
