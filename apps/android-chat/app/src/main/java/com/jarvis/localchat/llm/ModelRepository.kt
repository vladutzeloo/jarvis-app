package com.jarvis.localchat.llm

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileOutputStream

/**
 * Discovers a GGUF model file under app-private storage and (optionally) imports
 * one from a SAF-picked Uri. We keep the model in `filesDir/models/` so it gets
 * removed when the app is uninstalled — no SD-card hunting, no scoped-storage tax.
 */
class ModelRepository(private val context: Context) {

    private val modelsDir: File =
        File(context.filesDir, "models").apply { if (!exists()) mkdirs() }

    fun listModels(): List<File> =
        modelsDir.listFiles { f -> f.isFile && f.name.endsWith(".gguf", ignoreCase = true) }
            ?.sortedBy { it.name }
            ?: emptyList()

    fun firstAvailable(): File? = listModels().firstOrNull()

    /**
     * Copies a SAF-picked file into app-private storage. Streams in 1 MiB chunks
     * so we don't hold a 700 MB+ ByteArray on the heap. Caller runs this on IO.
     */
    fun importFromUri(uri: Uri, onProgress: (copied: Long, total: Long) -> Unit = { _, _ -> }): File? {
        val docName = DocumentFile.fromSingleUri(context, uri)?.name
            ?: uri.lastPathSegment?.substringAfterLast('/')
            ?: "model.gguf"
        val safeName = if (docName.endsWith(".gguf", true)) docName else "$docName.gguf"
        val dest = File(modelsDir, safeName)

        val total = runCatching {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
        }.getOrNull() ?: -1L

        context.contentResolver.openInputStream(uri)?.use { input ->
            FileOutputStream(dest).use { output ->
                val buf = ByteArray(1 shl 20)
                var copied = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    output.write(buf, 0, n)
                    copied += n
                    onProgress(copied, total)
                }
                output.fd.sync()
            }
        } ?: return null

        return dest
    }

    fun delete(file: File): Boolean = file.exists() && file.delete()
}
