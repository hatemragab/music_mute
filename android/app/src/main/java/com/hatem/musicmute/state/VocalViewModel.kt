package com.hatem.musicmute.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.data.AppPreferences
import com.hatem.musicmute.data.LanguageChoice
import com.hatem.musicmute.data.PreferencesRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class VocalUiState(
    val preferences: AppPreferences = AppPreferences(),
    val preferencesLoading: Boolean = true,
    val preferencesError: Boolean = false,
)

class VocalViewModel(
    private val preferencesRepository: PreferencesRepository,
) : ViewModel() {
    private val mutableState = MutableStateFlow(VocalUiState())
    val state = mutableState.asStateFlow()
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
