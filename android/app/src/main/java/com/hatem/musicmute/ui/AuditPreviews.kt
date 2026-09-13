package com.hatem.musicmute.ui

import android.content.res.Configuration
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.library.OfflineStatus
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.playback.QueueTrack
import com.hatem.musicmute.processing.JobHistoryState
import com.hatem.musicmute.processing.JobsProblem
import com.hatem.musicmute.state.LibraryUiState
import com.hatem.musicmute.ui.home.HomeScreen
import com.hatem.musicmute.ui.importing.ImportReviewSheet
import com.hatem.musicmute.ui.library.LibraryActions
import com.hatem.musicmute.ui.library.LibraryScreen
import com.hatem.musicmute.ui.player.PlaybackQueueSheet
import com.hatem.musicmute.ui.player.PlayerActions
import com.hatem.musicmute.ui.player.PlayerScreen
import com.hatem.musicmute.ui.settings.AccentPickerScreen
import com.hatem.musicmute.ui.design.AccentPalette

// Compile-time preview fixtures; rendering still requires Android Studio/Layoutlib.
@Preview(name = "Small phone", widthDp = 320, heightDp = 568)
@Preview(name = "Large font Arabic", widthDp = 320, heightDp = 640, fontScale = 2f, locale = "ar")
@Preview(name = "Landscape", widthDp = 640, heightDp = 320)
@Preview(name = "Large phone", widthDp = 480, heightDp = 960)
@Preview(name = "Light system, Creative theme", widthDp = 390, heightDp = 844, uiMode = Configuration.UI_MODE_NIGHT_NO)
private annotation class AuditConfigurations

private val auditTracks = List(30) { index ->
    LibraryEntry(
        key = LibraryKey("preview", "track-$index"),
        title = if (index == 1) "A" else "A very long recording name — اسم تسجيل صوتي طويل — ".repeat(4),
        createdAtEpochMs = 0,
        durationMs = if (index == 2) null else 123_000,
        starred = index % 2 == 0,
        hidden = false,
        offlineStatus = OfflineStatus.entries[index % OfflineStatus.entries.size],
    )
}
private val auditQueue = auditTracks.map { QueueTrack(it.key, it.title) }
private val auditPlayback = PlaybackState(
    trackId = "track-0", queue = auditQueue, orderedQueue = auditQueue,
    currentIndex = 0, durationMs = 123_000, positionMs = 45_000,
)
private val auditPlayerActions = PlayerActions({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})
private val auditLibraryActions = LibraryActions({}, {}, {}, {}, {}, {}, {}, { _, _ -> }, {}, {}, {}, {}, {})

@AuditConfigurations
@Composable
private fun LongTitlePlayerAudit() = VocalTheme {
    Surface { PlayerScreen(auditPlayback, auditTracks.first(), auditPlayerActions) }
}

@AuditConfigurations
@Composable
private fun FailedPlayerAudit() = VocalTheme {
    Surface { PlayerScreen(auditPlayback.copy(failed = true), auditTracks.first(), auditPlayerActions) }
}

@AuditConfigurations
@Composable
private fun EmptyPlayerAudit() = VocalTheme {
    Surface { PlayerScreen(PlaybackState(), null, auditPlayerActions) }
}

@AuditConfigurations
@Composable
private fun LargeLibraryAudit() = VocalTheme {
    Surface { LibraryScreen(LibraryUiState(entries = auditTracks), auditLibraryActions) }
}

@AuditConfigurations
@Composable
private fun QueueAudit() = VocalTheme {
    PlaybackQueueSheet(auditPlayback, auditTracks, {}, {}, {}, {}, {}, {}, auditQueue)
}

@AuditConfigurations
@Composable
private fun OfflineHomeAudit() = VocalTheme {
    Surface {
        HomeScreen(emptyList(), JobHistoryState(failure = JobsProblem.OFFLINE), false, {}, {}, {}, {}, {}, {}, {})
    }
}

@AuditConfigurations
@Composable
private fun ImportFailureAudit() = VocalTheme {
    ImportReviewSheet(auditTracks.first().title, 20_000_000, 123_000, false, {}, {},
        error = "Connection unavailable. Please try again. ".repeat(8))
}

@AuditConfigurations
@Composable
private fun AccentAudit() = VocalTheme {
    Surface { AccentPickerScreen(AccentPalette.DEFAULT, {}, {}) }
}
