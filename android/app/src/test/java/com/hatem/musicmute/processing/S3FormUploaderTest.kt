package com.hatem.musicmute.processing

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.*
import org.junit.Test

class S3FormUploaderTest {
    private class Connection(private val status: Int) : HttpURLConnection(URL("https://storage.example/")) {
        val output = ByteArrayOutputStream()
        var disconnected = false
        override fun disconnect() { disconnected = true }
        override fun usingProxy() = false
        override fun connect() = Unit
        override fun getOutputStream() = output
        override fun getResponseCode() = status
    }

    @Test fun signedFieldsAreUnchangedAndFileIsLastWithoutApiHeaders() = runTest { withContext(Dispatchers.IO) {
        val file=kotlin.io.path.createTempFile("signed-form-", ".mp3").toFile().apply { writeBytes(byteArrayOf(1,2,3)) }
        val input=InputDeclaration("mp3","audio/mpeg",3,1.0,Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(file.readBytes())))
        val fields=linkedMapOf("key" to "opaque/object", "Content-Type" to "audio/mpeg", "x-amz-extra" to "signed + / =\nline")
        val client=Connection(204); val sent=mutableListOf<Long>()
        S3FormUploader { client }.upload(file,input,UploadGrant("https://storage.example/",fields,Instant.EPOCH)) { bytes,_ -> sent += bytes }
        val form=client.output.toString("UTF-8")
        assertTrue(form.contains("signed + / =\nline"))
        assertTrue(form.indexOf("name=\"file\"") > form.indexOf("name=\"x-amz-extra\""))
        assertEquals("POST",client.requestMethod)
        assertFalse(client.instanceFollowRedirects)
        assertNull(client.getRequestProperty("Authorization"))
        assertNull(client.getRequestProperty("X-Installation-Id"))
        assertNull(client.getRequestProperty("Cookie"))
        assertEquals(listOf(3L),sent)
        assertTrue(client.disconnected)
    } }

    @Test fun redirectsAndMidTransferDeclarationMismatchFail() = runTest { withContext(Dispatchers.IO) {
        val file=kotlin.io.path.createTempFile("signed-form-failure-", ".mp3").toFile().apply { writeBytes(byteArrayOf(1,2,3)) }
        val digest=Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(file.readBytes()))
        val input=InputDeclaration("mp3","audio/mpeg",3,1.0,digest)
        val grant=UploadGrant("https://storage.example/",emptyMap(),Instant.EPOCH)
        for (status in listOf(307,403,503)) {
            val connection=Connection(status)
            assertTrue(runCatching { S3FormUploader { connection }.upload(file,input,grant) { _,_ -> } }.isFailure)
            assertFalse(connection.instanceFollowRedirects)
        }
        file.writeBytes(byteArrayOf(3,2,1))
        val failed=Connection(204)
        val error=runCatching { S3FormUploader { failed }.upload(file,input,grant) { _,_ -> } }.exceptionOrNull() as ProcessingTransferException
        assertEquals(ProcessingLocalProblem.INPUT_CHANGED,error.problem)
        assertFalse(failed.output.toString("UTF-8").endsWith("--\r\n"))
    } }
}
