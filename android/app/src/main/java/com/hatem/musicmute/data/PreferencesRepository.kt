package com.hatem.musicmute.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

enum class ThemeChoice {
    SYSTEM,
    LIGHT,
    DARK,
}

enum class LanguageChoice(val tag: String) {
    SYSTEM(""),
    ENGLISH("en"),
    ARABIC("ar"),
}

data class AppPreferences(
    val theme: ThemeChoice = ThemeChoice.SYSTEM,
    val language: LanguageChoice = LanguageChoice.SYSTEM,
)

interface PreferencesRepository {
    val preferences: Flow<AppPreferences>

    suspend fun setTheme(theme: ThemeChoice)

    suspend fun setLanguage(language: LanguageChoice)
}

class DataStorePreferencesRepository(private val store: DataStore<Preferences>) :
    PreferencesRepository {
    override val preferences =
        store.data.map { values ->
            AppPreferences(
                theme =
                    ThemeChoice.entries.firstOrNull { it.name == values[THEME] }
                        ?: ThemeChoice.SYSTEM,
                language =
                    LanguageChoice.entries.firstOrNull { it.name == values[LANGUAGE] }
                        ?: LanguageChoice.SYSTEM,
            )
        }

    override suspend fun setTheme(theme: ThemeChoice) {
        store.edit { it[THEME] = theme.name }
    }

    override suspend fun setLanguage(language: LanguageChoice) {
        store.edit { it[LANGUAGE] = language.name }
    }

    private companion object {
        val THEME = stringPreferencesKey("theme")
        val LANGUAGE = stringPreferencesKey("language")
    }
}
