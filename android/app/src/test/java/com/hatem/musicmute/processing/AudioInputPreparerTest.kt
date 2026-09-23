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

    @Test fun fullDecodeIsSkippedOnlyWhenExplicitlyRequested() = runBlocking {
        var decoded = 0
        val preparer = AudioInputPreparer(temporary.root,
            validateDecoded = { _, _ -> decoded++ },
            inspect = { AudioInspection(1.0, true, false, "audio/mpeg") })
        preparer.prepare("owner", "picked.mp3") { ByteArrayInputStream(byteArrayOf(1)) }
        assertEquals(1, decoded)
        preparer.prepare("owner", "downloaded.mp3", validateFullDecode = false) {
            ByteArrayInputStream(byteArrayOf(2))
        }
        assertEquals(1, decoded)
    }

    @Test fun generatedAudioWithoutSecondDecodeStillRequiresValidInspectionAndChecksum() = runBlocking {
        var hasVideo = false
        val preparer = AudioInputPreparer(temporary.root,
            validateDecoded = { _, _ -> fail("Generated audio must not be decoded twice") },
            inspect = { AudioInspection(12.0, true, hasVideo, "audio/mp4") })
        val bytes = byteArrayOf(1, 2, 3, 4)
        val prepared = preparer.prepare("owner", "extracted.m4a", validateFullDecode = false) {
            ByteArrayInputStream(bytes)
        }
        assertArrayEquals(bytes, prepared.file.readBytes())
        assertEquals(Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes)),
            prepared.declaration.sha256)
        hasVideo = true
        try {
            preparer.prepare("owner", "video.m4a", validateFullDecode = false) {
                ByteArrayInputStream(bytes)
            }
            fail("A video track must still be rejected")
        } catch (error: InputPreparationException) {
            assertEquals(InputPreparationError.INVALID_AUDIO, error.reason)
        }
    }

    @Test fun expandedInputIsInclusiveAndRecoveryPreservesMetadataWithoutProviderGrant() = runBlocking {
        val id = java.util.UUID.randomUUID().toString()
        val preparer = AudioInputPreparer(temporary.root) { AudioInspection(1200.0, true, false, "audio/mp4") }
        val input = preparer.prepare("owner", "video.m4a", id, standardMediaPolicy(), "video_file") { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val recovered = preparer.recover("owner", id, "video.mov", standardMediaPolicy(), "video_file")
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
        assertTrue(validProcessingInput(50_000_000, 1_200.0))
        assertFalse(validProcessingInput(50_000_001, 1_200.0))
        assertFalse(validProcessingInput(1, 1_200.001))
        assertTrue(validProcessingInput(1, 600.0))
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
        val exact = preparer.prepare("a", "sample.mp3") { ByteArrayInputStream(ByteArray(10)) }
        assertEquals(10, exact.declaration.bytes)
        try {
            preparer.prepare("a", "sample.mp3") { ByteArrayInputStream(ByteArray(11)) }
            fail("Above-limit input accepted")
        } catch (error: InputPreparationException) {
            assertEquals(InputPreparationError.TOO_LARGE, error.reason)
        }
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
