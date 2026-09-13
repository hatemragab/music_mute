package com.hatem.musicmute.processing

import com.hatem.musicmute.auth.AuthApiClient
import com.hatem.musicmute.auth.AuthFailure
import com.hatem.musicmute.auth.AuthHttpResponse
import com.hatem.musicmute.auth.AuthProblem
import java.net.URI
import java.net.URLEncoder
import kotlinx.serialization.serializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.json.*

interface JobsApi {
    suspend fun create(requestId: String, input: InputDeclaration): CreateReservation
    suspend fun createWithMetadata(
        requestId: String,
        input: InputDeclaration,
        metadata: CreateJobMetadata,
    ): CreateReservation = create(requestId, input)
    suspend fun mediaPolicy(): ProcessingMediaPolicy = ProcessingMediaPolicy.LEGACY
    suspend fun processingUsage(): ProcessingUsage? = null
    suspend fun renewUpload(id: String): UploadGrant
    suspend fun confirmUpload(id: String): JobMutation
    suspend fun list(cursor: String? = null, status: String? = null): JobPage
    suspend fun detail(id: String): Job
    suspend fun cancel(id: String): JobMutation
    suspend fun retry(id: String, requestId: String): JobMutation
    suspend fun download(id: String, artifact: String): DownloadGrant
    suspend fun rename(id: String, displayName: String): Job = throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
    suspend fun delete(id: String) { throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE) }
    suspend fun reportClientError(report: ClientErrorReport): ClientErrorAccepted =
        throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)
}

/** API requests share the authenticated client's identity checks and single refresh lock.
 * Storage transfers must use a separate transport without these headers.
 */
class JobsApiClient(
    private val auth: AuthApiClient,
    private val installationId: () -> String,
    private val onUpdateRequired: () -> Unit = {},
) : JobsApi {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    override suspend fun create(requestId: String, input: InputDeclaration): CreateReservation {
        return createWithMetadata(requestId, input, CreateJobMetadata())
    }

    override suspend fun createWithMetadata(
        requestId: String,
        input: InputDeclaration,
        metadata: CreateJobMetadata,
    ): CreateReservation {
        uuid(requestId)
        val body = buildJsonObject {
            put("requestId", requestId)
            metadata.sourceTitle?.let { put("sourceTitle", validatedName(it)) }
            metadata.sourceKind?.let { put("sourceKind", it.wireValue) }
            metadata.sourceUrl?.let { put("sourceUrl", it) }
            metadata.clientStartedAt?.let { put("clientStartedAt", wireInstant(it)) }
            metadata.policyVersion?.let { put("policyVersion", it) }
            metadata.preparationProfileId?.let { put("preparationProfileId", it) }
            metadata.source?.let { put("source", it) }
            put("input", json.encodeToJsonElement(input))
        }.toString()
        return decode<CreateReservation>(request("POST", "/jobs", body, true)).also {
            it.upload?.let(::validateUpload)
            if (it.status == "awaiting_upload" && it.upload == null) invalidResponse()
        }
    }

    override suspend fun mediaPolicy(): ProcessingMediaPolicy = try {
        ProcessingMediaPolicy.parse(request("GET", "/processing-policy?schemaVersion=2"))
    } catch (error: JobsFailure) {
        if (error.problem in setOf(JobsProblem.JOB_NOT_FOUND, JobsProblem.OFFLINE)) ProcessingMediaPolicy.LEGACY else throw error
    }

    override suspend fun processingUsage(): ProcessingUsage? =
        decode<ProcessingUsage>(request("GET", "/processing-usage")).also { it.validate() }

    override suspend fun renewUpload(id: String): UploadGrant =
        decode<UploadGrant>(request("POST", "${path(id)}/upload-url", "{}", true)).also(::validateUpload)

    override suspend fun confirmUpload(id: String): JobMutation =
        decode(request("POST", "${path(id)}/upload-complete", "{}", true))

    override suspend fun list(cursor: String?, status: String?): JobPage {
        if (cursor != null && cursor.length > 512) invalidInput()
        if (status != null && JobStatus.entries.none { it.wireValue == status }) invalidInput()
        val query = "?limit=20" + (cursor?.let { "&cursor=${encode(it)}" } ?: "") +
            (status?.let { "&status=${encode(it)}" } ?: "")
        return decode(request("GET", "/jobs$query"))
    }

    override suspend fun detail(id: String): Job = decode<Job>(request("GET", path(id))).also {
        if (it.workerAvailable == null) invalidResponse()
    }

    override suspend fun cancel(id: String): JobMutation =
        decode(request("POST", "${path(id)}/cancel", "{}"))

    override suspend fun retry(id: String, requestId: String): JobMutation {
        uuid(requestId)
        return decode(request("POST", "${path(id)}/retry", buildJsonObject { put("requestId", requestId) }.toString(), true))
    }

    override suspend fun download(id: String, artifact: String): DownloadGrant {
        if (artifact !in setOf("input", "output")) invalidInput()
        return decode<DownloadGrant>(request("POST", "${path(id)}/download-url", buildJsonObject { put("artifact", artifact) }.toString())).also { validateUrl(it.url) }
    }

    override suspend fun rename(id: String, displayName: String): Job =
        decode<Job>(request("PATCH", path(id), buildJsonObject {
            put("displayName", validatedName(displayName))
        }.toString())).also { if (it.id.lowercase() != id.lowercase()) invalidResponse() }

    override suspend fun delete(id: String) {
        request("DELETE", path(id))
    }

    override suspend fun reportClientError(report: ClientErrorReport): ClientErrorAccepted {
        uuid(report.eventId)
        uuid(report.operationId)
        report.jobId?.let(::path)
        if (report.platform != "android" || report.appVersion.length !in 1..32 ||
            report.osVersion.length !in 1..64 || report.appVersion.any(Char::isISOControl) ||
            report.osVersion.any(Char::isISOControl) || report.httpStatus?.let { it !in 100..599 } == true
        ) invalidInput()
        return decode(request("POST", "/client-errors", json.encodeToString(
            ClientErrorReport.serializer(), report
        )))
    }

    private suspend fun request(method: String, path: String, body: String? = null, processingAccess: Boolean = false): String {
        val headers = if (processingAccess) mapOf("X-Installation-Id" to installationId().also(::uuid)) else emptyMap()
        return try {
            auth.request(method, path, body, additionalHeaders = headers, responseFailure = ::failure)
        } catch (failure: AuthFailure) {
            throw JobsFailure(when (failure.problem) {
                AuthProblem.UNAUTHENTICATED, AuthProblem.REAUTH_REQUIRED -> JobsProblem.UNAUTHENTICATED
                AuthProblem.OFFLINE -> JobsProblem.OFFLINE
                AuthProblem.ACCOUNT_DISABLED -> JobsProblem.ACCOUNT_DISABLED
                else -> JobsProblem.SERVICE_UNAVAILABLE
            }, failure.retryAfterSeconds)
        }
    }

    private inline fun <reified T> decode(body: String): T = try {
        val element = json.parseToJsonElement(body)
        validateScalars(element, serializer<T>().descriptor)
        json.decodeFromJsonElement<T>(element)
    } catch (_: IllegalArgumentException) {
        invalidResponse()
    } catch (_: java.time.DateTimeException) {
        invalidResponse()
    }

    // Kotlin JSON decoding accepts quoted numbers; the wire contract does not.
    private fun validateScalars(value: JsonElement, descriptor: SerialDescriptor) {
        if (value is JsonNull) return // Required/nullability checks belong to the serializer.
        when (descriptor.kind) {
            PrimitiveKind.STRING -> if (value !is JsonPrimitive || !value.isString) invalidResponse()
            PrimitiveKind.BOOLEAN -> if (value !is JsonPrimitive || value.isString || value.booleanOrNull == null) invalidResponse()
            PrimitiveKind.INT, PrimitiveKind.LONG -> if (value !is JsonPrimitive || value.isString || value.longOrNull == null) invalidResponse()
            PrimitiveKind.DOUBLE -> if (value !is JsonPrimitive || value.isString || value.doubleOrNull?.isFinite() != true) invalidResponse()
            StructureKind.CLASS -> if (value is JsonObject) {
                for (index in 0 until descriptor.elementsCount) {
                    value[descriptor.getElementName(index)]?.let { validateScalars(it, descriptor.getElementDescriptor(index)) }
                }
            }
            StructureKind.LIST -> if (value is JsonArray) value.forEach { validateScalars(it, descriptor.getElementDescriptor(0)) }
            StructureKind.MAP -> if (value is JsonObject) value.values.forEach { validateScalars(it, descriptor.getElementDescriptor(1)) }
            else -> Unit
        }
    }

    private fun failure(response: AuthHttpResponse): JobsFailure {
        val code = runCatching { json.parseToJsonElement(response.body).jsonObject["code"]?.jsonPrimitive?.content }.getOrNull()
        val safeMediaProblem = JobsProblem.entries.find { it.name == code && (it.name.startsWith("MEDIA_") || it.name.startsWith("YOUTUBE_") || it.name.startsWith("PROCESSING_")) }
        val problem = safeMediaProblem ?: when (response.status) {
            400 -> JobsProblem.INVALID_INPUT
            401 -> JobsProblem.UNAUTHENTICATED
            403 -> JobsProblem.entries.find { it.name == code && it in policyProblems } ?: JobsProblem.POLICY_DENIED
            404 -> JobsProblem.JOB_NOT_FOUND
            409 -> JobsProblem.entries.find { it.name == code && it in conflictProblems } ?: JobsProblem.JOB_STATE_CONFLICT
            429 -> JobsProblem.RATE_LIMITED
            else -> JobsProblem.SERVICE_UNAVAILABLE
        }
        if (problem == JobsProblem.APP_UPDATE_REQUIRED) onUpdateRequired()
        return JobsFailure(problem, if (response.status == 429) response.retryAfter?.toLongOrNull()?.takeIf { it in 1..86_400 } ?: 60 else null)
    }

    private fun path(id: String): String {
        if (!id.matches(Regex("[a-fA-F0-9]{24}"))) invalidInput()
        return "/jobs/$id"
    }
    private fun uuid(value: String) {
        if (!value.matches(Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}"))) invalidInput()
    }
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    private fun validatedName(value: String): String {
        return try { validateDisplayName(value) } catch (_: IllegalArgumentException) { invalidInput() }
    }
    private fun validateUpload(grant: UploadGrant) { validateUrl(grant.url) }
    private fun validateUrl(value: String) {
        val uri = runCatching { URI(value) }.getOrNull() ?: invalidResponse()
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawFragment != null) invalidResponse()
    }
    private fun invalidInput(): Nothing = throw JobsFailure(JobsProblem.INVALID_INPUT)
    private fun invalidResponse(): Nothing = throw JobsFailure(JobsProblem.SERVICE_UNAVAILABLE)

    companion object {
        private val policyProblems = setOf(JobsProblem.ACCOUNT_DISABLED, JobsProblem.EMAIL_VERIFICATION_REQUIRED, JobsProblem.APP_UPDATE_REQUIRED, JobsProblem.PROFILE_SYNC_REQUIRED)
        private val conflictProblems = setOf(JobsProblem.JOB_STATE_CONFLICT, JobsProblem.JOB_ACTIVE, JobsProblem.IDEMPOTENCY_CONFLICT, JobsProblem.UPLOAD_NOT_READY, JobsProblem.NEW_INPUT_REQUIRED, JobsProblem.PROFILE_SYNC_REQUIRED, JobsProblem.DEVICE_SYNC_REQUIRED, JobsProblem.DEVICE_REPORT_CONFLICT)
    }
}
