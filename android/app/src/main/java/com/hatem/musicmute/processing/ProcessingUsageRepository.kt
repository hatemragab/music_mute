package com.hatem.musicmute.processing

import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

@Serializable
data class ProcessingReplenishment(val at: String, val audioSeconds: Double)
@Serializable
data class ProcessingUsage(
    val policyRevision: Int, val allowanceAudioSeconds: Double, val usedAudioSeconds: Double,
    val reservedAudioSeconds: Double, val remainingAudioSeconds: Double, val activeJobs: Int,
    val maxActiveJobs: Int, val nextReplenishmentAt: String? = null,
    val replenishments: List<ProcessingReplenishment> = emptyList(), val availability: String,
    val checkedAt: String,
) {
    fun validate() {
        if (listOf(allowanceAudioSeconds, usedAudioSeconds, reservedAudioSeconds, remainingAudioSeconds).any { !it.isFinite() || it < 0 } ||
            activeJobs < 0 || maxActiveJobs < 1 || replenishments.size > 100 ||
            availability !in setOf("available", "busy", "paused", "unavailable")) throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
        try {
            Instant.parse(checkedAt); nextReplenishmentAt?.let(Instant::parse)
            replenishments.forEach { require(it.audioSeconds.isFinite() && it.audioSeconds >= 0); Instant.parse(it.at) }
        } catch (_: Exception) { throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE) }
    }
    fun requireAvailable(checkAvailability: Boolean = true) {
        if (activeJobs >= maxActiveJobs) throw JobsFailure(JobsProblem.PROCESSING_LIMIT_REACHED)
        if (remainingAudioSeconds <= 0) throw JobsFailure(JobsProblem.PROCESSING_ALLOWANCE_EXHAUSTED)
        if (!checkAvailability) return
        when (availability) {
            "busy" -> throw JobsFailure(JobsProblem.PROCESSING_QUEUE_FULL)
            "paused", "unavailable" -> throw JobsFailure(JobsProblem.PROCESSING_CAPACITY_UNAVAILABLE)
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
