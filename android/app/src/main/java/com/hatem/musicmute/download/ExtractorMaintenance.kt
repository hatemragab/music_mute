package com.hatem.musicmute.download

import java.io.File
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

internal data class ExtractorRelease(val version: String, val sha256: String, val url: String)
internal enum class ExtractorUpdate { CURRENT, UPDATED, DEFERRED, FAILED }

/** Called only while holding the downloader's engine mutex. Never touches media files. */
internal class ExtractorMaintenance(
    private val installed: File,
    private val latest: () -> ExtractorRelease = ::latestExtractorRelease,
    private val fetch: (String) -> ByteArray = { readExtractorUrl(it, 16 * 1024 * 1024) },
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val previous = File(installed.parentFile, "yt-dlp.previous")
    private val pending = File(installed.parentFile, "yt-dlp.pending")
    private val nextCheck = File(installed.parentFile, "next-check")

    data class Candidate(val release: ExtractorRelease, val bytes: ByteArray)

    /** Offline recovery only. Caller holds the engine lock. */
    fun recover() {
        if (pending.exists()) {
            check(previous.isFile) { "Extractor recovery copy missing" }
            atomicWrite(installed, previous.readBytes())
            check(pending.delete())
        }
    }

    fun isDeferred(): Boolean =
        nextCheck.readTextOrNull()?.toLongOrNull()?.let { it - now() in 1..86_400_000L } == true

    /** Network work is deliberately outside the engine lock and download path. */
    fun prepare(currentVersion: String): Candidate? {
        if (isDeferred()) return null
        atomicWrite(nextCheck, (now() + 6 * 60 * 60 * 1000L).toString().toByteArray())
        val release = latest()
        require(release.version.matches(Regex("[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}")))
        require(release.sha256.matches(Regex("[a-f0-9]{64}")))
        if (currentVersion == release.version) {
            checkedSuccessfully()
            return null
        }
        val bytes = fetch(release.url)
        require(bytes.isNotEmpty() && bytes.size <= 16 * 1024 * 1024)
        require(sha256(bytes) == release.sha256) { "Extractor checksum mismatch" }
        return Candidate(release, bytes)
    }

    /** Only activation/probing takes the engine lock; no network access here. */
    fun activate(candidate: Candidate, probe: () -> String) {
        require(sha256(candidate.bytes) == candidate.release.sha256)
        atomicWrite(previous, installed.readBytes())
        atomicWrite(pending, byteArrayOf(1))
        try {
            atomicWrite(installed, candidate.bytes)
            check(probe().trim() == candidate.release.version) { "Extractor runtime incompatible" }
            check(pending.delete())
            checkedSuccessfully()
        } catch (error: Exception) {
            recover()
            throw error
        }
    }

    private fun checkedSuccessfully() {
        atomicWrite(nextCheck, (now() + 24 * 60 * 60 * 1000L).toString().toByteArray())
    }

    // Combined entry point for offline updater contract tests. Downloads never call this.
    fun refresh(probe: () -> String): ExtractorUpdate {
        recover()
        if (isDeferred()) return ExtractorUpdate.DEFERRED
        return try {
            val current = try { probe().trim() } catch (error: Exception) {
                if (error is InterruptedException || Thread.currentThread().isInterrupted) throw error
                "unknown"
            }
            val candidate = prepare(current)
            if (candidate == null) ExtractorUpdate.CURRENT else {
                activate(candidate, probe)
                ExtractorUpdate.UPDATED
            }
        } catch (error: Exception) {
            if (error is InterruptedException || Thread.currentThread().isInterrupted) throw error
            ExtractorUpdate.FAILED
        }
    }

    private fun File.readTextOrNull(): String? = if (isFile) readText() else null
}

internal fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun atomicWrite(target: File, bytes: ByteArray) {
    val temporary = File(target.parentFile, "${target.name}.tmp")
    temporary.outputStream().use { it.write(bytes); it.fd.sync() }
    Files.move(temporary.toPath(), target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
}

private fun latestExtractorRelease(): ExtractorRelease {
    val data = Json.parseToJsonElement(readExtractorUrl(
        "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", 1024 * 1024,
    ).decodeToString()).jsonObject
    val asset = data.getValue("assets").jsonArray.first {
        it.jsonObject["name"]?.jsonPrimitive?.content == "yt-dlp"
    }.jsonObject
    val version = data.getValue("tag_name").jsonPrimitive.content
    val url = asset.getValue("browser_download_url").jsonPrimitive.content
    require(url == "https://github.com/yt-dlp/yt-dlp/releases/download/$version/yt-dlp")
    val digest = asset.getValue("digest").jsonPrimitive.content
    require(digest.startsWith("sha256:"))
    return ExtractorRelease(version, digest.removePrefix("sha256:"), url)
}

private fun readExtractorUrl(address: String, limit: Int): ByteArray {
    var url = URL(address)
    repeat(4) {
        require(url.protocol == "https" && url.userInfo == null && url.port in listOf(-1, 443))
        require(url.host in setOf("api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"))
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("User-Agent", "MusicMute-Extractor-Updater")
            val status = connection.responseCode
            if (status in listOf(301, 302, 303, 307, 308)) {
                url = URL(url, requireNotNull(connection.getHeaderField("Location")))
            } else {
                check(status == 200) { "Extractor update HTTP failure" }
                require(connection.contentLengthLong <= limit)
                return connection.inputStream.use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    val deadline = System.nanoTime() + 30_000_000_000L
                    while (true) {
                        if (Thread.currentThread().isInterrupted) throw InterruptedException()
                        if (System.nanoTime() > deadline) throw InterruptedIOException("Extractor update deadline")
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= limit)
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
            }
        } finally {
            connection.disconnect()
        }
    }
    error("Too many extractor redirects")
}
