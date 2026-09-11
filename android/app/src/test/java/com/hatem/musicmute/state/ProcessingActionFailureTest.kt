package com.hatem.musicmute.state

import com.hatem.musicmute.R
import com.hatem.musicmute.processing.ArtifactException
import com.hatem.musicmute.processing.ArtifactProblem
import org.junit.Assert.assertEquals
import org.junit.Test

class ProcessingActionFailureTest {
    @Test fun outputFailuresDistinguishStorageFromUnavailableJobState() {
        assertEquals(R.string.processing_error_storage,
            processingActionFailureLabel(ArtifactException(ArtifactProblem.STORAGE)))
        assertEquals(R.string.processing_error_state,
            processingActionFailureLabel(ArtifactException(ArtifactProblem.NOT_READY)))
        for (problem in listOf(ArtifactProblem.INVALID_OUTPUT, ArtifactProblem.TRANSFER, ArtifactProblem.EXPIRED_GRANT)) {
            assertEquals(R.string.processing_error_service,
                processingActionFailureLabel(ArtifactException(problem)))
        }
    }
}
