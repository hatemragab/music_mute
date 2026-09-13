package com.hatem.musicmute.state

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.data.AppPreferences
import com.hatem.musicmute.data.AudioSource
import com.hatem.musicmute.data.LanguageChoice
import com.hatem.musicmute.data.PreferencesRepository
import com.hatem.musicmute.data.ThemeChoice
import com.hatem.musicmute.data.WorkflowEvent
import com.hatem.musicmute.data.WorkflowRepository
import com.hatem.musicmute.data.WorkflowRequest
import com.hatem.musicmute.data.WorkflowStage
import com.hatem.musicmute.data.YouTubeUrl
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class DemoSession(val id: String, val source: AudioSource)

sealed interface WorkflowState {
    data object Idle : WorkflowState

    data class Running(val stage: WorkflowStage, val progress: Float) : WorkflowState

    data object Cancelled : WorkflowState

    data object Failed : WorkflowState

    data class Complete(val session: DemoSession) : WorkflowState
}

data class VocalUiState(
    val url: String = "",
    val source: AudioSource = AudioSource.SAMPLE,
    val invalidUrl: Boolean = false,
    val workflow: WorkflowState = WorkflowState.Idle,
    val sessions: List<DemoSession> = emptyList(),
    val preferences: AppPreferences = AppPreferences(),
    val preferencesLoading: Boolean = true,
    val preferencesError: Boolean = false,
)

class VocalViewModel(
    private val workflowRepository: WorkflowRepository,
    private val preferencesRepository: PreferencesRepository,
    private val savedState: SavedStateHandle,
) : ViewModel() {
    private val mutableState =
        MutableStateFlow(
            VocalUiState(
                url = savedState["url"] ?: "",
                source =
                    AudioSource.entries.firstOrNull { it.name == savedState.get<String>("source") }
                        ?: AudioSource.YOUTUBE,
            )
        )
    val state = mutableState.asStateFlow()
    private var workflowJob: Job? = null
    private var preferencesJob: Job? = null

    init {
        loadPreferences()
    }

    fun loadPreferences() {
        preferencesJob?.cancel()
        mutableState.update { it.copy(preferencesLoading = true, preferencesError = false) }
        preferencesJob =
            viewModelScope.launch {
                try {
                    preferencesRepository.preferences.collect { prefs ->
                        mutableState.update {
                            it.copy(
                                preferences = prefs,
                                preferencesLoading = false,
                                preferencesError = false,
                            )
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    mutableState.update {
                        it.copy(preferencesLoading = false, preferencesError = true)
                    }
                }
            }
    }

    fun updateUrl(url: String) {
        savedState["url"] = url
        mutableState.update { it.copy(url = url, invalidUrl = false) }
    }

    fun selectSource(source: AudioSource) {
        savedState["source"] = source.name
        mutableState.update { it.copy(source = source, invalidUrl = false) }
    }

    fun startPreview(): Boolean {
        if (state.value.workflow is WorkflowState.Running) return false
        val request = WorkflowRequest(state.value.source, state.value.url.trim())
        if (request.source == AudioSource.YOUTUBE && !YouTubeUrl.isSupported(request.url)) {
            mutableState.update { it.copy(invalidUrl = true) }
            return false
        }
        mutableState.update {
            it.copy(
                workflow =
                    WorkflowState.Running(
                        if (request.source == AudioSource.YOUTUBE) WorkflowStage.DOWNLOADING
                        else WorkflowStage.PREPARING,
                        0f,
                    )
            )
        }
        workflowJob =
            viewModelScope.launch {
                try {
                    workflowRepository.preview(request).collect { event ->
                        when (event) {
                            is WorkflowEvent.Progress ->
                                mutableState.update {
                                    it.copy(
                                        workflow =
                                            WorkflowState.Running(event.stage, event.fraction)
                                    )
                                }
                            WorkflowEvent.Complete -> {
                                val session =
                                    DemoSession(UUID.randomUUID().toString(), request.source)
                                mutableState.update {
                                    it.copy(
                                        workflow = WorkflowState.Complete(session),
                                        sessions = listOf(session) + it.sessions,
                                    )
                                }
                            }
                        }
                    }
                    if (state.value.workflow is WorkflowState.Running) {
                        mutableState.update { it.copy(workflow = WorkflowState.Failed) }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    mutableState.update { it.copy(workflow = WorkflowState.Failed) }
                }
            }
        return true
    }

    fun validateYoutubeUrl(): Boolean {
        val valid = YouTubeUrl.isSupported(state.value.url)
        mutableState.update { it.copy(invalidUrl = !valid) }
        return valid
    }

    fun cancelPreview() {
        workflowJob?.cancel()
        if (state.value.workflow is WorkflowState.Running) {
            mutableState.update { it.copy(workflow = WorkflowState.Cancelled) }
        }
    }

    fun openSession(session: DemoSession) {
        mutableState.update { it.copy(workflow = WorkflowState.Complete(session)) }
    }

    fun setTheme(theme: ThemeChoice) = savePreference { preferencesRepository.setTheme(theme) }

    fun setAccent(argb: Int) = savePreference { preferencesRepository.setAccent(argb) }

    fun setLanguage(language: LanguageChoice) = savePreference {
        preferencesRepository.setLanguage(language)
    }

    private fun savePreference(save: suspend () -> Unit) {
        viewModelScope.launch {
            try {
                save()
                mutableState.update { it.copy(preferencesError = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                mutableState.update { it.copy(preferencesError = true) }
            }
        }
    }
}
