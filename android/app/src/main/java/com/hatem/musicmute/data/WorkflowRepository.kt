package com.hatem.musicmute.data

import java.net.URI
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

enum class AudioSource {
    YOUTUBE,
    SAMPLE,
}

enum class WorkflowStage {
    DOWNLOADING,
    PREPARING,
    REMOVING,
}

data class WorkflowRequest(val source: AudioSource, val url: String = "")

sealed interface WorkflowEvent {
    data class Progress(val stage: WorkflowStage, val fraction: Float) : WorkflowEvent

    data object Complete : WorkflowEvent
}

interface WorkflowRepository {
    fun preview(request: WorkflowRequest): Flow<WorkflowEvent>
}

/** Simulates state transitions only. Never downloads, uploads, or creates audio. */
class DemoWorkflowRepository : WorkflowRepository {
    override fun preview(request: WorkflowRequest): Flow<WorkflowEvent> = flow {
        require(request.source == AudioSource.SAMPLE || YouTubeUrl.isSupported(request.url))
        val stages =
            if (request.source == AudioSource.SAMPLE) {
                listOf(WorkflowStage.PREPARING, WorkflowStage.REMOVING)
            } else {
                WorkflowStage.entries
            }
        stages.forEachIndexed { index, stage ->
            repeat(10) { step ->
                emit(WorkflowEvent.Progress(stage, (index + step / 10f) / stages.size))
                delay(180)
            }
        }
        emit(WorkflowEvent.Complete)
    }
}

object YouTubeUrl {
    private val videoId = Regex("[A-Za-z0-9_-]{11}")
    private val hosts =
        setOf("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com")

    fun canonical(input: String): String? {
        val id =
            runCatching {
                val uri = URI(input.trim())
                if (
                    uri.scheme !in setOf("https", "http") || uri.userInfo != null || uri.port != -1
                ) {
                    return@runCatching null
                }
                val host = uri.host?.lowercase() ?: return@runCatching null
                val parts = uri.path.orEmpty().trim('/').split('/')
                when {
                    host == "youtu.be" && parts.size == 1 && videoId.matches(parts[0]) -> parts[0]
                    host !in hosts -> null
                    uri.path == "/watch" -> {
                        val ids = uri.rawQuery.orEmpty().split('&').filter { it.startsWith("v=") }
                        ids.singleOrNull()?.removePrefix("v=")?.takeIf(videoId::matches)
                    }
                    parts.size == 2 && parts[0] in setOf("shorts", "live", "embed") ->
                        parts[1].takeIf(videoId::matches)
                    else -> null
                }
            }
            .getOrNull() ?: return null
        return "https://www.youtube.com/watch?v=$id"
    }

    fun isSupported(input: String): Boolean = canonical(input) != null
}
