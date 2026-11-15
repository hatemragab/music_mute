import XCTest

final class VocalUITests: XCTestCase {
  private func launch(fixture: Bool = true) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-language", "en", "-appearance", "light",
      "-sourceURL", "",
    ]
    if fixture { app.launchArguments += ["--processing-ui-fixture"] }
    app.launch()
    return app
  }
  func testHomeValidationAndSettings() {
    let app = launch()
    reveal(app.buttons["YouTube (secondary option)"], app: app)
    app.buttons["YouTube (secondary option)"].tap()
    let input =
      app.textFields["youtubeURL"].exists
      ? app.textFields["youtubeURL"] : app.textViews["youtubeURL"]
    reveal(input, app: app)
    input.tap()
    input.typeText("https://example.com/video")
    let download = app.buttons["downloadAudio"]
    reveal(download, app: app)
    download.tap()
    XCTAssertTrue(app.staticTexts["invalidURL"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Settings"].tap()
    attach(app, name: "Settings after explicit invalid download")
    XCTAssertTrue(app.buttons["Account"].firstMatch.waitForExistence(timeout: 5))
  }

  func testArabicDarkAndLargeText() {
    let app = XCUIApplication()
    app.launchArguments = [
      "--processing-ui-fixture", "-language", "ar", "-appearance", "dark",
      "-UIPreferredContentSizeCategoryName",
      "UICTContentSizeCategoryAccessibilityXL",
    ]
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["السجل"].waitForExistence(timeout: 10))
    attach(app, name: "Arabic dark large text home")
    app.tabBars.buttons["السجل"].tap()
    XCTAssertTrue(app.staticTexts["أصواتك"].waitForExistence(timeout: 5))
    attach(app, name: "Arabic dark large text history")
  }

  // Explicit opt-in real network test. Run with -only-testing:VocalUITests/VocalUITests/testLiveDownloadPlaybackAndExport.
  func testLiveDownloadPlaybackAndExport() throws {
    guard ProcessInfo.processInfo.environment["VOCAL_LIVE_TEST"] == "1" else {
      throw XCTSkip("Set VOCAL_LIVE_TEST=1 in the test scheme for real YouTube testing.")
    }
    let app = launch(fixture: false)
    reveal(app.buttons["YouTube (secondary option)"], app: app)
    app.buttons["YouTube (secondary option)"].tap()
    let input =
      app.textFields["youtubeURL"].exists
      ? app.textFields["youtubeURL"] : app.textViews["youtubeURL"]
    reveal(input, app: app)
    input.tap()
    if let value = input.value as? String, !value.isEmpty {
      input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
    }
    input.typeText("https://www.youtube.com/watch?v=jNQXAC9IVRw")
    reveal(app.buttons["downloadAudio"], app: app)
    app.buttons["downloadAudio"].tap()
    let firstRow = app.otherElements.matching(
      NSPredicate(format: "identifier BEGINSWITH 'audioRow-' ")
    )
    .firstMatch
    XCTAssertTrue(firstRow.waitForExistence(timeout: 10))
    let row = app.otherElements[firstRow.identifier]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    let complete = row.staticTexts["downloadComplete"]
    XCTAssertTrue(complete.waitForExistence(timeout: 100), "Real download did not complete")
    let play = row.buttons["playAudio"]
    reveal(play, app: app)
    play.tap()
    XCTAssertTrue(app.sliders["audioSeek"].waitForExistence(timeout: 10))
    let pause = NSPredicate(format: "label CONTAINS 'Pause'")
    expectation(for: pause, evaluatedWith: play)
    waitForExpectations(timeout: 10)
    XCTAssertTrue(row.staticTexts["playbackTime"].label.hasSuffix("/ 0:19"))
    attach(app, name: "Downloaded original AAC playing")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    XCTAssertTrue(play.label.contains("Pause"), "Audio should continue in the background")
    play.tap()
    app.sliders["audioSeek"].adjust(toNormalizedSliderPosition: 0.5)
    let save = row.buttons["saveAudio"]
    reveal(save, app: app)
    save.tap()
    XCTAssertTrue(
      app.navigationBars.buttons["Export"].waitForExistence(timeout: 10)
        || app.buttons["Move"].exists || app.buttons["Save"].exists)
    attach(app, name: "Native Save to Files picker")
    if app.buttons["Export"].exists {
      app.buttons["Export"].tap()
    } else if app.buttons["Save"].exists {
      app.buttons["Save"].tap()
    } else {
      app.buttons["Move"].tap()
    }
    if app.alerts.buttons["Keep Both"].waitForExistence(timeout: 2) {
      app.alerts.buttons["Keep Both"].tap()
    }
    XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.alerts.firstMatch.label.contains("Audio saved"))
    app.alerts.buttons["OK"].tap()
    app.terminate()
    app.launch()
    app.tabBars.buttons["History"].tap()
    XCTAssertTrue(app.staticTexts["downloadComplete"].firstMatch.waitForExistence(timeout: 10))
    attach(app, name: "Persistent history after relaunch")
  }
  func testRadioLinkDownloadAndPlayback() throws {
    guard ProcessInfo.processInfo.environment["VOCAL_LIVE_TEST"] == "1" else {
      throw XCTSkip("Set VOCAL_LIVE_TEST=1 for real YouTube testing.")
    }
    let app = launch(fixture: false)
    reveal(app.buttons["YouTube (secondary option)"], app: app)
    app.buttons["YouTube (secondary option)"].tap()
    let input =
      app.textFields["youtubeURL"].exists
      ? app.textFields["youtubeURL"] : app.textViews["youtubeURL"]
    reveal(input, app: app)
    input.tap()
    input.typeText(
      "https://www.youtube.com/watch?v=EiRpINIoHbU&list=RDGMEMWO-g6DgCWEqKlDtKbJA1GwVMEiRpINIoHbU&start_radio=1"
    )
    reveal(app.buttons["downloadAudio"], app: app)
    app.buttons["downloadAudio"].tap()
    let firstRow = app.otherElements.matching(
      NSPredicate(format: "identifier BEGINSWITH 'audioRow-' ")
    )
    .firstMatch
    XCTAssertTrue(firstRow.waitForExistence(timeout: 10))
    let row = app.otherElements[firstRow.identifier]
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    let terminal = NSPredicate { _, _ in
      row.staticTexts["downloadComplete"].exists || row.staticTexts["downloadFailure"].exists
    }
    XCTAssertTrue(row.staticTexts["downloadPercent"].waitForExistence(timeout: 30))
    XCTAssertTrue(row.staticTexts["downloadBytes"].exists)
    attach(app, name: "Live download percentage and bytes")
    expectation(for: terminal, evaluatedWith: row)
    waitForExpectations(timeout: 660)
    attach(app, name: "Radio link download outcome")
    XCTAssertTrue(
      row.staticTexts["downloadComplete"].exists,
      "Download failed: \(row.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: "; "))"
    )
    let play = row.buttons["playAudio"]
    reveal(play, app: app)
    play.tap()
    expectation(for: NSPredicate(format: "label CONTAINS 'Pause'"), evaluatedWith: play)
    waitForExpectations(timeout: 10)
    attach(app, name: "Radio link original audio playing")
    play.tap()
  }

  private func attach(_ app: XCUIApplication, name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  private func reveal(_ element: XCUIElement, app: XCUIApplication) {
    for _ in 0..<12 {
      if element.isHittable { return }
      if element.exists && element.frame.midY > app.frame.midY {
        app.scrollViews.firstMatch.swipeUp()
      } else {
        app.scrollViews.firstMatch.swipeDown()
      }
    }
    XCTAssertTrue(element.exists)
  }
}
