import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Frames a complete, real Android capture. Never generates or alters app UI.
// Usage: swift compose-store-screenshots.swift input.png output.png "Sign in to MusicMute"
// The source capture is retained unchanged; existing outputs are never overwritten.

struct CompositionError: Error, CustomStringConvertible {
  let description: String
}

func color(_ hex: UInt32) -> CGColor {
  CGColor(
    red: CGFloat((hex >> 16) & 255) / 255,
    green: CGFloat((hex >> 8) & 255) / 255,
    blue: CGFloat(hex & 255) / 255,
    alpha: 1
  )
}

func compose(input: URL, output: URL, caption: String) throws {
  guard ["Sign in to MusicMute", "Create your MusicMute account"].contains(caption) else {
    throw CompositionError(description: "Use one of the two literal authentication captions.")
  }
  guard output.pathExtension.lowercased() == "png" else {
    throw CompositionError(description: "The output must have a .png extension.")
  }
  guard !FileManager.default.fileExists(atPath: output.path) else {
    throw CompositionError(description: "Output already exists; choose a new path.")
  }
  guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
    CGImageSourceGetType(source) as String? == UTType.png.identifier,
    CGImageSourceGetCount(source) == 1,
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
    (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue == 1080,
    (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue == 2400,
    ((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1) == 1,
    let capture = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else {
    throw CompositionError(description: "Input must be a single, upright 1080 x 2400 PNG capture.")
  }
  guard let space = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil, width: 1080, height: 1920, bitsPerComponent: 8, bytesPerRow: 0,
      space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    )
  else {
    throw CompositionError(description: "Unable to create the RGB canvas.")
  }

  context.setFillColor(color(0x123C37))
  context.fill(CGRect(x: 0, y: 0, width: 1080, height: 1920))
  context.interpolationQuality = .high
  // CoreGraphics uses a bottom-left origin. The full capture occupies the lower
  // 1800 pixels, leaving a separate 120-pixel header above it. Both axes scale 75%.
  context.draw(capture, in: CGRect(x: 135, y: 0, width: 810, height: 1800))

  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = .center
  paragraph.baseWritingDirection = .leftToRight
  paragraph.lineBreakMode = .byClipping
  let title = NSAttributedString(
    string: caption,
    attributes: [
      .font: NSFont.systemFont(ofSize: 40, weight: .semibold),
      .foregroundColor: NSColor(cgColor: color(0x96E6C7))!,
      .paragraphStyle: paragraph,
    ]
  )
  let titleSize = title.size()
  guard titleSize.width <= 810, titleSize.height <= 120 else {
    throw CompositionError(description: "Caption does not fit in the header.")
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  title.draw(
    in: CGRect(x: 135, y: 1800 + (120 - titleSize.height) / 2, width: 810,
      height: titleSize.height)
  )
  NSGraphicsContext.restoreGraphicsState()

  let data = NSMutableData()
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithData(
      data, UTType.png.identifier as CFString, 1, nil
    )
  else {
    throw CompositionError(description: "Unable to encode the composed PNG.")
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    throw CompositionError(description: "PNG encoding failed.")
  }
  // withoutOverwriting also protects a file created after the earlier path check.
  try (data as Data).write(to: output, options: .withoutOverwriting)
}

do {
  guard CommandLine.arguments.count == 4 else {
    throw CompositionError(
      description: "Usage: swift compose-store-screenshots.swift input.png output.png caption"
    )
  }
  let input = URL(fileURLWithPath: CommandLine.arguments[1])
  let output = URL(fileURLWithPath: CommandLine.arguments[2])
  try compose(input: input, output: output, caption: CommandLine.arguments[3])
  print("Saved RGB 1080 x 1920 PNG: \(output.path)")
} catch {
  FileHandle.standardError.write(Data("Screenshot composition failed: \(error)\n".utf8))
  exit(1)
}
