import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Store artwork only. These canvases contain no simulated app UI.
// The app icon preserves the Android Solo Signal geometry and colors.
let output = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 255) / 255,
    green: CGFloat((hex >> 8) & 255) / 255,
    blue: CGFloat(hex & 255) / 255,
    alpha: alpha
  )
}

func canvas(_ width: Int, _ height: Int, alpha: Bool = false) -> CGContext {
  let alphaInfo: CGImageAlphaInfo = alpha ? .premultipliedLast : .noneSkipLast
  return CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alphaInfo.rawValue
  )!
}

func save(_ context: CGContext, _ name: String) {
  let destination = CGImageDestinationCreateWithURL(
    output.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1,
    nil
  )!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  precondition(CGImageDestinationFinalize(destination))
}

func roundedBar(
  _ context: CGContext, x: CGFloat, centerY: CGFloat, width: CGFloat,
  height: CGFloat, fill: CGColor
) {
  context.setFillColor(fill)
  context.addPath(
    CGPath(
      roundedRect: CGRect(x: x, y: centerY - height / 2, width: width, height: height),
      cornerWidth: width / 2, cornerHeight: width / 2, transform: nil
    )
  )
  context.fillPath()
}

// Exact fill/stroke/opacity values from res/drawable/ic_vocal.xml.
let icon = canvas(512, 512, alpha: true)
icon.setFillColor(color(0x123C37))
icon.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
icon.saveGState()
icon.scaleBy(x: 512 / 108, y: 512 / 108)
for (xs, endpoints, width, opacity): ([CGFloat], [CGFloat], CGFloat, CGFloat) in [
  ([24, 84], [49, 59], 6, 0.24),
  ([34, 74], [43, 65], 7, 0.38),
  ([44, 64], [36, 72], 8, 0.56),
  ([54], [25, 83], 12, 1),
] {
  icon.setStrokeColor(color(0x96E6C7, alpha: opacity))
  icon.setLineWidth(width)
  icon.setLineCap(.round)
  for x in xs {
    icon.move(to: CGPoint(x: x, y: endpoints[0]))
    icon.addLine(to: CGPoint(x: x, y: endpoints[1]))
    icon.strokePath()
  }
}
icon.restoreGState()
save(icon, "icon-512.png")

func feature(arabic: Bool) {
  let context = canvas(1024, 500)
  let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
    colors: [color(0x123C37), color(0x0F302F), color(0x153A35)] as CFArray,
    locations: [0, 0.55, 1]
  )!
  context.drawLinearGradient(
    gradient, start: CGPoint(x: 0, y: 500), end: CGPoint(x: 1024, y: 0),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
  )

  // A quiet, abstract layered signal. Not a screenshot or measured waveform.
  let center: CGFloat = arabic ? 249 : 775
  context.setStrokeColor(color(0x96E6C7, alpha: 0.08))
  context.setLineWidth(1)
  for radius: CGFloat in [116, 145, 181] {
    context.strokeEllipse(
      in: CGRect(x: center - radius, y: 244 - radius, width: radius * 2, height: radius * 2)
    )
  }

  let heights: [CGFloat] = [22, 38, 71, 48, 103, 146, 199, 158, 96, 63, 87, 41, 25]
  for (index, height) in heights.enumerated() {
    let x = center - 109 + CGFloat(index) * 17
    let alpha: CGFloat = index == 6 ? 1 : max(0.24, 0.72 - abs(CGFloat(index - 6)) * 0.08)
    roundedBar(
      context, x: x, centerY: 244, width: 9, height: height,
      fill: color(0x96E6C7, alpha: alpha)
    )
  }
  for (index, height): (Int, CGFloat) in [34, 57, 29, 85, 44, 63, 31, 48].enumerated() {
    roundedBar(
      context, x: center - 90 + CGFloat(index) * 25, centerY: 244,
      width: 4, height: height, fill: color(0xFF814A, alpha: 0.16)
    )
  }
  context.setFillColor(color(0xFF814A))
  context.fillEllipse(in: CGRect(x: center + 107, y: 330, width: 9, height: 9))

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)

  func text(
    _ value: String, size: CGFloat, weight: NSFont.Weight, top: CGFloat,
    foreground: UInt32 = 0xF5F8F6
  ) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = arabic ? .right : .left
    paragraph.baseWritingDirection = arabic ? .rightToLeft : .leftToRight
    paragraph.lineBreakMode = .byClipping
    let rect = CGRect(x: arabic ? 390 : 96, y: 500 - top - 86, width: 538, height: 86)
    let string = NSAttributedString(
      string: value,
      attributes: [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: NSColor(cgColor: color(foreground))!,
        .paragraphStyle: paragraph,
      ]
    )
    precondition(string.size().width <= rect.width, "Text exceeds the safe area: \(value)")
    string.draw(in: rect)
  }

  text("MusicMute", size: 25, weight: .semibold, top: 80, foreground: 0x96E6C7)
  text(arabic ? "احتفظ بالصوت." : "Keep the voice.", size: 55, weight: .bold, top: 170)
  text(
    arabic ? "قلّل الموسيقى." : "Reduce the music.", size: 49, weight: .bold,
    top: 236, foreground: 0xFF814A
  )
  text(
    arabic ? "استمع. قارن. احفظ." : "Listen. Compare. Save.", size: 22, weight: .medium,
    top: 328, foreground: 0xC1D4CD
  )

  NSGraphicsContext.restoreGraphicsState()
  save(context, arabic ? "feature-graphic-ar-1024x500.png" : "feature-graphic-en-1024x500.png")
}

feature(arabic: false)
feature(arabic: true)
print(output.path)
