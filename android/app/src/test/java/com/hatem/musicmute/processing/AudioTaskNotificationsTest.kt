package com.hatem.musicmute.processing

import org.junit.Assert.*
import org.junit.Test

class AudioTaskNotificationsTest {
    private val operation = ProcessingOperation(
        operationId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
        requestId = "c21a2eaa-7e73-4f08-89da-6ac35baa83e1",
        ownerUid = "owner-a",
        displayName = "My interview",
        sourceTitle = "Interview",
        phase = ProcessingPhase.UPLOADING,
        uploadedBytes = 500,
        input = InputDeclaration("mp3", "audio/mpeg", 1000, 30.0, "hash"),
    )

    @Test fun transferProjectionUsesNameMeasuredProgressAndSilentGroupedPolicy() {
        val target = AudioTaskNotificationTarget(operation.ownerUid, operation.operationId, 7)
        val projection = audioTaskNotificationProjection(operation, target)
        assertEquals("My interview", projection.title)
        assertEquals(AudioTaskStage.UPLOADING_INPUT, projection.stage)
        assertEquals(50, projection.percent)
        assertEquals(500L, projection.transferredBytes)
        assertTrue(projection.ongoing)
        assertTrue(projection.canCancel)
        assertTrue(projection.silent)
        assertEquals("audio-task-transfers", projection.channelId)
        assertEquals(audioTaskNotificationGroup("owner-a"), projection.group)
        assertNotEquals(projection.group, audioTaskNotificationGroup("owner-b"))
    }

    @Test fun unknownTotalsAndRemoteProcessingNeverInventPercent() {
        val target = AudioTaskNotificationTarget(operation.ownerUid, operation.operationId, 7)
        val source = audioTaskNotificationProjection(operation, target,
            stage = AudioTaskStage.DOWNLOADING_SOURCE, transferredBytes = 123, totalBytes = null)
        assertNull(source.percent)
        assertEquals(123L, source.transferredBytes)
        val remote = audioTaskNotificationProjection(operation, target, stage = AudioTaskStage.PROCESSING)
        assertNull(remote.percent)
        val cancelled = audioTaskNotificationProjection(operation, target, stage = AudioTaskStage.CANCELLED)
        assertFalse(cancelled.ongoing)
        assertFalse(cancelled.canCancel)
        val failed = audioTaskFailureNotificationProjection(operation, target)
        assertEquals(PROCESSING_NOTIFICATION_CHANNEL, failed.channelId)
        assertFalse(failed.silent)
        assertFalse(failed.ongoing)
        assertFalse(failed.canCancel)
    }

    @Test fun identifiersRemainStablePerOperationAndTargetsRejectOtherSessions() {
        val target = AudioTaskNotificationTarget("owner-a", operation.operationId, 7)
        assertEquals(audioTaskNotificationId(target), audioTaskNotificationId(target.copy()))
        assertNotEquals(audioTaskNotificationId(target), audioTaskNotificationId(target.copy(operationId = "another")))
        assertNotEquals(audioTaskNotificationId(target), audioTaskNotificationId(target.copy(ownerUid = "owner-b")))
        assertNotEquals(audioTaskNotificationId(target), audioTaskNotificationId(target.copy(transferKind = AudioTaskTransferKind.SOURCE)))
        assertNotEquals(audioTaskNotificationId(target), audioTaskNotificationId(target.copy(epoch = 8)))
        assertNotEquals(audioTaskNotificationId(target.copy(workRequestId = "work-1")), audioTaskNotificationId(target.copy(workRequestId = "work-2")))
        assertTrue(target.matches(ProcessingSession("owner-a", 7)))
        assertFalse(target.matches(ProcessingSession("owner-a", 8)))
        assertFalse(target.matches(ProcessingSession("owner-b", 7)))
        assertFalse(target.matches(null))
    }

    @Test fun updatesThrottleBytesButImmediatelyShowPhaseChanges() {
        val target = AudioTaskNotificationTarget("owner-a", operation.operationId, 7)
        val projection = audioTaskNotificationProjection(operation, target)
        val throttle = AudioTaskNotificationThrottle()
        assertTrue(throttle.shouldUpdate(projection, 0))
        assertFalse(throttle.shouldUpdate(projection.copy(transferredBytes = 501), 100))
        assertTrue(throttle.shouldUpdate(projection.copy(stage = AudioTaskStage.CONFIRMING_UPLOAD), 101))
        assertFalse(throttle.shouldUpdate(projection.copy(stage = AudioTaskStage.CONFIRMING_UPLOAD), 200))
        assertTrue(throttle.shouldUpdate(projection.copy(stage = AudioTaskStage.CONFIRMING_UPLOAD, title = "Renamed"), 201))
        assertTrue(throttle.shouldUpdate(projection.copy(stage = AudioTaskStage.CONFIRMING_UPLOAD, title = "Renamed", transferredBytes = 600), 1_201))
    }
}
