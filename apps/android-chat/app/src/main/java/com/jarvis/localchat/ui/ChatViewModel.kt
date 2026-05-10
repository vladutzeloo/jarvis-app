package com.jarvis.localchat.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.jarvis.localchat.llm.ChatTemplate
import com.jarvis.localchat.llm.LlamaBridge
import com.jarvis.localchat.llm.ModelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

data class Message(val role: ChatTemplate.Role, val text: String)

data class UiState(
    val messages: List<Message> = emptyList(),
    val draft: String = "",
    val modelName: String? = null,
    val isModelLoading: Boolean = false,
    val isGenerating: Boolean = false,
    val importProgress: Float? = null,
    val error: String? = null,
)

/**
 * Owns the LlamaBridge + chat history. Inference is pinned to a single-thread
 * dispatcher because LlamaBridge is not thread-safe. The same scope cancels
 * generation when the user taps Stop.
 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {

    private val _state = MutableStateFlow(UiState())
    val state = _state.asStateFlow()

    private val bridge = LlamaBridge()
    private val repo = ModelRepository(app.applicationContext)
    private val llmDispatcher = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    private val llmScope = CoroutineScope(llmDispatcher)

    private var generationJob: Job? = null
    @Volatile private var stopFlag = false

    private val systemPrompt =
        "You are JARVIS, a concise on-device assistant. Answer briefly and accurately."

    init {
        repo.firstAvailable()?.let { loadModel(it.absolutePath) }
    }

    fun setDraft(text: String) {
        _state.value = _state.value.copy(draft = text)
    }

    fun loadModel(path: String) {
        if (_state.value.isModelLoading) return
        _state.value = _state.value.copy(isModelLoading = true, error = null)
        llmScope.launch {
            val ok = bridge.load(
                modelPath = path,
                contextSize = 2048,
                threads = pickThreadCount(),
            )
            withContext(Dispatchers.Main) {
                _state.value = _state.value.copy(
                    isModelLoading = false,
                    modelName = if (ok) path.substringAfterLast('/') else null,
                    error = if (ok) null else "Failed to load model",
                )
            }
        }
    }

    fun importModel(uri: Uri) {
        _state.value = _state.value.copy(importProgress = 0f, error = null)
        viewModelScope.launch(Dispatchers.IO) {
            val file = runCatching {
                repo.importFromUri(uri) { copied, total ->
                    val frac = if (total > 0) copied.toFloat() / total else 0f
                    _state.value = _state.value.copy(importProgress = frac.coerceIn(0f, 1f))
                }
            }.getOrNull()
            withContext(Dispatchers.Main) {
                _state.value = _state.value.copy(importProgress = null)
                if (file != null) loadModel(file.absolutePath)
                else _state.value = _state.value.copy(error = "Import failed")
            }
        }
    }

    fun send() {
        val draft = _state.value.draft.trim()
        if (draft.isEmpty() || !bridge.isLoaded || _state.value.isGenerating) return

        val userMsg = Message(ChatTemplate.Role.USER, draft)
        val placeholder = Message(ChatTemplate.Role.ASSISTANT, "")
        _state.value = _state.value.copy(
            messages = _state.value.messages + userMsg + placeholder,
            draft = "",
            isGenerating = true,
        )

        stopFlag = false
        val turns = _state.value.messages
            .dropLast(1) // exclude empty assistant placeholder
            .map { ChatTemplate.Turn(it.role, it.text) }
        val prompt = ChatTemplate.build(turns, system = systemPrompt)
        val builder = StringBuilder()

        generationJob = llmScope.launch {
            runCatching {
                bridge.generate(
                    prompt = prompt,
                    maxTokens = 512,
                    temperature = 0.7f,
                    topP = 0.95f,
                    topK = 40,
                    seed = 0L,
                    callback = object : LlamaBridge.TokenCallback {
                        override fun onToken(piece: String): Boolean {
                            if (stopFlag) return false
                            builder.append(piece)
                            val snapshot = builder.toString()
                            val msgs = _state.value.messages.toMutableList()
                            if (msgs.isNotEmpty()) {
                                msgs[msgs.lastIndex] = msgs.last().copy(text = snapshot)
                                _state.value = _state.value.copy(messages = msgs)
                            }
                            return true
                        }
                    },
                )
            }.onFailure { e ->
                _state.value = _state.value.copy(error = e.message ?: "Generation failed")
            }
            _state.value = _state.value.copy(isGenerating = false)
        }
    }

    fun stop() {
        stopFlag = true
    }

    fun clearChat() {
        stop()
        _state.value = _state.value.copy(messages = emptyList(), error = null)
    }

    override fun onCleared() {
        super.onCleared()
        stopFlag = true
        generationJob?.cancel()
        llmScope.launch { bridge.free() }.invokeOnCompletion {
            llmScope.cancel()
            llmDispatcher.close()
        }
    }

    private fun pickThreadCount(): Int {
        // S23 Ultra is 1+2+2+3. 4 threads on perf cores is the sweet spot for
        // llama.cpp on mobile — more crowds the little cores and hurts latency.
        val cores = Runtime.getRuntime().availableProcessors()
        return (cores - 2).coerceIn(2, 4)
    }
}
