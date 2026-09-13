package com.hatem.musicmute.state

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.download.DownloadRecord
import com.hatem.musicmute.download.DownloadRepository
import com.hatem.musicmute.download.resolveAudioFile
import com.hatem.musicmute.playback.AudioPlaybackController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class DownloadsUiState(
    val records: List<DownloadRecord> = emptyList(),
    val loading: Boolean = true,
    val historyError: Boolean = false,
    val actionError: Boolean = false,
    val adding: Boolean = false,
    val savingId: String? = null,
    val saveResult: Boolean? = null,
)

class DownloadsViewModel(
    private val repository: DownloadRepository,
    val playback: AudioPlaybackController,
) : ViewModel() {
    private val mutableState = MutableStateFlow(DownloadsUiState())
    val state = mutableState.asStateFlow()
    private var historyJob: Job? = null

    init {
        reload()
    }

    fun reload() {
        historyJob?.cancel()
        mutableState.update { it.copy(loading = true, historyError = false) }
        historyJob =
            viewModelScope.launch {
                try {
                    repository.records.collect { records ->
                        mutableState.update { it.copy(records = records, loading = false) }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    mutableState.update { it.copy(loading = false, historyError = true) }
                }
            }
    }

    fun download(url: String, onQueued: () -> Unit) {
        if (state.value.adding) return
        mutableState.update { it.copy(adding = true, actionError = false) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { repository.enqueue(url) }
                onQueued()
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(actionError = true) }
            } finally {
                mutableState.update { it.copy(adding = false) }
            }
        }
    }

    fun cancel(id: String) = action { repository.cancel(id) }

    fun retry(id: String) = action { repository.retry(id) }

    fun saveToDevice(id: String, destination: Uri) {
        if (state.value.savingId != null) return
        mutableState.update { it.copy(savingId = id, saveResult = null) }
        viewModelScope.launch {
            try {
                repository.saveToDevice(id, destination)
                mutableState.update { it.copy(saveResult = true) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(saveResult = false) }
            } finally {
                mutableState.update { it.copy(savingId = null) }
            }
        }
    }

    fun play(record: DownloadRecord) {
        viewModelScope.launch {
            val file =
                withContext(Dispatchers.IO) {
                    runCatching { resolveAudioFile(repository.audioRoot, record.relativePath) }
                        .getOrNull()
                }
            if (file == null) playback.reportMissingFile() else playback.toggle(record, file)
        }
    }

    private fun action(block: suspend () -> Unit) {
        mutableState.update { it.copy(actionError = false) }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { block() }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(actionError = true) }
            }
        }
    }

}
