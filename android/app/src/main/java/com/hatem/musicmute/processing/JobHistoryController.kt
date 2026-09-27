package com.hatem.musicmute.processing

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job as CoroutineJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.Json
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

data class JobHistoryState(
    val jobs: List<Job> = emptyList(),
    val nextCursor: String? = null,
    val detail: Job? = null,
    val selectedId: String? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val failure: JobsProblem? = null,
    val connection: RealtimeState = RealtimeState.PAUSED,
)

internal const val INITIAL_JOB_HISTORY_PAGE_SIZE = 10
internal const val JOB_HISTORY_PAGE_SIZE = 5

internal fun jobHistoryPageSize(cursor: String?): Int =
    if (cursor == null) INITIAL_JOB_HISTORY_PAGE_SIZE else JOB_HISTORY_PAGE_SIZE

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
    private val now: () -> Long = { System.nanoTime() / 1_000_000 },
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
    private val livePages = linkedMapOf<String?, JobPage>()
    private val liveTasks = linkedMapOf<String?, CoroutineJob>()
    private val liveJson = Json { ignoreUnknownKeys = true }
    private var visible = false
    private var retryDelay = 10_000L
    private var retryNotBefore = 0L
    private var lastRefreshAt: Long? = null
    private var lastSuccessfulRefreshAt: Long? = null
    private val reads = Mutex()
    private var freshIds = emptySet<String>()
    private var refreshPending = false

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
        retryDelay = 10_000L
        retryNotBefore = 0L
        lastRefreshAt = null
        lastSuccessfulRefreshAt = null
        freshIds = emptySet()
        refreshPending = false
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
        if (api.realtime != null) { if (visible) startLive(); api.realtime?.resync(); return }
        val uid = owner ?: return
        if (now() < retryNotBefore || refreshTask?.isActive == true) return
        refreshPending = false
        val ticket = epoch
        val version = ++pageVersion
        moreTask?.cancel()
        mutableState.update { it.copy(loading = true, loadingMore = false, failure = null) }
        refreshTask = scope.launch {
            try {
                // Collapse bursts without cancelling requests already sent to the server.
                lastRefreshAt?.let { delay((it + 1_000 - now()).coerceAtLeast(0)) }
                val page = reads.withLock {
                    if (now() < retryNotBefore) return@launch
                    lastRefreshAt = now()
                    api.list()
                }
                if (ticket != epoch || version != pageVersion) return@launch
                val jobs = page.items.distinctBy { it.id }
                lastSuccessfulRefreshAt = now()
                freshIds = jobs.map { it.id }.toSet()
                mutableState.update { it.copy(jobs = jobs, nextCursor = page.nextCursor, loading = false) }
                retryDelay = 10_000L
                retryNotBefore = 0L
                saveCached(uid, jobs)
                state.value.selectedId?.let { select(it, force = true) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (ticket == epoch && version == pageVersion) report(error)
            } finally {
                if (ticket == epoch && version == pageVersion) {
                    mutableState.update { it.copy(loading = false) }
                    refreshTask = null
                    if (refreshPending && visible) refresh()
                }
            }
        }
    }

    fun loadMore() {
        val uid = owner ?: return
        val cursor = state.value.nextCursor ?: return
        if (now() < retryNotBefore || state.value.loading || state.value.loadingMore) return
        if (api.realtime != null) { watchPage(cursor); return }
        val ticket = epoch
        val version = pageVersion
        mutableState.update { it.copy(loadingMore = true) }
        moreTask = scope.launch {
            try {
                val page = reads.withLock {
                    if (now() < retryNotBefore) return@launch
                    api.list(cursor)
                }
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

    fun select(id: String?) = select(id, force = false)

    private fun select(id: String?, force: Boolean) {
        if (!force && id != null && id == state.value.selectedId && detailTask?.isActive == true) return
        detailTask?.cancel()
        val ticket = epoch
        val version = ++detailVersion
        mutableState.update { it.copy(selectedId = id, detail = if (it.detail?.id == id) it.detail else null) }
        val selectedOwner = owner
        if (id == null || selectedOwner == null) return
        if (api.realtime != null) {
            if (!visible) return
            detailTask = scope.launch {
                try {
                    api.realtime!!.watch("job", mapOf("id" to id)).collect { body ->
                        val detail = liveJson.decodeFromString<Job>(body)
                        if (ticket == epoch && version == detailVersion) mutableState.update { it.copy(detail = detail, failure = null, jobs = it.jobs.map { job -> if (job.id == id) detail else job }) }
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    if (ticket == epoch && version == detailVersion) {
                        if (error is JobsFailure && error.problem == JobsProblem.JOB_NOT_FOUND) {
                            mutableState.update { it.copy(detail = null, jobs = it.jobs.filterNot { job -> job.id == id }) }
                            saveCached(selectedOwner, state.value.jobs)
                            onMissing(id)
                        }
                        report(error)
                    }
                }
            }
            return
        }
        val listed = state.value.jobs.find { it.id == id }
        if (id in freshIds && listed != null &&
            (listed.workerAvailable != null || listed.status in setOf("ready", "failed", "cancelled")) &&
            lastSuccessfulRefreshAt?.let { now() - it < 10_000 } == true) {
            mutableState.update { it.copy(detail = listed) }
            return
        }
        if (now() < retryNotBefore || state.value.loading) return
        detailTask = scope.launch {
            try {
                val detail = reads.withLock {
                    if (now() < retryNotBefore) return@launch
                    api.detail(id)
                }
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
        if (value == visible && (!value || pollTask?.isActive == true)) return
        visible = value
        pollTask?.cancel()
        pollTask = null
        if (!value) {
            liveTasks.values.forEach { it.cancel() }; liveTasks.clear(); livePages.clear()
            refreshTask?.cancel()
            moreTask?.cancel()
            detailTask?.cancel()
        }
        if (!value || owner == null) return
        if (api.realtime != null) { startLive(); return }
        refreshAfterChange()
    }

    private fun startLive() {
        if (!visible || owner == null) return
        val realtime = api.realtime ?: return
        if (pollTask?.isActive != true) pollTask = scope.launch {
            realtime.state.collect { connection ->
                mutableState.update { if (connection == RealtimeState.SIGNED_OUT) JobHistoryState(connection = connection, failure = JobsProblem.UNAUTHENTICATED) else it.copy(connection = connection) }
            }
        }
        if (liveTasks.isEmpty() || (livePages.containsKey(null) && liveTasks[null]?.isActive != true)) watchPage(null)
        state.value.selectedId?.let { if (detailTask?.isActive != true) select(it, force = true) }
    }

    private fun watchPage(cursor: String?) {
        val realtime = api.realtime ?: return
        val uid = owner ?: return
        if (liveTasks[cursor]?.isActive == true) return
        if (!liveTasks.containsKey(cursor) && liveTasks.size >= 10) {
            val oldest = liveTasks.keys.first()
            liveTasks.remove(oldest)?.cancel()
            livePages.remove(oldest)
        }
        if (cursor == null) pageVersion++
        val ticket = epoch
        mutableState.update { it.copy(loading = cursor == null && it.jobs.isEmpty(), loadingMore = cursor != null) }
        liveTasks[cursor] = scope.launch {
            try {
                realtime.watch(
                    "jobs",
                    mapOf("limit" to jobHistoryPageSize(cursor).toString()) +
                        (cursor?.let { mapOf("cursor" to it) } ?: emptyMap()),
                ).collect { body ->
                    val page = liveJson.decodeFromString<JobPage>(body)
                    if (ticket != epoch) return@collect
                    val prior = livePages[cursor]
                    if (prior != null && prior.nextCursor != page.nextCursor) {
                        val later = livePages.keys.dropWhile { it != cursor }.drop(1)
                        later.forEach { livePages.remove(it); liveTasks.remove(it)?.cancel() }
                    }
                    livePages[cursor] = page
                    val jobs = livePages.values.flatMap { it.items }.distinctBy { it.id }
                    mutableState.update { it.copy(jobs = jobs, nextCursor = livePages.values.last().nextCursor, loading = false, loadingMore = false, failure = null) }
                    saveCached(uid, jobs)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (ticket == epoch) { liveTasks.remove(cursor); report(error); mutableState.update { it.copy(loading = false, loadingMore = false) } } }
        }
    }

    fun clearFailure() { mutableState.update { it.copy(failure = null) } }

    fun refreshAfterChange() {
        refreshPending = true
        refresh()
    }

    fun refreshIfVisible() { if (visible) refreshAfterChange() }

    private fun report(error: Exception) {
        val failure = error as? JobsFailure
        retryDelay = failure?.retryAfterSeconds?.times(1000)?.coerceAtLeast(10_000)
            ?: (retryDelay * 2).coerceIn(10_000, 60_000)
        if (failure?.problem == JobsProblem.RATE_LIMITED)
            retryNotBefore = maxOf(retryNotBefore, now() + (failure.retryAfterSeconds ?: 60) * 1000)
        mutableState.update { it.copy(failure = failure?.problem ?: JobsProblem.SERVICE_UNAVAILABLE) }
    }

    fun close() {
        visible = false
        liveTasks.values.forEach { it.cancel() }; liveTasks.clear(); livePages.clear()
        refreshTask?.cancel()
        moreTask?.cancel()
        detailTask?.cancel()
        pollTask?.cancel()
        pollTask = null
    }
}
