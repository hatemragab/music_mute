package com.hatem.musicmute.library

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Optional listening history must never make durable processing metadata unreadable. */
object LibraryPlayCountSerializer : KSerializer<Long> {
    override val descriptor = PrimitiveSerialDescriptor("LibraryPlayCount", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        if (decoder !is JsonDecoder) return decoder.decodeLong().coerceAtLeast(0)
        val value = decoder.decodeJsonElement() as? JsonPrimitive ?: return 0
        return value.takeUnless { it.isString }?.longOrNull?.coerceAtLeast(0) ?: 0
    }

    override fun serialize(encoder: Encoder, value: Long) = encoder.encodeLong(value.coerceAtLeast(0))
}
