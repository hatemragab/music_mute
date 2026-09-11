package com.hatem.musicmute.download

import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AudioDownloadPolicyTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun actualLibraryRequestUsesOnlyTheSourceStreamAndAControlledOutputPath() {
        val directory = temporary.newFolder()
        val command = createAudioRequest("https://youtu.be/dQw4w9WgXcQ", directory).buildCommand()
        assertEquals(AudioDownloadPolicy.FORMAT, command[command.indexOf("-f") + 1])
        assertEquals("never", command[command.indexOf("--fixup") + 1])
        assertEquals(
            File(directory, "audio.%(ext)s").absolutePath,
            command[command.indexOf("-o") + 1],
        )
        assertFalse(command.contains("--extract-audio"))
        assertFalse(command.contains("--recode-video"))
        assertTrue(command.contains("https://youtu.be/dQw4w9WgXcQ"))
    }

    @Test
    fun selectsOnlyDirectAudioWithoutConversionOrVideoFallback() {
        assertEquals("bestaudio[protocol=https]", AudioDownloadPolicy.options["-f"])
        assertEquals("never", AudioDownloadPolicy.options["--fixup"])
        assertTrue(
            AudioDownloadPolicy.flags.containsAll(
                listOf("--ignore-config", "--no-playlist", "--write-info-json")
            )
        )
        val options = AudioDownloadPolicy.flags + AudioDownloadPolicy.options.keys
        listOf(
                "-x",
                "--extract-audio",
                "--audio-format",
                "--audio-quality",
                "--recode-video",
                "--remux-video",
                "--embed-metadata",
            )
            .forEach { assertFalse("Must not transform the source: $it", it in options) }
    }

    @Test
    fun readsOriginalMetadataWithoutChangingAudioBytes() {
        val directory = temporary.newFolder()
        val bytes = byteArrayOf(0x1a, 0x45, 0xdf.toByte(), 0xa3.toByte(), 1, 2, 3)
        val audio = File(directory, "audio.webm").apply { writeBytes(bytes) }
        File(directory, "audio.info.json")
            .writeText(
                """{"title":"Voice sample","ext":"webm","vcodec":"none","acodec":"opus","abr":145.5,"duration":42.25,"url":"https://expiring.example"}"""
            )
        val result = DownloadedAudioReader.read(directory)
        assertEquals("Voice sample", result.title)
        assertEquals("opus", result.codec)
        assertEquals(145, result.bitrateKbps)
        assertEquals(42250L, result.durationMs)
        assertArrayEquals(bytes, audio.readBytes())
    }

    @Test
    fun rejectsVideoOrIncompleteFiles() {
        val directory = temporary.newFolder()
        val metadata = File(directory, "audio.info.json")
        metadata.writeText("""{"ext":"mp4","vcodec":"avc1","acodec":"aac"}""")
        File(directory, "audio.mp4").writeText("video")
        assertThrows(IllegalArgumentException::class.java) { DownloadedAudioReader.read(directory) }
        metadata.writeText("""{"ext":"m4a","vcodec":"none","acodec":"aac"}""")
        File(directory, "audio.m4a.part").writeText("unfinished")
        assertThrows(IllegalArgumentException::class.java) { DownloadedAudioReader.read(directory) }
        File(directory, "audio.m4a").writeBytes(byteArrayOf())
        assertThrows(IllegalArgumentException::class.java) { DownloadedAudioReader.read(directory) }
    }

    @Test
    fun rejectsMetadataPathsOutsideTheDownloadDirectory() {
        val directory = temporary.newFolder()
        File(directory, "audio.info.json")
            .writeText("""{"ext":"../../outside","vcodec":"none","acodec":"opus"}""")
        assertThrows(IllegalArgumentException::class.java) { DownloadedAudioReader.read(directory) }
        val root = temporary.newFolder()
        val outside = temporary.newFile("outside.webm").apply { writeText("private") }
        assertNull(resolveAudioFile(root, "../${outside.name}"))
        assertNull(resolveAudioFile(root, "missing.webm"))
        assertNull(resolveAudioFile(root, ""))
        File(root, "audio.webm").writeText("audio")
        assertNotNull(resolveAudioFile(root, "audio.webm"))
    }
}
