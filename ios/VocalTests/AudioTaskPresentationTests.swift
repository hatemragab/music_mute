import Foundation
import XCTest

@testable import Vocal

final class AudioTaskPresentationTests: XCTestCase {
  func testServerMeasurementsDriveTimelineAndDoNotTickOnTheClient() throws {
    let fixture = processingJob(id: "68c000000000000000000001", status: "processing")
    let job = Job(
      id: fixture.id, status: fixture.status, createdAt: fixture.createdAt,
      updatedAt: fixture.updatedAt, queuedAt: fixture.queuedAt, finishedAt: nil,
      retryOfJobId: nil, input: fixture.input, error: nil, canDownloadInput: true,
      canDownloadOutput: false, workerAvailable: nil,
      serverStageTimings: ServerStageTimings(
        totalMs: 6000, totalComplete: false,
        stages: [
          ServerStageMeasurement(stage: "queue", durationMs: 1000, complete: true),
          ServerStageMeasurement(stage: "separation", durationMs: 3000, complete: false),
        ]))
    let task = try XCTUnwrap(
      AudioTaskPresentation.merge(pipelines: [], uploads: [], jobs: [job]).first)
    XCTAssertEqual(task.totalSeconds, 6)
    XCTAssertEqual(task.processingSeconds, 3)
    XCTAssertEqual(
      task.timeline.first { $0.titleKey == "processing_processing" }?.measurement?.durationMs, 3000)
    XCTAssertEqual(
      audioTaskTotalSeconds(task, at: Date(timeIntervalSince1970: 99999), sampledAt: .distantPast),
      6)
  }

  func testPreJobUsesReferenceAndActualLocalPhase() {
    let id = UUID()
    let intent = AudioPipelineIntent(
      operationId: id, ownerUid: "owner", sourceKind: .file, sourceTitle: "Interview",
      displayName: "My interview",
      clientStartedAt: Date(timeIntervalSince1970: 100),
      updatedAt: Date(timeIntervalSince1970: 110),
      phase: .preparingInput)

    let task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: []).first

    XCTAssertEqual(task?.title, "My interview")
    XCTAssertEqual(task?.reference, id.uuidString.lowercased())
    XCTAssertNil(task?.jobID)
    XCTAssertEqual(task?.statusKey, "processing_preparing")
    XCTAssertEqual(
      task?.timeline.map(\.state), [.active] + Array(repeating: .pending, count: 8))
  }

  func testMergedReadyJobKeepsNameIDsAndSeparateTiming() {
    let id = UUID(uuidString: "C21A2EAA-7E73-4F08-89DA-6AC35BAA83E1")!
    let intent = AudioPipelineIntent(
      operationId: id, ownerUid: "owner", sourceKind: .file, sourceTitle: "Interview",
      displayName: "My interview", clientStartedAt: Date(timeIntervalSince1970: 100),
      updatedAt: Date(timeIntervalSince1970: 170), phase: .waitingProcessing,
      jobId: "68c000000000000000000002", jobStatus: "queued")
    let job = processingJob(id: "68c000000000000000000002", status: "ready").withExperience(
      requestId: id.uuidString.lowercased(), sourceTitle: "Interview",
      displayName: "Server rename",
      timing: JobTiming(
        processingElapsedMs: 20_000, processingElapsedApproximate: false,
        totalElapsedMs: 70_000, totalElapsedApproximate: true))

    let tasks = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [job])
    let task = try! XCTUnwrap(tasks.first)

    XCTAssertEqual(tasks.count, 1)
    XCTAssertEqual(task.title, "Server rename")
    XCTAssertEqual(task.jobID, job.id)
    XCTAssertEqual(task.reference, id.uuidString.lowercased())
    XCTAssertEqual(task.statusKey, "processing_ready")
    XCTAssertEqual(task.processingSeconds, 20)
    XCTAssertNil(task.totalSeconds)
    XCTAssertTrue(task.totalApproximate)
    XCTAssertTrue(task.timeline.allSatisfy { $0.state == .complete })
  }

  func testLegacyAndOutputFailureStayUsableAsReady() {
    let job = processingJob(id: "68c000000000000000000001", status: "ready")
    var task = try! XCTUnwrap(
      AudioTaskPresentation.merge(pipelines: [], uploads: [], jobs: [job]).first)
    XCTAssertEqual(task.title, String(localized: "processing_untitled"))
    XCTAssertNil(task.reference)
    XCTAssertEqual(task.jobID, job.id)
    task.outputMessageKey = "processing_error_offline"
    XCTAssertTrue(task.isReady)
    XCTAssertEqual(task.statusKey, "processing_ready")
  }

  func testAwaitingUploadPreservesLocalTransferAndCancellationUntilServerAcknowledges() {
    let job = processingJob(id: "68c000000000000000000001", status: "awaiting_upload")
    var intent = intent(phase: .uploadingInput, job: job)
    var task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [job])[0]
    XCTAssertEqual(task.statusKey, "processing_uploading_audio")
    XCTAssertTrue(task.isActive)
    XCTAssertEqual(
      task.timeline.first { $0.state == .active }?.titleKey, "processing_uploading_audio")

    intent.phase = .confirmingUpload
    task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [job])[0]
    XCTAssertEqual(task.statusKey, "processing_checking_upload")

    intent.cancellationRequested = true
    task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [job])[0]
    XCTAssertEqual(task.statusKey, "processing_cancelling")
    XCTAssertTrue(task.isActive)
    XCTAssertFalse(task.canDelete)
    XCTAssertFalse(task.canCancel)
  }

  func testServerTerminalStateOverridesStaleLocalFailureAndCancelIntent() {
    let job = processingJob(id: "68c000000000000000000001", status: "ready")
    var intent = intent(phase: .failed, job: job)
    intent.cancellationRequested = true
    let task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [job])[0]
    XCTAssertTrue(task.isReady)
    XCTAssertFalse(task.isActive)
    XCTAssertFalse(task.canRetry)
    XCTAssertFalse(task.canCancel)
    XCTAssertTrue(task.canDelete)
    XCTAssertEqual(task.statusKey, "processing_ready")
  }

  func testFileTimelineIncludesEachUploadAndWorkerStageWithoutSourceDownload() {
    let job = processingJob(id: "68c000000000000000000001", status: "validating")
    let task = AudioTaskPresentation.merge(
      pipelines: [intent(phase: .waitingProcessing, job: job)], uploads: [], jobs: [job])[0]
    XCTAssertEqual(
      task.timeline.map(\.titleKey),
      [
        "processing_preparing", "processing_reserving", "processing_uploading_audio",
        "processing_checking_upload", "processing_queued", "processing_validating",
        "processing_processing", "processing_uploading_result", "processing_ready",
      ])
    XCTAssertEqual(task.timeline.first { $0.state == .active }?.titleKey, "processing_validating")
  }

  func testPersistedJobStateSurvivesMissingRefreshAndUnknownCloudStateIsReadOnly() {
    var intent = intent(phase: .waitingProcessing, job: nil)
    intent.jobStatus = "processing"
    let restored = AudioTaskPresentation.merge(pipelines: [intent], uploads: [], jobs: [])[0]
    XCTAssertEqual(restored.statusKey, "processing_processing")
    let unknown = processingJob(id: "68c000000000000000000001", status: "new_server_state")
    let cloud = AudioTaskPresentation.merge(pipelines: [], uploads: [], jobs: [unknown])[0]
    XCTAssertNil(cloud.operationID)
    XCTAssertFalse(cloud.canCancel)
    XCTAssertFalse(cloud.canRetry)
    XCTAssertFalse(cloud.canDelete)
  }

  func testPersistedTerminalResultWinsOverUploadBookkeepingAndActiveSamplesUseFreshness() {
    var intent = intent(phase: .ready, job: nil)
    intent.jobStatus = "ready"
    intent.jobId = "68c000000000000000000001"
    var upload = UploadOperation(
      operationId: intent.operationId, ownerUid: "owner", requestId: intent.operationId,
      input: InputDeclaration(
        extension: "mp3", contentType: "audio/mpeg", bytes: 20,
        durationSeconds: 1, sha256: "fixture"), stagedRelativePath: "fixture/input.mp3",
      createdAt: Date(timeIntervalSince1970: 100), updatedAt: Date(timeIntervalSince1970: 500),
      jobId: "68c000000000000000000001", jobStatus: "queued", phase: .submitted,
      transferId: nil, transferTaskId: nil, uploadAttempts: 1, lastFailureCode: nil)
    var task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [upload], jobs: [])[0]
    XCTAssertTrue(task.isReady)
    XCTAssertTrue(task.canDelete)
    XCTAssertFalse(task.canCancel)

    intent.phase = .waitingProcessing
    intent.jobStatus = "processing"
    intent.updatedAt = Date(timeIntervalSince1970: 600)
    task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [upload], jobs: [])[0]
    XCTAssertEqual(task.statusKey, "processing_processing")

    upload.jobStatus = "uploading_result"
    upload.updatedAt = Date(timeIntervalSince1970: 700)
    task = AudioTaskPresentation.merge(pipelines: [intent], uploads: [upload], jobs: [])[0]
    XCTAssertEqual(task.statusKey, "processing_uploading_result")
  }

  func testPersistedTerminalResultWinsOverStaleCachedNonterminalJob() {
    var intent = intent(phase: .ready, job: nil)
    intent.jobStatus = "ready"
    intent.jobId = "68c000000000000000000001"
    let staleJob = processingJob(id: "68c000000000000000000001", status: "queued")

    let task = AudioTaskPresentation.merge(
      pipelines: [intent], uploads: [], jobs: [staleJob])[0]

    XCTAssertTrue(task.isReady)
    XCTAssertFalse(task.isActive)
    XCTAssertEqual(task.statusKey, "processing_ready")
  }

  func testElapsedTotalNeverUsesClientIntakeOrLegacyClientTiming() {
    let active = AudioTaskPresentation.merge(
      pipelines: [intent(phase: .preparingInput, job: nil)], uploads: [], jobs: [])[0]
    XCTAssertNil(
      audioTaskTotalSeconds(active, at: Date(timeIntervalSince1970: 130), sampledAt: .distantPast))
    let job = processingJob(id: "68c000000000000000000001", status: "ready")
    let ready = AudioTaskPresentation.merge(
      pipelines: [], uploads: [],
      jobs: [
        job.withExperience(
          requestId: nil, sourceTitle: nil, displayName: nil,
          timing: JobTiming(
            processingElapsedMs: 20_000, processingElapsedApproximate: false,
            totalElapsedMs: 70_000, totalElapsedApproximate: true))
      ])[0]
    XCTAssertNil(audioTaskTotalSeconds(ready, at: .distantFuture, sampledAt: .distantPast))
    let legacy = AudioTaskPresentation.merge(pipelines: [], uploads: [], jobs: [job])[0]
    XCTAssertNil(audioTaskTotalSeconds(legacy, at: .distantFuture, sampledAt: .distantPast))
  }

  private func intent(phase: AudioPipelinePhase, job: Job?) -> AudioPipelineIntent {
    AudioPipelineIntent(
      operationId: UUID(), ownerUid: "owner", sourceKind: .file, sourceTitle: "Interview",
      clientStartedAt: Date(timeIntervalSince1970: 100),
      updatedAt: Date(timeIntervalSince1970: 110), phase: phase, jobId: job?.id,
      jobStatus: job?.status)
  }
}

extension Job {
  fileprivate func withExperience(
    requestId: String?, sourceTitle: String?, displayName: String?, timing: JobTiming?
  ) -> Job {
    Job(
      id: id, status: status, createdAt: createdAt, updatedAt: updatedAt, queuedAt: queuedAt,
      finishedAt: finishedAt, retryOfJobId: retryOfJobId, input: input, error: error,
      canDownloadInput: canDownloadInput, canDownloadOutput: canDownloadOutput,
      workerAvailable: workerAvailable, requestId: requestId, sourceTitle: sourceTitle,
      displayName: displayName, sourceKind: .file, serverTime: updatedAt, timing: timing,
      stages: nil)
  }
}
