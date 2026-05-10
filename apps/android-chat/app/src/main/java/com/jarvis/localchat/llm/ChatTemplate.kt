package com.jarvis.localchat.llm

/**
 * Llama 3.2 / 3.1 instruct chat template. Other model families need their own
 * builder — keep this file the single source of truth so swapping models is
 * one branch, not search-and-replace.
 */
object ChatTemplate {

    data class Turn(val role: Role, val content: String)
    enum class Role { SYSTEM, USER, ASSISTANT }

    private const val BOS = "<|begin_of_text|>"
    private const val EOT = "<|eot_id|>"

    fun build(turns: List<Turn>, system: String? = null): String {
        val sb = StringBuilder(BOS)
        if (!system.isNullOrBlank()) {
            sb.append(header("system")).append(system).append(EOT)
        }
        for (t in turns) {
            sb.append(header(t.role.tag())).append(t.content).append(EOT)
        }
        // Open the assistant turn so the model continues from there.
        sb.append(header("assistant"))
        return sb.toString()
    }

    private fun header(role: String) = "<|start_header_id|>$role<|end_header_id|>\n\n"

    private fun Role.tag() = when (this) {
        Role.SYSTEM -> "system"
        Role.USER -> "user"
        Role.ASSISTANT -> "assistant"
    }
}
