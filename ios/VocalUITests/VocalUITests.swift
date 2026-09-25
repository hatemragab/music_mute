import XCTest

final class VocalUITests: XCTestCase {
  private func launch(fixture: Bool = true) -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchArguments = [
      "-AppleLanguages", "(en)", "-AppleLocale", "en_US", "-language", "en", "-appearance", "light",
    ]
    if fixture { app.launchArguments += ["--processing-ui-fixture"] }
    app.launch()
    return app
  }
  func testHomeValidationAndSettings() {
    let app = launch()
    XCTAssertFalse(app.buttons["downloadAudio"].exists)
    app.tabBars.buttons["Settings"].tap()
    attach(app, name: "Settings from local import home")
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
    XCTAssertTrue(app.tabBars.buttons["معالجة الصوت"].waitForExistence(timeout: 10))
    attach(app, name: "Arabic dark large text home")
    app.tabBars.buttons["معالجة الصوت"].tap()
    XCTAssertTrue(app.staticTexts["معالجة الصوت"].waitForExistence(timeout: 5))
    attach(app, name: "Arabic dark large text history")
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
