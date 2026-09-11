package com.hatem.musicmute.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class YouTubeUrlTest {
    @Test
    fun canonicalizesEverySupportedFormToOneWatchUrl() {
        listOf(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                " https://youtu.be/dQw4w9WgXcQ?t=20 ",
                "https://m.youtube.com/shorts/dQw4w9WgXcQ",
                "https://youtube.com/live/dQw4w9WgXcQ",
            )
            .forEach {
                assertEquals(
                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    YouTubeUrl.canonical(it),
                )
            }
        assertNull(YouTubeUrl.canonical("https://example.test/watch?v=dQw4w9WgXcQ"))
    }

    @Test
    fun acceptsSupportedVideoForms() {
        listOf(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                " https://youtu.be/dQw4w9WgXcQ?t=20 ",
                "https://m.youtube.com/shorts/dQw4w9WgXcQ",
                "https://youtube.com/live/dQw4w9WgXcQ",
                "https://music.youtube.com/watch?list=123&v=dQw4w9WgXcQ",
                "http://youtube.com/embed/dQw4w9WgXcQ",
            )
            .forEach { assertTrue(it, YouTubeUrl.isSupported(it)) }
    }

    @Test
    fun rejectsMalformedUnsupportedAndDeceptiveUrls() {
        listOf(
                "",
                "hello",
                "youtube.com/watch?v=dQw4w9WgXcQ",
                "https://youtube.com",
                "https://youtube.com/playlist?list=123",
                "https://youtube.com/watch?v=short",
                "https://youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk",
                "https://youtu.be/dQw4w9WgXcQ/extra",
                "ftp://youtu.be/dQw4w9WgXcQ",
                "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
                "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
                "https://user@youtube.com/watch?v=dQw4w9WgXcQ",
                "https://youtube.com:123/watch?v=dQw4w9WgXcQ",
                "https://youtu.be/../../dQw4w9WgXcQ",
                "https://youtu.be/<script>123",
            )
            .forEach { assertFalse(it, YouTubeUrl.isSupported(it)) }
    }
}
