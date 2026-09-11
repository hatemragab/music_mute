import Foundation
import XCTest

@testable import Vocal

@MainActor final class ProcessingHistoryTests: XCTestCase {
  func testOutputStorageFailureUsesStorageMessage() {
    XCTAssertEqual(processingErrorKey(JobArtifactFailure.storage), "processing_error_storage")
    XCTAssertEqual(processingErrorKey(JobArtifactFailure.unavailable), "processing_error_state")
    XCTAssertEqual(processingErrorKey(JobArtifactFailure.invalidOutput), "processing_error_service")
  }

  func testVisibleHistoryRefreshesAfterDelayedOwnerBinding() async {
    let api = HistoryAPIFixture()
    let refreshed = expectation(description: "visible owner loaded")
    api.page = { _ in
      refreshed.fulfill()
      return JobPage(items: [], nextCursor: nil)
    }
    let model = ProcessingHistoryModel(api: api)
    model.setVisible(true)
    await model.bindOwner("owner")
    await fulfillment(of: [refreshed], timeout: 1)
    model.setVisible(false)
  }

  func testManualRefreshDuringCacheLoadDoesNotLoseVisiblePolling() async {
    let api = HistoryAPIFixture()
    let polled = expectation(description: "poll after cache race")
    var calls = 0
    api.page = { _ in
      calls += 1
      if calls == 2 { polled.fulfill() }
      return JobPage(items: [], nextCursor: nil)
    }
    var pending: CheckedContinuation<[Job], Error>?
    let model = ProcessingHistoryModel(
      api: api,
      loadCached: { _ in
        try await withCheckedThrowingContinuation { pending = $0 }
      })
    model.setVisible(true)
    let bind = Task { await model.bindOwner("owner") }
    while pending == nil { await Task.yield() }
    await model.refresh()
    pending?.resume(returning: [])
    await bind.value
    await fulfillment(of: [polled], timeout: 1)
    model.setVisible(false)
  }

  func testPaginationDeduplicatesAndOfflineRefreshRetainsHistory() async {
    let api = HistoryAPIFixture()
    api.page = { cursor in
      JobPage(
        items: cursor == nil ? [self.job("a")] : [self.job("a"), self.job("b")],
        nextCursor: cursor == nil ? "opaque" : nil)
    }
    let model = ProcessingHistoryModel(api: api)
    await model.bindOwner("owner")
    await model.refresh()
    await model.loadMore()
    XCTAssertEqual(model.jobs.map(\.id), ["a", "b"])
    api.page = { _ in throw URLError(.notConnectedToInternet) }
    await model.refresh()
    XCTAssertEqual(model.jobs.map(\.id), ["a", "b"])
    XCTAssertEqual(model.messageKey, "processing_error_offline")
  }

  func testAccountChangeFencesSuspendedResponse() async {
    let api = HistoryAPIFixture()
    var pending: CheckedContinuation<JobPage, Error>?
    api.page = { _ in try await withCheckedThrowingContinuation { pending = $0 } }
    let model = ProcessingHistoryModel(api: api)
    await model.bindOwner("a")
    let refresh = Task { await model.refresh() }
    while pending == nil { await Task.yield() }
    await model.bindOwner(nil)
    await model.bindOwner("a")
    pending?.resume(returning: JobPage(items: [job("private")], nextCursor: nil))
    await refresh.value
    XCTAssertTrue(model.jobs.isEmpty)
  }

  func testWorkerOfflineAndUnknownStatusesRemainReadOnly() async {
    let api = HistoryAPIFixture()
    api.fetch = { _ in self.job("a", status: "interrupted", worker: false) }
    let model = ProcessingHistoryModel(api: api)
    await model.bindOwner("owner")
    await model.select("a")
    XCTAssertEqual(model.detail?.status, "interrupted")
    XCTAssertEqual(model.detail?.workerAvailable, false)
    XCTAssertTrue(shouldPollProcessingJob("interrupted"))
    XCTAssertFalse(shouldPollProcessingJob("future_status"))
    XCTAssertFalse(shouldPollProcessingJob("ready"))
    XCTAssertEqual(processingStatusKey("future_status"), "processing_unknown")
  }

  private func job(_ id: String, status: String = "queued", worker: Bool? = nil) -> Job {
    Job(
      id: id, status: status, createdAt: .distantPast, updatedAt: .distantPast,
      queuedAt: nil, finishedAt: nil, retryOfJobId: nil,
      input: .init(extension: "mp3", bytes: 10, durationSeconds: 2), error: nil,
      canDownloadInput: true, canDownloadOutput: status == "ready", workerAvailable: worker)
  }
}

@MainActor private final class HistoryAPIFixture: JobsAPI {
  var page: (String?) async throws -> JobPage = { _ in JobPage(items: [], nextCursor: nil) }
  var fetch: (String) async throws -> Job = { _ in throw JobsFailure.notFound }
  func list(cursor: String?, status: String?) async throws -> JobPage { try await page(cursor) }
  func detail(id: String) async throws -> Job { try await fetch(id) }
  func create(requestId: UUID, input: InputDeclaration) async throws -> CreateReservation {
    throw JobsFailure.serviceUnavailable
  }
  func renewUpload(id: String) async throws -> UploadGrant { throw JobsFailure.serviceUnavailable }
  func confirmUpload(id: String) async throws -> JobMutation {
    throw JobsFailure.serviceUnavailable
  }
  func cancel(id: String) async throws -> JobMutation { throw JobsFailure.serviceUnavailable }
  func retry(id: String, requestId: UUID) async throws -> JobMutation {
    throw JobsFailure.serviceUnavailable
  }
  func download(id: String, artifact: String) async throws -> DownloadGrant {
    throw JobsFailure.serviceUnavailable
  }
}
