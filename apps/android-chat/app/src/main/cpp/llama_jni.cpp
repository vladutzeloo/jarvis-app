// Minimal JNI bridge over llama.cpp.
// Surface: loadModel, generate (streaming via callback), freeModel, backendFree.
// Targets the current llama.cpp C API (llama_model_load_from_file / llama_sampler_chain).

#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <string>
#include <vector>
#include <mutex>

#include "llama.h"

#define LOG_TAG "JarvisLlamaJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct Session {
    llama_model   *model = nullptr;
    llama_context *ctx   = nullptr;
    const llama_vocab *vocab = nullptr;
    int n_ctx = 0;
};

std::once_flag g_backend_once;

void ensure_backend() {
    std::call_once(g_backend_once, []() {
        llama_backend_init();
        LOGI("llama backend initialized");
    });
}

// Convert a single token id to its piece (UTF-8 bytes). Resizes as needed.
std::string token_to_piece(const llama_vocab *vocab, llama_token id, bool special) {
    std::string out(8, 0);
    int n = llama_token_to_piece(vocab, id, out.data(), (int)out.size(), 0, special);
    if (n < 0) {
        out.resize(-n);
        n = llama_token_to_piece(vocab, id, out.data(), (int)out.size(), 0, special);
        if (n < 0) return {};
    }
    out.resize(n);
    return out;
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_jarvis_localchat_llm_LlamaBridge_nativeLoadModel(
        JNIEnv *env, jobject /*thiz*/, jstring jpath, jint nCtx, jint nThreads) {
    ensure_backend();

    const char *cpath = env->GetStringUTFChars(jpath, nullptr);
    std::string path(cpath);
    env->ReleaseStringUTFChars(jpath, cpath);

    auto *s = new Session();
    s->n_ctx = nCtx;

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0; // CPU-only V1; Vulkan is opt-in via separate build.
    mparams.use_mmap = true;
    mparams.use_mlock = false;

    s->model = llama_model_load_from_file(path.c_str(), mparams);
    if (!s->model) {
        LOGE("failed to load model: %s", path.c_str());
        delete s;
        return 0;
    }
    s->vocab = llama_model_get_vocab(s->model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx     = (uint32_t)nCtx;
    cparams.n_batch   = 256;
    cparams.n_threads = nThreads;
    cparams.n_threads_batch = nThreads;

    s->ctx = llama_init_from_model(s->model, cparams);
    if (!s->ctx) {
        LOGE("failed to create context");
        llama_model_free(s->model);
        delete s;
        return 0;
    }

    LOGI("model loaded: ctx=%d threads=%d", nCtx, nThreads);
    return reinterpret_cast<jlong>(s);
}

JNIEXPORT void JNICALL
Java_com_jarvis_localchat_llm_LlamaBridge_nativeFreeModel(
        JNIEnv * /*env*/, jobject /*thiz*/, jlong handle) {
    auto *s = reinterpret_cast<Session *>(handle);
    if (!s) return;
    if (s->ctx)   llama_free(s->ctx);
    if (s->model) llama_model_free(s->model);
    delete s;
}

JNIEXPORT void JNICALL
Java_com_jarvis_localchat_llm_LlamaBridge_nativeBackendFree(
        JNIEnv * /*env*/, jobject /*thiz*/) {
    llama_backend_free();
}

// Streams generated tokens to a Kotlin callback. Returning false from the
// callback (Boolean) stops generation early — used for "Stop" in the UI.
JNIEXPORT void JNICALL
Java_com_jarvis_localchat_llm_LlamaBridge_nativeGenerate(
        JNIEnv *env, jobject /*thiz*/,
        jlong handle, jstring jprompt, jint nPredict,
        jfloat temp, jfloat topP, jint topK, jlong seed,
        jobject jcallback) {

    auto *s = reinterpret_cast<Session *>(handle);
    if (!s || !s->ctx) {
        LOGE("generate called with null session");
        return;
    }

    const char *cprompt = env->GetStringUTFChars(jprompt, nullptr);
    std::string prompt(cprompt);
    env->ReleaseStringUTFChars(jprompt, cprompt);

    // Tokenize.
    const int n_prompt_est = -llama_tokenize(s->vocab, prompt.c_str(), (int)prompt.size(),
                                             nullptr, 0, true, true);
    std::vector<llama_token> tokens(n_prompt_est);
    const int n_prompt = llama_tokenize(s->vocab, prompt.c_str(), (int)prompt.size(),
                                        tokens.data(), (int)tokens.size(), true, true);
    if (n_prompt < 0) {
        LOGE("tokenize failed");
        return;
    }
    tokens.resize(n_prompt);

    // Reset KV cache so each call is a fresh turn (history is re-sent in prompt).
    // V1 keeps things simple; KV reuse is on the upgrade path.
    llama_memory_clear(llama_get_memory(s->ctx), true);

    // Prefill.
    llama_batch batch = llama_batch_get_one(tokens.data(), (int)tokens.size());
    if (llama_decode(s->ctx, batch) != 0) {
        LOGE("prefill decode failed");
        return;
    }

    // Sampler chain: top-k → top-p → temp → dist.
    llama_sampler_chain_params sparams = llama_sampler_chain_default_params();
    llama_sampler *smpl = llama_sampler_chain_init(sparams);
    llama_sampler_chain_add(smpl, llama_sampler_init_top_k(topK > 0 ? topK : 40));
    llama_sampler_chain_add(smpl, llama_sampler_init_top_p(topP > 0.0f ? topP : 0.95f, 1));
    llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp > 0.0f ? temp : 0.7f));
    llama_sampler_chain_add(smpl, llama_sampler_init_dist((uint32_t)(seed == 0 ? LLAMA_DEFAULT_SEED : seed)));

    // Resolve callback method once.
    jclass cbClass = env->GetObjectClass(jcallback);
    jmethodID onToken = env->GetMethodID(cbClass, "onToken", "(Ljava/lang/String;)Z");
    if (!onToken) {
        LOGE("callback missing onToken(String):Boolean");
        llama_sampler_free(smpl);
        return;
    }

    int n_decoded = 0;
    llama_token id = 0;
    while (n_decoded < nPredict) {
        id = llama_sampler_sample(smpl, s->ctx, -1);

        if (llama_vocab_is_eog(s->vocab, id)) break;

        std::string piece = token_to_piece(s->vocab, id, false);
        jstring jpiece = env->NewStringUTF(piece.c_str());
        jboolean keepGoing = env->CallBooleanMethod(jcallback, onToken, jpiece);
        env->DeleteLocalRef(jpiece);

        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            break;
        }
        if (!keepGoing) break;

        // Feed sampled token back for the next step.
        llama_batch step = llama_batch_get_one(&id, 1);
        if (llama_decode(s->ctx, step) != 0) {
            LOGE("decode failed at step %d", n_decoded);
            break;
        }
        n_decoded++;
    }

    llama_sampler_free(smpl);
}

JNIEXPORT jstring JNICALL
Java_com_jarvis_localchat_llm_LlamaBridge_nativeBackendInfo(
        JNIEnv *env, jobject /*thiz*/) {
    ensure_backend();
    std::string info = std::string("llama.cpp build ") + llama_print_system_info();
    return env->NewStringUTF(info.c_str());
}

} // extern "C"
