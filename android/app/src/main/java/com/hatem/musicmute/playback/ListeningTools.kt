package com.hatem.musicmute.playback

import com.hatem.musicmute.library.LibraryKey
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Source-relative milliseconds: original and isolated audio never share annotations. */
@Serializable
data class AudioBookmark(val positionMs: Long, val label: String)

data class AudioRange(val startMs: Long, val endMs: Long) {
    fun valid(durationMs: Long) = startMs >= 0 && endMs - startMs >= 500 && endMs <= durationMs
}

internal fun sleepDeadline(nowMs: Long, minutes: Int): Long? =
    if (minutes in 1..180) nowMs + minutes * 60_000L else null

internal fun loopSeek(positionMs: Long, range: AudioRange?, durationMs: Long): Long? =
    range?.takeIf { it.valid(durationMs) && (positionMs >= it.endMs || positionMs < it.startMs) }?.startMs

internal fun clipRangeValid(range: AudioRange, durationMs: Long): Boolean =
    range.valid(durationMs) && range.endMs - range.startMs <= 300_000

internal fun listeningKey(value: String): String = MessageDigest.getInstance("SHA-256")
    .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }

class BookmarkStore(private val root: File) {
    private val json = Json { ignoreUnknownKeys = true }
    private fun file(key: LibraryKey, original: Boolean): File =
        File(File(root, listeningKey(key.ownerUid)), "${listeningKey(key.jobId)}-$original.json")

    @Synchronized fun load(key: LibraryKey, original: Boolean): List<AudioBookmark> = try {
        val file = file(key, original)
        if (file.length() > 64_000) emptyList() else json.decodeFromString<List<AudioBookmark>>(file.readText())
            .filter { it.positionMs >= 0 }.take(100).sortedBy { it.positionMs }
    } catch (_: Exception) { emptyList() }

    @Synchronized fun save(key: LibraryKey, original: Boolean, values: List<AudioBookmark>) {
        val target = file(key, original)
        target.parentFile?.mkdirs()
        val clean = values.filter { it.positionMs >= 0 }.distinctBy { it.positionMs }.take(100)
            .map { it.copy(label = it.label.trim().take(80)) }.sortedBy { it.positionMs }
        val temp = File(target.parentFile, "${target.name}.tmp")
        temp.outputStream().use { it.write(json.encodeToString(clean).toByteArray()); it.fd.sync() }
        check(temp.renameTo(target)) { "Unable to save bookmarks" }
    }

    @Synchronized fun clear(ownerUid: String) { File(root, listeningKey(ownerUid)).deleteRecursively() }
}

/** Legacy media browsers ask for Integer.MAX_VALUE; bound Binder payloads with a More folder. */
internal data class BrowseWindow(val start: Int, val count: Int, val nextOffset: Int?)
internal fun browseWindow(total: Int, offset: Int, page: Int, pageSize: Int): BrowseWindow? {
    if (total < 0 || offset < 0 || page < 0 || pageSize <= 0) return null
    val start = offset.toLong() + page.toLong() * pageSize
    if (start >= total) return BrowseWindow(total, 0, null)
    val remaining = total - start.toInt()
    val size = minOf(pageSize, 200)
    val more = pageSize > 200 && remaining > size
    val count = minOf(remaining, if (more) size - 1 else size)
    return BrowseWindow(start.toInt(), count, if (more) start.toInt() + count else null)
}
