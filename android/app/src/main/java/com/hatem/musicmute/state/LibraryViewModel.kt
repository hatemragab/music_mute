package com.hatem.musicmute.state

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.hatem.musicmute.library.DefaultLibraryRepository
import com.hatem.musicmute.library.LibraryEntry
import com.hatem.musicmute.library.LibraryFilter
import com.hatem.musicmute.library.LibraryKey
import com.hatem.musicmute.library.LibraryProblem
import com.hatem.musicmute.library.LibrarySort
import com.hatem.musicmute.library.queryLibrary
import com.hatem.musicmute.processing.ArtifactException
import com.hatem.musicmute.processing.ArtifactProblem
import com.hatem.musicmute.processing.JobsFailure
import com.hatem.musicmute.processing.JobsProblem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class LibraryUiState(
    val entries: List<LibraryEntry> = emptyList(),
    val query: String = "",
    val filter: LibraryFilter = LibraryFilter.ALL,
    val sort: LibrarySort = LibrarySort.NEWEST,
    val loadFailed: Boolean = false,
    val problem: LibraryProblem? = null,
)

class LibraryViewModel(private val repository: DefaultLibraryRepository) : ViewModel() {
    private val selection = MutableStateFlow(LibraryUiState())
    val state = combine(repository.entries, repository.loadFailed, selection) { entries, failed, selected ->
        selected.copy(entries = queryLibrary(entries, selected.query, selected.filter, selected.sort), loadFailed = failed)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), LibraryUiState())

    fun setQuery(value: String) { selection.update { it.copy(query = value) } }
    fun setFilter(value: LibraryFilter) { selection.update { it.copy(filter = value) } }
    fun setSort(value: LibrarySort) { selection.update { it.copy(sort = value) } }
    fun clearProblem() { selection.update { it.copy(problem = null) } }
    fun refreshLocal() = repository.refreshLocal()

    fun toggleStar(key: LibraryKey) = action { repository.toggleStar(key) }

    fun setHidden(key: LibraryKey, hidden: Boolean) = action { repository.setHidden(key, hidden) }
    fun download(key: LibraryKey) = action { repository.ensureLocal(key) }

    private fun action(block: suspend () -> Unit) {
        viewModelScope.launch {
            clearProblem()
            try { block() }
            catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                selection.update { it.copy(problem = when {
                    error is JobsFailure && error.problem == JobsProblem.OFFLINE -> LibraryProblem.OFFLINE
                    error is ArtifactException && error.problem == ArtifactProblem.STORAGE -> LibraryProblem.STORAGE
                    error is ArtifactException && error.problem == ArtifactProblem.INVALID_OUTPUT -> LibraryProblem.INVALID_AUDIO
                    else -> LibraryProblem.TRANSFER
                }) }
            }
        }
    }
}
