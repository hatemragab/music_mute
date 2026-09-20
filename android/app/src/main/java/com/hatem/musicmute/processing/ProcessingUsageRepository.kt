package com.hatem.musicmute.processing

import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class ProcessingUsagePeriod(
    val key: String,
    val start: String,
    val end: String,
    val nextResetAt: String,
)

@Serializable
data class ProcessingUsageAmounts(
    val limitSeconds: Double,
    val usedSeconds: Double,
    val reservedSeconds: Double,
    val releasedSeconds: Double,
    val remainingSeconds: Double,
)

@Serializable
data class ProcessingUploadUsage(
    val dailyGrantLimit: Int,
    val dailyGrants: Int,
    val dailyRemainingGrants: Int,
    val dailyResetAt: String,
    val monthlyGrantLimit: Int,
    val monthlyGrants: Int,
    val monthlyRemainingGrants: Int,
    val monthlyByteLimit: Long,
    val confirmedBytes: Long,
    val monthlyRemainingBytes: Long,
    val monthlyResetAt: String,
)

@Serializable
data class ProcessingStorageUsage(
    val limitBytes: Long,
    val retainedBytes: Long,
    val remainingBytes: Long,
)

@Serializable
data class ProcessingDownloadUsage(
    val monthlyGrantLimit: Int,
    val monthlyGrants: Int,
    val monthlyRemainingGrants: Int,
    val monthlyByteLimit: Long,
    val estimatedBytes: Long,
    val monthlyRemainingBytes: Long,
    val monthlyResetAt: String,
)

@Serializable
data class ProcessingEffectiveLimits(
    val maxDurationSeconds: Int,
    val maxPreparedAudioBytes: Long,
    val maxClientInputAttempts: Int,
    val signedUrlTtlSeconds: Int,
)

@Serializable
data class ProcessingAvailability(val status: String, val reason: String? = null)

@Serializable
data class ProcessingUsage(
    val schemaVersion: Int,
    val plan: String,
    val policyRevision: Int,
    val overrideRevision: Int? = null,
    val effectivePolicySource: String,
    val overrideExpiresAt: String? = null,
    val period: ProcessingUsagePeriod,
    val processing: ProcessingUsageAmounts,
    val uploads: ProcessingUploadUsage,
    val storage: ProcessingStorageUsage,
    val effectiveLimits: ProcessingEffectiveLimits,
    val downloads: ProcessingDownloadUsage,
    val usageRevision: Int,
    val waitingJobs: Int,
    val maxWaitingJobs: Int,
    val processingJobs: Int,
    val maxProcessingJobs: Int,
    val availability: ProcessingAvailability,
    val checkedAt: String,
) {
    fun validate() {
        val amounts = listOf(
            processing.limitSeconds,
            processing.usedSeconds,
            processing.reservedSeconds,
            processing.releasedSeconds,
            processing.remainingSeconds,
        )
        if (schemaVersion != 2 || plan != "standard" || policyRevision < 0 ||
            overrideRevision?.let { it < 1 } == true || usageRevision < 0 ||
            effectivePolicySource !in setOf("global", "account_override") ||
            amounts.any { !it.isFinite() || it < 0 } ||
            processing.remainingSeconds > processing.limitSeconds ||
            listOf(
                uploads.dailyGrantLimit, uploads.monthlyGrantLimit,
                downloads.monthlyGrantLimit, effectiveLimits.maxDurationSeconds,
                effectiveLimits.maxClientInputAttempts, effectiveLimits.signedUrlTtlSeconds,
            ).any { it < 1 } ||
            listOf(
                uploads.dailyGrants, uploads.dailyRemainingGrants, uploads.monthlyGrants,
                uploads.monthlyRemainingGrants, downloads.monthlyGrants,
                downloads.monthlyRemainingGrants,
            ).any { it < 0 } ||
            listOf(
                uploads.monthlyByteLimit, uploads.confirmedBytes, uploads.monthlyRemainingBytes,
                storage.limitBytes, storage.retainedBytes, storage.remainingBytes,
                downloads.monthlyByteLimit, downloads.estimatedBytes,
                downloads.monthlyRemainingBytes, effectiveLimits.maxPreparedAudioBytes,
            ).any { it < 0 } ||
            uploads.dailyRemainingGrants > uploads.dailyGrantLimit ||
            uploads.monthlyRemainingGrants > uploads.monthlyGrantLimit ||
            uploads.monthlyRemainingBytes > uploads.monthlyByteLimit ||
            storage.remainingBytes > storage.limitBytes ||
            downloads.monthlyRemainingGrants > downloads.monthlyGrantLimit ||
            downloads.monthlyRemainingBytes > downloads.monthlyByteLimit ||
            effectiveLimits.signedUrlTtlSeconds > 600 ||
            waitingJobs < 0 || maxWaitingJobs < 1 ||
            processingJobs < 0 || maxProcessingJobs < 1 ||
            availability.status !in setOf("available", "blocked") ||
            availability.reason !in setOf(null, "paused", "monthly_limit_reached", "waiting_job_limit", "storage_limit_reached") ||
            (availability.status == "available") != (availability.reason == null)) {
            throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
        }
        try {
            val start = Instant.parse(period.start)
            val end = Instant.parse(period.end)
            require(start < end && Instant.parse(period.nextResetAt) == end)
            Instant.parse(uploads.dailyResetAt)
            require(Instant.parse(uploads.monthlyResetAt) == end)
            require(Instant.parse(downloads.monthlyResetAt) == end)
            Instant.parse(checkedAt)
            overrideExpiresAt?.let(Instant::parse)
        } catch (_: Exception) { throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE) }
    }
    fun requireAvailable(checkAvailability: Boolean = true) {
        if (waitingJobs >= maxWaitingJobs) throw JobsFailure(JobsProblem.PROCESSING_LIMIT_REACHED)
        if (processing.remainingSeconds <= 0) throw JobsFailure(JobsProblem.PROCESSING_ALLOWANCE_EXHAUSTED)
        if (!checkAvailability) return
        when (availability.reason) {
            "monthly_limit_reached" -> throw JobsFailure(JobsProblem.PROCESSING_ALLOWANCE_EXHAUSTED)
            "waiting_job_limit" -> throw JobsFailure(JobsProblem.PROCESSING_LIMIT_REACHED)
            "paused" -> throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
        }
    }
}

/** Owner-fenced, nonbinding preflight. Never reserves capacity before local preparation. */
class ProcessingUsageRepository(private val api: JobsApi, private val session: () -> ProcessingSession?) {
    private val mutable = MutableStateFlow<ProcessingUsage?>(null)
    val usage = mutable.asStateFlow()
    suspend fun refresh(): ProcessingUsage? {
        val owner = session() ?: run { mutable.value = null; return null }
        mutable.value = null
        val result = try { api.processingUsage() } catch (error: CancellationException) { throw error }
            catch (error: JobsFailure) {
                // Legacy servers and disconnected clients keep their safe local flow;
                // actual admission still authoritatively enforces access and capacity.
                if (error.problem in setOf(JobsProblem.JOB_NOT_FOUND, JobsProblem.OFFLINE)) null else throw error
            }
        if (session() != owner) throw CancellationException("Processing session changed")
        mutable.value = result
        return result
    }
    fun clear() { mutable.value = null }
}
