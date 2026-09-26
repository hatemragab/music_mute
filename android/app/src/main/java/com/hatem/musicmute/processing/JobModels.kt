package com.hatem.musicmute.processing

import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

@Serializable
data class InputDeclaration(
    val extension: String,
    val contentType: String,
    val bytes: Long,
    val durationSeconds: Double,
    val sha256: String,
)

@Serializable
enum class SourceKind(val wireValue: String) {
    @SerialName("url") URL("url"),
    @SerialName("file") FILE("file"),
}

data class CreateJobMetadata(
    val sourceTitle: String? = null,
    val sourceKind: SourceKind? = null,
    val clientStartedAt: Instant? = null,
    val sourceUrl: String? = null,
    val policyVersion: Int? = null,
    val preparationProfileId: String? = null,
    val source: String? = null,
)

/** Unknown server states remain displayable, but have no actionable enum value. */
enum class JobStatus(val wireValue: String) {
    AWAITING_UPLOAD("awaiting_upload"), QUEUED("queued"), VALIDATING("validating"),
    PROCESSING("processing"), UPLOADING_RESULT("uploading_result"), INTERRUPTED("interrupted"),
    CANCEL_REQUESTED("cancel_requested"), READY("ready"), FAILED("failed"), CANCELLED("cancelled");
}

object JobInstantSerializer : KSerializer<Instant> {
    override val descriptor = PrimitiveSerialDescriptor("JobInstant", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(wireInstant(value))
    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

fun wireInstant(value: Instant): String = value.truncatedTo(ChronoUnit.MILLIS).toString()

fun validateDisplayName(value: String): String {
    val result = value.trim()
    require(result.codePointCount(0, result.length) in 1..200)
    require(!result.codePoints().anyMatch(Character::isISOControl))
    return result
}

fun boundedSourceTitle(value: String): String {
    val clean = buildString {
        value.trim().codePoints().forEach { point ->
            appendCodePoint(if (Character.isISOControl(point)) ' '.code else point)
        }
    }.trim().ifBlank { "Audio" }
    val count = clean.codePointCount(0, clean.length)
    return if (count <= 200) clean else clean.substring(0, clean.offsetByCodePoints(0, 200)).trim()
}

@Serializable
data class JobInput(val extension: String, val bytes: Long, val durationSeconds: Double)

@Serializable
data class JobError(
    val code: String,
    val message: String,
    @Serializable(with = JobInstantSerializer::class) val at: Instant,
)

@Serializable
data class JobTiming(
    val processingElapsedMs: Long? = null,
    val processingElapsedApproximate: Boolean = false,
    val totalElapsedMs: Long? = null,
    val totalElapsedApproximate: Boolean = false,
)

@Serializable
data class JobStages(
    @Serializable(with = JobInstantSerializer::class) val validatingAt: Instant? = null,
    @Serializable(with = JobInstantSerializer::class) val processingStartedAt: Instant? = null,
    @Serializable(with = JobInstantSerializer::class) val processingFinishedAt: Instant? = null,
    @Serializable(with = JobInstantSerializer::class) val uploadingResultAt: Instant? = null,
)

@Serializable
data class ServerStageMeasurement(val stage: String, val durationMs: Long, val complete: Boolean)

@Serializable
data class ServerStageTimings(
    val totalMs: Long? = null,
    val totalComplete: Boolean = false,
    val stages: List<ServerStageMeasurement> = emptyList(),
)

@Serializable
data class Job(
    val id: String,
    val status: String,
    @Serializable(with = JobInstantSerializer::class) val createdAt: Instant,
    @Serializable(with = JobInstantSerializer::class) val updatedAt: Instant,
    val input: JobInput,
    val canDownloadInput: Boolean,
    val canDownloadOutput: Boolean,
    @Serializable(with = JobInstantSerializer::class) val queuedAt: Instant? = null,
    @Serializable(with = JobInstantSerializer::class) val finishedAt: Instant? = null,
    val retryOfJobId: String? = null,
    val error: JobError? = null,
    val workerAvailable: Boolean? = null,
    val requestId: String? = null,
    val sourceTitle: String? = null,
    val displayName: String? = null,
    val sourceKind: String? = null,
    @Serializable(with = JobInstantSerializer::class) val serverTime: Instant? = null,
    val timing: JobTiming? = null,
    val serverStageTimings: ServerStageTimings? = null,
    val stages: JobStages? = null,
) {
    val knownStatus: JobStatus? get() = JobStatus.entries.find { it.wireValue == status }
}

@Serializable data class JobPage(val items: List<Job>, val nextCursor: String? = null)

@Serializable
enum class UploadMethod { @SerialName("PUT") PUT }

@Serializable
data class UploadGrant(
    val method: UploadMethod,
    val url: String,
    val headers: Map<String, String>,
    @Serializable(with = JobInstantSerializer::class) val expiresAt: Instant,
)

@Serializable
data class DownloadGrant(
    val url: String,
    @Serializable(with = JobInstantSerializer::class) val expiresAt: Instant,
)

@Serializable data class JobMutation(val id: String, val status: String, val retryOfJobId: String? = null)
@Serializable data class CreateReservation(
    val id: String,
    val status: String,
    val upload: UploadGrant? = null,
    val requestId: String? = null,
)

@Serializable
enum class ClientErrorStage {
    UNKNOWN, SOURCE_INTAKE, DOWNLOADING_SOURCE, PREPARING_INPUT, RESERVING_JOB,
    UPLOADING_INPUT, CONFIRMING_UPLOAD, REFRESHING_JOB, CANCELLING, RETRYING,
    FETCHING_OUTPUT, PLAYBACK, EXPORTING,
}

@Serializable
enum class ClientErrorCode {
    UNKNOWN, NETWORK, TIMEOUT, AUTHENTICATION, INVALID_MEDIA, SOURCE_UNAVAILABLE,
    STORAGE, SERVER, JOB_NOT_FOUND, JOB_CONFLICT, CHECKSUM_MISMATCH, LOCAL_IO,
}

@Serializable
data class ClientErrorReport(
    val eventId: String,
    val operationId: String,
    val jobId: String? = null,
    val stage: ClientErrorStage,
    val code: ClientErrorCode,
    val retryable: Boolean,
    val platform: String,
    val appVersion: String,
    val osVersion: String,
    @Serializable(with = JobInstantSerializer::class) val occurredAt: Instant,
    val httpStatus: Int? = null,
)

@Serializable data class ClientErrorAccepted(val eventId: String)

enum class JobsProblem {
    MEDIA_TOO_LONG, MEDIA_TOO_LARGE, MEDIA_NO_AUDIO, MEDIA_DEFAULT_TRACK_UNAVAILABLE, MEDIA_UNSUPPORTED, MEDIA_DURATION_UNKNOWN,
    YOUTUBE_PLAYLIST_UNSUPPORTED, YOUTUBE_LIVE_UNSUPPORTED, PROCESSING_ALLOWANCE_EXHAUSTED, PROCESSING_QUEUE_FULL,
    PROCESSING_POLICY_INCOMPATIBLE, PROCESSING_CAPACITY_UNAVAILABLE, PROCESSING_LIMIT_REACHED,
    INVALID_INPUT, UNAUTHENTICATED, ACCOUNT_DISABLED, POLICY_DENIED,
    EMAIL_VERIFICATION_REQUIRED, APP_UPDATE_REQUIRED, DEVICE_SYNC_REQUIRED, DEVICE_REPORT_CONFLICT,
    PROFILE_SYNC_REQUIRED, JOB_NOT_FOUND, JOB_STATE_CONFLICT, IDEMPOTENCY_CONFLICT,
    JOB_ACTIVE, UPLOAD_NOT_READY, UPLOAD_RESERVATION_EXPIRED, UPLOAD_GRANT_LIMIT_REACHED,
    UPLOAD_BYTE_LIMIT_REACHED, UPLOAD_ATTEMPT_LIMIT_REACHED, NEW_INPUT_REQUIRED,
    RETAINED_STORAGE_LIMIT_REACHED, DOWNLOAD_RESERVATION_EXPIRED,
    DOWNLOAD_GRANT_LIMIT_REACHED, DOWNLOAD_BYTE_LIMIT_REACHED, SERVICE_BANDWIDTH_LIMIT_REACHED,
    RATE_LIMITED, OFFLINE, SERVICE_UNAVAILABLE,
}

/** Only allowlisted codes are exposed; server diagnostics never become exception text. */
class JobsFailure(val problem: JobsProblem, val retryAfterSeconds: Long? = null) : Exception(problem.name)
