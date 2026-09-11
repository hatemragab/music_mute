package com.hatem.musicmute.processing

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class JobHistoryState(
    val jobs: List<Job> = emptyList(),
    val nextCursor: String? = null,
    val detail: Job? = null,
    val selectedId: String? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val failure: JobsProblem? = null,
)

fun shouldPollProcessingJob(status: String): Boolean = status in setOf(
    "awaiting_upload", "queued", "validating", "processing", "uploading_result",
    "interrupted", "cancel_requested",
)

/** Confined to the caller's UI scope; request generations fence stale pages and old accounts. */
class JobHistoryController(
    private val api: JobsApi,
    private val scope: CoroutineScope,
    private val loadCached: suspend (String) -> List<Job> = { emptyList() },
    private val saveCached: suspend (String, List<Job>) -> Unit = { _, _ -> },
    private val onMissing: suspend (String) -> Unit = {},
) {
    private val mutableState = MutableStateFlow(JobHistoryState())
    val state = mutableState.asStateFlow()
    private var owner: String? = null
    private var epoch = 0L
    private var pageVersion = 0L
    private var detailVersion = 0L
    private var refreshTask: CoroutineJob? = null
    private var moreTask: CoroutineJob? = null
    private var detailTask: CoroutineJob? = null
    private var pollTask: CoroutineJob? = null
    private var visible = false
    private var retryDelay = 10_000L

    fun bindOwner(uid: String?) {
        if (uid == owner) return
        val wasVisible = visible
        close()
        // Lifecycle visibility may arrive before authentication binds its owner.
        visible = wasVisible
        owner = uid
        epoch++
        pageVersion++
        detailVersion++
        mutableState.value = JobHistoryState()
        if (uid != null) {
            val ticket = epoch
            val version = pageVersion
            scope.launch {
                try {
                    val cached = loadCached(uid)
                    if (ticket == epoch && version == pageVersion)
                        mutableState.update { it.copy(jobs = cached) }
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    if (ticket == epoch) mutableState.update { it.copy(failure = JobsProblem.SERVICE_UNAVAILABLE) }
                } finally {
                    if (ticket == epoch && visible && pollTask == null) setVisible(true)
                }
            }
        }
    }

    fun refresh() {
        val uid = owner ?: return
        val ticket = epoch
        val version = ++pageVersion
        refreshTask?.cancel()
        moreTask?.cancel()
        mutableState.update { it.copy(loading = true, loadingMore = false, failure = null) }
        refreshTask = scope.launch {
            try {
                val page = api.list()
                if (ticket != epoch || version != pageVersion) return@launch
                val jobs = page.items.distinctBy { it.id }
                mutableState.update { it.copy(jobs = jobs, nextCursor = page.nextCursor, loading = false) }
                retryDelay = 10_000L
                saveCached(uid, jobs)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (ticket == epoch && version == pageVersion) report(error)
            } finally {
                if (ticket == epoch && version == pageVersion) mutableState.update { it.copy(loading = false) }
            }
        }
        state.value.selectedId?.let(::select)
    }

    fun loadMore() {
        val uid = owner ?: return
        val cursor = state.value.nextCursor ?: return
        if (state.value.loading || state.value.loadingMore) return
        val ticket = epoch
        val version = pageVersion
        mutableState.update { it.copy(loadingMore = true) }
        moreTask = scope.launch {
            try {
                val page = api.list(cursor)
                if (ticket != epoch || version != pageVersion) return@launch
                val jobs = (state.value.jobs + page.items).distinctBy { it.id }
                mutableState.update { it.copy(jobs = jobs, nextCursor = page.nextCursor) }
                saveCached(uid, jobs)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (ticket == epoch && version == pageVersion) report(error) }
            finally {
                if (ticket == epoch && version == pageVersion) mutableState.update { it.copy(loadingMore = false) }
            }
        }
    }

    fun select(id: String?) {
        detailTask?.cancel()
        val ticket = epoch
        val version = ++detailVersion
        mutableState.update { it.copy(selectedId = id, detail = if (it.detail?.id == id) it.detail else null) }
        val selectedOwner = owner
        if (id == null || selectedOwner == null) return
        detailTask = scope.launch {
            try {
                val detail = api.detail(id)
                if (ticket == epoch && version == detailVersion) {
                    mutableState.update { it.copy(detail = detail, jobs = it.jobs.map { job -> if (job.id == id) detail else job }) }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (ticket == epoch && version == detailVersion) {
                    if (error is JobsFailure && error.problem == JobsProblem.JOB_NOT_FOUND) {
                        val retained = state.value.jobs.filterNot { it.id == id }
                        mutableState.update { it.copy(detail = null, jobs = retained) }
                        saveCached(selectedOwner, retained)
                        try {
                            onMissing(id)
                        } catch (_: Exception) {
                            // A missing remote job stays evicted from history even if local cleanup fails.
                        }
                    }
                    report(error)
                }
            }
        }
    }

    fun setVisible(value: Boolean) {
        visible = value
        pollTask?.cancel()
        pollTask = null
        if (!value || owner == null) return
        refresh()
        pollTask = scope.launch {
            while (visible) {
                delay(retryDelay)
                val snapshot = state.value
                if (!snapshot.loading && (snapshot.failure != null || snapshot.jobs.any { shouldPollProcessingJob(it.status) } ||
                    snapshot.detail?.let { shouldPollProcessingJob(it.status) } == true)) refresh()
            }
        }
    }

    fun clearFailure() { mutableState.update { it.copy(failure = null) } }

    private fun report(error: Exception) {
        val failure = error as? JobsFailure
        retryDelay = failure?.retryAfterSeconds?.times(1000)?.coerceAtLeast(10_000)
            ?: (retryDelay * 2).coerceIn(10_000, 60_000)
        mutableState.update { it.copy(failure = failure?.problem ?: JobsProblem.SERVICE_UNAVAILABLE) }
    }

    fun close() {
        visible = false
        refreshTask?.cancel()
        moreTask?.cancel()
        detailTask?.cancel()
        pollTask?.cancel()
        pollTask = null
    }
}
