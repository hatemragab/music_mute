import XCTest

final class ProcessingUITests: XCTestCase {
  private func launch(
    id: String = UUID().uuidString, arabic: Bool = false, offline: Bool = false,
    offlineAfterCache: Bool = false, paginated: Bool = false
  )
    -> XCUIApplication
  {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "--processing-ui-fixture", "--processing-fixture-id", id,
      "-language", arabic ? "ar" : "en", "-appearance", arabic ? "dark" : "light",
    ]
    if arabic {
      app.launchArguments += [
        "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL",
      ]
    }
    if offline { app.launchArguments += ["--processing-fixture-offline"] }
    if offlineAfterCache { app.launchArguments += ["--processing-fixture-offline-after-cache"] }
    if paginated { app.launchArguments += ["--processing-fixture-paginated"] }
    app.launch()
    let processing = app.buttons["openProcessing"]
    XCTAssertTrue(processing.waitForExistence(timeout: 10))
    for _ in 0..<8 where !processing.isHittable { app.scrollViews.firstMatch.swipeUp() }
    XCTAssertTrue(processing.isHittable)
    processing.tap()
    return app
  }

  func testOriginalVoiceComparisonUsesSeparateArtifacts() {
    let app = launch(offlineAfterCache: true)
    openLibraryDetails(1, app)
    reveal(app.buttons["processingPlay"], app: app).tap()
    let original = app.segmentedControls["comparisonSource"].buttons["Original"]
    XCTAssertTrue(original.waitForExistence(timeout: 5))
    original.tap()
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: original)
    waitForExpectations(timeout: 10)
    assertMetric("fixtureOutputRequests", equals: 2, app: app)
    let voice = app.segmentedControls["comparisonSource"].buttons["Voice"]
    voice.tap()
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: voice)
    waitForExpectations(timeout: 10)
    assertMetric("fixtureOutputRequests", equals: 2, app: app)
    attach(app, "Original and voice comparison uses separate cached audio")
  }

  func testLibraryDownloadAndPlayerActionsMatchAndroid() {
    let app = launch()
    let jobID = String(format: "%024d", 1)
    app.tabBars.buttons["Library"].tap()

    let download = app.buttons["libraryDownload-\(jobID)"]
    XCTAssertTrue(download.waitForExistence(timeout: 5))
    download.tap()
    XCTAssertTrue(app.staticTexts["Available offline"].waitForExistence(timeout: 10))

    let play = app.buttons["libraryPlay-\(jobID)"]
    XCTAssertTrue(play.isHittable)
    play.tap()
    let openPlayer = app.buttons["miniPlayerOpen"]
    XCTAssertTrue(openPlayer.waitForExistence(timeout: 10))
    openPlayer.tap()

    let favorite = app.buttons["playerFavorite"]
    XCTAssertTrue(favorite.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["playerSaveOriginal"].isHittable)
    XCTAssertTrue(app.buttons["playerInfo"].isHittable)
    favorite.tap()
    let updatedFavorite = app.buttons["playerFavorite"]
    expectation(
      for: NSPredicate(format: "label == %@", "Remove from favorites"),
      evaluatedWith: updatedFavorite
    )
    waitForExpectations(timeout: 5)
    attach(app, "Library download and Android player actions")

    app.buttons["playerInfo"].tap()
    XCTAssertTrue(app.scrollViews["processingDetail"].waitForExistence(timeout: 10))
  }

  func testUnsupportedLinkIsRejectedOnHome() {
    let app = launch()
    app.tabBars.buttons["Home"].tap()
    let source = app.textFields["urlImportSource"]
    XCTAssertTrue(source.waitForExistence(timeout: 5))
    source.tap()
    source.typeText("https://unknown.example/audio\n")
    let rights = app.switches["urlImportRights"]
    XCTAssertTrue(rights.waitForExistence(timeout: 5))
    for _ in 0..<3 where !rights.isHittable { app.swipeUp() }
    rights.tap()
    app.buttons["submitURLImport"].tap()
    let error = app.staticTexts["urlImportError"]
    XCTAssertTrue(error.waitForExistence(timeout: 5))
    XCTAssertTrue(error.label.contains("not supported"))
    XCTAssertEqual(app.otherElements["fixtureCreatedJobs"].label, "0")
  }

  func testAccountDeletionFinalConfirmationCanBeCancelled() {
    let app = launch()
    app.tabBars.buttons["Settings"].tap()
    app.buttons["Account"].firstMatch.tap()
    let deletion = app.buttons["deleteAccount"]
    for _ in 0..<8 {
      if deletion.isHittable { break }
      app.swipeUp()
    }
    XCTAssertTrue(deletion.isHittable)
    deletion.tap()
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 5))
    app.alerts.buttons["Cancel"].tap()
    XCTAssertFalse(app.alerts.firstMatch.exists)
    XCTAssertTrue(deletion.exists)
  }

  func testListDetailCancellationHidesTerminalHistory() {
    let app = launch()
    row(2, app).tap()
    reveal(app.buttons["processingCancel"], app: app).tap()
    XCTAssertTrue(app.staticTexts["Cancelling…"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["processingRetry"].exists)
    XCTAssertFalse(app.buttons["processingDelete"].exists)
    attach(app, "Processing cancellation remains pending")
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertFalse(app.buttons["audioTask-job:" + String(format: "%024d", 1)].exists)
    XCTAssertFalse(app.buttons["audioTask-job:" + String(format: "%024d", 3)].exists)

  }

  func testArabicDarkLargeTextInterruptedAndReady() throws {
    let app = launch(arabic: true)
    row(4, app).tap()
    XCTAssertTrue(app.scrollViews["processingDetail"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["processingRetry"].exists)
    attach(app, "Arabic dark large text interrupted job")
    app.navigationBars.buttons.firstMatch.tap()
    for _ in 0..<4 { app.scrollViews["processingHistory"].swipeDown() }
    openLibraryDetails(1, app)
    reveal(app.buttons["processingPlay"], app: app)
    XCTAssertTrue(app.buttons["processingSave"].exists)
    attach(app, "Arabic dark large text ready output")
    try app.performAccessibilityAudit(for: [.dynamicType, .textClipped])
  }

  func testFinishedJobsStayInLibraryAcrossOfflineRelaunch() {
    let id = UUID().uuidString
    let app = launch(id: id)
    XCTAssertTrue(row(2, app).exists)
    XCTAssertFalse(app.buttons["audioTask-job:" + String(format: "%024d", 1)].exists)
    openLibraryDetails(1, app)
    app.terminate()
    let offline = launch(id: id, offline: true)
    XCTAssertFalse(offline.buttons["audioTask-job:" + String(format: "%024d", 1)].exists)
    XCTAssertFalse(offline.buttons["audioTask-job:" + String(format: "%024d", 3)].exists)
    offline.tabBars.buttons.element(boundBy: 1).tap()
    XCTAssertTrue(
      offline.buttons["libraryPlay-" + String(format: "%024d", 1)].waitForExistence(timeout: 5))
    attach(offline, "Finished audio remains in Library after offline relaunch")
  }

  func testReadyRenameOnDemandSharePlaybackSaveAndConfirmedDelete() {
    let renamedTitle = "Readiness fixture " + UUID().uuidString
    let app = launch()
    openLibraryDetails(1, app)
    assertMetric("fixtureOutputRequests", equals: 0, app: app)
    reveal(app.buttons["processingRename"], app: app).tap()
    let name = app.textFields["processingName"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    let currentName = name.value as? String ?? ""
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentName.count))
    name.typeText(renamedTitle)
    app.navigationBars.buttons["Save"].tap()
    XCTAssertTrue(app.staticTexts[renamedTitle].waitForExistence(timeout: 5))
    assertMetric("fixtureOutputRequests", equals: 0, app: app)
    attach(app, "Renamed ready audio before any output request")

    reveal(app.buttons["processingShare"], app: app).tap()
    let share = app.otherElements["ActivityListView"]
    XCTAssertTrue(share.waitForExistence(timeout: 10))
    attach(app, "Native processed MP3 share sheet")
    dismissNativeSheet(app)
    assertMetric("fixtureOutputRequests", equals: 1, app: app)

    let play = app.buttons["processingPlay"]
    reveal(play, app: app).tap()
    expectation(for: NSPredicate(format: "label CONTAINS 'Pause'"), evaluatedWith: play)
    waitForExpectations(timeout: 10)
    let seek = app.sliders.firstMatch
    reveal(seek, app: app)
    seek.adjust(toNormalizedSliderPosition: 0.5)
    attach(app, "Validated synthetic MP3 playback and seek")
    play.tap()
    reveal(app.buttons["processingSave"], app: app).tap()
    XCTAssertTrue(
      app.navigationBars.buttons["Export"].waitForExistence(timeout: 10)
        || app.buttons["Move"].exists || app.buttons["Save"].exists)
    attach(app, "Processing output native Save to Files picker")
    let save = app.buttons["Save"].firstMatch
    if save.exists, save.isHittable {
      save.tap()
      XCTAssertTrue(app.buttons["processingPlay"].waitForExistence(timeout: 5))
    } else {
      dismissNativeSheet(app)
    }
    // This fixture counts all artifact grants. Playback prefetches the original
    // once for comparison; saving the cached voice must not request a third grant.
    assertMetric("fixtureOutputRequests", equals: 2, app: app)
    reveal(play, app: app).tap()
    expectation(for: NSPredicate(format: "label CONTAINS 'Pause'"), evaluatedWith: play)
    waitForExpectations(timeout: 5)
    reveal(app.buttons["processingDelete"], app: app).tap()
    let confirmation = app.sheets.buttons["Delete"]
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    attach(app, "Terminal audio deletion requires confirmation")
    confirmation.tap()
    XCTAssertTrue(app.scrollViews["processingHistory"].waitForExistence(timeout: 5))
    app.tabBars.buttons.element(boundBy: 1).tap()
    let deleted = app.buttons["libraryPlay-" + String(format: "%024d", 1)]
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: deleted)
    waitForExpectations(timeout: 5)
    attach(app, "Deleted processed audio removed from library")
  }

  func testNativeFileRequiresRightsAndCloudConfirmation() {
    let fixtureID = "00000000-0000-4000-8000-" + UUID().uuidString.suffix(12)
    let app = launch(id: fixtureID)
    reveal(app.buttons["processingImport"], app: app, scrollID: "processingHistory").tap()
    let browse = app.buttons["Browse"].firstMatch
    if browse.waitForExistence(timeout: 3), browse.isHittable { browse.tap() }
    tapPickerItem("On My iPhone", app: app)
    openPickerFolder("MusicMute", containingAnyOf: ["UITestImports"], app: app)
    tapPickerItem("UITestImports", app: app)
    openPickerFolder(
      fixtureID, containingAnyOf: ["Fixture input", "Fixture input.mp3"], app: app)
    attach(app, "Native Files picker shows synthetic fixture audio")
    tapPickerItem("Fixture input", app: app, alternate: "Fixture input.mp3")
    confirmReview(app)
    assertMetric("fixtureCreatedJobs", equals: 1, app: app)
    if app.scrollViews["processingDetail"].exists {
      app.navigationBars.buttons.firstMatch.tap()
    }
    XCTAssertTrue(app.scrollViews["processingHistory"].waitForExistence(timeout: 5))
    XCTAssertTrue(row(5, app).exists)
    row(5, app).tap()
    XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.scrollViews["processingDetail"].staticTexts["Find source"].exists)
    XCTAssertFalse(app.scrollViews["processingDetail"].staticTexts["Download audio"].exists)
    attach(app, "Selected local audio queued only after rights and cloud confirmation")
  }

  private func confirmReview(_ app: XCUIApplication) {
    let confirm = app.buttons["confirmCloudProcessing"]
    let appeared = confirm.waitForExistence(timeout: 10)
    if !appeared { attach(app, "Missing audio review after native selection") }
    XCTAssertTrue(appeared)
    XCTAssertFalse(confirm.isEnabled)
    let trim = app.switches["importTrimSilence"]
    XCTAssertTrue(trim.exists)
    XCTAssertEqual(trim.value as? String, "1", "Trimming should be enabled by default")
    trim.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    XCTAssertEqual(trim.value as? String, "0")
    trim.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    XCTAssertEqual(trim.value as? String, "1")
    app.switches["importRightsConfirmation"].coordinate(
      withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)
    ).tap()
    XCTAssertTrue(confirm.isEnabled)
    confirm.tap()
  }

  private func openLibraryDetails(_ number: Int, _ app: XCUIApplication) {
    app.tabBars.buttons.element(boundBy: 1).tap()
    let details = app.buttons["libraryDetails-" + String(format: "%024d", number)]
    XCTAssertTrue(details.waitForExistence(timeout: 5))
    reveal(details, app: app, scrollID: nil).tap()
  }

  func testLibraryLoadsOlderAudioAndHomeHidesFinishedJobs() {
    let app = launch(paginated: true)
    XCTAssertTrue(row(2, app).exists)
    XCTAssertFalse(app.buttons["audioTask-job:" + String(format: "%024d", 1)].exists)
    app.tabBars.buttons.element(boundBy: 1).tap()
    XCTAssertTrue(
      app.buttons["libraryPlay-" + String(format: "%024d", 1)].waitForExistence(timeout: 5))
    let more = app.buttons["libraryLoadMore"]
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    reveal(more, app: app, scrollID: nil).tap()
    XCTAssertTrue(
      app.buttons["libraryPlay-" + String(format: "%024d", 6)].waitForExistence(timeout: 5))
    XCTAssertFalse(more.exists)
    attach(app, "Library retains earlier audio and loads the next page")
  }

  private func row(_ number: Int, _ app: XCUIApplication) -> XCUIElement {
    let item = app.buttons["audioTask-job:" + String(format: "%024d", number)]
    return reveal(item, app: app, scrollID: "processingHistory")
  }

  @discardableResult private func reveal(
    _ item: XCUIElement, app: XCUIApplication, scrollID: String? = "processingDetail"
  ) -> XCUIElement {
    let scroll = scrollID.map { app.scrollViews[$0] } ?? app.scrollViews.firstMatch
    for _ in 0..<12 {
      if item.isHittable { return item }
      if item.exists && item.frame.maxY < app.frame.midY {
        scroll.swipeDown()
      } else {
        scroll.swipeUp()
      }
    }
    XCTAssertTrue(item.waitForExistence(timeout: 5))
    XCTAssertTrue(item.isHittable)
    return item
  }

  private func assertMetric(_ id: String, equals expected: Int, app: XCUIApplication) {
    let metric = app.descendants(matching: .any).matching(identifier: id).firstMatch
    XCTAssertTrue(metric.waitForExistence(timeout: 5))
    let text = String(expected)
    expectation(
      for: NSPredicate(format: "label == %@ OR value == %@", text, text), evaluatedWith: metric)
    waitForExpectations(timeout: 5)
  }

  private func tapPickerItem(
    _ label: String, app: XCUIApplication, alternate: String? = nil
  ) {
    let names = [label, alternate].compactMap { $0 }
    for _ in 0..<5 {
      for name in names {
        let cell = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch
        if cell.waitForExistence(timeout: 1), cell.isHittable {
          // Let XCTest choose a hittable point: a partially scrolled grid cell's
          // upper icon can sit behind the Files search/navigation overlay.
          cell.tap()
          return
        }
        for item in app.staticTexts.matching(identifier: name).allElementsBoundByIndex
        where item.isHittable {
          item.tap()
          return
        }
        let button = app.buttons[name].firstMatch
        if button.exists, button.isHittable {
          button.tap()
          return
        }
      }
      app.swipeUp()
    }
    attach(app, "Missing native picker item: " + label)
    XCTFail("Native picker did not expose " + label)
  }

  private func openPickerFolder(
    _ label: String, containingAnyOf children: [String], app: XCUIApplication
  ) {
    let candidates = app.cells.containing(.staticText, identifier: label)
    XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 5))
    let candidateCount = candidates.count
    for index in 0..<candidateCount {
      let candidate = candidates.element(boundBy: index)
      guard candidate.exists, candidate.isHittable else { continue }
      for _ in 0..<2 {
        candidate.tap()
        if children.contains(where: {
          let expectedChild = app.staticTexts.matching(identifier: $0).firstMatch
          return expectedChild.waitForExistence(timeout: 5)
        }) {
          return
        }
        // Files can ignore a grid tap while its scroll view is settling. If the
        // same folder is still visible, retry it instead of navigating backward.
        if candidate.exists, candidate.isHittable { continue }
        break
      }
      let navigationButtons = app.navigationBars.buttons.allElementsBoundByIndex
      guard
        let back = navigationButtons.first(where: {
          $0.isHittable
            && ($0.identifier == "BackButton"
              || (!$0.label.localizedCaseInsensitiveContains("actions menu")
                && !$0.label.localizedCaseInsensitiveContains("more")
                && !$0.label.localizedCaseInsensitiveContains("cancel")
                && !$0.label.localizedCaseInsensitiveContains("close")))
        })
      else {
        XCTFail("Native picker back button is not available")
        return
      }
      back.tap()
      XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 5))
    }
    let childDescription = children.joined(separator: " or ")
    attach(app, "Missing native picker folder containing: " + childDescription)
    XCTFail("Native picker did not expose " + label + " containing " + childDescription)
  }

  private func dismissNativeSheet(_ app: XCUIApplication) {
    let close = app.buttons["Close"].firstMatch
    if close.exists, close.isHittable {
      close.tap()
    } else {
      let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.10))
      top.press(
        forDuration: 0.1,
        thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
    }
    XCTAssertTrue(app.scrollViews["processingDetail"].waitForExistence(timeout: 5))
  }

  private func attach(_ app: XCUIApplication, _ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
