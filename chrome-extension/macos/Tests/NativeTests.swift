import CryptoKit
import Darwin
import Foundation

enum TestFailure: Error { case failed(String) }
private func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw TestFailure.failed(message) }
}
private final class Capture: @unchecked Sendable {
  let lock = NSLock()
  var events: [ControlEvent] = []
  var outcome: ProcessOutcome?
  func event(_ value: ControlEvent) {
    lock.lock()
    events.append(value)
    lock.unlock()
  }
  func finish(_ value: ProcessOutcome) {
    lock.lock()
    outcome = value
    lock.unlock()
  }
}

private final class RecordingRuntimeSignatureChecker: RuntimeSignatureChecking, @unchecked Sendable
{
  private let lock = NSLock()
  let verificationPolicyIdentifier: String
  private(set) var outerChecks = 0
  private(set) var codePaths = [String]()
  private var rejectOuterApplication = false
  private var rejectCode = false
  private var nextOuterValidationAction: (() throws -> Void)?

  init(verificationPolicyIdentifier: String = UUID().uuidString) {
    self.verificationPolicyIdentifier = verificationPolicyIdentifier
  }

  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    outerChecks += 1
    let reject = rejectOuterApplication
    let action = nextOuterValidationAction
    nextOuterValidationAction = nil
    lock.unlock()
    try action?()
    if reject { throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") }
  }

  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    codePaths.append(url.lastPathComponent)
    let reject = rejectCode
    lock.unlock()
    if reject { throw RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") }
  }

  func setRejectOuterApplication(_ reject: Bool) {
    lock.lock()
    rejectOuterApplication = reject
    lock.unlock()
  }

  func setRejectCode(_ reject: Bool) {
    lock.lock()
    rejectCode = reject
    lock.unlock()
  }

  func onNextOuterValidation(_ action: @escaping () throws -> Void) {
    lock.lock()
    nextOuterValidationAction = action
    lock.unlock()
  }

  func snapshot() -> (outer: Int, code: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (outerChecks, codePaths.count)
  }
}

private final class ReceiptRuntimeSignatureChecker: RuntimeSignatureChecking, @unchecked Sendable {
  private let lock = NSLock()
  let verificationPolicyIdentifier: String
  let supportsDurableVerificationReceipts = true
  private var application: RuntimeVerificationApplicationIdentity
  private(set) var outerChecks = 0
  private(set) var codeChecks = 0

  init(
    verificationPolicyIdentifier: String,
    application: RuntimeVerificationApplicationIdentity
  ) {
    self.verificationPolicyIdentifier = verificationPolicyIdentifier
    self.application = application
  }

  func validateOuterApplication(resources: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    outerChecks += 1
    lock.unlock()
  }

  func validateCode(at url: URL, signing: RuntimeSigningManifest) throws {
    lock.lock()
    codeChecks += 1
    lock.unlock()
  }

  func verificationReceiptApplicationIdentity(resources: URL) throws
    -> RuntimeVerificationApplicationIdentity
  {
    lock.lock()
    defer { lock.unlock() }
    return application
  }

  func snapshot() -> (outer: Int, code: Int) {
    lock.lock()
    defer { lock.unlock() }
    return (outerChecks, codeChecks)
  }
}

private struct InMemoryRuntimeReceiptAuthenticator: RuntimeVerificationReceiptAuthenticating {
  let key = SymmetricKey(data: Data(repeating: 0x5a, count: 32))

  func authenticationCode(for payload: Data) throws -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
  }

  func isValidAuthenticationCode(_ code: Data, authenticating payload: Data) throws -> Bool {
    HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: payload, using: key)
  }
}

private struct UnavailableRuntimeReceiptAuthenticator: RuntimeVerificationReceiptAuthenticating {
  func authenticationCode(for payload: Data) throws -> Data {
    throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
  }

  func isValidAuthenticationCode(_ code: Data, authenticating payload: Data) throws -> Bool {
    throw RuntimeBootstrapFailure.code("RUNTIME_RECEIPT_UNAVAILABLE")
  }
}

private final class MutatingRuntimeMetadataFingerprinter:
  RuntimeInventoryMetadataFingerprinting, @unchecked Sendable
{
  private let lock = NSLock()
  private let triggerPath: String
  private let mutation: () throws -> Void
  private var invocationCount = 0
  private var didMutate = false

  init(triggerPath: String, mutation: @escaping () throws -> Void) {
    self.triggerPath = triggerPath
    self.mutation = mutation
  }

  func compute(release: URL, manifest: RuntimeBootstrapManifest) throws -> String {
    lock.lock()
    invocationCount += 1
    let shouldMutate = invocationCount == 1
    lock.unlock()
    return try RuntimeInventoryMetadataFingerprint.compute(
      release: release, manifest: manifest,
      entryObserved: shouldMutate
        ? { [self] path in
          guard path == triggerPath else { return }
          lock.lock()
          let runMutation = !didMutate
          didMutate = true
          lock.unlock()
          if runMutation { try mutation() }
        } : nil)
  }

  func snapshot() -> (invocations: Int, mutated: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (invocationCount, didMutate)
  }
}

private final class InMemoryRuntimeReceiptStore: RuntimeVerificationReceiptStoring,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var data: Data?

  func load(support: URL) throws -> Data? {
    lock.lock()
    defer { lock.unlock() }
    return data
  }

  func persist(_ data: Data, support: URL) throws {
    lock.lock()
    self.data = data
    lock.unlock()
  }

  func corrupt() {
    lock.lock()
    if var value = data, !value.isEmpty {
      value[value.startIndex] ^= 0xff
      data = value
    }
    lock.unlock()
  }

  func tamperAuthenticationCode() throws {
    lock.lock()
    defer { lock.unlock() }
    guard let data,
      var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let code = object["authentication_code"] as? String, !code.isEmpty
    else { throw TestFailure.failed("Receipt fixture was not persisted") }
    let replacement = code.hasPrefix("A") ? "B" : "A"
    object["authentication_code"] = replacement + String(code.dropFirst())
    self.data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }
}

private final class RuntimeDownloadFixtureStore: @unchecked Sendable {
  struct Step: @unchecked Sendable {
    let status: Int
    let headers: [String: String]
    let chunks: [Data]
    let redirect: URL?
    let hold: Bool
    let delivered: DispatchSemaphore?
    let chunkDelay: DispatchTimeInterval

    init(
      status: Int = 200, headers: [String: String] = [:], chunks: [Data] = [],
      redirect: URL? = nil, hold: Bool = false, delivered: DispatchSemaphore? = nil,
      chunkDelay: DispatchTimeInterval = .never
    ) {
      self.status = status
      self.headers = headers
      self.chunks = chunks
      self.redirect = redirect
      self.hold = hold
      self.delivered = delivered
      self.chunkDelay = chunkDelay
    }
  }

  private let lock = NSLock()
  private var steps = [Step]()
  private var requests = [URLRequest]()

  func configure(_ steps: [Step]) {
    lock.lock()
    self.steps = steps
    requests = []
    lock.unlock()
  }

  func take(_ request: URLRequest) -> Step? {
    lock.lock()
    defer { lock.unlock() }
    requests.append(request)
    guard !steps.isEmpty else { return nil }
    return steps.removeFirst()
  }

  func snapshot() -> [URLRequest] {
    lock.lock()
    defer { lock.unlock() }
    return requests
  }
}

private final class RuntimeDownloadFixtureProtocol: URLProtocol, @unchecked Sendable {
  static let store = RuntimeDownloadFixtureStore()
  private let lock = NSLock()
  private var stopped = false
  private var work: DispatchWorkItem?

  override class func canInit(with request: URLRequest) -> Bool {
    ["downloads.example.com", "cdn.example.com"].contains(request.url?.host?.lowercased())
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let step = Self.store.take(request) else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    if let redirect = step.redirect {
      let response = HTTPURLResponse(
        url: url, statusCode: step.status, httpVersion: "HTTP/1.1",
        headerFields: ["Location": redirect.absoluteString])!
      var redirected = URLRequest(url: redirect)
      redirected.setValue("Bearer must-not-cross", forHTTPHeaderField: "Authorization")
      redirected.setValue("must-not-cross", forHTTPHeaderField: "X-Untrusted")
      client?.urlProtocol(self, wasRedirectedTo: redirected, redirectResponse: response)
      return
    }
    let response = HTTPURLResponse(
      url: url, statusCode: step.status, httpVersion: "HTTP/1.1",
      headerFields: step.headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.isActive else { return }
      for (index, chunk) in step.chunks.enumerated() {
        guard self.isActive else { return }
        self.client?.urlProtocol(self, didLoad: chunk)
        if index == 0 { step.delivered?.signal() }
        if index + 1 < step.chunks.count, step.chunkDelay != .never {
          let delayed = DispatchSemaphore(value: 0)
          _ = delayed.wait(timeout: .now() + step.chunkDelay)
        }
      }
      if step.chunks.isEmpty { step.delivered?.signal() }
      if !step.hold, self.isActive { self.client?.urlProtocolDidFinishLoading(self) }
    }
    lock.lock()
    self.work = work
    lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(10), execute: work)
  }

  override func stopLoading() {
    lock.lock()
    stopped = true
    let work = work
    self.work = nil
    lock.unlock()
    work?.cancel()
  }

  private var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !stopped
  }
}

private final class RuntimeDownloadInvocation: @unchecked Sendable {
  private let lock = NSLock()
  private var storedError: Error?
  let finished = DispatchSemaphore(value: 0)

  func complete(_ error: Error?) {
    lock.lock()
    storedError = error
    lock.unlock()
    finished.signal()
  }

  var error: Error? {
    lock.lock()
    defer { lock.unlock() }
    return storedError
  }
}

private final class RuntimeDownloadCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var delegate: RuntimeDownloadDelegate?

  func install(_ delegate: RuntimeDownloadDelegate?) {
    lock.lock()
    self.delegate = delegate
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    let delegate = delegate
    lock.unlock()
    delegate?.cancel()
  }
}

@main struct NativeTests {
  static let status = """
    {"type":"result","protocol_version":1,"status":{"ready":true,"platform":"darwin","arch":"arm64","version":"0.1.0","runtime_ready":true,"model_ready":true,"extension_registered":true,"extension_path":"/fixture/extension","model_bytes":66759214,"cache_bytes":0,"diagnostic_mode":"LOCAL_ONLY","max_duration_seconds":900}}
    """
  static func main() throws {
    try check(
      SystemRuntimeVerificationReceiptAuthenticator.noninteractiveContext().interactionNotAllowed,
      "Optional runtime receipts must never prompt for Keychain authentication")
    try parserChecks()
    try readinessChecks()
    try setupDiagnosticsChecks()
    try desktopDiagnosticsChecks()
    try identityChecks()
    try inventoryChecks()
    try inventoryReplacementChecks()
    try pathChecks()
    try productLinkChecks()
    try cloudHandoffChecks()
    try youtubeSetupChecks()
    try preferenceChecks()
    try accountUsagePresentationChecks()
    try playbackAdvanceChecks()
    try offlineStoragePolicyChecks()
    try cacheBudgetOutcomeChecks()
    try cacheClearOutcomeChecks()
    try runtimeBootstrapChecks()
    try bridgeChecks()
    try journalChecks()
    print(
      "Native macOS checks passed: parser, readiness presentation, retained setup alerts, diagnostic identity and bounded safe inventory, paths, preference defaults and normalization, account allowance parsing and presentation, playback advance and repeat decisions, pinned external runtime schema/inventory/activation, subprocess completion, environment filtering, malformed output, missing resources, cancellation and private bounded UI journal."
    )
  }

  static func preferenceChecks() throws {
    try check(
      DesktopAppearancePreference.allCases.map(\.rawValue) == ["system", "light", "dark"],
      "Appearance preference values must remain stable")
    try check(
      DesktopAccentPreference.allCases.map(\.rawValue) == ["orange", "mint", "blue", "purple"],
      "Accent preference values must remain stable")
    try check(
      DesktopTextSizePreference.allCases.map(\.rawValue)
        == ["system", "compact", "small", "standard", "large", "extraLarge", "accessibility"],
      "Text size preference values must remain stable")
    try check(
      DesktopImportSourcePreference.allCases.map(\.rawValue) == ["youtube", "file"],
      "Import source preference values must remain stable")
    try check(
      DesktopProcessingPreference.allCases.map(\.rawValue) == ["local", "cloud"],
      "Processing preference values must remain stable")
    try check(
      DesktopLanguagePreference.allCases.map(\.rawValue) == ["system", "en", "ar"],
      "Language preference values must remain compatible with the app locale resolver")

    let validAppearance: DesktopAppearancePreference = DesktopPreferenceNormalizer.normalize(
      "light", fallback: .system)
    let invalidAppearance: DesktopAppearancePreference = DesktopPreferenceNormalizer.normalize(
      "LIGHT", fallback: .system)
    let invalidAccent: DesktopAccentPreference = DesktopPreferenceNormalizer.normalize(
      "future-accent", fallback: .orange)
    let invalidTextSize: DesktopTextSizePreference = DesktopPreferenceNormalizer.normalize(
      "giant", fallback: .standard)
    let invalidImport: DesktopImportSourcePreference = DesktopPreferenceNormalizer.normalize(
      "", fallback: .youtube)
    let invalidProcessing: DesktopProcessingPreference = DesktopPreferenceNormalizer.normalize(
      "automatic", fallback: .local)
    let invalidLanguage: DesktopLanguagePreference = DesktopPreferenceNormalizer.normalize(
      "arabic", fallback: .system)
    try check(validAppearance == .light, "A valid stored preference must round-trip")
    try check(invalidAppearance == .system, "Malformed appearance must use the system fallback")
    try check(invalidAccent == .orange, "Malformed accent must use the orange fallback")
    try check(invalidTextSize == .standard, "Malformed text size must use the standard fallback")
    try check(invalidImport == .youtube, "Malformed import source must use the YouTube fallback")
    try check(invalidProcessing == .local, "Malformed processing mode must stay local")
    try check(invalidLanguage == .system, "Malformed language must use the system fallback")
    try check(
      DesktopAppearancePreference.system.colorScheme == nil
        && DesktopAppearancePreference.light.colorScheme == .light
        && DesktopAppearancePreference.dark.colorScheme == .dark,
      "Appearance preferences must map to the expected SwiftUI color scheme")
    try check(
      DesktopTextSizePreference.compact.decreased() == .compact
        && DesktopTextSizePreference.compact.increased() == .small
        && DesktopTextSizePreference.system.decreased() == .small
        && DesktopTextSizePreference.system.increased() == .large
        && DesktopTextSizePreference.standard.decreased() == .small
        && DesktopTextSizePreference.standard.increased() == .large
        && DesktopTextSizePreference.accessibility.increased() == .accessibility,
      "Text size adjustments must move one bounded level at a time")
    try check(
      DesktopTextSizePreference.clamped(index: -20) == .compact
        && DesktopTextSizePreference.clamped(index: 2) == .standard
        && DesktopTextSizePreference.clamped(index: 20) == .accessibility,
      "Text size index clamping must protect both bounds")
    try check(
      DesktopTextSizePreference.system.dynamicTypeSize == nil
        && DesktopTextSizePreference.standard.dynamicTypeSize == .large
        && DesktopTextSizePreference.accessibility.dynamicTypeSize == .accessibility1,
      "Text size preferences must map to semantic Dynamic Type sizes")

    let shortcuts = DesktopAppShortcut.allCases
    try check(
      Set(shortcuts.map(\.chordIdentifier)).count == shortcuts.count,
      "App keyboard shortcuts must remain unique")
    try check(
      shortcuts.allSatisfy {
        $0.modifiers.contains(.command) && !$0.title.isEmpty && !$0.display.isEmpty
      },
      "App shortcuts must be discoverable and use Command to stay text-entry safe")

    let keys = [
      DesktopPreferenceKey.appearance, DesktopPreferenceKey.accent,
      DesktopPreferenceKey.textSize, DesktopPreferenceKey.language,
      DesktopPreferenceKey.importSource,
      DesktopPreferenceKey.processingMode, DesktopPreferenceKey.expandPlayer,
      DesktopPreferenceKey.playbackVolume, DesktopPreferenceKey.playbackMuted,
      DesktopPreferenceKey.playbackLastAudibleVolume,
      DesktopPreferenceKey.restoreLastPage, DesktopPreferenceKey.lastPage,
    ]
    try check(
      Set(keys).count == keys.count && keys.allSatisfy { !$0.isEmpty },
      "Preference storage keys must be unique and nonempty")
  }

  static func accountUsagePresentationChecks() throws {
    let fixture = usageFixture()
    guard let presentation = DesktopUsagePresentation.parse(fixture) else {
      throw TestFailure.failed("A complete valid allowance snapshot must be presentable")
    }
    try check(
      presentation.processing == DesktopUsageAmount(remaining: 27_000, limit: 54_000)
        && presentation.storage
          == DesktopUsageAmount(remaining: 3_520_000_000, limit: 5_000_000_000)
        && presentation.uploads == DesktopUsageAmount(remaining: 937, limit: 1_000)
        && presentation.downloads == DesktopUsageAmount(remaining: 979, limit: 1_000),
      "Allowance parsing must preserve all remaining and limit values")
    try check(
      presentation.processing.remainingFraction == 0.5,
      "Allowance progress must represent the remaining share")
    try check(
      DesktopUsageAmount(remaining: 0, limit: 0).remainingFraction == nil,
      "A zero limit must not render misleading progress")
    try check(
      DesktopUsagePresentation.nonnegativeSafeInteger(
        .number(DesktopUsagePresentation.maximumSafeInteger))
        == 9_007_199_254_740_991,
      "The parser must accept the largest JavaScript-safe integer")

    let zuluDate = DesktopUsagePresentation.rfc3339Date("2026-11-01T00:00:00Z")
    let offsetDate = DesktopUsagePresentation.rfc3339Date("2026-11-01T02:00:00+02:00")
    try check(
      zuluDate != nil && zuluDate == offsetDate, "RFC3339 offsets must identify the same date")
    try check(
      DesktopUsagePresentation.rfc3339Date("1999-12-31T23:59:59Z") == nil
        && DesktopUsagePresentation.rfc3339Date("2101-01-01T00:00:00Z") == nil
        && DesktopUsagePresentation.rfc3339Date("2026-11-01") == nil,
      "Reset dates must be bounded and use the complete RFC3339 form")

    let locale = Locale(identifier: "en_US_POSIX")
    try check(
      !DesktopUsagePresentation.durationLabel(seconds: 4_500, locale: locale).isEmpty
        && !DesktopUsagePresentation.byteLabel(3_520_000_000, locale: locale).isEmpty
        && !DesktopUsagePresentation.countLabel(12_345, locale: locale).isEmpty
        && !DesktopUsagePresentation.resetLabel(presentation.resetAt, locale: locale).contains("T"),
      "Allowance values and reset dates must use localized human-readable labels")
    try check(
      DesktopAccountPresentation.initials(name: "Hatem Ragap", email: nil) == "HR"
        && DesktopAccountPresentation.initials(name: "Hatem", email: nil) == "HA"
        && DesktopAccountPresentation.initials(name: nil, email: "music@example.com") == "MU"
        && DesktopAccountPresentation.initials(name: nil, email: nil) == "M",
      "Account avatars must provide predictable, private initials")

    let invalidSnapshots = [
      usageFixture(processingRemaining: -1),
      usageFixture(processingRemaining: 0.5),
      usageFixture(processingRemaining: 54_001),
      usageFixture(processingRemaining: DesktopUsagePresentation.maximumSafeInteger + 1),
      usageFixture(storageLimit: .infinity),
      usageFixture(resetAt: "2026-11-01"),
      DesktopJSON.object([
        "processing": .object(["remaining_seconds": .number(1)]),
        "storage": .object(["remaining_bytes": .number(1), "limit_bytes": .number(1)]),
        "uploads": .object([
          "monthly_remaining_grants": .number(1), "monthly_grant_limit": .number(1),
        ]),
        "downloads": .object([
          "monthly_remaining_grants": .number(1), "monthly_grant_limit": .number(1),
        ]),
        "period": .object(["next_reset_at": .string("2026-11-01T00:00:00Z")]),
      ]),
    ]
    try check(
      invalidSnapshots.allSatisfy { DesktopUsagePresentation.parse($0) == nil },
      "Malformed, inconsistent, or unsafe allowance snapshots must be rejected")
  }

  static func usageFixture(
    processingRemaining: Double = 27_000,
    processingLimit: Double = 54_000,
    storageRemaining: Double = 3_520_000_000,
    storageLimit: Double = 5_000_000_000,
    resetAt: String = "2026-11-01T00:00:00.000Z"
  ) -> DesktopJSON {
    .object([
      "processing": .object([
        "remaining_seconds": .number(processingRemaining),
        "limit_seconds": .number(processingLimit),
      ]),
      "storage": .object([
        "remaining_bytes": .number(storageRemaining),
        "limit_bytes": .number(storageLimit),
      ]),
      "uploads": .object([
        "monthly_remaining_grants": .number(937),
        "monthly_grant_limit": .number(1_000),
      ]),
      "downloads": .object([
        "monthly_remaining_grants": .number(979),
        "monthly_grant_limit": .number(1_000),
      ]),
      "period": .object(["next_reset_at": .string(resetAt)]),
    ])
  }

  static func playbackAdvanceChecks() throws {
    try check(
      DesktopPlaybackAdvance.next(
        repeatMode: "Off", hasCurrent: true, currentVariant: .voice, queueCount: 0,
        selectedQueueIndex: 0) == .pause,
      "An empty queue without repeat must pause playback")
    for original in [false, true] {
      try check(
        DesktopPlaybackAdvance.next(
          repeatMode: "Track", hasCurrent: true,
          currentVariant: original ? .original : .voice, queueCount: 2,
          selectedQueueIndex: 1)
          == .replayCurrent(variant: original ? .original : .voice),
        "Repeat Track must replay the current audio variant")
    }
    try check(
      DesktopPlaybackAdvance.next(
        repeatMode: "Queue", hasCurrent: true, currentVariant: .original, queueCount: 0,
        selectedQueueIndex: 0) == .replayCurrent(variant: .original),
      "Repeat Queue must replay its only current track")
    for variant in [DesktopPlaybackVariant.voice, .original] {
      try check(
        DesktopPlaybackAdvance.next(
          repeatMode: "Queue", hasCurrent: true, currentVariant: variant, queueCount: 3,
          selectedQueueIndex: 2)
          == .playQueued(index: 2, requeueCurrent: true, variant: variant),
        "Repeat Queue must preserve the current audio variant while cycling multiple tracks")
    }
    try check(
      DesktopPlaybackAdvance.next(
        repeatMode: "Off", hasCurrent: true, currentVariant: .voice, queueCount: 2,
        selectedQueueIndex: 4)
        == .playQueued(index: 0, requeueCurrent: false, variant: .voice),
      "An invalid queue selection must fall back to the first queued track")
    try check(
      DesktopPlaybackAdvance.next(
        repeatMode: "Queue", hasCurrent: false, currentVariant: .voice, queueCount: 0,
        selectedQueueIndex: 0) == .pause,
      "Repeat Queue without a current or queued track must pause playback")
  }
  static func offlineStoragePolicyChecks() throws {
    try check(
      DesktopOfflineStoragePolicy.defaultBytes == 2_000_000_000,
      "Offline voices must default to two decimal gigabytes")
    for gigabytes in [Int64(1), 2, 64, DesktopOfflineStoragePolicy.maximumGigabytes] {
      let bytes = gigabytes * 1_000_000_000
      try check(
        DesktopOfflineStoragePolicy.validBudget(.number(Double(bytes))) == bytes
          && DesktopOfflineStoragePolicy.bytes(gigabytes: String(gigabytes)) == bytes
          && DesktopOfflineStoragePolicy.gigabytes(bytes) == String(gigabytes),
        "A whole-gigabyte budget must round-trip without changing units")
    }
    try check(
      DesktopOfflineStoragePolicy.bytes(gigabytes: "  2\n") == 2_000_000_000,
      "The budget input must tolerate surrounding whitespace")
    let invalidBudgets: [DesktopJSON?] = [
      nil, DesktopJSON.null, .number(0), .number(-1_000_000_000),
      .number(1_500_000_000), .number(1_000_000_001), .number(.infinity), .number(.nan),
      .number(Double((DesktopOfflineStoragePolicy.maximumGigabytes + 1) * 1_000_000_000)),
      .number(Double(Int64.max)), .string("2000000000"), .bool(true), .object([:]),
    ]
    for invalid in invalidBudgets {
      try check(
        DesktopOfflineStoragePolicy.validBudget(invalid) == nil,
        "Malformed, non-whole, or unsafe byte budgets must be rejected")
    }
    for invalid in [
      "", "   ", "0", "-1", "1.5", "2.0", "1e3", "two", "2 GB",
      String(DesktopOfflineStoragePolicy.maximumGigabytes + 1), String(Int64.max),
      String(repeating: "9", count: 100),
    ] {
      try check(
        DesktopOfflineStoragePolicy.bytes(gigabytes: invalid) == nil,
        "The budget editor must reject malformed, zero, fractional, or overflowing gigabytes")
    }
  }
  static func cacheBudgetOutcomeChecks() throws {
    for gigabytes in [Int64(1), 2, 64, DesktopOfflineStoragePolicy.maximumGigabytes] {
      let bytes = gigabytes * 1_000_000_000
      let outcome = try DesktopWorkspace.cacheBudgetOutcome(
        .object(["cache_bytes": .number(1_024), "budget_bytes": .number(Double(bytes))]))
      try check(
        outcome == DesktopCacheBudgetOutcome(cacheBytes: 1_024, budgetBytes: bytes),
        "Saving a cache budget must preserve both the current bytes and the selected limit")
    }
    let pinned = try DesktopWorkspace.cacheBudgetOutcome(
      .object(["cache_bytes": .number(2_000_000_001), "budget_bytes": .number(1_000_000_000)]))
    try check(
      pinned.cacheBytes == 2_000_000_001 && pinned.budgetBytes == 1_000_000_000,
      "Pinned bytes above a newly reduced budget must remain a valid settings result")
    for invalid in [
      DesktopJSON.null,
      .object(["cache_bytes": .number(0)]),
      .object(["budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .number(-1), "budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .number(0.5), "budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .string("0"), "budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .bool(false), "budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .number(Double(Int64.max)), "budget_bytes": .number(2_000_000_000)]),
      .object(["cache_bytes": .number(0), "budget_bytes": .number(0)]),
      .object(["cache_bytes": .number(0), "budget_bytes": .number(1_500_000_000)]),
      .object(["cache_bytes": .number(0), "budget_bytes": .string("2000000000")]),
      .object(["cache_bytes": .number(0), "budget_bytes": .bool(true)]),
      .object([
        "cache_bytes": .number(0),
        "budget_bytes": .number(
          Double((DesktopOfflineStoragePolicy.maximumGigabytes + 1) * 1_000_000_000)),
      ]),
      .object([
        "cache_bytes": .number(0), "budget_bytes": .number(2_000_000_000),
        "unexpected": .bool(true),
      ]),
    ] {
      do {
        _ = try DesktopWorkspace.cacheBudgetOutcome(invalid)
        throw TestFailure.failed("Malformed cache budget result accepted")
      } catch is TestFailure {
        throw TestFailure.failed("Malformed cache budget result accepted")
      } catch {}
    }
  }
  static func cacheClearOutcomeChecks() throws {
    let valid = DesktopJSON.object([
      "cleared_entries": .number(3), "cache_bytes": .number(1_024),
      "budget_bytes": .number(1_000_000_000),
    ])
    let outcome = try DesktopWorkspace.cacheClearOutcome(valid)
    try check(
      outcome
        == DesktopCacheClearOutcome(
          clearedEntries: 3, remainingBytes: 1_024, budgetBytes: 1_000_000_000),
      "Cache clear results must preserve bounded removal and remaining-byte counts")
    for gigabytes in [Int64(2), 64, DesktopOfflineStoragePolicy.maximumGigabytes] {
      let bytes = gigabytes * 1_000_000_000
      let custom = try DesktopWorkspace.cacheClearOutcome(
        .object([
          "cleared_entries": .number(0), "cache_bytes": .number(0),
          "budget_bytes": .number(Double(bytes)),
        ]))
      try check(
        custom
          == DesktopCacheClearOutcome(clearedEntries: 0, remainingBytes: 0, budgetBytes: bytes),
        "Cache clearing must accept the default and custom whole-gigabyte budgets")
    }
    let overBudget = try DesktopWorkspace.cacheClearOutcome(
      .object([
        "cleared_entries": .number(8_192), "cache_bytes": .number(1_000_000_001),
        "budget_bytes": .number(1_000_000_000),
      ]))
    try check(
      overBudget
        == DesktopCacheClearOutcome(
          clearedEntries: 8_192, remainingBytes: 1_000_000_001,
          budgetBytes: 1_000_000_000),
      "Pinned or unmanaged bytes above the eviction target must remain a valid clear result")
    let largestExactlyRepresentableInt64 = Double(Int64.max).nextDown
    let large = try DesktopWorkspace.cacheClearOutcome(
      .object([
        "cleared_entries": .number(0), "cache_bytes": .number(largestExactlyRepresentableInt64),
        "budget_bytes": .number(1_000_000_000),
      ]))
    try check(
      large.remainingBytes == Int64(exactly: largestExactlyRepresentableInt64),
      "Cache bytes must accept the largest safely convertible nonnegative Int64 value")
    for invalid in [
      DesktopJSON.object([
        "cleared_entries": .number(-1), "cache_bytes": .number(0),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1.5), "cache_bytes": .number(0),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(8_193), "cache_bytes": .number(0),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(-1),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(1.5),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(Double(Int64.max)),
        "budget_bytes": .number(1_000_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(0),
        "budget_bytes": .number(0),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(0),
        "budget_bytes": .number(1_500_000_000),
      ]),
      DesktopJSON.object([
        "cleared_entries": .number(1), "cache_bytes": .number(0),
        "budget_bytes": .number(1_000_000_000), "unexpected": .bool(true),
      ]),
    ] {
      do {
        _ = try DesktopWorkspace.cacheClearOutcome(invalid)
        throw TestFailure.failed("Malformed cache clear result accepted")
      } catch is TestFailure {
        throw TestFailure.failed("Malformed cache clear result accepted")
      } catch {}
    }
  }
  static func identityChecks() throws {
    let expected = NativeDiagnosticIdentity.expectedModelSha256
    let current = DiagnosticIdentity(
      softwareVersion: "0.1.0", runtimeScope: .packagedApp, expectedModelSha256: expected,
      packageInventorySha256: String(repeating: "a", count: 64))
    let encoded = try JSONEncoder().encode(current)
    let fields = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    try check(
      Set(fields.keys)
        == Set([
          "software_version", "runtime_scope", "expected_model_sha256", "package_inventory_sha256",
        ]),
      "Identity must encode only approved scalar wire fields")
    let decoded = try JSONDecoder().decode(DiagnosticIdentity.self, from: encoded)
    try check(
      decoded == current,
      "Wire-key identity must round-trip without relabeling")
    let development = DiagnosticIdentity(
      softwareVersion: "0.1.0-dev.1", runtimeScope: .development, expectedModelSha256: expected)
    let withoutHash =
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(development)) as! [String: Any]
    try check(
      withoutHash["package_inventory_sha256"] == nil,
      "Unknown inventory must be absent instead of fabricated")
    try check(
      current.recorderLabel.contains("Report recorder")
        && current.inventoryLabel.contains("aaaaaaaaaaaa"),
      "Displayed identity must label the recorder rather than all historical records")

    func decode(_ report: [String: Any]) throws -> LocalReport {
      let data = try JSONSerialization.data(withJSONObject: ["type": "result", "report": report])
      guard let value = try ControlEvent.decode(data, command: .snapshot).report else {
        throw TestFailure.failed("Identity fixture report absent")
      }
      return value
    }
    let base: [String: Any] = ["schema_version": 1, "availability": "available"]
    for unknown: Any? in [nil, NSNull()] {
      var report = base
      report["identity"] = unknown
      report["recent_events"] = [
        [
          "event": "stage_completed", "identity": unknown ?? NSNull(),
          "verified_model_sha256": NSNull(),
        ]
      ]
      report["app_ui_events"] = [
        [
          "at": "2026-10-02T00:00:00Z", "session_id": "fixture", "event": "app_started",
          "code": "NONE", "command": "none", "identity": unknown ?? NSNull(),
        ]
      ]
      report["app_setup_diagnostics"] = ["identity": unknown ?? NSNull()]
      let legacy = try decode(report)
      try check(
        legacy.identity == nil && legacy.recentEvents?.first?.identity == nil
          && legacy.appUiEvents?.first?.identity == nil
          && legacy.appSetupDiagnostics?.identity == nil,
        "Legacy absent/null identities must remain unknown across report sources")
      try check(
        legacy.recentEvents?.first?.verifiedModelSha256 == nil,
        "Legacy missing verification must not acquire the current expected model")
    }
    var old = fields
    old["software_version"] = "0.0.8"
    old["expected_model_sha256"] = String(repeating: "b", count: 64)
    old["package_inventory_sha256"] = NSNull()
    var report = base
    report["identity"] = fields
    report["recent_events"] = [
      [
        "event": "stage_completed", "identity": old,
        "verified_model_sha256": String(repeating: "b", count: 64),
      ]
    ]
    report["recent_errors"] = [["event": "tool_failed", "identity": old]]
    report["recent_warnings"] = [["event": "performance_alert", "identity": old]]
    report["app_ui_events"] = [
      [
        "at": "2026-10-02T00:00:00Z", "session_id": "fixture", "event": "app_started",
        "code": "NONE", "command": "none", "identity": old,
      ]
    ]
    report["app_setup_diagnostics"] = [
      "identity": old, "recent_events": [["event": "stage_completed", "identity": old]],
    ]
    let retained = try decode(report)
    try check(
      retained.identity == current
        && retained.recentEvents?.first?.identity?.softwareVersion == "0.0.8"
        && retained.recentErrors?.first?.identity?.softwareVersion == "0.0.8"
        && retained.recentWarnings?.first?.identity?.softwareVersion == "0.0.8"
        && retained.appUiEvents?.first?.identity?.softwareVersion == "0.0.8"
        && retained.appSetupDiagnostics?.identity?.softwareVersion == "0.0.8",
      "Report recorder and historical identities must decode independently")
    try check(
      retained.recentEvents?.first?.verifiedModelSha256 == String(repeating: "b", count: 64),
      "Verified model observations must stay distinct from current expected model")

    for (key, value) in [
      ("software_version", "/Users/private/version"), ("software_version", "0.1.0\n"),
      ("software_version", "1.2.3-" + String(repeating: "a", count: 60)),
      ("runtime_scope", "REMOTE"), ("expected_model_sha256", String(repeating: "A", count: 64)),
      ("expected_model_sha256", "token=fixture"),
      ("package_inventory_sha256", "https://private.invalid/audit"),
    ] {
      var invalidIdentity = fields
      invalidIdentity[key] = value
      var invalidReport = base
      invalidReport["identity"] = invalidIdentity
      do {
        _ = try decode(invalidReport)
        throw TestFailure.failed("Unsafe diagnostic identity accepted")
      } catch is TestFailure {
        throw TestFailure.failed("Unsafe diagnostic identity accepted")
      } catch {}
    }
    for nested in ["recent_events", "recent_errors", "recent_warnings"] {
      var invalidReport = base
      invalidReport[nested] = [
        ["event": "stage_completed", "verified_model_sha256": "/Users/private/model"]
      ]
      do {
        _ = try decode(invalidReport)
        throw TestFailure.failed("Unsafe verification accepted")
      } catch is AppValidation {}
    }
    var invalidSetup = base
    invalidSetup["app_setup_diagnostics"] = [
      "recent_events": [["event": "stage_completed", "verified_model_sha256": "fixture-secret"]]
    ]
    do {
      _ = try decode(invalidSetup)
      throw TestFailure.failed("Unsafe nested verification accepted")
    } catch is AppValidation {}
  }
  static func inventoryChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-inventory-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let resources = root.appendingPathComponent("Resources", isDirectory: true)
    try FileManager.default.createDirectory(
      at: resources, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = resources.appendingPathComponent("bundle-audit.json")
    let valid: [String: Any] = [
      "schema_version": 1, "architecture": "arm64", "includes_model_weights": false,
      "includes_worker_state": false,
      "files": [["path": "/Users/fixture/private-inventory", "private": "fixture-secret"]],
    ]
    func write(_ value: Any) throws -> Data {
      let data = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
      try data.write(to: file)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      return data
    }
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Missing inventory must leave fingerprint unknown")
    let bytes = try write(valid)
    let expected = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == expected,
      "Valid bounded inventory must fingerprint exact bytes without projecting entries")
    var largestShape = valid
    largestShape["files"] = Array(repeating: "fixture", count: 50_000)
    _ = try write(largestShape)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) != nil,
      "Inventory collection at the qualified limit must remain compatible")
    let padding = NativeDiagnosticIdentity.maxInventoryBytes - bytes.count
    var maximum = bytes
    maximum.append(Data(repeating: 32, count: padding))
    try maximum.write(to: file)
    let maximumDigest = SHA256.hash(data: maximum).map { String(format: "%02x", $0) }.joined()
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == maximumDigest,
      "Exactly 8 MiB of valid inventory must hash without rejecting the boundary")
    _ = try write(valid)
    let captured = DiagnosticIdentity(
      softwareVersion: "0.1.0", runtimeScope: .packagedApp,
      expectedModelSha256: NativeDiagnosticIdentity.expectedModelSha256,
      packageInventorySha256: NativeDiagnosticIdentity.inventoryDigest(resources: resources))
    let encoded = try String(decoding: JSONEncoder().encode(captured), as: UTF8.self)
    try check(
      !encoded.contains("/Users/fixture") && !encoded.contains("fixture-secret")
        && !encoded.contains("files"),
      "Identity encoding must exclude inventory paths, contents and unapproved fields")

    let app = root.appendingPathComponent("Owned.app", isDirectory: true)
    let appResources = app.appendingPathComponent("Contents/Resources", isDirectory: true)
    try FileManager.default.createDirectory(at: appResources, withIntermediateDirectories: true)
    let appInfo: [String: Any] = [
      "CFBundleIdentifier": "com.hatem.musicmute.local", "CFBundleShortVersionString": "0.1.7",
      "CFBundlePackageType": "APPL",
    ]
    try PropertyListSerialization.data(fromPropertyList: appInfo, format: .xml, options: 0).write(
      to: app.appendingPathComponent("Contents/Info.plist"))
    guard let bundle = Bundle(url: app) else {
      throw TestFailure.failed("Owned bundle fixture unavailable")
    }
    let missing = NativeDiagnosticIdentity.resolve(bundle: bundle)
    try check(
      missing.softwareVersion == "0.1.7" && missing.runtimeScope == .packagedApp
        && missing.packageInventorySha256 == nil,
      "Missing inventory must keep actual bundle version and packaged scope")
    let fallbackJournal = UIJournal(
      logsRoot: root.appendingPathComponent("fallback-logs"), identity: missing)
    fallbackJournal.record(.appStarted)
    fallbackJournal.flushForTesting()
    try check(
      fallbackJournal.availableForTesting,
      "Missing inventory must not block the app journal or create setup failure")
    try bytes.write(to: appResources.appendingPathComponent("bundle-audit.json"))
    let packaged = NativeDiagnosticIdentity.resolve(bundle: bundle)
    try check(
      packaged.packageInventorySha256 == expected
        && packaged.expectedModelSha256 == NativeDiagnosticIdentity.expectedModelSha256,
      "Packaged identity must use only the running bundle's Resources and expected pin")
    try check(
      NativeDiagnosticIdentity.current.runtimeScope == .development
        && NativeDiagnosticIdentity.current.packageInventorySha256 == nil,
      "Bare source test executable must not claim packaged inventory")

    for (key, value) in [
      ("schema_version", true as Any), ("schema_version", 2 as Any),
      ("architecture", "x86_64" as Any), ("includes_model_weights", true as Any),
      ("includes_model_weights", 0 as Any), ("includes_worker_state", true as Any),
      ("files", [] as [Any]), ("files", Array(repeating: "fixture", count: 50_001) as Any),
    ] {
      var malformed = valid
      malformed[key] = value
      _ = try write(malformed)
      try check(
        NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
        "Malformed inventory shape must not claim a fingerprint")
    }
    _ = try write("fixture-secret")
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Scalar inventory must not claim a fingerprint")
    try Data("{not-json}".utf8).write(to: file)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Malformed JSON must not block or produce inventory identity")
    try Data().write(to: file)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Empty inventory must not claim a fingerprint")
    try Data(repeating: 32, count: NativeDiagnosticIdentity.maxInventoryBytes + 1).write(to: file)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Inventory beyond 8 MiB must be refused before reading")
    _ = try write(valid)
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Unreadable inventory must leave the fingerprint absent")
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o620], ofItemAtPath: file.path)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Writable inventory must be refused")
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    let linkPath = root.appendingPathComponent("hardlink.json")
    guard link(file.path, linkPath.path) == 0 else {
      throw TestFailure.failed("Inventory hardlink fixture unavailable")
    }
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Hardlinked inventory must be refused")
    try FileManager.default.removeItem(at: linkPath)
    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(
      at: file, withDestinationURL: appResources.appendingPathComponent("bundle-audit.json"))
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Symlink inventory must be refused")
    try FileManager.default.removeItem(at: file)
    let linkedResources = root.appendingPathComponent("LinkedResources")
    try FileManager.default.createSymbolicLink(
      at: linkedResources, withDestinationURL: appResources)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: linkedResources) == nil,
      "Symlink Resources must be refused")
    try FileManager.default.setAttributes([.posixPermissions: 0o720], ofItemAtPath: resources.path)
    try check(
      NativeDiagnosticIdentity.inventoryDigest(resources: resources) == nil,
      "Writable Resources must be refused")
  }
  static func inventoryReplacementChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-inventory-replacement-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let bytes = Data(
      #"{"schema_version":1,"architecture":"arm64","includes_model_weights":false,"includes_worker_state":false,"files":["fixture"]}"#
        .utf8)
    func fixture(_ name: String) throws -> URL {
      let resources = root.appendingPathComponent(name, isDirectory: true)
      try FileManager.default.createDirectory(
        at: resources, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try bytes.write(to: resources.appendingPathComponent("bundle-audit.json"))
      return resources
    }
    let untouched = try fixture("untouched")
    var baselineHookRan = false
    let baseline = NativeDiagnosticIdentity.inventoryDigestForTesting(resources: untouched) {
      baselineHookRan = true
    }
    try check(
      baselineHookRan
        && baseline == SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
      "Unchanged inventory must remain available through the final validation point")

    func replaced(
      _ name: String, _ change: @escaping (URL, URL) throws -> Void
    ) throws {
      let resources = try fixture(name)
      let file = resources.appendingPathComponent("bundle-audit.json")
      var hookRan = false
      var mutationFailure: Error?
      let result = NativeDiagnosticIdentity.inventoryDigestForTesting(resources: resources) {
        hookRan = true
        do { try change(resources, file) } catch { mutationFailure = error }
      }
      if let mutationFailure { throw mutationFailure }
      try check(
        hookRan && result == nil,
        "Inventory fingerprint must be omitted after final replacement: \(name)")
    }
    try replaced("resources-writable") { resources, _ in
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o720], ofItemAtPath: resources.path)
    }
    try replaced("resources-symlink") { resources, _ in
      let stashed = root.appendingPathComponent("stashed-directory", isDirectory: true)
      try FileManager.default.moveItem(at: resources, to: stashed)
      try FileManager.default.createSymbolicLink(at: resources, withDestinationURL: stashed)
    }
    try replaced("resources-new-directory") { resources, _ in
      let stashed = root.appendingPathComponent("stashed-original-directory", isDirectory: true)
      try FileManager.default.moveItem(at: resources, to: stashed)
      try FileManager.default.createDirectory(
        at: resources, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try bytes.write(to: resources.appendingPathComponent("bundle-audit.json"))
    }
    try replaced("inventory-new-file") { _, file in
      try FileManager.default.moveItem(
        at: file, to: root.appendingPathComponent("stashed-original-file"))
      try bytes.write(to: file)
    }
    try replaced("inventory-symlink") { _, file in
      let stashed = root.appendingPathComponent("stashed-link-target")
      try FileManager.default.moveItem(at: file, to: stashed)
      try FileManager.default.createSymbolicLink(at: file, withDestinationURL: stashed)
    }
    try replaced("inventory-writable") { _, file in
      try FileManager.default.setAttributes([.posixPermissions: 0o620], ofItemAtPath: file.path)
    }
    try replaced("inventory-missing") { _, file in
      try FileManager.default.moveItem(
        at: file, to: root.appendingPathComponent("stashed-missing-file"))
    }
  }
  static func readinessChecks() throws {
    let readyStatus = try ControlEvent.decode(Data(status.utf8), command: .status).status
    let incompleteJSON = status.replacingOccurrences(
      of: "\"ready\":true", with: "\"ready\":false"
    ).replacingOccurrences(of: "\"model_ready\":true", with: "\"model_ready\":false")
    let incompleteStatus = try ControlEvent.decode(
      Data(incompleteJSON.utf8), command: .status
    ).status
    let unchecked = SetupPresentation(status: nil, activeCommand: nil, hasFailure: false)
    try check(
      unchecked.runtime == .notChecked && unchecked.model == .notChecked
        && unchecked.chrome == .notChecked && !unchecked.ready,
      "Absent status is unknown, not a confirmed setup failure")
    try check(
      unchecked.actionLabel == "Prepare my Mac" && ReadinessState.notChecked.label == "Not checked",
      "Unchecked readiness must offer setup with an honest row value")

    for command in [AppCommand.status, .setup] {
      let expectedState: ReadinessState = command == .status ? .checking : .preparing
      let expectedLabel = command == .status ? "Checking readiness…" : "Preparing your Mac…"
      // Cover the old ready status, the clear at command start and the arriving terminal result.
      for value in [readyStatus, nil, incompleteStatus] {
        let running = SetupPresentation(status: value, activeCommand: command, hasFailure: false)
        try check(
          running.runtime == expectedState && running.model == expectedState
            && running.chrome == expectedState,
          "In-flight readiness must not display stale Ready or Needs setup")
        try check(
          !running.ready && !running.needsChromeRepair && running.actionLabel == expectedLabel,
          "In-flight setup primary must describe the active operation")
      }
      try check(
        expectedState.label == (command == .status ? "Checking" : "Preparing")
          && expectedState.symbol == "ellipsis.circle",
        "Visible and accessible row state must describe work in progress")
    }

    let ready = SetupPresentation(status: readyStatus, activeCommand: nil, hasFailure: false)
    try check(
      ready.ready && ready.runtime == .ready && ready.model == .ready && ready.chrome == .ready
        && ready.actionLabel == "Check readiness",
      "A successful terminal result must restore verified readiness")
    let incomplete = SetupPresentation(
      status: incompleteStatus, activeCommand: nil, hasFailure: false)
    try check(
      !incomplete.ready && incomplete.runtime == .ready && incomplete.model == .needsSetup
        && incomplete.chrome == .ready && incomplete.actionLabel == "Prepare my Mac",
      "Only confirmed incomplete fields should report Needs setup after completion")

    let repairJSON = status.replacingOccurrences(
      of: "\"ready\":true", with: "\"ready\":false"
    ).replacingOccurrences(
      of: "\"extension_registered\":true", with: "\"extension_registered\":false")
    let repairStatus = try ControlEvent.decode(Data(repairJSON.utf8), command: .status).status
    let repair = SetupPresentation(status: repairStatus, activeCommand: nil, hasFailure: false)
    try check(
      repair.needsChromeRepair && repair.runtime == .ready && repair.model == .ready
        && repair.chrome == .needsSetup && repair.actionLabel == "Repair Chrome connection",
      "Confirmed Chrome-only failure must keep the repair action")

    let failed = SetupPresentation(status: nil, activeCommand: nil, hasFailure: true)
    try check(
      failed.runtime == .notChecked && failed.model == .notChecked && failed.chrome == .notChecked
        && !failed.ready && failed.actionLabel == "Retry setup",
      "Failed or cancelled checks without a result must not invent readiness")
    for command in [AppCommand.snapshot, .export] {
      let inspecting = SetupPresentation(
        status: readyStatus, activeCommand: command, hasFailure: false)
      try check(
        inspecting.ready && inspecting.runtime == .ready && inspecting.model == .ready
          && inspecting.chrome == .ready && inspecting.actionLabel == "Check readiness",
        "Diagnostics operations must not replace existing verified readiness with setup work")
    }
  }
  static func parserChecks() throws {
    let result = try ControlEvent.decode(Data(status.utf8), command: .status)
    try check(
      result.status?.complete == true,
      "Status must require runtime/model/registration and ARM64 local-only support")
    let invalidPlatform = status.replacingOccurrences(of: "arm64", with: "x86_64")
    let intel = try ControlEvent.decode(Data(invalidPlatform.utf8), command: .status)
    try check(intel.status?.complete == false, "Intel must not be ready")
    let invalid = [
      status.replacingOccurrences(of: "\"protocol_version\":1", with: "\"protocol_version\":2"),
      "{\"type\":\"result\",\"report\":{}}",
      "{\"type\":\"progress\",\"phase\":\"model\",\"percent\":101,\"label\":\"Download\"}",
      "{\"type\":\"error\",\"error_code\":\"https://invalid.example/token\"}",
    ]
    for (index, json) in invalid.enumerated() {
      do {
        _ = try ControlEvent.decode(
          Data(json.utf8), command: index == 1 ? .snapshot : index == 2 ? .setup : .status)
        throw TestFailure.failed("Malformed message accepted")
      } catch is AppValidation {}
    }
    try check(measuredBytesLabel(Double.infinity) == "Not sampled", "Infinite RSS must not trap")
    try check(measuredBytesLabel(1e100) == "Not sampled", "Huge RSS must not trap")
    try check(
      displayCode("/Users/private/error") == "UNKNOWN_ERROR", "Do not expose raw paths as codes")
  }
  static func setupDiagnosticsChecks() throws {
    func decode(_ setup: [String: Any]?) throws -> LocalReport {
      var report: [String: Any] = ["schema_version": 1, "availability": "available"]
      if let setup { report["app_setup_diagnostics"] = setup }
      let data = try JSONSerialization.data(withJSONObject: ["type": "result", "report": report])
      guard let value = try ControlEvent.decode(data, command: .snapshot).report else {
        throw TestFailure.failed("Setup report fixture was not decoded")
      }
      return value
    }
    let oldError: [String: Any] = [
      "component": "companion", "severity": "error", "event": "setup_failed",
      "code": "TOOL_TIMEOUT", "sequence": 1, "session_id": "fixture",
    ]
    let oldWarning: [String: Any] = [
      "component": "companion", "severity": "warning", "event": "performance_alert",
      "code": "RESOURCE_RSS_GROWTH", "sequence": 2, "session_id": "fixture",
    ]
    let successfulRetry = (3...14).map { sequence -> [String: Any] in
      [
        "component": "companion", "severity": "info", "event": "stage_completed",
        "sequence": sequence, "session_id": "fixture",
      ]
    }
    let report = try decode([
      "availability": "available", "recent_errors": [oldError], "recent_warnings": [oldWarning],
      "recent_events": successfulRetry,
    ])
    guard let setup = report.appSetupDiagnostics else {
      throw TestFailure.failed("Retained setup evidence must be decoded")
    }
    try check(
      setup.events.count == 6 && setup.events.first?.sequence == 14
        && setup.events.last?.sequence == 9,
      "Successful retry activity must stay bounded and newest first")
    try check(
      setup.errors.count == 1 && setup.errors.first?.displayErrorCode == "TOOL_TIMEOUT"
        && setup.warnings.count == 1
        && setup.warnings.first?.displayErrorCode == "RESOURCE_RSS_GROWTH",
      "An old failure and warning must remain visible apart from later successful activity")
    try check(
      !setup.events.contains { $0.sequence == 1 || $0.sequence == 2 },
      "Alert retention must not depend on alerts remaining in the recent activity tail")
    try check(
      report.errors.isEmpty && report.warnings.isEmpty,
      "Setup alerts must not be relabeled as processing alerts")

    let legacyFields: [[String: Any]] = [
      [:],
      ["recent_errors": NSNull(), "recent_warnings": NSNull(), "recent_events": NSNull()],
      ["future_optional_field": ["safe_marker": true]],
    ]
    for fields in legacyFields {
      let legacy = try decode(fields).appSetupDiagnostics
      try check(
        legacy?.errors.isEmpty == true && legacy?.warnings.isEmpty == true
          && legacy?.events.isEmpty == true && legacy?.hasValidCollectionBounds == true,
        "Absent/null legacy arrays and compatible optional additions must remain accepted")
    }
    let withoutSetup = try decode(nil)
    try check(
      withoutSetup.appSetupDiagnostics == nil,
      "A legacy report without setup evidence must remain accepted")

    let alerts = (0..<12).map { sequence -> [String: Any] in
      [
        "component": "companion", "event": "setup_failed", "code": "TOOL_TIMEOUT",
        "sequence": sequence,
      ]
    }
    let bounded = try decode([
      "recent_errors": alerts, "recent_warnings": alerts, "recent_events": successfulRetry,
    ]).appSetupDiagnostics
    try check(
      bounded?.errors.count == 8 && bounded?.errors.first?.sequence == 11
        && bounded?.errors.last?.sequence == 4 && bounded?.warnings.count == 8
        && bounded?.warnings.first?.sequence == 11 && bounded?.warnings.last?.sequence == 4,
      "Each retained alert list must be independently bounded and newest first")

    let unsafe: [String: Any] = [
      "component": "/fixture/private", "event": "https://invalid.example/private",
      "code": "cookie=fixture-secret",
    ]
    let projected = try decode(["recent_errors": [unsafe]]).appSetupDiagnostics?.errors.first
    try check(
      projected?.displayName == "Event" && projected?.displayComponent == "UNKNOWN_ERROR"
        && projected?.displayErrorCode == "UNKNOWN_ERROR",
      "Setup alert rendering must safely project names/components/codes")

    let job: [String: Any] = ["job_id": "fixture", "state": "ready"]
    let maximum = try decode([
      "recent_errors": Array(repeating: oldError, count: 50),
      "recent_warnings": Array(repeating: oldWarning, count: 50),
      "recent_events": Array(repeating: oldError, count: 500),
      "jobs": Array(repeating: job, count: 100),
    ]).appSetupDiagnostics
    try check(
      maximum?.hasValidCollectionBounds == true && maximum?.errors.count == 8
        && maximum?.warnings.count == 8 && maximum?.events.count == 6,
      "Allowed nested collection maxima must decode while presentation stays bounded")
    for (field, count, value) in [
      ("recent_errors", 51, oldError), ("recent_warnings", 51, oldWarning),
      ("recent_events", 501, oldError), ("jobs", 101, job),
    ] {
      do {
        _ = try decode([field: Array(repeating: value, count: count)])
        throw TestFailure.failed("Oversized nested setup collection accepted")
      } catch is AppValidation {}
    }
  }
  static func desktopDiagnosticsChecks() throws {
    func decode(_ desktop: [String: Any]?) throws -> LocalReport {
      var report: [String: Any] = ["schema_version": 1, "availability": "available"]
      if let desktop { report["app_desktop_diagnostics"] = desktop }
      let data = try JSONSerialization.data(withJSONObject: ["type": "result", "report": report])
      guard let value = try ControlEvent.decode(data, command: .snapshot).report else {
        throw TestFailure.failed("Desktop evidence absent")
      }
      return value
    }
    let error: [String: Any] = [
      "component": "companion", "severity": "error", "event": "job_failed",
      "code": "TOOL_TIMEOUT", "sequence": 1,
      "verified_model_sha256": String(repeating: "a", count: 64),
    ]
    let warning: [String: Any] = [
      "component": "engine", "severity": "warning", "event": "performance_alert",
      "code": "RESOURCE_RSS_GROWTH", "sequence": 2,
    ]
    let successful = (3...14).map { sequence -> [String: Any] in
      ["component": "companion", "event": "stage_completed", "sequence": sequence]
    }
    let report = try decode([
      "availability": "available", "counts": ["job_failed": 1, "job_ready": 1],
      "peaks": ["rss_bytes": 268_435_456, "cpu_percent": 42.5],
      "recent_errors": [error], "recent_warnings": [warning], "recent_events": successful,
    ])
    guard let desktop = report.appDesktopDiagnostics else {
      throw TestFailure.failed("Desktop evidence was not decoded")
    }
    try check(
      desktop.counts?["job_ready"] == 1 && desktop.peaks?["cpu_percent"] == 42.5
        && desktop.errors.first?.displayErrorCode == "TOOL_TIMEOUT"
        && desktop.warnings.first?.displayErrorCode == "RESOURCE_RSS_GROWTH"
        && desktop.events.count == 6 && desktop.events.first?.sequence == 14,
      "Desktop counts/measurements and retained alerts must remain separate from latest successful activity"
    )
    try check(
      report.appSetupDiagnostics == nil && report.errors.isEmpty && report.events.isEmpty,
      "Desktop evidence must not be mislabeled as setup or Chrome processing evidence")
    let legacyReport = try decode(nil)
    try check(
      legacyReport.appDesktopDiagnostics == nil,
      "Existing reports without desktop evidence must remain compatible")
    let job: [String: Any] = ["job_id": "fixture", "state": "ready"]
    for (field, count, value) in [
      ("recent_errors", 51, error), ("recent_warnings", 51, warning),
      ("recent_events", 501, error), ("jobs", 101, job),
    ] {
      do {
        _ = try decode([field: Array(repeating: value, count: count)])
        throw TestFailure.failed("Oversized desktop collection accepted")
      } catch is AppValidation {}
    }
    for field in ["counts", "peaks"] {
      let entries = Dictionary(uniqueKeysWithValues: (0..<65).map { ("metric_\($0)", 1) })
      do {
        _ = try decode([field: entries])
        throw TestFailure.failed("Oversized desktop metric dictionary accepted")
      } catch is AppValidation {}
    }
    for entries: [String: Any] in [
      ["counts": ["job_ready": -1]], ["peaks": ["rss_bytes": -1]],
      ["counts": ["/fixture/private": 1]], ["peaks": ["cookie=secret": 1]],
      ["recent_events": [["verified_model_sha256": "invalid"]]],
    ] {
      do {
        _ = try decode(entries)
        throw TestFailure.failed("Unsafe desktop evidence accepted")
      } catch is AppValidation {}
    }
    let unsafe = try decode([
      "recent_errors": [
        [
          "component": "/private/fixture", "event": "https://example.invalid/private",
          "code": "cookie=fixture-secret", "recorded_at": "/private/fixture-user-data",
        ]
      ]
    ]).appDesktopDiagnostics?.errors.first
    try check(
      unsafe?.displayName == "Event" && unsafe?.displayComponent == "UNKNOWN_ERROR"
        && unsafe?.displayErrorCode == "UNKNOWN_ERROR" && unsafe?.displayTime == nil,
      "Untrusted desktop alert display must project safe identifiers and dates without raw paths")
  }
  static func pathChecks() throws {
    let parent = URL(fileURLWithPath: "/tmp/musicmute-root", isDirectory: true)
    try check(
      LocalPaths.descendant("/tmp/musicmute-root/file", of: parent) != nil,
      "Child path should be allowed")
    try check(
      LocalPaths.descendant("/tmp/musicmute-root-other/file", of: parent) == nil,
      "Sibling prefixes must not match")
    try check(
      LocalPaths.descendant("/tmp/musicmute-root/../outside", of: parent) == nil,
      "Traversal must not match")
    try check(
      LocalPaths.descendant("https://example.invalid/report.json", of: parent) == nil,
      "Remote path must not match")
    try check(LocalPaths.isSetupURL(URL(string: "musicmute-local://setup")!), "Setup URL must work")
    for value in [
      "musicmute-local://setup?command=run", "musicmute-local://setup/other",
      "musicmute-local://setup:99", "musicmute-local://user@setup", "https://setup",
    ] {
      try check(
        !LocalPaths.isSetupURL(URL(string: value)!),
        "Only exact setup navigation should be accepted")
    }
    try check(
      LocalPaths.isAccountURL(URL(string: "musicmute-local://account")!),
      "The account return URL must work without sign-in credentials")
    for value in [
      "musicmute-local://account/", "musicmute-local://account/other",
      "musicmute-local://account?", "musicmute-local://account?code=fixture-code",
      "musicmute-local://account#", "musicmute-local://account#fragment",
      "musicmute-local://account:99", "musicmute-local://user@account",
      "musicmute-local://user:password@account", "musicmute-local://setup",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1", "https://account",
    ] {
      try check(
        !LocalPaths.isAccountURL(URL(string: value)!),
        "Only exact credential-free account navigation should be accepted")
    }
    let home = URL(fileURLWithPath: "/Users/fixture", isDirectory: true)
    let system = URL(fileURLWithPath: "/Applications/MusicMute Local.app", isDirectory: true)
    let user = home.appendingPathComponent("Applications/MusicMute Local.app", isDirectory: true)
    let build = URL(
      fileURLWithPath: "/Users/fixture/work/output/macos/build/MusicMute Local.app",
      isDirectory: true)
    try check(
      InstalledAppLocation.isInstalledCopy(system, home: home)
        && InstalledAppLocation.isInstalledCopy(user, home: home),
      "The extension handoff may open only the system or home Applications copy")
    try check(
      !InstalledAppLocation.isInstalledCopy(build, home: home)
        && !InstalledAppLocation.isInstalledCopy(
          URL(fileURLWithPath: "/Applications/MusicMute Local.app.backup", isDirectory: true),
          home: home),
      "Build folders and lookalike names must not receive the extension handoff")
    try check(
      InstalledAppLocation.preferredInstalledCopy(home: home, fileExists: { $0 == system.path })?
        .path == system.path
        && InstalledAppLocation.preferredInstalledCopy(
          home: home, fileExists: { $0 == user.path }
        )?.path == user.path
        && InstalledAppLocation.preferredInstalledCopy(home: home, fileExists: { _ in false })
          == nil,
      "An installed copy is chosen from /Applications before the home Applications folder")
  }
  static func productLinkChecks() throws {
    let destinations = MusicMuteProductLinks.allCases.map(\.url)
    try check(
      destinations.count == 3 && destinations.allSatisfy(MusicMuteProductLinks.isAllowed),
      "Product discovery links must remain exact, HTTPS, credential-free destinations")
    try check(
      MusicMuteProductLinks.webApp.url.absoluteString == "https://app.music-mute.com"
        && MusicMuteProductLinks.googlePlay.url.absoluteString
          == "https://play.google.com/store/apps/details?id=com.hatem.musicmute"
        && MusicMuteProductLinks.downloads.url.absoluteString
          == "https://music-mute.com/#downloads",
      "Product discovery links must retain their reviewed public destinations")
    for value in [
      "http://app.music-mute.com", "https://user@app.music-mute.com",
      "https://app.music-mute.com/private", "https://app.music-mute.com?token=secret",
      "https://play.google.com/store/apps/details?id=com.example.other",
      "https://music-mute.com/#other",
    ] {
      try check(
        !MusicMuteProductLinks.isAllowed(URL(string: value)!),
        "Unreviewed or credential-bearing product links must be refused")
    }
  }
  static func cloudHandoffChecks() throws {
    let valid = URL(string: "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=364")!
    guard let handoff = DesktopCloudHandoff(url: valid) else {
      throw TestFailure.failed("A bounded canonical cloud handoff must be accepted")
    }
    try check(
      handoff.sourceURL == "https://www.youtube.com/watch?v=AbCdEfGh_-1",
      "Case-sensitive source identity must survive the handoff")
    try check(handoff.estimatedDurationSeconds == 364, "The advisory duration must be retained")
    let maximum = URL(string: "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=1200")!
    try check(
      DesktopCloudHandoff(url: maximum)?.estimatedDurationSeconds == 1200,
      "The full twenty-minute handoff must be accepted")
    for value in [
      "https://cloud?video_id=AbCdEfGh_-1", "musicmute-local://cloud/path?video_id=AbCdEfGh_-1",
      "musicmute-local://cloud:80?video_id=AbCdEfGh_-1",
      "musicmute-local://user@cloud?video_id=AbCdEfGh_-1",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1#fragment",
      "musicmute-local://cloud?video_id=short",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&video_id=AbCdEfGh_-1",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&token=private",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=0",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=1201",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=1.5",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=01",
      "musicmute-local://cloud?video_id=AbCdEfGh_-1&duration_seconds=1&duration_seconds=2",
    ] {
      try check(
        DesktopCloudHandoff(url: URL(string: value)!) == nil,
        "Malformed or credential-bearing cloud handoffs must be rejected")
    }
    let scope = DesktopSessionScope(firebaseUid: "fixture-owner", generation: UUID())
    let confirmation = DesktopCloudConfirmation(
      sourceURL: handoff.sourceURL, sourceFile: nil, accountScope: scope,
      estimatedDurationSeconds: 364)
    try check(
      confirmation.matches(url: handoff.sourceURL, file: nil, scope: scope, hasRights: true),
      "Confirmed unchanged source and account must match")
    try check(
      !confirmation.matches(
        url: "https://www.youtube.com/watch?v=Different_1", file: nil, scope: scope, hasRights: true
      ), "Changing source must invalidate cloud confirmation")
    try check(
      !confirmation.matches(
        url: handoff.sourceURL, file: nil,
        scope: DesktopSessionScope(firebaseUid: scope.firebaseUid, generation: UUID()),
        hasRights: true), "Account/session changes must invalidate cloud confirmation")
    try check(
      !confirmation.matches(url: handoff.sourceURL, file: nil, scope: scope, hasRights: false),
      "Rights must still be confirmed at submission")
  }
  static func youtubeSetupChecks() throws {
    let partialJSON = status.replacingOccurrences(
      of: "\"max_duration_seconds\":900",
      with:
        "\"max_duration_seconds\":900,\"downloader_ready\":true,\"javascript_ready\":false,\"token_provider_ready\":false,\"youtube_ready\":false,\"local_processing_ready\":true,\"components\":[{\"component\":\"javascript\",\"state\":\"missing\",\"error_code\":\"JAVASCRIPT_RUNTIME_UNAVAILABLE\"}]"
    )
    let parsed = try ControlEvent.decode(Data(partialJSON.utf8), command: .status).status
    let presentation = SetupPresentation(status: parsed, activeCommand: nil, hasFailure: false)
    try check(
      presentation.ready && presentation.runtime == .ready,
      "YouTube tool failure must not erase local processing readiness")
    try check(
      presentation.javascript == .needsSetup && presentation.tokenProvider == .needsSetup,
      "The failed setup components must remain actionable")
    try check(
      presentation.needsYouTubeRepair && presentation.actionLabel == "Check YouTube tools",
      "Partial readiness must offer a tool check without disabling local work")
    try check(
      presentation.completionMessage
        == "Local processing is ready. Some YouTube tools need attention; review the setup checks.",
      "A failed YouTube health check must not claim that all tools are prepared")
    for value in [
      partialJSON.replacingOccurrences(
        of: "\"component\":\"javascript\"", with: "\"component\":\"arbitrary\""),
      partialJSON.replacingOccurrences(of: "\"state\":\"missing\"", with: "\"state\":\"unknown\""),
      partialJSON.replacingOccurrences(
        of: "JAVASCRIPT_RUNTIME_UNAVAILABLE", with: "https://private.invalid/token"),
    ] {
      do {
        _ = try ControlEvent.decode(Data(value.utf8), command: .status)
        throw TestFailure.failed("Unbounded or unsafe component state accepted")
      } catch is AppValidation {}
    }
    try check(
      DesktopAuthFailure.service("SOURCE_CHALLENGE_FAILED").message.contains("Deno"),
      "JavaScript failures must offer runtime/solver repair")
    try check(
      DesktopAuthFailure.service("SOURCE_TOKEN_REQUIRED").message.contains("token provider"),
      "Missing tokens must offer provider checks")
    try check(
      DesktopAuthFailure.service("ACQUISITION_COOLDOWN").message.contains("cooldown"),
      "Bot refusal must not be described as missing runtime")
    try check(
      DesktopAuthFailure.service("PROCESSING_ALLOWANCE_EXHAUSTED").message.contains("allowance"),
      "Quota failures must name the account allowance")
  }

  static func runtimeBootstrapChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-runtime-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let release = root.appendingPathComponent("release", isDirectory: true)
    try FileManager.default.createDirectory(
      at: release, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let executionMarker = root.appendingPathComponent("external-runtime-executed")
    let escapedMarker = executionMarker.path.replacingOccurrences(of: "'", with: "'\\''")
    let holdChild = root.appendingPathComponent("hold-external-runtime")
    let childEntered = root.appendingPathComponent("external-runtime-waiting")
    let releaseChild = root.appendingPathComponent("release-external-runtime")
    let escapedHoldChild = holdChild.path.replacingOccurrences(of: "'", with: "'\\''")
    let escapedChildEntered = childEntered.path.replacingOccurrences(of: "'", with: "'\\''")
    let escapedReleaseChild = releaseChild.path.replacingOccurrences(of: "'", with: "'\\''")
    let nodeFixture = Data(
      """
      #!/bin/sh
      /usr/bin/touch '\(escapedMarker)'
      if [ -f '\(escapedHoldChild)' ]; then
        /usr/bin/touch '\(escapedChildEntered)'
        while [ ! -f '\(escapedReleaseChild)' ]; do /bin/sleep 0.01; done
      fi
      printf '%s\\n' '\(status)'
      """.utf8)

    let regular: [(String, Data, Bool, Bool)] = [
      ("runtime/runtime/node/bin/node", nodeFixture, true, true),
      ("runtime/runtime/python/bin/python3.13", Data("python-fixture".utf8), true, true),
      ("runtime/runtime/bin/ffmpeg", Data("ffmpeg-fixture".utf8), true, true),
      ("runtime/runtime/bin/ffprobe", Data("ffprobe-fixture".utf8), true, true),
      ("runtime/tools/youtube/bin/deno", Data("deno-fixture".utf8), true, true),
      (
        "runtime/runtime/python/lib/libfixture.dylib", Data("signed-library".utf8), false,
        true
      ),
    ]
    var files = [[String: Any]]()
    var installedBytes: Int64 = 0
    for (path, bytes, executable, codeSigned) in regular {
      let file = release.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try bytes.write(to: file)
      try FileManager.default.setAttributes(
        [.posixPermissions: executable ? 0o500 : 0o400], ofItemAtPath: file.path)
      installedBytes += Int64(bytes.count)
      files.append([
        "path": path, "type": "file", "bytes": bytes.count,
        "sha256": RuntimeDigest.data(bytes), "executable": executable,
        "code_signed": codeSigned,
      ])
    }
    let pythonLink = "runtime/runtime/python/bin/python3"
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "python3.13")
    files.append(["path": pythonLink, "type": "symlink", "link_target": "python3.13"])
    let pythonLibLink = "runtime/runtime/python/current-lib"
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLibLink).path,
      withDestinationPath: "lib")
    files.append(["path": pythonLibLink, "type": "symlink", "link_target": "lib"])
    let pythonLibLinkChain = "runtime/runtime/python/linked-lib"
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLibLinkChain).path,
      withDestinationPath: "current-lib")
    files.append([
      "path": pythonLibLinkChain, "type": "symlink", "link_target": "current-lib",
    ])

    func bootstrapData(
      files: [[String: Any]], runtimeID: String = "macos-arm64-1.0.0",
      url: String = "https://downloads.example.com/runtime.zip",
      archiveBytes: Int64 = 512, archiveSHA256: String = String(repeating: "a", count: 64),
      installedByteCount: Int64? = nil
    )
      throws -> Data
    {
      try JSONSerialization.data(
        withJSONObject: [
          "schema_version": 1,
          "runtime": [
            "id": runtimeID, "api_version": 1, "platform": "darwin",
            "arch": "arm64", "url": url, "archive_format": "zip",
            "archive_sha256": archiveSHA256, "archive_bytes": archiveBytes,
            "installed_bytes": installedByteCount ?? installedBytes,
            "download_hosts": ["downloads.example.com", "cdn.example.com"],
            "signing": ["mode": "ad_hoc"], "files": files,
          ],
        ], options: [.sortedKeys])
    }

    let manifestData = try bootstrapData(files: files)
    let document = try RuntimeBootstrapDocument.decodeValidated(manifestData)
    try check(
      document.runtime.files.count == files.count
        && document.runtime.signing.mode == "ad_hoc"
        && document.runtime.installedBytes == installedBytes,
      "A complete pinned runtime bootstrap manifest must decode")

    let downloadConfiguration = URLSessionConfiguration.ephemeral
    downloadConfiguration.protocolClasses = [RuntimeDownloadFixtureProtocol.self]
    func transportManifest(_ bytes: Data, runtimeID: String = "macos-arm64-transport") throws
      -> RuntimeBootstrapManifest
    {
      try RuntimeBootstrapDocument.decodeValidated(
        try bootstrapData(
          files: files, runtimeID: runtimeID, archiveBytes: Int64(bytes.count),
          archiveSHA256: RuntimeDigest.data(bytes))
      ).runtime
    }
    func transportPartial(_ name: String, manifest: RuntimeBootstrapManifest) throws -> URL {
      let directory = root.appendingPathComponent("Transport-\(name)", isDirectory: true)
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      return directory.appendingPathComponent(
        "\(manifest.id)-\(manifest.archiveSha256.prefix(12)).zip.partial")
    }
    func responseHeaders(
      bytes: Int, etag: String? = nil, range: String? = nil,
      encoding: String? = nil
    ) -> [String: String] {
      var headers = ["Content-Length": String(bytes)]
      if let etag { headers["ETag"] = etag }
      if let range { headers["Content-Range"] = range }
      if let encoding { headers["Content-Encoding"] = encoding }
      return headers
    }
    func download(
      partial: URL, manifest: RuntimeBootstrapManifest
    ) throws {
      try RuntimeDownloadDelegate(
        file: partial, manifest: manifest, configuration: downloadConfiguration,
        progress: { _, _ in }
      ).download(manifest.archiveURL!)
    }
    func seedResume(
      partial: URL, manifest: RuntimeBootstrapManifest, bytes: Data, etag: String
    ) throws {
      try bytes.write(to: partial)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: partial.path)
      try RuntimeDownloadResumeState.persist(
        RuntimeDownloadResumeState(manifest: manifest, etag: etag), for: partial)
    }
    func interruptedDownload(
      partial: URL, manifest: RuntimeBootstrapManifest, headers: [String: String],
      prefix: Data
    ) throws -> (Error?, [URLRequest]) {
      let written = DispatchSemaphore(value: 0)
      RuntimeDownloadFixtureProtocol.store.configure([
        .init(headers: headers, chunks: [prefix])
      ])
      let cancellation = RuntimeDownloadCancellation()
      let delegate = RuntimeDownloadDelegate(
        file: partial, manifest: manifest, configuration: downloadConfiguration,
        progress: { _, _ in
          written.signal()
          cancellation.cancel()
        })
      cancellation.install(delegate)
      let invocation = RuntimeDownloadInvocation()
      DispatchQueue.global().async {
        do {
          try delegate.download(manifest.archiveURL!)
          invocation.complete(nil)
        } catch { invocation.complete(error) }
      }
      guard written.wait(timeout: .now() + 3) == .success else {
        delegate.cancel()
        throw TestFailure.failed("Runtime fixture did not deliver its interrupted prefix")
      }
      guard invocation.finished.wait(timeout: .now() + 3) == .success else {
        delegate.cancel()
        throw TestFailure.failed("Cancelled runtime transfer did not finish promptly")
      }
      cancellation.install(nil)
      return (invocation.error, RuntimeDownloadFixtureProtocol.store.snapshot())
    }

    let transportBytes = Data("0123456789abcdefghijklmnopqrstuvwxyz".utf8)
    let transportDocument = try transportManifest(transportBytes)
    let freshPartial = try transportPartial("fresh", manifest: transportDocument)
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        headers: responseHeaders(
          bytes: transportBytes.count, etag: "\"fresh-v1\"", encoding: "identity"),
        chunks: [transportBytes])
    ])
    try download(partial: freshPartial, manifest: transportDocument)
    let freshRequests = RuntimeDownloadFixtureProtocol.store.snapshot()
    let freshState = try RuntimeDownloadResumeState.validated(
      partial: freshPartial, manifest: transportDocument)
    let freshBytes = try Data(contentsOf: freshPartial)
    try check(
      freshBytes == transportBytes
        && freshState?.state.etag == "\"fresh-v1\"" && freshRequests.count == 1
        && freshRequests[0].value(forHTTPHeaderField: "Accept-Encoding") == "identity"
        && freshRequests[0].value(forHTTPHeaderField: "Range") == nil
        && freshRequests[0].value(forHTTPHeaderField: "If-Range") == nil,
      "A fresh exact 200 must retain only a durable strong validator for safe recovery")
    try RuntimeDownloadResumeState.discard(partial: freshPartial)
    try check(
      RuntimeDownloadResumeState.strongETag("\"opaque\"")
        && !RuntimeDownloadResumeState.strongETag("W/\"weak\"")
        && !RuntimeDownloadResumeState.strongETag("unquoted"),
      "Only bounded strong entity tags may authorize a runtime resume")

    let resumedPartial = try transportPartial("resume", manifest: transportDocument)
    let prefixCount = 11
    let prefix = Data(transportBytes.prefix(prefixCount))
    let suffix = Data(transportBytes.dropFirst(prefixCount))
    let interrupted = try interruptedDownload(
      partial: resumedPartial, manifest: transportDocument,
      headers: responseHeaders(bytes: transportBytes.count, etag: "\"resume-v1\""),
      prefix: prefix)
    let interruptedBytes = try Data(contentsOf: resumedPartial)
    let interruptedState = try RuntimeDownloadResumeState.validated(
      partial: resumedPartial, manifest: transportDocument)
    let interruptedCode = (interrupted.0 as? RuntimeBootstrapFailure)?.errorCode ?? "NONE"
    try check(
      (interrupted.0 as? RuntimeBootstrapFailure) == .cancelled
        && interruptedBytes == prefix && interruptedState?.state.etag == "\"resume-v1\"",
      "Cancellation may retain only bytes protected by a durably committed strong validator (\(interruptedCode), \(interruptedBytes.count), \(interruptedState?.state.etag ?? "NONE"))"
    )
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        status: 206,
        headers: responseHeaders(
          bytes: suffix.count, etag: "\"resume-v1\"",
          range: "bytes \(prefixCount)-\(transportBytes.count - 1)/\(transportBytes.count)"),
        chunks: [suffix])
    ])
    try download(partial: resumedPartial, manifest: transportDocument)
    let resumedRequests = RuntimeDownloadFixtureProtocol.store.snapshot()
    let resumedBytes = try Data(contentsOf: resumedPartial)
    try check(
      resumedBytes == transportBytes && resumedRequests.count == 1
        && resumedRequests[0].value(forHTTPHeaderField: "Range") == "bytes=\(prefixCount)-"
        && resumedRequests[0].value(forHTTPHeaderField: "If-Range") == "\"resume-v1\"",
      "A validated cross-run partial must use an exact Range and If-Range validator")
    try RuntimeDownloadResumeState.discard(partial: resumedPartial)

    for (name, etag) in [("missing-etag", nil), ("weak-etag", "W/\"weak\"")] {
      let partial = try transportPartial(name, manifest: transportDocument)
      let result = try interruptedDownload(
        partial: partial, manifest: transportDocument,
        headers: responseHeaders(bytes: transportBytes.count, etag: etag), prefix: prefix)
      try check(
        (result.0 as? RuntimeBootstrapFailure) == .cancelled
          && !FileManager.default.fileExists(atPath: partial.path)
          && !FileManager.default.fileExists(
            atPath: RuntimeDownloadResumeState.sidecar(for: partial).path),
        "A missing or weak ETag must disable recovery and discard interrupted bytes")
    }

    let replacementBytes = Data("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".utf8)
    let replacementDocument = try transportManifest(
      replacementBytes, runtimeID: "macos-arm64-replacement")
    let replacementPartial = try transportPartial(
      "etag-replacement", manifest: replacementDocument)
    try seedResume(
      partial: replacementPartial, manifest: replacementDocument,
      bytes: Data(replacementBytes.prefix(prefixCount)), etag: "\"old-validator\"")
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        headers: responseHeaders(
          bytes: replacementBytes.count, etag: "\"new-validator\""),
        chunks: [replacementBytes])
    ])
    try download(partial: replacementPartial, manifest: replacementDocument)
    let replacementRequests = RuntimeDownloadFixtureProtocol.store.snapshot()
    let replacementState = try RuntimeDownloadResumeState.validated(
      partial: replacementPartial, manifest: replacementDocument)
    let replacedBytes = try Data(contentsOf: replacementPartial)
    try check(
      replacedBytes == replacementBytes
        && replacementRequests[0].value(forHTTPHeaderField: "If-Range")
          == "\"old-validator\""
        && replacementState?.state.etag == "\"new-validator\"",
      "A 200 response to a resume must truncate old bytes and replace validator state")
    try RuntimeDownloadResumeState.discard(partial: replacementPartial)

    let invalidResumeCases: [(String, [String: String])] = [
      (
        "missing-206-etag",
        responseHeaders(
          bytes: suffix.count,
          range: "bytes \(prefixCount)-\(transportBytes.count - 1)/\(transportBytes.count)")
      ),
      (
        "changed-206-etag",
        responseHeaders(
          bytes: suffix.count, etag: "\"changed\"",
          range: "bytes \(prefixCount)-\(transportBytes.count - 1)/\(transportBytes.count)")
      ),
      (
        "malformed-content-range",
        responseHeaders(
          bytes: suffix.count, etag: "\"resume-v1\"",
          range: "bytes \(prefixCount)-/\(transportBytes.count)")
      ),
    ]
    for (name, invalidHeaders) in invalidResumeCases {
      let partial = try transportPartial(name, manifest: transportDocument)
      try seedResume(
        partial: partial, manifest: transportDocument, bytes: prefix, etag: "\"resume-v1\"")
      RuntimeDownloadFixtureProtocol.store.configure([
        .init(status: 206, headers: invalidHeaders, chunks: [suffix]),
        .init(
          headers: responseHeaders(bytes: transportBytes.count, etag: "\"clean-v2\""),
          chunks: [transportBytes]),
      ])
      try download(partial: partial, manifest: transportDocument)
      let requests = RuntimeDownloadFixtureProtocol.store.snapshot()
      let downloadedBytes = try Data(contentsOf: partial)
      try check(
        downloadedBytes == transportBytes && requests.count == 2
          && requests[0].value(forHTTPHeaderField: "Range") == "bytes=\(prefixCount)-"
          && requests[1].value(forHTTPHeaderField: "Range") == nil,
        "An invalid 206 must discard mixed state and perform exactly one clean retry")
      try RuntimeDownloadResumeState.discard(partial: partial)
    }

    for status in [412, 416] {
      let partial = try transportPartial("status-\(status)", manifest: transportDocument)
      try seedResume(
        partial: partial, manifest: transportDocument, bytes: prefix, etag: "\"resume-v1\"")
      RuntimeDownloadFixtureProtocol.store.configure([
        .init(status: status, headers: responseHeaders(bytes: 0)),
        .init(
          headers: responseHeaders(bytes: transportBytes.count, etag: "\"clean-v2\""),
          chunks: [transportBytes]),
      ])
      try download(partial: partial, manifest: transportDocument)
      let requests = RuntimeDownloadFixtureProtocol.store.snapshot()
      try check(
        requests.count == 2 && requests[0].value(forHTTPHeaderField: "Range") != nil
          && requests[1].value(forHTTPHeaderField: "Range") == nil,
        "A \(status) resume rejection must trigger one bounded clean request")
      try RuntimeDownloadResumeState.discard(partial: partial)
    }

    for name in ["missing-sidecar", "mismatched-sidecar", "crash-sidecar"] {
      let partial = try transportPartial(name, manifest: transportDocument)
      try prefix.write(to: partial)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: partial.path)
      let sidecar = RuntimeDownloadResumeState.sidecar(for: partial)
      if name == "mismatched-sidecar" {
        try RuntimeDownloadResumeState.persist(
          RuntimeDownloadResumeState(manifest: replacementDocument, etag: "\"wrong\""),
          for: partial)
      } else if name == "crash-sidecar" {
        try Data("{\"schema_version\":".utf8).write(to: sidecar)
        try FileManager.default.setAttributes(
          [.posixPermissions: 0o600], ofItemAtPath: sidecar.path)
      }
      RuntimeDownloadFixtureProtocol.store.configure([
        .init(
          headers: responseHeaders(bytes: transportBytes.count, etag: "\"clean-v2\""),
          chunks: [transportBytes])
      ])
      try download(partial: partial, manifest: transportDocument)
      let requests = RuntimeDownloadFixtureProtocol.store.snapshot()
      let downloadedBytes = try Data(contentsOf: partial)
      try check(
        requests.count == 1 && requests[0].value(forHTTPHeaderField: "Range") == nil
          && downloadedBytes == transportBytes,
        "Missing, mismatched or crash-truncated sidecar state must restart from zero")
      try RuntimeDownloadResumeState.discard(partial: partial)
    }

    let redirectState = RuntimeDownloadResumeState(
      manifest: transportDocument, etag: "\"redirect-v1\"")
    var proposedRedirect = URLRequest(url: URL(string: "https://cdn.example.com/runtime.zip")!)
    proposedRedirect.setValue("Bearer must-not-cross", forHTTPHeaderField: "Authorization")
    proposedRedirect.setValue("must-not-cross", forHTTPHeaderField: "X-Untrusted")
    proposedRedirect.setValue("bytes=999-", forHTTPHeaderField: "Range")
    let allowedRedirect = RuntimeDownloadRequestPolicy.redirectedRequest(
      proposedRedirect, allowedHosts: Set(transportDocument.downloadHosts),
      resume: (redirectState, Int64(prefixCount)))
    try check(
      allowedRedirect?.url?.host == "cdn.example.com"
        && allowedRedirect?.value(forHTTPHeaderField: "Range") == "bytes=\(prefixCount)-"
        && allowedRedirect?.value(forHTTPHeaderField: "If-Range") == "\"redirect-v1\""
        && allowedRedirect?.value(forHTTPHeaderField: "Accept-Encoding") == "identity"
        && allowedRedirect?.value(forHTTPHeaderField: "Authorization") == nil
        && allowedRedirect?.value(forHTTPHeaderField: "X-Untrusted") == nil
        && allowedRedirect?.allHTTPHeaderFields?.count == 4,
      "Allowed-host redirects must rebuild only the safe runtime request headers")
    let deniedRedirect = RuntimeDownloadRequestPolicy.redirectedRequest(
      URLRequest(url: URL(string: "https://denied.example.net/runtime.zip")!),
      allowedHosts: Set(transportDocument.downloadHosts),
      resume: (redirectState, Int64(prefixCount)))
    try check(
      deniedRedirect == nil,
      "A redirect outside the sealed host allowlist must be rejected without a request")

    let boundedRetryPartial = try transportPartial("bounded-retry", manifest: transportDocument)
    try seedResume(
      partial: boundedRetryPartial, manifest: transportDocument, bytes: prefix,
      etag: "\"resume-v1\"")
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        status: 206,
        headers: responseHeaders(
          bytes: suffix.count, etag: "\"wrong\"",
          range: "bytes \(prefixCount)-\(transportBytes.count - 1)/\(transportBytes.count)"),
        chunks: [suffix]),
      .init(status: 206, headers: responseHeaders(bytes: transportBytes.count), chunks: []),
      .init(
        headers: responseHeaders(bytes: transportBytes.count, etag: "\"must-not-run\""),
        chunks: [transportBytes]),
    ])
    do {
      try download(partial: boundedRetryPartial, manifest: transportDocument)
      throw TestFailure.failed("A second invalid runtime response was retried")
    } catch RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") {}
    try check(
      RuntimeDownloadFixtureProtocol.store.snapshot().count == 2,
      "Malformed resume recovery must never loop beyond one clean request")
    try RuntimeDownloadResumeState.discard(partial: boundedRetryPartial)

    for (name, headers) in [
      (
        "compressed-fresh",
        responseHeaders(
          bytes: transportBytes.count, etag: "\"fresh-v1\"", encoding: "gzip")
      ),
      ("lengthless-fresh", ["ETag": "\"fresh-v1\""]),
    ] {
      let partial = try transportPartial(name, manifest: transportDocument)
      RuntimeDownloadFixtureProtocol.store.configure([
        .init(headers: headers, chunks: [transportBytes])
      ])
      do {
        try download(partial: partial, manifest: transportDocument)
        throw TestFailure.failed("A non-identity or lengthless fresh response was accepted")
      } catch RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_FAILED") {}
      try check(
        RuntimeDownloadFixtureProtocol.store.snapshot().count == 1
          && !FileManager.default.fileExists(atPath: partial.path),
        "Fresh response validation failures must remain single-attempt and non-resumable")
    }

    let downloadMaintenance = root.appendingPathComponent(
      "DownloadMaintenance", isDirectory: true)
    try FileManager.default.createDirectory(
      at: downloadMaintenance, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    @discardableResult func privateDownload(
      _ directory: URL, _ name: String, bytes: Data = Data("download".utf8)
    ) throws -> URL {
      let file = directory.appendingPathComponent(name)
      try bytes.write(to: file)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      return file
    }
    let currentArchiveName =
      "\(document.runtime.id)-\(document.runtime.archiveSha256.prefix(12)).zip"
    let currentPartial = try privateDownload(
      downloadMaintenance, "\(currentArchiveName).partial")
    try RuntimeDownloadResumeState.persist(
      RuntimeDownloadResumeState(manifest: document.runtime, etag: "\"maintenance-v1\""),
      for: currentPartial)
    let currentSidecar = RuntimeDownloadResumeState.sidecar(for: currentPartial)
    let staleArchiveDigest = String(repeating: "b", count: 12)
    let stalePartialDigest = String(repeating: "c", count: 12)
    let staleArchive = try privateDownload(
      downloadMaintenance, "macos-arm64-old-\(staleArchiveDigest).zip")
    let stalePartial = try privateDownload(
      downloadMaintenance,
      "macos-arm64-older-\(stalePartialDigest).zip.partial")
    try RuntimeDownloadResumeState.persist(
      RuntimeDownloadResumeState(manifest: document.runtime, etag: "\"stale-v1\""),
      for: stalePartial)
    let staleSidecar = RuntimeDownloadResumeState.sidecar(for: stalePartial)
    let staleTemporary = try privateDownload(
      downloadMaintenance, ".runtime-resume-00000000-0000-4000-8000-000000000001.tmp",
      bytes: Data("interrupted-sidecar".utf8))
    try RuntimeStorageMaintenance.cleanupDownloads(
      downloadMaintenance, preserving: document.runtime)
    try check(
      FileManager.default.fileExists(atPath: currentPartial.path)
        && FileManager.default.fileExists(atPath: currentSidecar.path)
        && !FileManager.default.fileExists(atPath: staleArchive.path)
        && !FileManager.default.fileExists(atPath: stalePartial.path)
        && !FileManager.default.fileExists(atPath: staleSidecar.path)
        && !FileManager.default.fileExists(atPath: staleTemporary.path),
      "Download cleanup must retain the exact partial/sidecar pair and prune stale recognized state"
    )

    let removableDigest = String(repeating: "d", count: 12)
    let removable = try privateDownload(
      downloadMaintenance, "macos-arm64-stale-\(removableDigest).zip")
    let unknown = try privateDownload(downloadMaintenance, "user-note.txt")
    do {
      try RuntimeStorageMaintenance.cleanupDownloads(
        downloadMaintenance, preserving: document.runtime)
      throw TestFailure.failed("Unknown runtime download entry was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") {}
    try check(
      FileManager.default.fileExists(atPath: removable.path)
        && FileManager.default.fileExists(atPath: unknown.path),
      "Unknown download entries must fail closed before any validated stale file is removed")
    try FileManager.default.removeItem(at: unknown)

    let unsafeLinkDigest = String(repeating: "e", count: 12)
    let unsafeLink = downloadMaintenance.appendingPathComponent(
      "macos-arm64-linked-\(unsafeLinkDigest).zip")
    let outsideDownload = root.appendingPathComponent("outside-download")
    try Data("outside".utf8).write(to: outsideDownload)
    try FileManager.default.createSymbolicLink(
      atPath: unsafeLink.path, withDestinationPath: outsideDownload.path)
    do {
      try RuntimeStorageMaintenance.cleanupDownloads(
        downloadMaintenance, preserving: document.runtime)
      throw TestFailure.failed("Linked runtime download entry was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") {}
    var unsafeDownloadInformation = stat()
    let outsideDownloadBytes = try Data(contentsOf: outsideDownload)
    try check(
      lstat(unsafeLink.path, &unsafeDownloadInformation) == 0
        && unsafeDownloadInformation.st_mode & S_IFMT == S_IFLNK
        && outsideDownloadBytes == Data("outside".utf8),
      "Unsafe download entries and their targets must remain untouched")
    try FileManager.default.removeItem(at: unsafeLink)
    try FileManager.default.removeItem(at: downloadMaintenance)
    try FileManager.default.createDirectory(
      at: downloadMaintenance, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    for index in 0..<129 {
      _ = try privateDownload(
        downloadMaintenance, "runtime-cap-\(String(format: "%012x", index)).zip",
        bytes: Data())
    }
    do {
      try RuntimeStorageMaintenance.cleanupDownloads(downloadMaintenance, preserving: nil)
      throw TestFailure.failed("Unbounded runtime download directory was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_DOWNLOAD_UNSAFE") {}
    let cappedDownloadCount = try FileManager.default.contentsOfDirectory(
      atPath: downloadMaintenance.path
    ).count
    try check(
      cappedDownloadCount == 129,
      "Download entry caps must fail without deleting files")
    let unsignedExecutable = document.runtime.files.first {
      $0.path.hasSuffix("libfixture.dylib")
    }
    try check(
      unsignedExecutable?.codeSigned == true && unsignedExecutable?.executable == false,
      "Signed dylibs must not be forced to carry an execute bit")

    let developerSigning = RuntimeSigningManifest(mode: "developer_id", teamID: "K5UP26B3W8")
    let developerArguments = try SystemRuntimeSignatureChecker.verificationArguments(
      for: release, signing: developerSigning)
    let designatedRequirement =
      "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"K5UP26B3W8\""
    try check(
      developerArguments.contains("--all-architectures")
        && developerArguments.contains("--test-requirement")
        && developerArguments.contains(designatedRequirement),
      "Developer-ID verification must require an Apple-anchored Developer ID from the pinned team")
    let adHocArguments = try SystemRuntimeSignatureChecker.verificationArguments(
      for: release, signing: RuntimeSigningManifest(mode: "ad_hoc", teamID: nil))
    try check(
      adHocArguments.contains("--all-architectures")
        && !adHocArguments.contains("--test-requirement"),
      "Ad-hoc development verification must remain separate from Developer-ID trust evaluation")

    let runtimeProgress = [0.0, 40, 42, 94].map(ProcessBridge.runtimeSetupPercent)
    let companionProgress = [0.0, 50, 100].map(ProcessBridge.companionSetupPercent)
    let allProgress = runtimeProgress + companionProgress
    try check(
      zip(allProgress, allProgress.dropFirst()).allSatisfy { $0 <= $1 }
        && runtimeProgress.last! < companionProgress.first!
        && companionProgress.last == 100,
      "Runtime and companion setup progress must remain monotonic across the 55 percent handoff")

    let completeArchive = Data("complete-partial-runtime-archive".utf8)
    let recoveryDocument = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(
        files: files, archiveBytes: Int64(completeArchive.count),
        archiveSHA256: RuntimeDigest.data(completeArchive)))
    let partial = root.appendingPathComponent("runtime.zip.partial")
    let archive = root.appendingPathComponent("runtime.zip")
    try completeArchive.write(to: partial)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: partial.path)
    try RuntimeDownloadResumeState.persist(
      RuntimeDownloadResumeState(manifest: recoveryDocument.runtime, etag: "\"complete-v1\""),
      for: partial)
    let completeSidecar = RuntimeDownloadResumeState.sidecar(for: partial)
    let recoveredPartial = try RuntimeArchivePromotion.recoverCompletePartial(
      partial, archive: archive, manifest: recoveryDocument.runtime)
    try check(
      recoveredPartial,
      "A complete verified partial download must promote without an invalid Range retry")
    let promotedBytes = try Data(contentsOf: archive)
    try check(
      !FileManager.default.fileExists(atPath: partial.path)
        && !FileManager.default.fileExists(atPath: completeSidecar.path)
        && promotedBytes == completeArchive,
      "Complete partial promotion must preserve exact bytes and remove resume state")
    try completeArchive.write(to: partial)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: partial.path)
    try RuntimeDownloadResumeState.persist(
      RuntimeDownloadResumeState(manifest: recoveryDocument.runtime, etag: "\"complete-v1\""),
      for: partial)
    let recoveredRace = try RuntimeArchivePromotion.recoverCompletePartial(
      partial, archive: archive, manifest: recoveryDocument.runtime)
    try check(
      recoveredRace && !FileManager.default.fileExists(atPath: partial.path)
        && !FileManager.default.fileExists(atPath: completeSidecar.path),
      "A raced-in identical archive must be revalidated before discarding its duplicate partial")
    let exclusiveSource = root.appendingPathComponent("exclusive-source")
    let exclusiveDestination = root.appendingPathComponent("exclusive-destination")
    try Data("source".utf8).write(to: exclusiveSource)
    try Data("destination".utf8).write(to: exclusiveDestination)
    let exclusiveResult = RuntimeFileSecurity.exclusiveRename(
      exclusiveSource, to: exclusiveDestination)
    let exclusiveSourceText = try String(contentsOf: exclusiveSource, encoding: .utf8)
    let exclusiveDestinationText = try String(contentsOf: exclusiveDestination, encoding: .utf8)
    try check(
      !exclusiveResult && exclusiveSourceText == "source"
        && exclusiveDestinationText == "destination",
      "Exclusive promotion must never overwrite a raced-in destination")
    for invalid in [
      try bootstrapData(
        files: files, url: "https://downloads.example.com/runtime.zip?token=secret"),
      try bootstrapData(
        files: files + [
          [
            "path": "../escape", "type": "file", "bytes": 1,
            "sha256": String(repeating: "b", count: 64), "executable": false,
            "code_signed": false,
          ]
        ]),
      try bootstrapData(files: files + [files[0]]),
      try bootstrapData(
        files: files.map { entry in
          guard entry["path"] as? String == pythonLink else { return entry }
          var replacement = entry
          replacement["link_target"] = "../../../../../outside"
          return replacement
        }),
    ] {
      do {
        _ = try RuntimeBootstrapDocument.decodeValidated(invalid)
        throw TestFailure.failed("Unsafe runtime manifest accepted")
      } catch RuntimeBootstrapFailure.code("RUNTIME_MANIFEST_INVALID") {}
    }

    let signatures = RecordingRuntimeSignatureChecker()
    let verifier = RuntimeInventoryVerifier(signatureChecker: signatures)
    try verifier.verify(
      release: release, resources: root, manifest: document.runtime,
      cancelled: { false })
    let initialSignatureSnapshot = signatures.snapshot()
    try check(
      initialSignatureSnapshot.outer == 1 && initialSignatureSnapshot.code == regular.count,
      "Every marked Mach-O and the containing app identity must be checked")

    let installerArchive = root.appendingPathComponent("installer-runtime.zip")
    let zip = Process()
    zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
    zip.arguments = ["-X", "-y", "-q", "-r", installerArchive.path, "."]
    zip.currentDirectoryURL = release
    zip.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
    zip.standardInput = FileHandle.nullDevice
    zip.standardOutput = FileHandle.nullDevice
    zip.standardError = FileHandle.nullDevice
    try zip.run()
    zip.waitUntilExit()
    try check(zip.terminationStatus == 0, "The tiny runtime fixture ZIP must be reproducible")
    let installerArchiveBytes = try Data(contentsOf: installerArchive)
    let installerResources = root.appendingPathComponent(
      "InstallerResources", isDirectory: true)
    try FileManager.default.createDirectory(
      at: installerResources, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let installerManifestData = try bootstrapData(
      files: files, runtimeID: "macos-arm64-installer",
      archiveBytes: Int64(installerArchiveBytes.count),
      archiveSHA256: RuntimeDigest.data(installerArchiveBytes))
    try installerManifestData.write(
      to: installerResources.appendingPathComponent("runtime-bootstrap.json"))
    let installerDocument = try RuntimeBootstrapDocument.decodeValidated(installerManifestData)
    let corruptArchiveBytes = Data(repeating: 0x58, count: installerArchiveBytes.count)
    let installerSupport = root.appendingPathComponent("InstallerSupport", isDirectory: true)
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        headers: responseHeaders(
          bytes: corruptArchiveBytes.count, etag: "\"corrupt-v1\""),
        chunks: [corruptArchiveBytes]),
      .init(
        headers: responseHeaders(
          bytes: installerArchiveBytes.count, etag: "\"archive-v2\""),
        chunks: [installerArchiveBytes]),
    ])
    let installerActivation = try RuntimeBootstrapInstaller(
      resources: installerResources, support: installerSupport,
      signatureChecker: RecordingRuntimeSignatureChecker(),
      downloadConfiguration: downloadConfiguration
    ).prepare { _, _ in }
    let installerRequests = RuntimeDownloadFixtureProtocol.store.snapshot()
    let installerDownloads = installerSupport.appendingPathComponent(
      "runtime/downloads", isDirectory: true)
    let installedRuntime = installerActivation.runtimeRoot
    let installerDownloadEntries = try FileManager.default.contentsOfDirectory(
      atPath: installerDownloads.path)
    try check(
      installerRequests.count == 2
        && installerRequests.allSatisfy { $0.value(forHTTPHeaderField: "Range") == nil }
        && RuntimeInstallationResolver.activeDocument(support: installerSupport)
          == RuntimeActiveDocument(runtime: installerDocument.runtime)
        && FileManager.default.isExecutableFile(
          atPath: installedRuntime.appendingPathComponent("runtime/node/bin/node").path)
        && installerDownloadEntries.isEmpty,
      "Installer download must clean-redownload one corrupt digest, extract and activate the exact ZIP"
    )
    try check(
      installerActivation.rollback()
        && RuntimeInstallationResolver.activeDocument(support: installerSupport) == nil
        && FileManager.default.fileExists(
          atPath: installerSupport.appendingPathComponent(
            "runtime/releases/\(installerDocument.runtime.id)", isDirectory: true
          ).path),
      "Installer activation rollback must clear selection without destroying the verified release")

    let corruptSupport = root.appendingPathComponent("CorruptSupport", isDirectory: true)
    RuntimeDownloadFixtureProtocol.store.configure([
      .init(
        headers: responseHeaders(
          bytes: corruptArchiveBytes.count, etag: "\"corrupt-v1\""),
        chunks: [corruptArchiveBytes]),
      .init(
        headers: responseHeaders(
          bytes: corruptArchiveBytes.count, etag: "\"corrupt-v2\""),
        chunks: [corruptArchiveBytes]),
      .init(
        headers: responseHeaders(
          bytes: installerArchiveBytes.count, etag: "\"must-not-run\""),
        chunks: [installerArchiveBytes]),
    ])
    do {
      _ = try RuntimeBootstrapInstaller(
        resources: installerResources, support: corruptSupport,
        signatureChecker: RecordingRuntimeSignatureChecker(),
        downloadConfiguration: downloadConfiguration
      ).prepare { _, _ in }
      throw TestFailure.failed("Repeated runtime digest corruption was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    let corruptDownloads = corruptSupport.appendingPathComponent(
      "runtime/downloads", isDirectory: true)
    let corruptRelease = corruptSupport.appendingPathComponent(
      "runtime/releases/\(installerDocument.runtime.id)", isDirectory: true)
    let corruptDownloadEntries = try FileManager.default.contentsOfDirectory(
      atPath: corruptDownloads.path)
    try check(
      RuntimeDownloadFixtureProtocol.store.snapshot().count == 2
        && corruptDownloadEntries.isEmpty
        && !FileManager.default.fileExists(atPath: corruptRelease.path),
      "Digest corruption must stop after one clean retry with no resumable mixed state")

    let extra = release.appendingPathComponent("runtime/unlisted")
    try Data("extra".utf8).write(to: extra)
    try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: extra.path)
    do {
      try verifier.verify(
        release: release, resources: root, manifest: document.runtime,
        cancelled: { false })
      throw TestFailure.failed("Unlisted extracted file accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: extra)

    let extraDirectory = release.appendingPathComponent("runtime/unlisted-directory")
    try FileManager.default.createDirectory(
      at: extraDirectory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    do {
      try verifier.verify(
        release: release, resources: root, manifest: document.runtime,
        cancelled: { false })
      throw TestFailure.failed("Unlisted extracted directory accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: extraDirectory)

    let danglingFiles = files.map { entry -> [String: Any] in
      guard entry["path"] as? String == pythonLink else { return entry }
      var replacement = entry
      replacement["link_target"] = "missing-python"
      return replacement
    }
    let dangling = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(files: danglingFiles))
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "missing-python")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: dangling.runtime,
        cancelled: { false })
      throw TestFailure.failed("Dangling manifest symlink accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "python3.13")

    let normalizedDanglingFiles = files.map { entry -> [String: Any] in
      guard entry["path"] as? String == pythonLink else { return entry }
      var replacement = entry
      replacement["link_target"] = "missing/../python3.13"
      return replacement
    }
    let normalizedDangling = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(files: normalizedDanglingFiles))
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "missing/../python3.13")
    try check(
      RuntimePath.canonicalExisting(release.appendingPathComponent(pythonLink)) == nil,
      "Normalized dangling-link fixture must remain physically unresolved")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: normalizedDangling.runtime,
        cancelled: { false })
      throw TestFailure.failed("Lexically normalized dangling runtime symlink accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "python3.13")

    let criticalDirectoryFiles = files.map { entry -> [String: Any] in
      guard entry["path"] as? String == pythonLink else { return entry }
      var replacement = entry
      replacement["link_target"] = "../current-lib"
      return replacement
    }
    let criticalDirectory = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(files: criticalDirectoryFiles))
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "../current-lib")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: criticalDirectory.runtime,
        cancelled: { false })
      throw TestFailure.failed("Critical runtime launcher resolving to a directory accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "python3.13")

    func writeRedirectFixture(
      path: String, bytes: Data, executable: Bool, codeSigned: Bool
    ) throws -> [String: Any] {
      let destination = release.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try bytes.write(to: destination)
      try FileManager.default.setAttributes(
        [.posixPermissions: executable ? 0o500 : 0o400], ofItemAtPath: destination.path)
      return [
        "path": path, "type": "file", "bytes": bytes.count,
        "sha256": RuntimeDigest.data(bytes), "executable": executable,
        "code_signed": codeSigned,
      ]
    }
    let declaredLauncher = "runtime/runtime/python/bin/declared-python"
    let redirectedLauncher = "runtime/runtime/python/bad/declared-python"
    let redirectMarker = "runtime/runtime/python/bad/sub/marker"
    let redirectAlias = "runtime/runtime/python/bin/alias"
    let declaredBytes = Data("declared-signed-launcher".utf8)
    let redirectedBytes = Data("redirected-unsigned-launcher".utf8)
    let redirectMarkerBytes = Data("redirect-marker".utf8)
    let redirectEntries = try [
      writeRedirectFixture(
        path: declaredLauncher, bytes: declaredBytes, executable: true, codeSigned: true),
      writeRedirectFixture(
        path: redirectedLauncher, bytes: redirectedBytes, executable: true, codeSigned: false),
      writeRedirectFixture(
        path: redirectMarker, bytes: redirectMarkerBytes, executable: false, codeSigned: false),
    ]
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(redirectAlias).path,
      withDestinationPath: "../bad/sub")
    var redirectedFiles = files.map { entry -> [String: Any] in
      guard entry["path"] as? String == pythonLink else { return entry }
      var replacement = entry
      replacement["link_target"] = "alias/../declared-python"
      return replacement
    }
    redirectedFiles.append(contentsOf: redirectEntries)
    redirectedFiles.append([
      "path": redirectAlias, "type": "symlink", "link_target": "../bad/sub",
    ])
    let redirectedInstalledBytes =
      installedBytes
      + Int64(declaredBytes.count + redirectedBytes.count + redirectMarkerBytes.count)
    let redirectedCritical = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(
        files: redirectedFiles, installedByteCount: redirectedInstalledBytes))
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "alias/../declared-python")
    try check(
      RuntimePath.canonicalExisting(release.appendingPathComponent(pythonLink))
        == RuntimePath.canonicalExisting(release.appendingPathComponent(redirectedLauncher))
        && RuntimePath.canonicalExisting(release.appendingPathComponent(pythonLink))
          != RuntimePath.canonicalExisting(release.appendingPathComponent(declaredLauncher)),
      "Directory-link fixture must physically redirect away from the lexically declared launcher")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: redirectedCritical.runtime,
        cancelled: { false })
      throw TestFailure.failed("Critical launcher redirected through a directory symlink accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(pythonLink))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(pythonLink).path,
      withDestinationPath: "python3.13")
    try FileManager.default.removeItem(at: release.appendingPathComponent(redirectAlias))
    try FileManager.default.removeItem(at: release.appendingPathComponent(declaredLauncher))
    try FileManager.default.removeItem(
      at: release.appendingPathComponent("runtime/runtime/python/bad"))

    let cycleOne = "runtime/runtime/python/cycle-one"
    let cycleTwo = "runtime/runtime/python/cycle-two"
    let cycleFiles =
      files + [
        ["path": cycleOne, "type": "symlink", "link_target": "cycle-two"],
        ["path": cycleTwo, "type": "symlink", "link_target": "cycle-one"],
      ]
    let cyclic = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(files: cycleFiles))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(cycleOne).path,
      withDestinationPath: "cycle-two")
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(cycleTwo).path,
      withDestinationPath: "cycle-one")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: cyclic.runtime,
        cancelled: { false })
      throw TestFailure.failed("Cyclic manifest symlinks accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(cycleOne))
    try FileManager.default.removeItem(at: release.appendingPathComponent(cycleTwo))

    let escapeTop = "runtime/runtime/python/escape-a/top"
    let escapeAliasOne = "runtime/runtime/python/escape-a/alias-one"
    let escapeAliasTwo = "runtime/runtime/python/escape-b/alias-two"
    let escapeMarker = "runtime/runtime/python/escape-c/marker"
    let internalEscapedGood = "runtime/escaped-good"
    let internalEscapedBytes = Data("internal-good".utf8)
    let escapeMarkerBytes = Data("escape-marker".utf8)
    let escapeFileEntries = try [
      writeRedirectFixture(
        path: internalEscapedGood, bytes: internalEscapedBytes, executable: false,
        codeSigned: false),
      writeRedirectFixture(
        path: escapeMarker, bytes: escapeMarkerBytes, executable: false,
        codeSigned: false),
    ]
    for (path, target) in [
      (escapeTop, "alias-one/alias-two/../../../../../escaped-good"),
      (escapeAliasOne, "../escape-b"),
      (escapeAliasTwo, "../escape-c"),
    ] {
      let link = release.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: link.deletingLastPathComponent(), withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      try FileManager.default.createSymbolicLink(
        atPath: link.path, withDestinationPath: target)
    }
    let externalEscapedGood = root.appendingPathComponent("escaped-good")
    try Data("external-good".utf8).write(to: externalEscapedGood)
    try check(
      RuntimePath.canonicalExisting(release.appendingPathComponent(escapeTop))
        == RuntimePath.canonicalExisting(externalEscapedGood),
      "Composed-link fixture must physically resolve outside the candidate release")
    var escapeFiles = files + escapeFileEntries
    escapeFiles.append(contentsOf: [
      [
        "path": escapeTop, "type": "symlink",
        "link_target": "alias-one/alias-two/../../../../../escaped-good",
      ],
      ["path": escapeAliasOne, "type": "symlink", "link_target": "../escape-b"],
      ["path": escapeAliasTwo, "type": "symlink", "link_target": "../escape-c"],
    ])
    let escapeDocument = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(
        files: escapeFiles,
        installedByteCount: installedBytes
          + Int64(internalEscapedBytes.count + escapeMarkerBytes.count)))
    do {
      try verifier.verify(
        release: release, resources: root, manifest: escapeDocument.runtime,
        cancelled: { false })
      throw TestFailure.failed("Composed runtime symlinks escaping the release were accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    for path in ["escape-a", "escape-b", "escape-c"] {
      try FileManager.default.removeItem(
        at: release.appendingPathComponent("runtime/runtime/python/\(path)"))
    }
    try FileManager.default.removeItem(at: release.appendingPathComponent(internalEscapedGood))
    try FileManager.default.removeItem(at: externalEscapedGood)

    let ancestorCycle = "runtime/runtime/python/ancestor-cycle"
    let ancestorCycleFiles =
      files + [
        ["path": ancestorCycle, "type": "symlink", "link_target": ".."]
      ]
    let ancestorCyclic = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(files: ancestorCycleFiles))
    try FileManager.default.createSymbolicLink(
      atPath: release.appendingPathComponent(ancestorCycle).path,
      withDestinationPath: "..")
    do {
      try verifier.verify(
        release: release, resources: root, manifest: ancestorCyclic.runtime,
        cancelled: { false })
      throw TestFailure.failed("Runtime directory symlink to its own ancestor accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: release.appendingPathComponent(ancestorCycle))

    let resources = root.appendingPathComponent("Resources", isDirectory: true)
    try FileManager.default.createDirectory(
      at: resources, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: resources.appendingPathComponent("companion"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: resources.appendingPathComponent("scripts"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try manifestData.write(to: resources.appendingPathComponent("runtime-bootstrap.json"))
    try Data("fixture control".utf8).write(
      to: resources.appendingPathComponent("companion/app-control.js"))
    try Data("fixture native host".utf8).write(
      to: resources.appendingPathComponent("companion/host.js"))
    try Data("fixture native lock".utf8).write(
      to: resources.appendingPathComponent("scripts/native-lock.py"))
    let support = root.appendingPathComponent("Support", isDirectory: true)
    let runtime = support.appendingPathComponent("runtime", isDirectory: true)
    let installedRelease = runtime.appendingPathComponent(
      "releases/\(document.runtime.id)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: installedRelease.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: support.path)
    try FileManager.default.copyItem(at: release, to: installedRelease)
    let active = RuntimeActiveDocument(runtime: document.runtime)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var activeData = try encoder.encode(active)
    activeData.append(10)
    try RuntimeFileSecurity.atomicWrite(
      activeData, to: runtime.appendingPathComponent("active.json"))
    let activeFile = runtime.appendingPathComponent("active.json")
    let runtimeBootstrapLock = runtime.appendingPathComponent("bootstrap.lock")
    try Data().write(to: runtimeBootstrapLock)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: runtimeBootstrapLock.path)
    guard let canonicalUpdateSupportPath = RuntimePath.canonicalExisting(support) else {
      throw TestFailure.failed("The runtime support fixture must have a canonical path")
    }
    let canonicalUpdateSupport = URL(
      fileURLWithPath: canonicalUpdateSupportPath, isDirectory: true)
    try check(
      RuntimeInstallationResolver.runtimeRoot(resources: resources, support: support)
        == installedRelease.appendingPathComponent("runtime", isDirectory: true),
      "A matching private active descriptor must resolve the versioned runtime")

    let nonCriticalLeaf = installedRelease.appendingPathComponent(
      "runtime/runtime/python/lib/libfixture.dylib")
    let originalLeaf = try Data(contentsOf: nonCriticalLeaf)
    func replaceNonCriticalLeaf(with data: Data) throws {
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: nonCriticalLeaf.path)
      try data.write(to: nonCriticalLeaf)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o400], ofItemAtPath: nonCriticalLeaf.path)
    }

    let receiptAuthenticator = InMemoryRuntimeReceiptAuthenticator()
    let receiptApplication = RuntimeVerificationApplicationIdentity(
      bundleIdentifier: "com.musicmute.local", bundleVersion: "100",
      codeDirectoryHash: String(repeating: "a", count: 40))
    func receiptChecker(
      policy: String = "receipt-policy-v1",
      application: RuntimeVerificationApplicationIdentity? = nil
    ) -> ReceiptRuntimeSignatureChecker {
      ReceiptRuntimeSignatureChecker(
        verificationPolicyIdentifier: policy, application: application ?? receiptApplication)
    }
    func receiptCoordinator(_ store: InMemoryRuntimeReceiptStore)
      -> RuntimeVerificationCoordinator
    {
      RuntimeVerificationCoordinator(
        receiptAuthenticator: receiptAuthenticator, receiptStore: store)
    }
    func establishReceipt(
      store: InMemoryRuntimeReceiptStore, checker: ReceiptRuntimeSignatureChecker
    ) throws {
      let coordinator = receiptCoordinator(store)
      var verified = try coordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: checker)
      try check(
        verified?.runtimeRoot.path
          == RuntimePath.canonicalExisting(
            installedRelease.appendingPathComponent("runtime", isDirectory: true))
          && coordinator.verificationRunCount == 1 && checker.snapshot().code == regular.count,
        "The first receipt-capable coordinator must complete full runtime verification")
      verified = nil
    }

    let crossCoordinatorStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: crossCoordinatorStore, checker: receiptChecker())
    let crossCoordinatorChecker = receiptChecker()
    let crossCoordinator = receiptCoordinator(crossCoordinatorStore)
    var receiptHit = try crossCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: crossCoordinatorChecker)
    try check(
      receiptHit?.runtimeRoot.path
        == RuntimePath.canonicalExisting(
          installedRelease.appendingPathComponent("runtime", isDirectory: true))
        && crossCoordinator.verificationRunCount == 0
        && crossCoordinatorChecker.snapshot().outer == 1
        && crossCoordinatorChecker.snapshot().code == 0,
      "An authenticated receipt must skip leaf hashing across coordinator/process boundaries")
    receiptHit = nil

    let bundledResources = root.appendingPathComponent("BundledResources", isDirectory: true)
    let bundledRuntime = bundledResources.appendingPathComponent("runtime", isDirectory: true)
    let bundledNode = bundledRuntime.appendingPathComponent("runtime/node/bin/node")
    try FileManager.default.createDirectory(
      at: bundledNode.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: bundledNode)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: bundledNode.path)
    let bundledReceiptChecker = receiptChecker()
    let bundledReceiptCoordinator = receiptCoordinator(crossCoordinatorStore)
    var bundledReceiptRuntime = try bundledReceiptCoordinator.verifiedRuntime(
      resources: bundledResources, support: support, signatureChecker: bundledReceiptChecker)
    let bundledResolvedPath = bundledReceiptRuntime.flatMap {
      RuntimePath.canonicalExisting($0.runtimeRoot)
    }
    try check(
      bundledResolvedPath == RuntimePath.canonicalExisting(bundledRuntime)
        && bundledReceiptCoordinator.verificationRunCount == 0
        && bundledReceiptChecker.snapshot().outer == 0
        && bundledReceiptChecker.snapshot().code == 0,
      "An external-runtime receipt must not poison a bundled-runtime rollback")
    bundledReceiptRuntime = nil

    let unavailableAuthenticatorStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: unavailableAuthenticatorStore, checker: receiptChecker())
    let unavailableAuthenticatorChecker = receiptChecker()
    let unavailableAuthenticatorCoordinator = RuntimeVerificationCoordinator(
      receiptAuthenticator: UnavailableRuntimeReceiptAuthenticator(),
      receiptStore: unavailableAuthenticatorStore)
    var unavailableAuthenticatorRuntime = try unavailableAuthenticatorCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: unavailableAuthenticatorChecker)
    try check(
      unavailableAuthenticatorRuntime != nil
        && unavailableAuthenticatorCoordinator.verificationRunCount == 1
        && unavailableAuthenticatorChecker.snapshot().code == regular.count,
      "Unavailable Keychain authentication must fall back to full verification without blocking execution"
    )
    unavailableAuthenticatorRuntime = nil

    try crossCoordinatorStore.tamperAuthenticationCode()
    let tamperedReceiptChecker = receiptChecker()
    let tamperedReceiptCoordinator = receiptCoordinator(crossCoordinatorStore)
    var tamperedReceiptRuntime = try tamperedReceiptCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: tamperedReceiptChecker)
    try check(
      tamperedReceiptRuntime != nil && tamperedReceiptCoordinator.verificationRunCount == 1
        && tamperedReceiptChecker.snapshot().code == regular.count,
      "A receipt with a modified HMAC must fall back to complete verification")
    tamperedReceiptRuntime = nil

    crossCoordinatorStore.corrupt()
    let corruptReceiptChecker = receiptChecker()
    let corruptReceiptCoordinator = receiptCoordinator(crossCoordinatorStore)
    var corruptReceiptRuntime = try corruptReceiptCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: corruptReceiptChecker)
    try check(
      corruptReceiptRuntime != nil && corruptReceiptCoordinator.verificationRunCount == 1
        && corruptReceiptChecker.snapshot().code == regular.count,
      "A corrupt receipt must fall back to complete verification and remain executable only after it"
    )
    corruptReceiptRuntime = nil

    let mutationReceiptStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: mutationReceiptStore, checker: receiptChecker())
    var receiptMutation = originalLeaf
    receiptMutation[receiptMutation.startIndex] ^= 0xff
    try check(
      receiptMutation.count == originalLeaf.count,
      "The receipt mutation fixture must preserve the declared leaf length")
    try replaceNonCriticalLeaf(with: receiptMutation)
    let mutationReceiptCoordinator = receiptCoordinator(mutationReceiptStore)
    do {
      _ = try mutationReceiptCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: receiptChecker())
      throw TestFailure.failed("A runtime mutation reused an authenticated durable receipt")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try check(
      mutationReceiptCoordinator.verificationRunCount == 1,
      "Changed exact inventory metadata must invalidate the receipt and run the complete verifier")
    try replaceNonCriticalLeaf(with: originalLeaf)

    let duringScanReceiptStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: duringScanReceiptStore, checker: receiptChecker())
    var duringScanMutation = originalLeaf
    duringScanMutation[duringScanMutation.startIndex] ^= 0x7f
    let duringScanFingerprinter = MutatingRuntimeMetadataFingerprinter(
      triggerPath: "runtime/runtime/python/lib/libfixture.dylib"
    ) {
      try replaceNonCriticalLeaf(with: duringScanMutation)
    }
    let duringScanCoordinator = RuntimeVerificationCoordinator(
      receiptAuthenticator: receiptAuthenticator, receiptStore: duringScanReceiptStore,
      metadataFingerprinter: duringScanFingerprinter)
    do {
      _ = try duringScanCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: receiptChecker())
      throw TestFailure.failed("An in-place mutation during the first metadata pass was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    let duringScanSnapshot = duringScanFingerprinter.snapshot()
    try check(
      duringScanSnapshot.mutated && duringScanSnapshot.invocations >= 2
        && duringScanCoordinator.verificationRunCount == 1,
      "The second exact metadata pass must detect a mutation after its leaf was first scanned")
    try replaceNonCriticalLeaf(with: originalLeaf)

    let policyReceiptStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: policyReceiptStore, checker: receiptChecker(policy: "policy-one"))
    let changedPolicyChecker = receiptChecker(policy: "policy-two")
    let changedPolicyCoordinator = receiptCoordinator(policyReceiptStore)
    var changedPolicyRuntime = try changedPolicyCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: changedPolicyChecker)
    try check(
      changedPolicyRuntime != nil && changedPolicyCoordinator.verificationRunCount == 1
        && changedPolicyChecker.snapshot().code == regular.count,
      "A different signature-verification policy must invalidate a durable receipt")
    changedPolicyRuntime = nil

    let buildReceiptStore = InMemoryRuntimeReceiptStore()
    try establishReceipt(store: buildReceiptStore, checker: receiptChecker())
    let changedApplication = RuntimeVerificationApplicationIdentity(
      bundleIdentifier: receiptApplication.bundleIdentifier, bundleVersion: "101",
      codeDirectoryHash: receiptApplication.codeDirectoryHash)
    let changedBuildChecker = receiptChecker(application: changedApplication)
    let changedBuildCoordinator = receiptCoordinator(buildReceiptStore)
    var changedBuildRuntime = try changedBuildCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: changedBuildChecker)
    try check(
      changedBuildRuntime != nil && changedBuildCoordinator.verificationRunCount == 1
        && changedBuildChecker.snapshot().code == regular.count,
      "A different signed app build identity must invalidate a durable receipt")
    changedBuildRuntime = nil

    let postCheckMutation = Data("mutated-lib!!!".utf8)
    try check(
      postCheckMutation.count == originalLeaf.count,
      "The verify-time mutation fixture must preserve leaf length")
    let postCheckSignatures = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "post-check-mutation")
    postCheckSignatures.onNextOuterValidation {
      try replaceNonCriticalLeaf(with: postCheckMutation)
    }
    let postCheckCoordinator = RuntimeVerificationCoordinator()
    do {
      _ = try postCheckCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: postCheckSignatures)
      throw TestFailure.failed("A verify-time runtime mutation escaped the post-check")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    let postCheckBytes = try Data(contentsOf: nonCriticalLeaf)
    try replaceNonCriticalLeaf(with: originalLeaf)
    try check(
      postCheckBytes == postCheckMutation && postCheckCoordinator.verificationRunCount == 1,
      "Verification must re-resolve the exact inventory after its expensive checks")

    let metadataSignatures = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "metadata-cache-invalidation")
    let metadataCoordinator = RuntimeVerificationCoordinator()
    var metadataRuntime = try metadataCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: metadataSignatures)
    try check(
      metadataRuntime?.runtimeRoot.path
        == RuntimePath.canonicalExisting(
          installedRelease.appendingPathComponent("runtime", isDirectory: true)),
      "The metadata cache fixture must first verify the installed runtime")
    metadataRuntime = nil
    let derivedDirectory = nonCriticalLeaf.deletingLastPathComponent()
    let metadataBeforeChild = try RuntimeInventoryMetadataFingerprint.compute(
      release: installedRelease, manifest: document.runtime)
    let addedChild = derivedDirectory.appendingPathComponent("unlisted-after-cache")
    try Data("unlisted".utf8).write(to: addedChild)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o400], ofItemAtPath: addedChild.path)
    let metadataAfterChild = try RuntimeInventoryMetadataFingerprint.compute(
      release: installedRelease, manifest: document.runtime)
    do {
      _ = try metadataCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: metadataSignatures)
      throw TestFailure.failed("An added runtime child reused a stale verified cache entry")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.removeItem(at: addedChild)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o500], ofItemAtPath: derivedDirectory.path)
    metadataRuntime = try metadataCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: metadataSignatures)
    metadataRuntime = nil
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o520], ofItemAtPath: derivedDirectory.path)
    do {
      _ = try metadataCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: metadataSignatures)
      throw TestFailure.failed("Unsafe derived-directory metadata reused a verified cache entry")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: derivedDirectory.path)
    try check(
      metadataBeforeChild != metadataAfterChild
        && metadataCoordinator.verificationRunCount == 4,
      "Added children and derived-directory metadata must force complete same-process reverification"
    )

    let policyCoordinator = RuntimeVerificationCoordinator()
    let acceptingPolicy = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "accepting-signature-policy")
    var policyRuntime = try policyCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: acceptingPolicy)
    try check(
      policyRuntime?.runtimeRoot.path
        == RuntimePath.canonicalExisting(
          installedRelease.appendingPathComponent("runtime", isDirectory: true)),
      "The accepting signature policy must establish its own verified cache entry")
    policyRuntime = nil
    let rejectingPolicy = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "rejecting-signature-policy")
    rejectingPolicy.setRejectCode(true)
    do {
      _ = try policyCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: rejectingPolicy)
      throw TestFailure.failed("A stricter signature checker reused another policy's success")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") {}
    try check(
      policyCoordinator.verificationRunCount == 2 && rejectingPolicy.snapshot().code == 1,
      "Runtime verification caches must remain separated by checker policy")

    let retrySignatures = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "retryable-signature-policy")
    retrySignatures.setRejectCode(true)
    let retryCoordinator = RuntimeVerificationCoordinator()
    do {
      _ = try retryCoordinator.verifiedRuntime(
        resources: resources, support: support, signatureChecker: retrySignatures)
      throw TestFailure.failed("The retry fixture unexpectedly accepted its first verification")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") {}
    retrySignatures.setRejectCode(false)
    var retryRuntime = try retryCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: retrySignatures)
    try check(
      retryRuntime?.runtimeRoot.path
        == RuntimePath.canonicalExisting(
          installedRelease.appendingPathComponent("runtime", isDirectory: true))
        && retryCoordinator.verificationRunCount == 2,
      "A failed verification must be retryable in the same process after the fault clears")
    retryRuntime = nil

    try check(
      support.path.hasPrefix("/var/")
        && RuntimePath.canonicalExisting(support) == "/private\(support.path)",
      "The canonical-alias regression requires macOS's /var to /private/var alias")
    let canonicalSupport = URL(fileURLWithPath: "/private\(support.path)", isDirectory: true)
    let canonicalRuntimeRoot = canonicalSupport.appendingPathComponent(
      "runtime/releases/\(document.runtime.id)/runtime", isDirectory: true)
    let aliasCoordinator = RuntimeVerificationCoordinator()
    let aliasSignatures = RecordingRuntimeSignatureChecker(
      verificationPolicyIdentifier: "canonical-alias-policy")
    var aliasedRuntime = try aliasCoordinator.verifiedRuntime(
      resources: resources, support: support, signatureChecker: aliasSignatures)
    var canonicalRuntime = try aliasCoordinator.verifiedRuntime(
      resources: resources, support: canonicalSupport, signatureChecker: aliasSignatures)
    try check(
      aliasedRuntime?.runtimeRoot == canonicalRuntimeRoot
        && canonicalRuntime?.runtimeRoot == canonicalRuntimeRoot
        && aliasCoordinator.verificationRunCount == 1,
      "A canonical cache hit must never return a stale lexical runtime URL")
    aliasedRuntime = nil
    canonicalRuntime = nil

    try replaceNonCriticalLeaf(with: Data("tampered-library".utf8))
    try? FileManager.default.removeItem(at: executionMarker)
    let rejectionCoordinator = RuntimeVerificationCoordinator()
    let gatedBridge = ProcessBridge(
      support: support, signatureChecker: signatures,
      verificationCoordinator: rejectionCoordinator)
    let trustedCommand = try run(resources, bridge: gatedBridge)
    if case .success? = trustedCommand.outcome {
    } else {
      throw TestFailure.failed("Normal app control must trust installed contents")
    }
    try check(
      FileManager.default.fileExists(atPath: executionMarker.path),
      "Normal launch must not run the full inventory audit")
    var nativeReplacementCalled = false
    _ = try NativeHostLauncher.execute(
      arguments: ["chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/"],
      resources: resources, support: support, signatureChecker: signatures,
      coordinator: rejectionCoordinator,
      replace: { _ in
        nativeReplacementCalled = true
        return 0
      })
    try check(
      nativeReplacementCalled && rejectionCoordinator.verificationRunCount == 0,
      "Normal native launch trusts installed contents without verification fallback")
    do {
      _ = try rejectionCoordinator.inspectRuntime(
        resources: resources, support: support,
        signatureChecker: signatures)
      throw TestFailure.failed("Explicit manual audit must detect a modified runtime leaf")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try replaceNonCriticalLeaf(with: originalLeaf)

    let processSignatures = RecordingRuntimeSignatureChecker()
    let processCoordinator = RuntimeVerificationCoordinator()
    let processBridge = ProcessBridge(
      support: support, signatureChecker: processSignatures,
      verificationCoordinator: processCoordinator)
    try? FileManager.default.removeItem(at: executionMarker)
    let verifiedCommand = try run(resources, bridge: processBridge)
    if case .success? = verifiedCommand.outcome {
    } else {
      throw TestFailure.failed("A valid runtime did not reach app-control launch")
    }
    try check(
      FileManager.default.fileExists(atPath: executionMarker.path)
        && processCoordinator.verificationRunCount == 0,
      "ProcessBridge must launch without a runtime integrity audit")

    try? FileManager.default.removeItem(at: executionMarker)
    try? FileManager.default.removeItem(at: childEntered)
    try? FileManager.default.removeItem(at: releaseChild)
    try Data().write(to: holdChild)
    let heldCapture = Capture()
    let heldDone = DispatchSemaphore(value: 0)
    processBridge.run(
      .status, resources: resources, onEvent: { heldCapture.event($0) },
      onFinish: {
        heldCapture.finish($0)
        heldDone.signal()
      })
    let childDeadline = Date().addingTimeInterval(5)
    while !FileManager.default.fileExists(atPath: childEntered.path), Date() < childDeadline {
      usleep(10_000)
    }
    let childReachedWait = FileManager.default.fileExists(atPath: childEntered.path)
    var processLeaseBlockedPruning = false
    var processUpdateLeaseBlocked = false
    if childReachedWait {
      do {
        let unexpectedLock = try RuntimeFileLock(path: runtimeBootstrapLock, mode: .exclusive)
        _ = unexpectedLock
      } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {
        processLeaseBlockedPruning = true
      }
      do {
        let unexpectedUpdateLease = try DesktopUpdateInstallationLease(
          support: canonicalUpdateSupport)
        withExtendedLifetime(unexpectedUpdateLease) {}
      } catch DesktopUpdateGateFailure.busy {
        processUpdateLeaseBlocked = true
      } catch {}
    }
    try Data().write(to: releaseChild)
    let heldFinished = heldDone.wait(timeout: .now() + 5) == .success
    try? FileManager.default.removeItem(at: holdChild)
    try? FileManager.default.removeItem(at: childEntered)
    try? FileManager.default.removeItem(at: releaseChild)
    var lockAfterChild = try? RuntimeFileLock(path: runtimeBootstrapLock, mode: .exclusive)
    var updateLeaseAfterChild = try? DesktopUpdateInstallationLease(
      support: canonicalUpdateSupport)
    try check(
      childReachedWait && processLeaseBlockedPruning && processUpdateLeaseBlocked
        && heldFinished && lockAfterChild != nil && updateLeaseAfterChild != nil,
      "ProcessBridge must retain runtime and update leases through child completion, then release them"
    )
    lockAfterChild = nil
    updateLeaseAfterChild = nil
    if case .success? = heldCapture.outcome {
    } else {
      throw TestFailure.failed("The held runtime child did not finish successfully")
    }

    try FileManager.default.removeItem(at: executionMarker)
    try replaceNonCriticalLeaf(with: Data("tampered-bytes".utf8))
    let trustedCachedCommand = try run(resources, bridge: processBridge)
    if case .success? = trustedCachedCommand.outcome {
    } else {
      throw TestFailure.failed("Normal launch must not audit post-install content changes")
    }
    try check(
      processCoordinator.verificationRunCount == 0
        && FileManager.default.fileExists(atPath: executionMarker.path),
      "Repeated normal launch must not fall back to full verification")
    try replaceNonCriticalLeaf(with: originalLeaf)

    var nativePlan: NativeHostLaunchPlan?
    var nativeLeaseHeldDuringReplacement = false
    var nativeUpdateLeaseHeldDuringReplacement = false
    let nativeSignatures = RecordingRuntimeSignatureChecker()
    let validCoordinator = RuntimeVerificationCoordinator()
    let replacementResult = try NativeHostLauncher.execute(
      arguments: ["chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/"],
      resources: resources, support: support, signatureChecker: nativeSignatures,
      coordinator: validCoordinator,
      replace: { plan in
        do {
          let unexpectedLock = try RuntimeFileLock(path: runtimeBootstrapLock, mode: .exclusive)
          _ = unexpectedLock
        } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {
          nativeLeaseHeldDuringReplacement = true
        } catch {}
        do {
          let unexpectedUpdateLease = try DesktopUpdateInstallationLease(
            support: canonicalUpdateSupport)
          withExtendedLifetime(unexpectedUpdateLease) {}
        } catch DesktopUpdateGateFailure.busy {
          nativeUpdateLeaseHeldDuringReplacement = true
        } catch {}
        nativePlan = plan
        return 42
      })
    try check(
      replacementResult == 42
        && nativePlan?.arguments.suffix(1)
          == ["chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/"]
        && nativePlan?.environment["MUSICMUTE_LOCAL_ROOT"] == support.path
        && nativePlan?.environment["MUSICMUTE_LOCAL_APP_RESOURCES"] == resources.path
        && nativePlan?.environment["MUSICMUTE_NATIVE_TEST_SECRET"] == nil
        && nativeLeaseHeldDuringReplacement && nativeUpdateLeaseHeldDuringReplacement
        && validCoordinator.verificationRunCount == 0,
      "Native-host exec must forward one bounded origin with only app-derived runtime environment")
    nativePlan = nil
    var lockAfterReplacement = try? RuntimeFileLock(
      path: runtimeBootstrapLock, mode: .exclusive)
    var updateLeaseAfterReplacement = try? DesktopUpdateInstallationLease(
      support: canonicalUpdateSupport)
    try check(
      lockAfterReplacement != nil && updateLeaseAfterReplacement != nil,
      "A returned fake native-host replacement must release its retained runtime and update leases"
    )
    lockAfterReplacement = nil
    updateLeaseAfterReplacement = nil

    nativeSignatures.setRejectOuterApplication(true)
    var trustedSignedResourceReplacement = false
    _ = try NativeHostLauncher.execute(
      arguments: ["chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/"],
      resources: resources, support: support, signatureChecker: nativeSignatures,
      coordinator: validCoordinator,
      replace: { _ in
        trustedSignedResourceReplacement = true
        return 0
      })
    let launchSignatures = nativeSignatures.snapshot()
    try check(
      trustedSignedResourceReplacement && launchSignatures.outer == 0
        && launchSignatures.code == 0,
      "Normal launch must not perform explicit signature audits")
    do {
      _ = try validCoordinator.inspectRuntime(
        resources: resources, support: support,
        signatureChecker: nativeSignatures)
      throw TestFailure.failed("Explicit check must still validate the app signature")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SIGNATURE_INVALID") {}
    nativeSignatures.setRejectOuterApplication(false)
    try replaceNonCriticalLeaf(with: Data("tampered-bytes".utf8))
    do {
      _ = try validCoordinator.inspectRuntime(
        resources: resources, support: support,
        signatureChecker: nativeSignatures)
      throw TestFailure.failed("Explicit check must still detect changed runtime contents")
    } catch RuntimeBootstrapFailure.code("RUNTIME_ARCHIVE_INVALID") {}
    try replaceNonCriticalLeaf(with: originalLeaf)

    try check(
      NativeHostLauncher.validChromeOrigin(
        "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/")
        && NativeHostLauncher.validChromeOrigin(
          "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd")
        && !NativeHostLauncher.validChromeOrigin("https://example.invalid/")
        && !NativeHostLauncher.validChromeOrigin(
          "chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/extra"),
      "Native-host CLI must accept only one canonical Chrome extension origin")

    var incompatibleActive = try JSONSerialization.data(
      withJSONObject: [
        "schema_version": 1, "runtime_id": "macos-arm64-older-app",
        "api_version": 1, "release_path": "releases/macos-arm64-older-app",
        "archive_sha256": String(repeating: "b", count: 64),
      ], options: [.sortedKeys])
    incompatibleActive.append(10)
    try RuntimeFileSecurity.atomicWrite(incompatibleActive, to: activeFile)
    try? FileManager.default.removeItem(at: executionMarker)
    let incompatibleStatus = try run(
      resources,
      bridge: ProcessBridge(
        support: support, signatureChecker: signatures,
        verificationCoordinator: RuntimeVerificationCoordinator()))
    if case .success? = incompatibleStatus.outcome {
    } else {
      throw TestFailure.failed("A safe runtime from an older app version must remain setup-ready")
    }
    try check(
      incompatibleStatus.events.first?.status?.runtimeReady == false
        && !FileManager.default.fileExists(atPath: executionMarker.path),
      "Status must offer setup without executing a safe but incompatible runtime version")
    var incompatibleReplacementCalled = false
    do {
      _ = try NativeHostLauncher.execute(
        arguments: ["chrome-extension://dclpfemnpknfdlpcbfcjkmdbnociippd/"],
        resources: resources, support: support, signatureChecker: signatures,
        coordinator: RuntimeVerificationCoordinator(),
        replace: { _ in
          incompatibleReplacementCalled = true
          return 0
        })
      throw TestFailure.failed("An incompatible runtime version reached native-host exec")
    } catch RuntimeBootstrapFailure.code("APP_RUNTIME_INCOMPATIBLE") {}
    try check(
      !incompatibleReplacementCalled,
      "Chrome startup must fail closed until this app version's runtime is prepared")
    try RuntimeFileSecurity.atomicWrite(activeData, to: activeFile)

    let integrationSupport = root.appendingPathComponent("IntegrationSupport", isDirectory: true)
    let integrationRuntime = integrationSupport.appendingPathComponent(
      "runtime", isDirectory: true)
    let integrationReleases = integrationRuntime.appendingPathComponent(
      "releases", isDirectory: true)
    let integrationDownloads = integrationRuntime.appendingPathComponent(
      "downloads", isDirectory: true)
    for directory in [
      integrationSupport, integrationRuntime, integrationReleases, integrationDownloads,
    ] {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    }
    let integrationCurrentRelease = integrationReleases.appendingPathComponent(
      document.runtime.id, isDirectory: true)
    let previousDocument = try RuntimeBootstrapDocument.decodeValidated(
      try bootstrapData(
        files: files, runtimeID: "macos-arm64-previous",
        archiveSHA256: String(repeating: "f", count: 64)))
    let integrationPreviousRelease = integrationReleases.appendingPathComponent(
      previousDocument.runtime.id, isDirectory: true)
    try FileManager.default.copyItem(at: release, to: integrationCurrentRelease)
    try FileManager.default.copyItem(at: release, to: integrationPreviousRelease)
    let integrationFileAfterDirectoryLink = integrationCurrentRelease.appendingPathComponent(
      "runtime/runtime/python/lib/libfixture.dylib")
    let integrationDirectoryAfterDirectoryLink =
      integrationFileAfterDirectoryLink.deletingLastPathComponent()
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: integrationFileAfterDirectoryLink.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700], ofItemAtPath: integrationDirectoryAfterDirectoryLink.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o500], ofItemAtPath: integrationPreviousRelease.path)
    let integrationActiveFile = integrationRuntime.appendingPathComponent("active.json")
    var previousActiveData = try encoder.encode(
      RuntimeActiveDocument(runtime: previousDocument.runtime))
    previousActiveData.append(10)
    try RuntimeFileSecurity.atomicWrite(previousActiveData, to: integrationActiveFile)

    _ = try privateDownload(integrationDownloads, currentArchiveName)
    _ = try privateDownload(integrationDownloads, "\(currentArchiveName).partial")
    let firstIntegrationStaleDigest = String(repeating: "1", count: 12)
    let secondIntegrationStaleDigest = String(repeating: "2", count: 12)
    _ = try privateDownload(
      integrationDownloads, "macos-arm64-stale-\(firstIntegrationStaleDigest).zip")
    _ = try privateDownload(
      integrationDownloads,
      "macos-arm64-stale-\(secondIntegrationStaleDigest).zip.partial")
    let integrationInstaller = RuntimeBootstrapInstaller(
      resources: resources, support: integrationSupport, signatureChecker: signatures)
    let rolledBackActivation = try integrationInstaller.prepare { _, _ in }
    let frozenFileMode =
      try FileManager.default.attributesOfItem(
        atPath: integrationFileAfterDirectoryLink.path)[.posixPermissions] as? NSNumber
    let frozenDirectoryMode =
      try FileManager.default.attributesOfItem(
        atPath: integrationDirectoryAfterDirectoryLink.path)[.posixPermissions] as? NSNumber
    try check(
      frozenFileMode?.intValue == 0o400 && frozenDirectoryMode?.intValue == 0o500,
      "Runtime freeze must visit files and directories ordered after directory symlinks")
    let downloadsAfterReuse = try FileManager.default.contentsOfDirectory(
      atPath: integrationDownloads.path)
    try check(
      downloadsAfterReuse.isEmpty,
      "Installed-runtime reuse must remove current and stale downloads before activation")
    try check(
      rolledBackActivation.rollback(),
      "A later setup failure must be able to roll back the prepared runtime")
    let activeAfterRollback = try RuntimeFileSecurity.readPrivateFile(
      integrationActiveFile, maximumBytes: 16 * 1024)
    try check(
      activeAfterRollback == previousActiveData
        && FileManager.default.fileExists(atPath: integrationCurrentRelease.path)
        && FileManager.default.fileExists(atPath: integrationPreviousRelease.path),
      "Rollback must restore the old active descriptor and preserve both verified releases")
    let previousResources = root.appendingPathComponent("PreviousResources", isDirectory: true)
    try FileManager.default.createDirectory(
      at: previousResources, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try bootstrapData(
      files: files, runtimeID: previousDocument.runtime.id,
      archiveSHA256: previousDocument.runtime.archiveSha256
    ).write(to: previousResources.appendingPathComponent("runtime-bootstrap.json"))
    try check(
      RuntimeInstallationResolver.runtimeRoot(
        resources: previousResources, support: integrationSupport)
        == integrationPreviousRelease.appendingPathComponent("runtime", isDirectory: true),
      "The restored release must remain resolvable after rollback")

    let integrationUnsafeRelease = integrationReleases.appendingPathComponent(
      "macos-arm64-unsafe", isDirectory: true)
    try FileManager.default.createSymbolicLink(
      atPath: integrationUnsafeRelease.path, withDestinationPath: root.path)
    let failedCommitActivation = try RuntimeBootstrapInstaller(
      resources: resources, support: integrationSupport, signatureChecker: signatures
    ).prepare { _, _ in }
    try check(
      failedCommitActivation.commit() == false,
      "Unsafe release cleanup must fail the coupled activation commit")
    let activeAfterFailedCommit = try RuntimeFileSecurity.readPrivateFile(
      integrationActiveFile, maximumBytes: 16 * 1024)
    try check(
      activeAfterFailedCommit == previousActiveData
        && RuntimeInstallationResolver.runtimeRoot(
          resources: previousResources, support: integrationSupport)
          == integrationPreviousRelease.appendingPathComponent("runtime", isDirectory: true),
      "Commit cleanup failure must restore and resolve the old active runtime")
    try FileManager.default.removeItem(at: integrationUnsafeRelease)

    let successfulActivation = try RuntimeBootstrapInstaller(
      resources: resources, support: integrationSupport, signatureChecker: signatures
    ).prepare { _, _ in }
    try check(successfulActivation.commit(), "A safe runtime activation must commit")
    let remainingReleases = try FileManager.default.contentsOfDirectory(
      atPath: integrationReleases.path)
    let downloadsAfterCommit = try FileManager.default.contentsOfDirectory(
      atPath: integrationDownloads.path)
    try check(
      RuntimeInstallationResolver.activeDocument(support: integrationSupport)
        == RuntimeActiveDocument(runtime: document.runtime)
        && RuntimeInstallationResolver.runtimeRoot(
          resources: resources, support: integrationSupport)
          == integrationCurrentRelease.appendingPathComponent("runtime", isDirectory: true)
        && remainingReleases == [document.runtime.id]
        && downloadsAfterCommit.isEmpty,
      "Successful commit must leave the new active runtime, one release and no downloads")

    let recoveryInstaller = RuntimeBootstrapInstaller(
      resources: resources, support: support, signatureChecker: signatures)
    let preservedActive = try recoveryInstaller.previousActiveData(
      activeFile: activeFile, runtimeDirectory: runtime)
    try check(
      preservedActive == activeData,
      "A usable previous runtime must remain available for rollback")
    var missingOldData = try JSONSerialization.data(
      withJSONObject: [
        "schema_version": 1, "runtime_id": "macos-arm64-old",
        "api_version": 1, "release_path": "releases/macos-arm64-old",
        "archive_sha256": String(repeating: "b", count: 64),
      ], options: [.sortedKeys])
    missingOldData.append(10)
    try RuntimeFileSecurity.atomicWrite(missingOldData, to: activeFile)
    let clearedActive = try recoveryInstaller.previousActiveData(
      activeFile: activeFile, runtimeDirectory: runtime)
    try check(
      clearedActive == nil
        && !FileManager.default.fileExists(atPath: activeFile.path),
      "A structurally safe descriptor for a missing older runtime must clear so setup can repair")
    try RuntimeFileSecurity.atomicWrite(activeData, to: activeFile)
    let previous = try RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)
    let replacement = Data("{\"replacement\":true}\n".utf8)
    try RuntimeFileSecurity.atomicWrite(replacement, to: activeFile)
    let activation = RuntimeActivation(
      runtimeRoot: installedRelease.appendingPathComponent("runtime"), activeFile: activeFile,
      previous: previous, activated: replacement, changed: true)
    activation.rollback()
    let rolledBack = try RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)
    try check(
      rolledBack == previous,
      "Failed setup must atomically restore the preceding active descriptor")
    let committed = RuntimeActivation(
      runtimeRoot: installedRelease.appendingPathComponent("runtime"), activeFile: activeFile,
      previous: replacement, activated: previous, changed: true)
    committed.commit()
    let retained = try RuntimeFileSecurity.readPrivateFile(activeFile, maximumBytes: 16 * 1024)
    try check(
      retained == previous,
      "Committed activation must not roll back on release")

    let concurrent = Data("{\"concurrent\":true}\n".utf8)
    try RuntimeFileSecurity.atomicWrite(replacement, to: activeFile)
    let racedRollback = RuntimeActivation(
      runtimeRoot: installedRelease.appendingPathComponent("runtime"), activeFile: activeFile,
      previous: previous, activated: replacement, changed: true)
    try RuntimeFileSecurity.atomicWrite(concurrent, to: activeFile)
    racedRollback.rollback()
    let racedResult = try RuntimeFileSecurity.readPrivateFile(
      activeFile, maximumBytes: 16 * 1024)
    try check(
      racedResult == concurrent,
      "Rollback must not overwrite an active descriptor replaced by another setup")

    let bootstrapLock = runtime.appendingPathComponent("activation-test.lock")
    var retainedSetupLock: RuntimeFileLock? = try RuntimeFileLock(path: bootstrapLock)
    let lockedActivation = RuntimeActivation(
      runtimeRoot: installedRelease.appendingPathComponent("runtime"), activeFile: activeFile,
      previous: concurrent, activated: concurrent, changed: false,
      setupLock: retainedSetupLock)
    retainedSetupLock = nil
    do {
      _ = try RuntimeFileLock(path: bootstrapLock)
      throw TestFailure.failed("Activation released the bootstrap lock before commit")
    } catch RuntimeBootstrapFailure.code("RUNTIME_SETUP_BUSY") {}
    lockedActivation.commit()
    _ = try RuntimeFileLock(path: bootstrapLock)

    let maintenance = root.appendingPathComponent("Maintenance", isDirectory: true)
    let maintenanceReleases = maintenance.appendingPathComponent("releases", isDirectory: true)
    let maintenanceStaging = maintenance.appendingPathComponent("staging", isDirectory: true)
    try FileManager.default.createDirectory(
      at: maintenanceReleases, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: maintenanceStaging, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    func frozenRelease(_ id: String) throws -> URL {
      let directory = maintenanceReleases.appendingPathComponent(id, isDirectory: true)
      let nested = directory.appendingPathComponent("runtime", isDirectory: true)
      try FileManager.default.createDirectory(
        at: nested, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      let marker = nested.appendingPathComponent("marker")
      try Data(id.utf8).write(to: marker)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o400], ofItemAtPath: marker.path)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o500], ofItemAtPath: nested.path)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o500], ofItemAtPath: directory.path)
      return directory
    }
    let currentRelease = try frozenRelease("runtime-current")
    let previousRelease = try frozenRelease("runtime-previous")
    let staleRelease = try frozenRelease("runtime-stale")
    try RuntimeStorageMaintenance.pruneReleases(
      releases: maintenanceReleases, staging: maintenanceStaging,
      currentID: "runtime-current", previousID: "runtime-previous")
    try check(
      FileManager.default.fileExists(atPath: currentRelease.path)
        && !FileManager.default.fileExists(atPath: previousRelease.path)
        && !FileManager.default.fileExists(atPath: staleRelease.path),
      "Successful activation must prune every non-current owned release")
    let sameIDStale = try frozenRelease("runtime-same-id-stale")
    try RuntimeStorageMaintenance.pruneReleases(
      releases: maintenanceReleases, staging: maintenanceStaging,
      currentID: "runtime-current", previousID: "runtime-current")
    try check(
      !FileManager.default.fileExists(atPath: sameIDStale.path),
      "Same-ID preparation must retry pruning any non-current owned release")

    let rollbackRelease = try frozenRelease("runtime-rollback")
    let unsafeRelease = maintenanceReleases.appendingPathComponent("runtime-unsafe")
    try FileManager.default.createSymbolicLink(
      atPath: unsafeRelease.path, withDestinationPath: root.path)
    do {
      try RuntimeStorageMaintenance.pruneReleases(
        releases: maintenanceReleases, staging: maintenanceStaging,
        currentID: "runtime-current", previousID: "runtime-rollback")
      throw TestFailure.failed("Unsafe release entry was accepted for pruning")
    } catch RuntimeBootstrapFailure.code("RUNTIME_INSTALL_FAILED") {}
    var unsafeInformation = stat()
    try check(
      lstat(unsafeRelease.path, &unsafeInformation) == 0
        && unsafeInformation.st_mode & S_IFMT == S_IFLNK,
      "Unsafe release entries must remain untouched and fail closed")

    let activatedForCleanup = Data("{\"runtime\":\"current\"}\n".utf8)
    try RuntimeFileSecurity.atomicWrite(activatedForCleanup, to: activeFile)
    let cleanupFailureActivation = RuntimeActivation(
      runtimeRoot: installedRelease.appendingPathComponent("runtime"), activeFile: activeFile,
      previous: concurrent, activated: activatedForCleanup, changed: true,
      commitAction: {
        try RuntimeStorageMaintenance.pruneReleases(
          releases: maintenanceReleases, staging: maintenanceStaging,
          currentID: "runtime-current", previousID: "runtime-rollback")
      })
    try check(
      cleanupFailureActivation.commit() == false,
      "Unsafe commit-time pruning must fail the activation commit")
    let cleanupRollback = try RuntimeFileSecurity.readPrivateFile(
      activeFile, maximumBytes: 16 * 1024)
    try check(
      cleanupRollback == concurrent
        && FileManager.default.fileExists(atPath: currentRelease.path)
        && FileManager.default.fileExists(atPath: rollbackRelease.path),
      "Failed pruning must restore the prior descriptor and preserve its rollback release")

    let sharedParent = root.appendingPathComponent("SharedConsumers", isDirectory: true)
    let sharedRuntime = sharedParent.appendingPathComponent(
      "MusicMuteLocal/runtime", isDirectory: true)
    let sharedReleases = sharedRuntime.appendingPathComponent("releases", isDirectory: true)
    let sharedStaging = sharedRuntime.appendingPathComponent("staging", isDirectory: true)
    let consumers = sharedRuntime.appendingPathComponent("consumers", isDirectory: true)
    let workerRoot = sharedParent.appendingPathComponent("MusicMuteWorker", isDirectory: true)
    for directory in [sharedReleases, sharedStaging, consumers, workerRoot] {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    for name in ["runtime-current", "runtime-worker", "runtime-unused"] {
      try FileManager.default.createDirectory(
        at: sharedReleases.appendingPathComponent(name), withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o500])
    }
    let serviceID = String(repeating: "b", count: 64)
    let consumerFile = consumers.appendingPathComponent("\(serviceID).json")
    let consumerRecord: [String: Any] = [
      "schema_version": 1, "consumer": "macos-worker", "runtime_id": "runtime-worker",
      "archive_sha256": String(repeating: "a", count: 64),
      "worker_root": RuntimePath.canonicalExisting(workerRoot)!, "service_id": serviceID,
    ]
    try RuntimeFileSecurity.atomicWrite(
      JSONSerialization.data(withJSONObject: consumerRecord), to: consumerFile, mode: 0o600)
    try RuntimeStorageMaintenance.pruneReleases(
      releases: sharedReleases, staging: sharedStaging, currentID: "runtime-current",
      previousID: nil)
    try check(
      FileManager.default.fileExists(
        atPath: sharedReleases.appendingPathComponent("runtime-worker").path)
        && !FileManager.default.fileExists(
          atPath: sharedReleases.appendingPathComponent("runtime-unused").path),
      "Prepare must retain an independent worker's exact runtime while pruning unused releases")
    try RuntimeFileSecurity.atomicWrite(Data("{}".utf8), to: consumerFile, mode: 0o600)
    do {
      try RuntimeStorageMaintenance.pruneReleases(
        releases: sharedReleases, staging: sharedStaging, currentID: "runtime-current",
        previousID: nil)
      throw TestFailure.failed("Malformed consumer reference allowed runtime pruning")
    } catch RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") {}
    try check(
      FileManager.default.fileExists(
        atPath: sharedReleases.appendingPathComponent("runtime-worker").path),
      "Uncertain references must fail before removing a worker runtime")
    var booleanRecord = consumerRecord
    booleanRecord["schema_version"] = true
    try RuntimeFileSecurity.atomicWrite(
      JSONSerialization.data(withJSONObject: booleanRecord), to: consumerFile, mode: 0o600)
    do {
      _ = try RuntimeStorageMaintenance.referencedRuntimeIDs(releases: sharedReleases)
      throw TestFailure.failed("Boolean consumer schema version was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") {}
    try FileManager.default.removeItem(at: consumerFile)
    try FileManager.default.createSymbolicLink(at: consumerFile, withDestinationURL: activeFile)
    do {
      _ = try RuntimeStorageMaintenance.referencedRuntimeIDs(releases: sharedReleases)
      throw TestFailure.failed("Symlink consumer reference was accepted")
    } catch RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") {}
    try FileManager.default.removeItem(at: consumerFile)
    var foreignRecord = consumerRecord
    foreignRecord["worker_root"] = root.path
    try RuntimeFileSecurity.atomicWrite(
      JSONSerialization.data(withJSONObject: foreignRecord), to: consumerFile, mode: 0o600)
    do {
      _ = try RuntimeStorageMaintenance.referencedRuntimeIDs(releases: sharedReleases)
      throw TestFailure.failed("Foreign worker root was accepted as a consumer")
    } catch RuntimeBootstrapFailure.code("RUNTIME_CONSUMER_REFERENCE_INVALID") {}

    let abandoned = maintenanceStaging.appendingPathComponent(
      "install-11111111-2222-3333-4444-555555555555", isDirectory: true)
    try FileManager.default.createDirectory(
      at: abandoned.appendingPathComponent("nested"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o500], ofItemAtPath: abandoned.path)
    let unrelatedScratch = maintenanceStaging.appendingPathComponent("user-note")
    try Data("keep".utf8).write(to: unrelatedScratch)
    try RuntimeStorageMaintenance.cleanupStaging(maintenanceStaging)
    try check(
      !FileManager.default.fileExists(atPath: abandoned.path)
        && FileManager.default.fileExists(atPath: unrelatedScratch.path),
      "Preparation must remove only bounded MusicMute-owned abandoned staging trees")

    let outsideRuntime = root.appendingPathComponent("OutsideRuntime", isDirectory: true)
    let unsafeSupport = root.appendingPathComponent("UnsafeSupport", isDirectory: true)
    try FileManager.default.createDirectory(
      at: outsideRuntime.appendingPathComponent("releases/forged/runtime"),
      withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(
      at: unsafeSupport, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try FileManager.default.createSymbolicLink(
      atPath: unsafeSupport.appendingPathComponent("runtime").path,
      withDestinationPath: outsideRuntime.path)
    try check(
      !RuntimeInstallationResolver.safeReleaseDirectory(
        unsafeSupport.appendingPathComponent("runtime/releases/forged"),
        support: unsafeSupport),
      "Runtime resolution must reject an intermediate runtime-directory symlink")

    let missingResources = root.appendingPathComponent("MissingResources", isDirectory: true)
    try FileManager.default.createDirectory(
      at: missingResources.appendingPathComponent("companion"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    try manifestData.write(to: missingResources.appendingPathComponent("runtime-bootstrap.json"))
    try Data("fixture".utf8).write(
      to: missingResources.appendingPathComponent("companion/app-control.js"))
    let missing = try run(
      missingResources, command: .status,
      bridge: ProcessBridge(
        support: root.appendingPathComponent("MissingSupport", isDirectory: true)))
    if case .success? = missing.outcome {
    } else {
      throw TestFailure.failed("Missing external runtime status must remain a setup state")
    }
    try check(
      missing.events.first?.status?.runtimeReady == false,
      "Thin app status must report the absent runtime without launching bundled tools")
  }

  static func fixture(script: String?) throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-native-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("runtime/runtime/node/bin"), withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("companion"), withIntermediateDirectories: true)
    try Data("fixture control script".utf8).write(
      to: root.appendingPathComponent("companion/app-control.js"))
    if let script {
      let node = root.appendingPathComponent("runtime/runtime/node/bin/node")
      try Data(("#!/bin/sh\n" + script + "\n").utf8).write(to: node)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    }
    return root
  }
  fileprivate static func run(
    _ root: URL, command: AppCommand = .status, cancel: Bool = false,
    bridge: ProcessBridge = ProcessBridge()
  ) throws -> Capture {
    let capture = Capture()
    let done = DispatchSemaphore(value: 0)
    bridge.run(
      command, resources: root, onEvent: { capture.event($0) },
      onFinish: {
        capture.finish($0)
        done.signal()
      })
    if cancel { DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { bridge.cancel() } }
    guard done.wait(timeout: .now() + 8) == .success else {
      bridge.cancel()
      throw TestFailure.failed("Subprocess did not finish")
    }
    return capture
  }
  static func bridgeChecks() throws {
    setenv("MUSICMUTE_NATIVE_TEST_SECRET", "fixture-must-not-be-inherited", 1)
    defer { unsetenv("MUSICMUTE_NATIVE_TEST_SECRET") }
    let ready = try fixture(
      script:
        "if [ -n \"$MUSICMUTE_NATIVE_TEST_SECRET\" ]; then exit 42; fi\nprintf '%s\\n' '\(status)'\n"
    )
    defer { try? FileManager.default.removeItem(at: ready) }
    let success = try run(ready)
    if case .success? = success.outcome {
    } else {
      throw TestFailure.failed("Expected successful filtered subprocess")
    }
    try check(
      success.events.count == 1 && success.events.first?.status?.complete == true,
      "Parsed result must arrive")
    let missing = try fixture(script: nil)
    defer { try? FileManager.default.removeItem(at: missing) }
    if case .failed("APP_RESOURCES_INCOMPLETE")? = try run(missing).outcome {
    } else {
      throw TestFailure.failed("Missing runtime must surface typed error")
    }
    let malformed = try fixture(script: "printf '%s\\n' '{not-json}'")
    defer { try? FileManager.default.removeItem(at: malformed) }
    if case .failed("APP_CONTROL_INVALID")? = try run(malformed).outcome {
    } else {
      throw TestFailure.failed("Malformed output must stop safely")
    }
    let sleeping = try fixture(script: "exec /bin/sleep 30")
    defer { try? FileManager.default.removeItem(at: sleeping) }
    if case .cancelled? = try run(sleeping, cancel: true).outcome {
    } else {
      throw TestFailure.failed("Cancellation must stop owned process")
    }
  }
  static func journalChecks() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "musicmute-ui-journal-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let logs = root.appendingPathComponent("logs", isDirectory: true)
    let identity = DiagnosticIdentity(
      softwareVersion: "0.1.0", runtimeScope: .development,
      expectedModelSha256: NativeDiagnosticIdentity.expectedModelSha256)
    let journal = UIJournal(logsRoot: logs, maxBytes: 1024, identity: identity)
    for _ in 0..<40 { journal.record(.appStarted) }
    journal.record(.appOperationError, code: "fixture-cookie=/Users/private", command: .setup)
    journal.flushForTesting()
    try check(journal.availableForTesting, "Journal must be available")
    let names = try FileManager.default.contentsOfDirectory(atPath: logs.path)
    try check(
      Set(names) == Set(["ui-events.jsonl", "ui-events.jsonl.1"]),
      "Only two journal segments should remain")
    var total: Int64 = 0
    for name in names {
      let file = logs.appendingPathComponent(name)
      let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
      let size = (attributes[.size] as? NSNumber)?.int64Value ?? -1
      total += size
      try check(size >= 0 && size <= 1024, "Journal segment exceeded bound")
      try check(
        (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "Journal must be private")
      let text = try String(contentsOf: file, encoding: .utf8)
      try check(
        !text.contains("fixture-cookie") && !text.contains("/Users/private"),
        "Free-form code must not persist")
      for line in text.split(separator: "\n") {
        let record = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        try check(
          Set(record.keys)
            == Set(["schema_version", "at", "session_id", "event", "code", "command", "identity"]),
          "Unexpected journal field")
        try check(
          UUID(uuidString: record["session_id"] as? String ?? "") != nil,
          "Journal must correlate session")
        let encodedIdentity = try JSONSerialization.data(withJSONObject: record["identity"] as Any)
        let recordedIdentity = try JSONDecoder().decode(
          DiagnosticIdentity.self, from: encodedIdentity)
        try check(
          recordedIdentity == identity,
          "Every new journal record must retain its recorder-owned identity")
      }
    }
    try check(total <= 2048, "Aggregate journal exceeded quota")
    let text = try String(
      contentsOf: logs.appendingPathComponent("ui-events.jsonl"), encoding: .utf8)
    try check(text.contains("UNKNOWN_ERROR"), "Rejected code must retain safe observation")

    let outside = root.appendingPathComponent("outside", isDirectory: true)
    try FileManager.default.createDirectory(
      at: outside, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let symlink = root.appendingPathComponent("symlink")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
    let blocked = UIJournal(logsRoot: symlink)
    blocked.record(.appStarted)
    blocked.flushForTesting()
    try check(!blocked.availableForTesting, "Symlink journal root must be unavailable")
    let outsideContents = try FileManager.default.contentsOfDirectory(atPath: outside.path)
    try check(outsideContents.isEmpty, "Symlink destination must not be touched")

    let linkedLogs = root.appendingPathComponent("linked", isDirectory: true)
    try FileManager.default.createDirectory(
      at: linkedLogs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let target = root.appendingPathComponent("foreign.jsonl")
    try Data("fixture original".utf8).write(to: target)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    guard link(target.path, linkedLogs.appendingPathComponent("ui-events.jsonl").path) == 0 else {
      throw TestFailure.failed("Could not create link fixture")
    }
    let hardlinked = UIJournal(logsRoot: linkedLogs)
    hardlinked.record(.appStarted)
    hardlinked.flushForTesting()
    try check(!hardlinked.availableForTesting, "Hardlinked journal file must be unavailable")
    let original = try String(contentsOf: target, encoding: .utf8)
    try check(original == "fixture original", "Foreign target must be preserved")
  }
}
