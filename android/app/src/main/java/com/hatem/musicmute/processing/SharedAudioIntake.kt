package com.hatem.musicmute.processing

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Copy temporary incoming grants while Activity owns them; workers use our durable URI. */
internal suspend fun stageSharedAudio(context: Context, uri: Uri, owner: ProcessingSession,
    current: () -> ProcessingSession?, activeUris: Set<String>): Uri = withContext(Dispatchers.IO) {
    require(uri.scheme == "content" && uri.authority != "${context.packageName}.processed-audio")
    check(current() == owner)
    val resolver = context.contentResolver
    val mime = resolver.getType(uri)
    require(mime?.startsWith("audio/") == true) { "Unsupported audio" }
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: "audio"
    val root = processingOwnerDirectory(File(context.filesDir, "shared_audio_intake"), owner.uid).apply { mkdirs() }
    root.walkTopDown().filter { it.isFile }.toList().forEach { file ->
        val ownUri = FileProvider.getUriForFile(context, "${context.packageName}.processed-audio", file).toString()
        if (ownUri !in activeUris && System.currentTimeMillis() - file.lastModified() > 86_400_000) file.delete()
    }
    require(root.walkTopDown().filter { it.isFile }.sumOf { it.length() } < 300_000_000) { "Shared audio storage is full" }
    val safeName = name.replace(Regex("[^\\p{L}\\p{N} ._-]"), "_").takeLast(100)
    val output = File(File(root, UUID.randomUUID().toString()).apply { mkdirs() }, safeName.ifBlank { "audio" })
    try {
        requireNotNull(resolver.openInputStream(uri)).use { input ->
            output.outputStream().use { target ->
                val bytes = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    currentCoroutineContext().ensureActive()
                    check(current() == owner)
                    val count = input.read(bytes)
                    if (count < 0) break
                    total += count
                    require(total <= 100_000_000) { "Shared audio is too large" }
                    target.write(bytes, 0, count)
                }
                require(total > 0)
            }
        }
        check(current() == owner)
        FileProvider.getUriForFile(context, "${context.packageName}.processed-audio", output)
    } catch (error: Exception) { output.delete(); throw error }
}
