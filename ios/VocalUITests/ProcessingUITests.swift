import XCTest

final class ProcessingUITests: XCTestCase {
  private func launch(
    id: String = UUID().uuidString, arabic: Bool = false, offline: Bool = false,
    pasteURL: String? = nil
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
    if let pasteURL { app.launchArguments += ["--processing-fixture-paste-url", pasteURL] }
    app.launch()
    let tab = app.tabBars.buttons[arabic ? "معالجة الصوت" : "Voice processing"]
    XCTAssertTrue(tab.waitForExistence(timeout: 10))
    tab.tap()
    return app
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

  func testListDetailCancellationAndRetryNewJob() {
    let app = launch()
    row(2, app).tap()
    reveal(app.buttons["processingCancel"], app: app).tap()
    XCTAssertTrue(app.staticTexts["Cancelling…"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["processingRetry"].exists)
    XCTAssertFalse(app.buttons["processingDelete"].exists)
    attach(app, "Processing cancellation remains pending")
    app.navigationBars.buttons.firstMatch.tap()
    row(3, app).tap()
    reveal(app.buttons["processingRetry"], app: app).tap()
    XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["processingRetry"].exists)
    attach(app, "Retry opens newly queued job")
  }

  func testArabicDarkLargeTextInterruptedAndReady() throws {
    let app = launch(arabic: true)
    row(4, app).tap()
    XCTAssertTrue(app.scrollViews["processingDetail"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["processingRetry"].exists)
    attach(app, "Arabic dark large text interrupted job")
    app.navigationBars.buttons.firstMatch.tap()
    for _ in 0..<4 { app.scrollViews["processingHistory"].swipeDown() }
    row(1, app).tap()
    reveal(app.buttons["processingPlay"], app: app)
    XCTAssertTrue(app.buttons["processingSave"].exists)
    attach(app, "Arabic dark large text ready output")
    try app.performAccessibilityAudit(for: [.dynamicType, .textClipped])
  }

  func testCachedHistorySurvivesOfflineRelaunch() {
    let id = UUID().uuidString
    let app = launch(id: id)
    XCTAssertTrue(row(1, app).exists)
    app.terminate()
    let offline = launch(id: id, offline: true)
    XCTAssertTrue(row(1, offline).exists)
    XCTAssertTrue(row(3, offline).exists)
    attach(offline, "Processing safe cache after offline relaunch")
  }

  func testReadyRenameOnDemandSharePlaybackSaveAndConfirmedDelete() {
    let app = launch()
    row(1, app).tap()
    assertMetric("fixtureOutputRequests", equals: 0, app: app)
    reveal(app.buttons["processingRename"], app: app).tap()
    let name = app.textFields["processingName"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    let currentName = name.value as? String ?? ""
    name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: currentName.count))
    name.typeText("Studio interview")
    app.navigationBars.buttons["Save"].tap()
    XCTAssertTrue(app.staticTexts["Studio interview"].waitForExistence(timeout: 5))
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
    dismissNativeSheet(app)
    assertMetric("fixtureOutputRequests", equals: 1, app: app)
    reveal(play, app: app).tap()
    expectation(for: NSPredicate(format: "label CONTAINS 'Pause'"), evaluatedWith: play)
    waitForExpectations(timeout: 5)
    reveal(app.buttons["processingDelete"], app: app).tap()
    let confirmation = app.sheets.buttons["Delete"]
    XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
    attach(app, "Terminal audio deletion requires confirmation")
    confirmation.tap()
    XCTAssertTrue(app.scrollViews["processingHistory"].waitForExistence(timeout: 5))
    let deleted = app.buttons["audioTask-job:" + String(format: "%024d", 1)]
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: deleted)
    waitForExpectations(timeout: 5)
    attach(app, "Deleted processed audio removed from library")
  }

  func testExplicitDownloadAndNativeFileRequireRightsAndCloudConfirmation() {
    let fixtureID = "00000000-0000-4000-8000-" + UUID().uuidString.suffix(12)
    let app = launch(id: fixtureID, pasteURL: "https://youtu.be/jNQXAC9IVRw")
    for number in 5...6 {
      app.tabBars.buttons["Home"].tap()
      if number == 5 {
        reveal(app.buttons["YouTube (secondary option)"], app: app, scrollID: nil).tap()
      }
      reveal(app.buttons["pasteURL"], app: app, scrollID: nil).tap()
      XCTAssertTrue(app.textFields["youtubeURL"].exists || app.textViews["youtubeURL"].exists)
      reveal(app.buttons["downloadAudio"], app: app, scrollID: nil).tap()
      confirmReview(app)
      XCTAssertTrue(app.scrollViews["processingHistory"].waitForExistence(timeout: 5))
      XCTAssertTrue(row(number, app).exists)
    }
    assertMetric("fixtureCreatedJobs", equals: 2, app: app)
    row(5, app).tap()
    for label in [
      "Find source", "Download audio", "Preparing audio…", "Creating the processing job…",
      "Uploading audio…", "Confirming the upload…", "Checking audio", "Removing music",
      "Saving voice result",
    ] {
      XCTAssertTrue(app.scrollViews["processingDetail"].staticTexts[label].exists, label)
    }
    attach(app, "Confirmed URL task exposes all transfer and worker stages")
    app.navigationBars.buttons.firstMatch.tap()
    reveal(app.buttons["processingImport"], app: app, scrollID: "processingHistory").tap()
    let browse = app.buttons["Browse"].firstMatch
    if browse.waitForExistence(timeout: 3), browse.isHittable { browse.tap() }
    tapPickerItem("On My iPhone", app: app)
    openPickerFolder("MusicMute", containing: "UITestImports", app: app)
    tapPickerItem("UITestImports", app: app)
    tapPickerItem(fixtureID, app: app)
    attach(app, "Native Files picker shows synthetic fixture audio")
    tapPickerItem("Fixture input", app: app, alternate: "Fixture input.mp3")
    confirmReview(app)
    assertMetric("fixtureCreatedJobs", equals: 3, app: app)
    if app.scrollViews["processingDetail"].exists {
      app.navigationBars.buttons.firstMatch.tap()
    }
    XCTAssertTrue(app.scrollViews["processingHistory"].waitForExistence(timeout: 5))
    XCTAssertTrue(row(7, app).exists)
    row(7, app).tap()
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
    app.switches["importRightsConfirmation"].coordinate(
      withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)
    ).tap()
    XCTAssertTrue(confirm.isEnabled)
    confirm.tap()
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
        let cell = app.cells.containing(.staticText, identifier: name).firstMatch
        if cell.exists, cell.isHittable {
          // Files grid captions can have a separate hit region. Activate the
          // icon in the upper part of the matched cell, including wrapped names.
          cell.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
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
    _ label: String, containing child: String, app: XCUIApplication
  ) {
    let candidates = app.cells.containing(.staticText, identifier: label)
    XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 5))
    let candidateCount = candidates.count
    for index in 0..<candidateCount {
      let candidate = candidates.element(boundBy: index)
      guard candidate.exists, candidate.isHittable else { continue }
      candidate.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      let expectedChild = app.staticTexts.matching(identifier: child).firstMatch
      if expectedChild.waitForExistence(timeout: 2), expectedChild.isHittable {
        return
      }
      guard
        let back = app.navigationBars.buttons.allElementsBoundByIndex.first(where: { $0.isHittable }
        )
      else {
        XCTFail("Native picker back button is not available")
        return
      }
      back.tap()
      XCTAssertTrue(candidates.firstMatch.waitForExistence(timeout: 5))
    }
    attach(app, "Missing native picker folder containing: " + child)
    XCTFail("Native picker did not expose " + label + " containing " + child)
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
