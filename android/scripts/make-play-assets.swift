import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Reuses the existing Solo Signal mark. These are promotional assets, never
// screenshots or claims of Android runtime validation. Run from the repo root.
let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "artifacts/google-play")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let markURL = URL(fileURLWithPath: "ios/Vocal/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
guard let source = CGImageSourceCreateWithURL(markURL as CFURL, nil),
  let mark = CGImageSourceCreateImageAtIndex(source, 0, nil)
else { fatalError("Existing MusicMute icon is required") }

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor {
  CGColor(red: red / 255, green: green / 255, blue: blue / 255, alpha: 1)
}

func canvas(_ width: Int, _ height: Int) -> CGContext {
  CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
}

func save(_ context: CGContext, _ name: String) {
  let destination = CGImageDestinationCreateWithURL(
    output.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  precondition(CGImageDestinationFinalize(destination))
}

let icon = canvas(512, 512)
icon.setFillColor(color(18, 60, 55))
icon.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
icon.interpolationQuality = .high
icon.draw(mark, in: CGRect(x: 0, y: 0, width: 512, height: 512))
save(icon, "icon-512.png")

func feature(arabic: Bool) {
  let context = canvas(1024, 500)
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
    colors: [color(18, 60, 55), color(27, 89, 74)] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: 500),
    end: CGPoint(x: 1024, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

  // Abstract audio signal communicates separation without invented app UI.
  let heights: [CGFloat] = [26, 48, 78, 40, 104, 58, 140, 206, 140, 58, 104, 40, 78, 48, 26]
  for (index, height) in heights.enumerated() {
    let x = CGFloat(index) * 16 + (arabic ? 116 : 678)
    let opacity: CGFloat = index == 7 ? 1 : (index % 2 == 0 ? 0.34 : 0.16)
    context.setFillColor(color(150, 230, 199).copy(alpha: opacity)!)
    context.addPath(CGPath(roundedRect: CGRect(x: x, y: 228 - height / 2, width: 8, height: height),
      cornerWidth: 4, cornerHeight: 4, transform: nil))
    context.fillPath()
  }
  let graphics = NSGraphicsContext(cgContext: context, flipped: false)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = graphics

  func text(_ value: String, size: CGFloat, weight: NSFont.Weight, y: CGFloat, mint: Bool = false) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = arabic ? .right : .left
    paragraph.baseWritingDirection = arabic ? .rightToLeft : .leftToRight
    let rect = CGRect(x: arabic ? 386 : 104, y: y, width: 534, height: 80)
    NSAttributedString(string: value, attributes: [
      .font: NSFont.systemFont(ofSize: size, weight: weight),
      .foregroundColor: NSColor(cgColor: mint ? color(150, 230, 199) : color(243, 248, 245))!,
      .paragraphStyle: paragraph,
    ]).draw(in: rect)
  }

  text("MusicMute", size: 25, weight: .semibold, y: 335, mint: true)
  text(arabic ? "احتفظ بالصوت." : "Keep the voice.", size: 52, weight: .bold, y: 243)
  text(arabic ? "قلّل الموسيقى." : "Reduce the music.", size: 48, weight: .bold, y: 179, mint: true)
  text(arabic ? "استمع. قارن. احفظ." : "Listen. Compare. Save.", size: 22, weight: .medium, y: 103)
  NSGraphicsContext.restoreGraphicsState()
  save(context, arabic ? "feature-graphic-ar-1024x500.png" : "feature-graphic-en-1024x500.png")
}

feature(arabic: false)
feature(arabic: true)
print(output.path)
