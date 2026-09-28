import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Deterministic opaque 1024-pixel Solo Signal icon, independent of display scale.
let canvasSize: CGFloat = 1024
let designScale = canvasSize / 108
let context = CGContext(
  data: nil, width: Int(canvasSize), height: Int(canvasSize), bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 18 / 255, green: 60 / 255, blue: 55 / 255, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))

let bars: [(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, opacity: CGFloat)] = [
  (21, 46, 6, 16, 0.24),
  (30.5, 39.5, 7, 29, 0.38),
  (40, 32, 8, 44, 0.56),
  (48, 19, 12, 70, 1),
  (60, 32, 8, 44, 0.56),
  (70.5, 39.5, 7, 29, 0.38),
  (81, 46, 6, 16, 0.24),
]
for bar in bars {
  context.setFillColor(
    CGColor(red: 150 / 255, green: 230 / 255, blue: 199 / 255, alpha: bar.opacity))
  context.addPath(
    CGPath(
      roundedRect: CGRect(
        x: bar.x * designScale, y: bar.y * designScale,
        width: bar.width * designScale, height: bar.height * designScale),
      cornerWidth: bar.width * designScale / 2,
      cornerHeight: bar.width * designScale / 2,
      transform: nil))
  context.fillPath()
}
let destination = CGImageDestinationCreateWithURL(
  URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil
)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
