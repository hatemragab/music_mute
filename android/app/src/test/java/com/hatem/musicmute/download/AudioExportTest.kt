package com.hatem.musicmute.download

import java.io.ByteArrayOutputStream
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AudioExportTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun exportPreservesEveryByteAndTheOriginalFile() {
        val source = temporary.newFile("audio.webm")
        val bytes = ByteArray(32_789) { (it % 251).toByte() }
        source.writeBytes(bytes)
        val output = ByteArrayOutputStream()
        assertEquals(bytes.size.toLong(), copyOriginalAudio(source, output))
        assertArrayEquals(bytes, output.toByteArray())
        assertArrayEquals(bytes, source.readBytes())
    }

    @Test
    fun exportNamePreservesArabicAndOriginalContainerWithoutPathSeparators() {
        val record = DownloadRecord("id", "url", 0, title = "صوت / اختبار: 1", extension = "webm")
        assertEquals("صوت _ اختبار_ 1.webm", audioExportName(record))
        assertEquals("audio/webm", audioMimeType(record.extension))
        assertEquals("audio/mp4", audioMimeType("m4a"))
        assertEquals("audio/ogg", audioMimeType("opus"))
    }

    @Test
    fun missingAudioCannotBeExported() {
        val output = ByteArrayOutputStream()
        assertThrows(IllegalArgumentException::class.java) {
            copyOriginalAudio(File(temporary.root, "missing.webm"), output)
        }
        assertEquals(0, output.size())
    }
}
