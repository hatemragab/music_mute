package com.hatem.musicmute.auth

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Keep Kotlin model names local while the HTTP JSON contract uses snake_case. */
object ApiWireJson {
    private val json = Json
    private val snakeCase = Regex("^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
    private val uppercase = Regex("[A-Z]")
    private val underscore = Regex("_([a-z0-9])")

    fun request(body: String): String = convert(json.parseToJsonElement(body), false).toString()

    fun response(body: String): String =
        if (body.isEmpty()) body else convert(json.parseToJsonElement(body), true).toString()

    private fun convert(value: JsonElement, incoming: Boolean, opaque: Boolean = false): JsonElement =
        when (value) {
            is JsonArray -> JsonArray(value.map { convert(it, incoming, opaque) })
            is JsonObject -> JsonObject(
                value.mapKeys { (key, _) ->
                    if (opaque) key
                    else if (incoming) {
                        require(snakeCase.matches(key)) { "Invalid API response key" }
                        underscore.replace(key) { it.groupValues[1].uppercase() }
                    } else uppercase.replace(key) { "_${it.value.lowercase()}" }
                }.mapValues { (key, item) ->
                    convert(item, incoming, opaque || key == "headers")
                }
            )
            else -> value
        }
}
