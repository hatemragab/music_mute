package com.hatem.musicmute.state

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.data.*
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VocalViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val models = mutableListOf<VocalViewModel>()

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        models.forEach { it.viewModelScope.cancel() }
        Dispatchers.resetMain()
    }

    private fun model(preferences: PreferencesRepository = FakePreferences()) =
        VocalViewModel(preferences).also { models += it }

    @Test
    fun loadingAndPreferenceChangesAreExposed() =
        runTest(dispatcher) {
            val model = model()
            assertTrue(model.state.value.preferencesLoading)
            runCurrent()
            assertFalse(model.state.value.preferencesLoading)
            model.setLanguage(LanguageChoice.ARABIC)
            runCurrent()
            assertEquals(
                AppPreferences(LanguageChoice.ARABIC),
                model.state.value.preferences,
            )
        }

    @Test
    fun failedPreferenceSaveKeepsPreviousValueAndShowsError() =
        runTest(dispatcher) {
            val preferences = FakePreferences()
            val model = model(preferences = preferences)
            runCurrent()
            preferences.failWrites = true
            model.setLanguage(LanguageChoice.ARABIC)
            runCurrent()
            assertTrue(model.state.value.preferencesError)
            assertEquals(LanguageChoice.SYSTEM, model.state.value.preferences.language)
            preferences.failWrites = false
            model.setLanguage(LanguageChoice.ARABIC)
            runCurrent()
            assertFalse(model.state.value.preferencesError)
            assertEquals(LanguageChoice.ARABIC, model.state.value.preferences.language)
        }

    @Test
    fun preferencesReadFailureCanBeRetried() =
        runTest(dispatcher) {
            var fail = true
            val preferences =
                object : PreferencesRepository {
                    override val preferences = flow {
                        if (fail) throw IOException("test failure")
                        emit(AppPreferences(LanguageChoice.ARABIC))
                    }

                    override suspend fun setLanguage(language: LanguageChoice) = Unit

                    override suspend fun setAccent(argb: Int) = Unit
                }
            val model = model(preferences = preferences)
            runCurrent()
            assertFalse(model.state.value.preferencesLoading)
            assertTrue(model.state.value.preferencesError)
            fail = false
            model.loadPreferences()
            runCurrent()
            assertFalse(model.state.value.preferencesError)
            assertEquals(
                AppPreferences(LanguageChoice.ARABIC),
                model.state.value.preferences,
            )
        }

    private class FakePreferences : PreferencesRepository {
        override val preferences = MutableStateFlow(AppPreferences())
        var failWrites = false

        override suspend fun setLanguage(language: LanguageChoice) {
            if (failWrites) throw IOException("test failure")
            preferences.value = preferences.value.copy(language = language)
        }

        override suspend fun setAccent(argb: Int) {
            if (failWrites) throw IOException("test failure")
            preferences.value = preferences.value.copy(accentArgb = argb)
        }
    }
}
