package com.hatem.musicmute.ui

import android.content.res.Configuration
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import com.hatem.musicmute.download.DownloadError
import com.hatem.musicmute.download.DownloadRecord
import com.hatem.musicmute.download.DownloadStatus
import com.hatem.musicmute.playback.PlaybackState
import com.hatem.musicmute.state.DownloadsUiState

@Preview(name = "Downloads • playing and progress", widthDp = 390, heightDp = 1100)
@Preview(name = "Downloads • Arabic RTL", locale = "ar", widthDp = 390, heightDp = 1100)
@Preview(name = "Downloads • narrow large text", widthDp = 320, heightDp = 1100, fontScale = 1.6f)
@Preview(
    name = "Downloads • dark",
    widthDp = 390,
    heightDp = 1100,
    uiMode = Configuration.UI_MODE_NIGHT_YES,
)
@Composable
private fun DownloadsPreview() = VocalTheme {
    Surface {
        DownloadHistoryScreen(
            DownloadsUiState(
                loading = false,
                records =
                    listOf(
                        DownloadRecord(
                            "saved",
                            "",
                            1_788_739_200_000,
                            status = DownloadStatus.COMPLETE,
                            title = "Morning voice notes",
                            codec = "opus",
                            extension = "webm",
                            bitrateKbps = 145,
                            sizeBytes = 5_100_000,
                            durationMs = 180_000,
                        ),
                        DownloadRecord(
                            "progress",
                            "",
                            1_788_739_200_000,
                            status = DownloadStatus.DOWNLOADING,
                            progress = 42,
                        ),
                        DownloadRecord(
                            "failed",
                            "",
                            1_788_739_200_000,
                            status = DownloadStatus.FAILED,
                            error = DownloadError.NETWORK,
                        ),
                    ),
            ),
            PlaybackState(
                trackId = "saved",
                playing = true,
                positionMs = 48_000,
                durationMs = 180_000,
            ),
        )
    }
}
