package com.hatem.musicmute.data

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PreferencesRepositoryTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    @Test
    fun customAccentSurvivesRecreationAsOpaqueRgb() = runTest {
        val file = File(temporaryFolder.root, "accent.preferences_pb")
        val firstScope = CoroutineScope(backgroundScope.coroutineContext + Job())
        val firstStore = PreferenceDataStoreFactory.create(scope = firstScope) { file }
        DataStorePreferencesRepository(firstStore).setAccent(0x003355AA)
        firstScope.cancel()
        firstScope.coroutineContext[Job]!!.join()
        val restored = PreferenceDataStoreFactory.create(scope = backgroundScope) { file }
        assertEquals(0xFF3355AA.toInt(), DataStorePreferencesRepository(restored).preferences.first().accentArgb)
    }

    @Test
    fun legacyLightPreferenceRestoresAsDarkWithoutLosingLanguage() = runTest {
        val store = PreferenceDataStoreFactory.create(scope = backgroundScope) {
            File(temporaryFolder.root, "legacy.preferences_pb")
        }
        store.edit {
            it[stringPreferencesKey("theme")] = "LIGHT"
            it[stringPreferencesKey("language")] = "ARABIC"
        }
        val preferences = DataStorePreferencesRepository(store).preferences.first()
        assertEquals(ThemeChoice.DARK, preferences.theme)
        assertEquals(LanguageChoice.ARABIC, preferences.language)
    }

    @Test
    fun defaultsAndStoredPreferencesRoundTrip() = runTest {
        val store =
            PreferenceDataStoreFactory.create(scope = backgroundScope) {
                File(temporaryFolder.root, "preferences.preferences_pb")
            }
        val repository = DataStorePreferencesRepository(store)
        assertEquals(AppPreferences(), repository.preferences.first())
        repository.setTheme(ThemeChoice.DARK)
        repository.setLanguage(LanguageChoice.ARABIC)
        assertEquals(
            AppPreferences(ThemeChoice.DARK, LanguageChoice.ARABIC),
            repository.preferences.first(),
        )
        repository.setTheme(ThemeChoice.LIGHT)
        assertEquals(LanguageChoice.ARABIC, repository.preferences.first().language)
        repository.setLanguage(LanguageChoice.SYSTEM)
        assertEquals(
            AppPreferences(ThemeChoice.DARK, LanguageChoice.SYSTEM),
            repository.preferences.first(),
        )
    }

    @Test
    fun preferencesSurviveStoreRecreation() = runTest {
        val file = File(temporaryFolder.root, "persistent.preferences_pb")
        val firstScope = CoroutineScope(backgroundScope.coroutineContext + Job())
        val firstStore = PreferenceDataStoreFactory.create(scope = firstScope) { file }
        try {
            val repository = DataStorePreferencesRepository(firstStore)
            repository.setTheme(ThemeChoice.DARK)
            repository.setLanguage(LanguageChoice.ARABIC)
        } finally {
            firstScope.cancel()
            firstScope.coroutineContext[Job]!!.join()
        }
        val reopenedStore = PreferenceDataStoreFactory.create(scope = backgroundScope) { file }
        assertEquals(
            AppPreferences(ThemeChoice.DARK, LanguageChoice.ARABIC),
            DataStorePreferencesRepository(reopenedStore).preferences.first(),
        )
    }

    @Test
    fun unrecognizedStoredValuesFallBackToSystem() = runTest {
        val store =
            PreferenceDataStoreFactory.create(scope = backgroundScope) {
                File(temporaryFolder.root, "unknown.preferences_pb")
            }
        store.edit {
            it[stringPreferencesKey("theme")] = "removed-theme"
            it[stringPreferencesKey("language")] = "unsupported"
        }
        assertEquals(AppPreferences(), DataStorePreferencesRepository(store).preferences.first())
    }
}
