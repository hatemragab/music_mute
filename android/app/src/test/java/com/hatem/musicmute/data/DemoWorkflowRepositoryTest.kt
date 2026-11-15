package com.hatem.musicmute.data

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DemoWorkflowRepositoryTest {
    @Test
    fun youtubeProgressIsOrderedAndCompletes() = runTest {
        val events =
            DemoWorkflowRepository()
                .preview(WorkflowRequest(AudioSource.YOUTUBE, "https://youtu.be/dQw4w9WgXcQ"))
                .toList()
        val progress = events.filterIsInstance<WorkflowEvent.Progress>()
        assertEquals(WorkflowStage.entries, progress.map { it.stage }.distinct())
        assertTrue(progress.zipWithNext().all { (a, b) -> a.fraction < b.fraction })
        assertEquals(WorkflowEvent.Complete, events.last())
    }

    @Test
    fun localExampleSkipsDownloadStage() = runTest {
        val events = DemoWorkflowRepository().preview(WorkflowRequest(AudioSource.SAMPLE)).toList()
        assertFalse(
            events.filterIsInstance<WorkflowEvent.Progress>().any {
                it.stage == WorkflowStage.DOWNLOADING
            }
        )
        assertEquals(WorkflowEvent.Complete, events.last())
    }

    @Test
    fun cancellingCollectionStopsBeforeCompletion() = runTest {
        val events = mutableListOf<WorkflowEvent>()
        val job = launch {
            DemoWorkflowRepository().preview(WorkflowRequest(AudioSource.SAMPLE)).toList(events)
        }
        advanceTimeBy(400)
        job.cancel()
        job.join()
        assertTrue(events.isNotEmpty())
        assertFalse(events.contains(WorkflowEvent.Complete))
    }
}
