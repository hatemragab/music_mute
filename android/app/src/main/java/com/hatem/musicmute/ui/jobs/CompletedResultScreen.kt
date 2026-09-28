package com.hatem.musicmute.ui.jobs

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.hatem.musicmute.R
import com.hatem.musicmute.ui.design.*

/** Result actions within the detail adapter's actual completion timeline. No automatic retrieval. */
@Composable
fun CompletedResultScreen(
    availableOffline: Boolean,
    busy: Boolean,
    onPlay: () -> Unit,
    onDownload: () -> Unit,
    onSaveVoice: () -> Unit,
    onSaveOriginal: () -> Unit,
    onShare: () -> Unit,
) {
    CreativeCard {
        if (availableOffline) Text(stringResource(R.string.creative_jobs_offline), color = MaterialTheme.colorScheme.primary)
        CreativePrimaryButton(onPlay, Modifier.fillMaxWidth().testTag("processing-play"), busy = busy) { Text(stringResource(R.string.creative_jobs_open_player)) }
        if (!availableOffline) OutlinedButton(onDownload, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.creative_jobs_keep_offline)) }
        OutlinedButton(onSaveVoice, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.save_voice)) }
        OutlinedButton(onSaveOriginal, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.save_original)) }
        OutlinedButton(onShare, Modifier.fillMaxWidth(), enabled = !busy) { Text(stringResource(R.string.audio_task_share)) }
        CreativeFeedback(stringResource(R.string.processing_output_notice))
    }
}
