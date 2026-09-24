package com.hatem.musicmute.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import com.hatem.musicmute.ui.design.AccentPalette
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

enum class LanguageChoice(val tag: String) {
    SYSTEM(""),
    ENGLISH("en"),
    ARABIC("ar"),
}

data class AppPreferences(
    val language: LanguageChoice = LanguageChoice.SYSTEM,
    val accentArgb: Int = AccentPalette.DEFAULT,
)

interface PreferencesRepository {
    val preferences: Flow<AppPreferences>

    suspend fun setLanguage(language: LanguageChoice)

    suspend fun setAccent(argb: Int)
}

class DataStorePreferencesRepository(private val store: DataStore<Preferences>) :
    PreferencesRepository {
    override val preferences =
        store.data.map { values ->
            AppPreferences(
                language =
                    LanguageChoice.entries.firstOrNull { it.name == values[LANGUAGE] }
                        ?: LanguageChoice.SYSTEM,
                accentArgb = AccentPalette.opaque(values[ACCENT] ?: AccentPalette.DEFAULT),
            )
        }

    override suspend fun setLanguage(language: LanguageChoice) {
        store.edit { it[LANGUAGE] = language.name }
    }

    override suspend fun setAccent(argb: Int) {
        store.edit { it[ACCENT] = AccentPalette.opaque(argb) }
    }

    private companion object {
        val LANGUAGE = stringPreferencesKey("language")
        val ACCENT = intPreferencesKey("accent_argb")
    }
}
