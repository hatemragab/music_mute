package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthConfiguration
import com.hatem.musicmute.auth.AuthHttpTransport
import java.util.UUID
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class SupportedAudioSitesTest {
    @Serializable private data class Case(val url: String, val accepted: Boolean, val canonicalUrl: String? = null)
    @Test fun sharedPolicyFixtures() {
        val source = javaClass.getResourceAsStream("/url-policy-cases.json")!!.bufferedReader().use { it.readText() }
        for (case in Json.decodeFromString<List<Case>>(source)) {
            val result = runCatching { SupportedAudioSites.canonical(case.url) }
            assertEquals(case.url, case.accepted, result.isSuccess)
            case.canonicalUrl?.let { assertEquals(case.url, it, result.getOrThrow()) }
        }
        assertEquals(12, SupportedAudioSites.names.size)
    }

    @Test fun unsupportedLinksNeverAcquireTokensOrReachTransport() = runTest {
        var calls = 0
        val api = UrlImportsApiClient(AuthApiClient(
            AuthConfiguration("https://api.example.test", false), { "owner" },
            { calls++; error("Unexpected token request") },
            AuthHttpTransport { _, _, _, _ -> calls++; error("Unexpected HTTP request") }),
            { calls++; error("Unexpected installation access") })
        val failure = runCatching { api.create("https://unknown.example/audio", UUID.randomUUID().toString()) }.exceptionOrNull()
        assertEquals("IMPORT_UNSUPPORTED_PROVIDER", (failure as UrlImportFailure).code)
        assertEquals(0, calls)
    }
}
