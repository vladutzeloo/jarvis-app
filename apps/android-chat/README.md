# JARVIS local — Android (offline)

A minimal, fully-offline AI chat app for Android. Runs a small instruction-tuned
LLM on-device via [llama.cpp](https://github.com/ggerganov/llama.cpp). No
network calls, no analytics, no login, no cloud fallback.

Tuned for **Galaxy S23 Ultra** (Snapdragon 8 Gen 2, arm64-v8a).

## What's in the box

- Native Android (Kotlin + Jetpack Compose, Material 3)
- llama.cpp via JNI, single ABI (`arm64-v8a`)
- 1B–2B class model loaded from app-private storage
- Streaming token output, cancellable mid-generation
- ~3 MB APK before model; model lives outside the APK

## Project layout

```
apps/android-chat/
├── settings.gradle.kts        # root settings
├── build.gradle.kts           # plugin declarations
├── gradle/libs.versions.toml  # version catalog
└── app/
    ├── build.gradle.kts       # arm64-v8a only, CMake → llama.cpp
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml          # no INTERNET permission
        ├── cpp/
        │   ├── CMakeLists.txt           # builds libjarvis_llm.so + llama.cpp
        │   └── llama_jni.cpp            # JNI wrapper (load/generate/free)
        ├── java/com/jarvis/localchat/
        │   ├── MainActivity.kt
        │   ├── llm/
        │   │   ├── LlamaBridge.kt       # Kotlin façade over JNI
        │   │   ├── ChatTemplate.kt      # Llama 3.x instruct template
        │   │   └── ModelRepository.kt   # SAF import + local discovery
        │   └── ui/
        │       ├── ChatViewModel.kt     # owns the bridge, single-thread dispatcher
        │       ├── ChatScreen.kt        # header / list / input / send / clear
        │       └── Theme.kt
        └── res/                         # strings, theme, backup rules
```

## Prerequisites

- **Android Studio** Ladybug or newer (or Gradle 8.7+ with JDK 17 standalone)
- **Android SDK** 35
- **NDK** 27.x (`27.2.12479018` in `app/build.gradle.kts`)
- **CMake** 3.22.1 (installed via Android Studio's SDK Manager)
- **Git** (for the llama.cpp submodule)

## One-time setup

```bash
cd apps/android-chat

# Pull llama.cpp into the C++ tree as a submodule.
git submodule add https://github.com/ggerganov/llama.cpp \
    app/src/main/cpp/llama.cpp
git submodule update --init --recursive
```

Pin a known-good llama.cpp tag if you want reproducible builds:

```bash
cd app/src/main/cpp/llama.cpp && git checkout b4404 && cd -
git add app/src/main/cpp/llama.cpp && git commit -m "pin llama.cpp"
```

(`b4404` is an example — pick the latest tag that has the
`llama_model_load_from_file` / `llama_sampler_chain_*` API.)

## Build

From `apps/android-chat/`:

```bash
# Debug install on a connected device
./gradlew :app:installDebug

# Release APK (unsigned)
./gradlew :app:assembleRelease
# Output: app/build/outputs/apk/release/app-release-unsigned.apk
```

### Signing for release

```bash
keytool -genkey -v -keystore jarvis.keystore \
    -keyalg RSA -keysize 2048 -validity 10000 -alias jarvis

apksigner sign --ks jarvis.keystore \
    --out app-release.apk \
    app/build/outputs/apk/release/app-release-unsigned.apk
```

Or wire `signingConfigs` into `app/build.gradle.kts` with `keystore.properties`
(kept out of git via `.gitignore`).

## Get a model

Download a 1B–2B class GGUF with Q4_K_M quantization. Recommended:

- **Llama 3.2 1B Instruct Q4_K_M** (~770 MB) — best speed/quality V1 pick
  - `meta-llama/Llama-3.2-1B-Instruct` → `Q4_K_M.gguf` from any GGUF repack
- **Qwen 2.5 1.5B Instruct Q4_K_M** (~1.0 GB) — better answers, ~30% slower

Two ways to put it on the phone:

1. **In-app**: tap "Select model file" → SAF picker → choose the `.gguf`. The
   app copies it into `filesDir/models/`.
2. **adb push** (faster for big files):
   ```bash
   adb push Llama-3.2-1B-Instruct-Q4_K_M.gguf \
       /sdcard/Download/
   ```
   then pick it from the SAF dialog.

## Performance testing on Galaxy S23 Ultra

The first reliable signal is **tokens/second** during decode. Quick checklist:

1. **Plug in or use a cool device** — sustained inference is thermally limited;
   throttled cores look like a software bug.
2. **Battery saver OFF**, **performance mode** if available.
3. **First-run mmap warmup**: the very first prompt is slower because the GGUF
   isn't paged in. Run one throwaway prompt, then measure.
4. **Watch logs**:
   ```bash
   adb logcat -s JarvisLlamaJNI llama
   ```
   llama.cpp prints prefill and decode timings.
5. **Targets** for Llama-3.2-1B Q4_K_M, 4 threads on perf cores:
   - Prefill: ~80–150 tok/s
   - Decode:  ~15–25 tok/s
   - First-token latency: <1 s for ≤256-token prompts
6. **Memory**: expect ~1.2–1.5 GB resident with a 2048 ctx. `adb shell dumpsys meminfo com.jarvis.localchat` to confirm.

If tokens/s is much lower than the targets:

- Verify `ndk { abiFilters += "arm64-v8a" }` actually applied (`unzip -l app.apk | grep .so` should show only `arm64-v8a/libjarvis_llm.so`).
- Confirm release build (`-O3` + minified). Debug builds are 2–3× slower.
- Drop `n_ctx` to 1024 in `ChatViewModel.kt` if RAM-pressured.

## Future upgrade path

Listed in roughly the order they pay off:

1. **Vulkan / OpenCL backend** — set `GGML_VULKAN=ON` in `CMakeLists.txt` and
   bump `n_gpu_layers` in `LlamaBridge::load`. Adreno 740 gives a meaningful
   decode speedup but adds APK size.
2. **KV cache reuse** — currently each turn does `llama_kv_self_clear` and
   re-prefills full history. Keep the KV around and only encode the new tokens
   to drop multi-turn latency dramatically.
3. **Voice input (V2)** — drop in [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
   alongside llama.cpp, mirror the JNI pattern (`whisper_jni.cpp` →
   `WhisperBridge.kt`), wire a mic button in `ChatScreen`. The
   `Message`/`ChatViewModel` surface doesn't need to change.
4. **TTS output** — Android's built-in `TextToSpeech` is offline on most
   devices; gate it behind a settings toggle.
5. **Quantized 3B class** — Phi-3.5-mini or Llama-3.2-3B Q4_K_M fits the S23
   Ultra. Bump `n_ctx` to 4096 only if you also raise `n_batch` to keep
   prefill fast.
6. **Multiple model slots** — `ModelRepository.listModels()` already returns
   all `.gguf` files; surface a picker in the top app bar.
7. **App icon / splash** — currently uses the Android default launcher icon.
   Add `res/mipmap-*/ic_launcher.*` and a `Theme.SplashScreen` parent.

## What this project deliberately does NOT have

- No INTERNET permission (declared absent in `AndroidManifest.xml`).
- No analytics SDKs, no crash reporters.
- No login, no accounts, no sync.
- No persisted chat history (cleared on app close).
- No remote model registry — you control which files exist on disk.
