package com.hatem.musicmute.processing

import java.io.ByteArrayInputStream
import java.io.File
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AudioInputPreparerTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun expandedInputIsInclusiveAndRecoveryPreservesMetadataWithoutProviderGrant() = runBlocking {
        val id = java.util.UUID.randomUUID().toString()
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1800.0, true, false, "audio/mp4") }
        val input = preparer.prepare("owner", "video.m4a", id, expandedMediaPolicy(), "video_file") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val recovered = preparer.recover("owner", id, "video.mov", expandedMediaPolicy(), "video_file")
        assertEquals(input.declaration, recovered?.declaration)
        assertEquals("video_file", recovered?.mediaSource)
        assertEquals(2, recovered?.mediaPolicy?.version)
    }

    @Test fun replayUsesCommittedBytesWithoutReopeningTheSource() = runBlocking {
        val id = java.util.UUID.randomUUID().toString()
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mpeg") }
        val first = preparer.prepare("owner", "sample.mp3", id) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val restarted = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mpeg") }
        val replay = restarted.prepare("owner", "sample.mp3", id) { error("Source permission is no longer available") }
        assertEquals(first.declaration, replay.declaration)
        assertEquals(first.file, replay.file)
        assertArrayEquals(byteArrayOf(1, 2, 3), replay.file.readBytes())
    }

    @Test fun failedPreparationNeverDeletesAnExistingUnownedInput() = runBlocking {
        val id = java.util.UUID.randomUUID().toString()
        val directory = File(processingOwnerDirectory(temporary.root, "owner"), id).apply { mkdirs() }
        val existing = File(directory, "input.mp3").apply { writeBytes(byteArrayOf(9, 8, 7)) }
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mpeg") }
        try {
            preparer.prepare("owner", "sample.mp3", id) { error("Must preserve unowned input") }
            fail("Uncommitted legacy input must not be adopted")
        } catch (_: InputPreparationException) { }
        assertArrayEquals(byteArrayOf(9, 8, 7), existing.readBytes())
    }

    @Test fun restartFinishesPublishingValidatedPendingBytesAndDetectsCorruption() = runBlocking {
        val id = java.util.UUID.randomUUID().toString()
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mpeg") }
        val first = preparer.prepare("owner", "sample.mp3", id) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val pending = File(first.file.parentFile, ".input.pending.mp3")
        assertTrue(first.file.renameTo(pending)) // Simulate the durable marker/file publication boundary.
        val recovered = preparer.prepare("owner", "sample.mp3", id) { error("Must recover pending bytes") }
        assertArrayEquals(byteArrayOf(1, 2, 3), recovered.file.readBytes())
        recovered.file.writeBytes(byteArrayOf(7, 7, 7))
        try {
            preparer.prepare("owner", "sample.mp3", id) { error("Must not replace corrupt committed data") }
            fail("Corrupt committed input accepted")
        } catch (_: InputPreparationException) { }
        assertArrayEquals(byteArrayOf(7, 7, 7), recovered.file.readBytes())
    }

    @Test fun stagedTaggedAacKeepsItsContainerIdentity() = runBlocking {
        val preparer = AudioInputPreparer(temporary.root) { file ->
            AudioInspection(1.0, true, false, requireNotNull(sniffProcessingContainer(file)))
        }
        val result = preparer.prepare("owner", "sample.aac") {
            ByteArrayInputStream("ID3".toByteArray() + ByteArray(20))
        }
        assertEquals("audio/aac", result.declaration.contentType)
        assertEquals("aac", result.file.extension)
    }

    @Test fun limitsMatchServerExactly() {
        assertTrue(validProcessingInput(29_999_999, 599.999))
        assertFalse(validProcessingInput(30_000_000, 599.999))
        assertFalse(validProcessingInput(1, 600.0))
        assertFalse(validProcessingInput(0, 1.0))
        assertFalse(validProcessingInput(1, Double.NaN))
        assertFalse(validProcessingInput(1, Double.POSITIVE_INFINITY))
        assertFalse(validProcessingInput(1, 0.0))
    }

    @Test fun copiesOriginalBytesAndHashesBase64IntoOwnerPrivateDirectory() = runBlocking {
        val bytes = ByteArray(80_003) { (it % 239).toByte() }
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(19.5, true, false, "audio/mp4") }
        val result = preparer.prepare("owner/../../unsafe", "original.m4a") { ByteArrayInputStream(bytes) }
        assertArrayEquals(bytes, result.file.readBytes())
        assertEquals("m4a", result.declaration.extension)
        assertEquals("audio/mp4", result.declaration.contentType)
        assertEquals(bytes.size.toLong(), result.declaration.bytes)
        assertEquals(Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes)), result.declaration.sha256)
        assertTrue(result.file.canonicalPath.startsWith(temporary.root.canonicalPath + File.separator))
        assertFalse(result.file.path.contains("unsafe"))
        assertEquals("owner/../../unsafe", result.ownerUid)
    }

    @Test fun rejectsUnsupportedNamesBeforeReadingAndRejectsVideoAfterCopy() = runBlocking {
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(2.0, true, true, "audio/mp4") }
        var opened = false
        try {
            preparer.prepare("a", "sound.wav") { opened = true; ByteArrayInputStream(byteArrayOf(1)) }
            fail("Unsupported audio accepted")
        } catch (_: InputPreparationException) { }
        assertFalse(opened)
        try {
            preparer.prepare("a", "video.mp4") { ByteArrayInputStream(byteArrayOf(1)) }
            fail("Video accepted")
        } catch (_: InputPreparationException) { }
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
    }

    @Test fun rejectsEmptyUnknownDurationAndContainerMismatch() = runBlocking {
        for (inspection in listOf(
            AudioInspection(Double.NaN, true, false, "audio/mp4"),
            AudioInspection(1.0, false, false, "audio/mp4"),
            AudioInspection(1.0, true, false, "audio/webm"),
        )) {
            val preparer = AudioInputPreparer(temporary.root) { inspection }
            try {
                preparer.prepare("a", "sample.m4a") { ByteArrayInputStream(byteArrayOf(1)) }
                fail("Invalid input accepted")
            } catch (_: InputPreparationException) { }
        }
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mp4") }
        try {
            preparer.prepare("a", "sample.m4a") { ByteArrayInputStream(byteArrayOf()) }
            fail("Empty input accepted")
        } catch (_: InputPreparationException) { }
    }

    @Test fun byteLimitUsesStreamNotProviderClaim() = runBlocking {
        val preparer = AudioInputPreparer(temporary.root, maxBytes = 10) { AudioInspection(1.0, true, false, "audio/mpeg") }
        try {
            preparer.prepare("a", "sample.mp3") { ByteArrayInputStream(ByteArray(10)) }
            fail("Exact limit accepted")
        } catch (error: InputPreparationException) {
            assertEquals(InputPreparationError.TOO_LARGE, error.reason)
        }
        assertFalse(temporary.root.walkTopDown().any { it.isFile })
    }

    @Test fun differentOwnersAndSelectionsDoNotReuseStagedFiles() = runBlocking {
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1.0, true, false, "audio/mpeg") }
        val first = preparer.prepare("a", "sample.mp3") { ByteArrayInputStream(byteArrayOf(1)) }
        val second = preparer.prepare("b", "sample.mp3") { ByteArrayInputStream(byteArrayOf(1)) }
        assertNotEquals(requireNotNull(first.file.parentFile).parentFile, requireNotNull(second.file.parentFile).parentFile)
        assertTrue(first.file.exists())
        assertTrue(second.file.exists())
    }
}
