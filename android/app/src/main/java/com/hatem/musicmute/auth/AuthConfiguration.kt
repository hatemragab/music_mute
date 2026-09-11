package com.hatem.musicmute.auth

import java.net.URI

class AuthConfiguration(private val origin: String, private val debug: Boolean) {
    fun apiRoot(): String {
        val value = origin.trim().trimEnd('/')
        val url =
            runCatching { URI(value) }.getOrNull() ?: throw AuthFailure(AuthProblem.CONFIGURATION)
        val local = url.host in setOf("127.0.0.1", "localhost", "10.0.2.2", "[::1]")
        if (
            url.host.isNullOrBlank() ||
                url.rawUserInfo != null ||
                url.rawQuery != null ||
                url.rawFragment != null ||
                !url.rawPath.isNullOrEmpty() ||
                (url.scheme != "https" && !(debug && local && url.scheme == "http"))
        )
            throw AuthFailure(AuthProblem.CONFIGURATION)
        return "$value/api/v1"
    }

    fun isConfigured(): Boolean = runCatching { apiRoot() }.isSuccess
}
