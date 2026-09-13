package com.hatem.musicmute.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.library.OfflineStatus
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.QueueTrack
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.state.LibraryUiState
import com.hatem.musicmute.state.VocalUiState
import com.hatem.musicmute.ui.home.HomeScreen
import com.hatem.musicmute.ui.library.LibraryActions
import com.hatem.musicmute.ui.library.LibraryScreen
import com.hatem.musicmute.ui.player.PlayerActions
import com.hatem.musicmute.ui.player.PlayerScreen
import com.hatem.musicmute.ui.player.MiniPlayer
import com.hatem.musicmute.ui.settings.CreativeSettingsScreen

@Preview(name = "Creative Home", widthDp = 390, heightDp = 850)
@Preview(name = "Creative Home Arabic", locale = "ar", widthDp = 390, heightDp = 850)
@Preview(name = "Creative Home narrow large text", widthDp = 320, heightDp = 900, fontScale = 1.6f)
@Composable
private fun HomePreview() = VocalTheme {
    Surface { HomeScreen(emptyList(), JobHistoryState(), false, {}, {}, {}, {}, {}, {}, {}) }
}

private val savedTrack = LibraryEntry(
    key = LibraryKey("preview", "68c000000000000000000001"), title = "Saved voice",
    createdAtEpochMs = 0, durationMs = 182_000, starred = true, hidden = false,
    offlineStatus = OfflineStatus.AVAILABLE,
)
private val queueTrack = QueueTrack(savedTrack.key, savedTrack.title)
private val previewPlayback = PlaybackState(
    trackId = "processing:68c000000000000000000001", queue = listOf(queueTrack), orderedQueue = listOf(queueTrack),
    currentIndex = 0, positionMs = 42_000, durationMs = 182_000,
)
private val libraryActions = LibraryActions({}, {}, {}, {}, {}, {}, {}, { _, _ -> }, {}, {}, {}, {}, {})
private val playerActions = PlayerActions({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})

@Preview(name = "Creative Library offline", widthDp = 390, heightDp = 850)
@Preview(name = "Creative Library Arabic large text", locale = "ar", widthDp = 320, heightDp = 1000, fontScale = 1.6f)
@Composable
private fun LibraryPreview() = VocalTheme {
    Surface { LibraryScreen(LibraryUiState(entries = listOf(savedTrack)), libraryActions) {
        MiniPlayer(previewPlayback, {}, {}, {})
    } }
}

@Preview(name = "Creative Player", widthDp = 390, heightDp = 1000)
@Preview(name = "Creative Player narrow Arabic", locale = "ar", widthDp = 320, heightDp = 1100, fontScale = 1.6f)
@Composable
private fun PlayerPreview() = VocalTheme {
    Surface { PlayerScreen(previewPlayback, savedTrack, playerActions) }
}

@Preview(name = "Creative Settings", widthDp = 390, heightDp = 950)
@Preview(name = "Creative Settings Arabic", locale = "ar", widthDp = 390, heightDp = 1100, fontScale = 1.6f)
@Composable
private fun SettingsPreview() = VocalTheme {
    Surface { CreativeSettingsScreen(VocalUiState(preferencesLoading = false), {}, {}, {}, {}, {}) }
}
