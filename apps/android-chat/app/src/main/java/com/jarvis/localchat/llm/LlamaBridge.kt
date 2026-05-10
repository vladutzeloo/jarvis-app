package com.jarvis.localchat.llm

/**
 * Thin Kotlin wrapper over the JNI surface in `llama_jni.cpp`.
 * One instance == one loaded model + context. Not thread-safe; callers must
 * serialize generate() calls (the ChatViewModel does this on a single dispatcher).
 */
class LlamaBridge {

    interface TokenCallback {
        /** Return false to cancel generation. */
        fun onToken(piece: String): Boolean
    }

    @Volatile private var handle: Long = 0L

    val isLoaded: Boolean get() = handle != 0L

    fun load(modelPath: String, contextSize: Int, threads: Int): Boolean {
        if (isLoaded) free()
        handle = nativeLoadModel(modelPath, contextSize, threads)
        return isLoaded
    }

    fun generate(
        prompt: String,
        maxTokens: Int,
        temperature: Float,
        topP: Float,
        topK: Int,
        seed: Long,
        callback: TokenCallback,
    ) {
        check(isLoaded) { "model not loaded" }
        nativeGenerate(handle, prompt, maxTokens, temperature, topP, topK, seed, callback)
    }

    fun free() {
        if (handle != 0L) {
            nativeFreeModel(handle)
            handle = 0L
        }
    }

    fun backendInfo(): String = nativeBackendInfo()

    // --- JNI ---
    private external fun nativeLoadModel(path: String, ctx: Int, threads: Int): Long
    private external fun nativeGenerate(
        handle: Long,
        prompt: String,
        nPredict: Int,
        temp: Float,
        topP: Float,
        topK: Int,
        seed: Long,
        callback: TokenCallback,
    )
    private external fun nativeFreeModel(handle: Long)
    private external fun nativeBackendFree()
    private external fun nativeBackendInfo(): String

    companion object {
        init { System.loadLibrary("jarvis_llm") }
    }
}
