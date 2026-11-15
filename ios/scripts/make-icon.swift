import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Deterministic opaque 1024-pixel waveform icon, independent of display scale.
let context = CGContext(
  data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setFillColor(CGColor(red: 0.055, green: 0.14, blue: 0.12, alpha: 1))
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
let heights: [CGFloat] = [180, 330, 530, 280, 620, 410, 240]
context.setFillColor(CGColor(red: 0.58, green: 0.88, blue: 0.76, alpha: 1))
for (index, height) in heights.enumerated() {
  context.addPath(
    CGPath(
      roundedRect: CGRect(
        x: 182 + CGFloat(index) * 96, y: (1024 - height) / 2, width: 66, height: height),
      cornerWidth: 33, cornerHeight: 33, transform: nil))
  context.fillPath()
}
let destination = CGImageDestinationCreateWithURL(
  URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL, UTType.png.identifier as CFString, 1, nil
)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
