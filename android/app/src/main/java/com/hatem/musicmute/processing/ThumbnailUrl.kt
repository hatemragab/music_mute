package com.hatem.musicmute.processing

import java.net.URI
import java.net.URLDecoder
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

private val thumbnailPath = Regex("/vi(?:_webp)?/[A-Za-z0-9_-]{11}/[A-Za-z0-9_-]{1,64}\\.(?:jpg|webp)")
private val thumbnailQueryValue = Regex("[A-Za-z0-9_-]{1,1024}={0,2}")

/** Keep only the original public thumbnail URL supplied by the API; never derive one. */
fun validatedThumbnailUrl(value: String?): String? {
    if (value.isNullOrEmpty() || value.length > 2048 ||
        value.any { it.code !in 33..126 || it == '\\' } || '#' in value) return null
    val uri = runCatching { URI(value) }.getOrNull() ?: return null
    if (uri.scheme != "https" || uri.rawAuthority != "i.ytimg.com" ||
        uri.rawFragment != null || !thumbnailPath.matches(uri.rawPath ?: "")) return null
    val query = uri.rawQuery?.takeIf { it.isNotEmpty() } ?: return value
    val parameters = query.split('&')
    if (parameters.size > 2) return null
    val names = mutableSetOf<String>()
    for (parameter in parameters) {
        val separator = parameter.indexOf('=')
        if (separator < 1) return null
        val name = runCatching { URLDecoder.decode(parameter.substring(0, separator), "UTF-8") }.getOrNull()
            ?: return null
        val field = runCatching { URLDecoder.decode(parameter.substring(separator + 1), "UTF-8") }.getOrNull()
            ?: return null
        if (name !in setOf("sqp", "rs") || !names.add(name) || !thumbnailQueryValue.matches(field)) return null
    }
    return value
}

/** Missing, null or malformed optional artwork must never hide an otherwise valid song. */
@OptIn(ExperimentalSerializationApi::class)
object ThumbnailUrlSerializer : KSerializer<String?> {
    // Decode this optional field as JSON so invalid types fall back independently of required job scalars.
    override val descriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): String? {
        if (decoder !is JsonDecoder) return validatedThumbnailUrl(decoder.decodeString())
        val value = decoder.decodeJsonElement() as? JsonPrimitive ?: return null
        return value.takeIf { it.isString }?.content?.let(::validatedThumbnailUrl)
    }

    override fun serialize(encoder: Encoder, value: String?) {
        val clean = validatedThumbnailUrl(value)
        if (clean == null) encoder.encodeNull() else encoder.encodeString(clean)
    }
}
