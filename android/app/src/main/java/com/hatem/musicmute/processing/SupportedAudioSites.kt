package com.hatem.musicmute.processing

import java.net.URLDecoder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One bundled policy shared with iOS and web; no discovery request is made. */
object SupportedAudioSites {
    @Serializable private data class Catalog(
        val schemaVersion: Int,
        val blockedQueryKeys: List<String>,
        val sites: List<Site>,
    )
    @Serializable private data class Site(val id: String, val name: String, val rules: List<Rule>)
    @Serializable private data class Rule(
        val host: String,
        val path: String,
        val requiredQuery: Map<String, String>,
    )
    private val json = Json { ignoreUnknownKeys = true }
    private val catalog: Catalog? by lazy {
        runCatching {
            SupportedAudioSites::class.java.getResourceAsStream("/supported-audio-sites.json")
                ?.bufferedReader()?.use { json.decodeFromString<Catalog>(it.readText()) }
                ?.takeIf { it.schemaVersion == 1 }
        }.getOrNull()
    }
    val names: List<String> get() = catalog?.sites?.map { it.name }.orEmpty()
    private val authority = Regex("^(https?)://([a-zA-Z0-9.-]+)(/[^?#]*)?(\\?[^#]*)?$", RegexOption.IGNORE_CASE)

    fun canonical(raw: String): String {
        fun invalid(): Nothing = throw UrlImportFailure("IMPORT_INVALID_URL")
        val value = raw.trim()
        if (value.length !in 1..2048 || value.any { it.code !in 33..126 || it == '\\' }) invalid()
        val parts = authority.matchEntire(value) ?: invalid()
        if (Regex("%(?![a-fA-F0-9]{2})").containsMatchIn(value)) invalid()
        val host = parts.groupValues[2].lowercase()
        val path = parts.groupValues[3].ifEmpty { "/" }
        val rawQuery = parts.groupValues[4]
        if (Regex("(?:^|/)\\.{1,2}(?:/|$)|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)", RegexOption.IGNORE_CASE)
                .containsMatchIn(path)) invalid()
        val query = mutableMapOf<String, String>()
        try {
            rawQuery.removePrefix("?").split('&').filter { it.isNotEmpty() }.forEach { pair ->
                val name = URLDecoder.decode(pair.substringBefore('='), "UTF-8")
                val content = URLDecoder.decode(pair.substringAfter('=', ""), "UTF-8")
                if (query.containsKey(name) || (name + content).any { it.code < 32 || it.code == 127 }) invalid()
                query[name] = content
            }
        } catch (_: IllegalArgumentException) { invalid() }
        val policy = catalog ?: throw UrlImportFailure("IMPORT_UNSUPPORTED_PROVIDER")
        val site = policy.sites.firstOrNull { site -> site.rules.any { rule ->
            Regex(rule.host).matches(host) && Regex(rule.path).matches(path) &&
                rule.requiredQuery.all { (key, pattern) -> Regex(pattern).matches(query[key].orEmpty()) }
        } }
        if (site?.id == "youtube") {
            val videoId = if (Regex("/watch/?").matches(path)) query["v"].orEmpty()
                else path.trimEnd('/').substringAfterLast('/')
            if (!Regex("[A-Za-z0-9_-]{11}").matches(videoId) ||
                (query.containsKey("v") && query["v"] != videoId)) invalid()
            // Share links carry playlist/radio context, but each import targets one video.
            return "https://www.youtube.com/watch?v=$videoId"
        }
        if (policy.blockedQueryKeys.any { query.containsKey(it) })
            throw UrlImportFailure("IMPORT_SINGLE_ITEM_REQUIRED")
        if (site == null) throw UrlImportFailure("IMPORT_UNSUPPORTED_PROVIDER")
        // Retain existing SoundCloud identity normalization for saved request deduplication.
        if (host in setOf("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"))
            return "https://soundcloud.com${path.trimEnd('/')}"
        return "${parts.groupValues[1].lowercase()}://$host$path$rawQuery"
    }
}
