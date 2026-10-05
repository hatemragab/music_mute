import AppKit

// Android ic_vocal.xml geometry, rendered directly into native icon sizes.
let destination = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    bitmap.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let scale = CGFloat(size) / 108
    NSGraphicsContext.current?.imageInterpolation = .high
    let transform = NSAffineTransform()
    transform.scale(by: scale)
    transform.concat()
    NSColor(srgbRed: 0x12 / 255.0, green: 0x3c / 255.0, blue: 0x37 / 255.0, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 4, y: 4, width: 100, height: 100), xRadius: 24, yRadius: 24).fill()
    for (x, height, width, alpha) in [(24.0, 10.0, 6.0, 0.24), (34.0, 22.0, 7.0, 0.38), (44.0, 36.0, 8.0, 0.56), (54.0, 58.0, 12.0, 1.0), (64.0, 36.0, 8.0, 0.56), (74.0, 22.0, 7.0, 0.38), (84.0, 10.0, 6.0, 0.24)] {
        NSColor(srgbRed: 0x96 / 255.0, green: 0xe6 / 255.0, blue: 0xc7 / 255.0, alpha: alpha).setStroke()
        let line = NSBezierPath()
        line.lineWidth = width
        line.lineCapStyle = .round
        line.move(to: NSPoint(x: x, y: 54 - height / 2))
        line.line(to: NSPoint(x: x, y: 54 + height / 2))
        line.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    let bytes = bitmap.representation(using: .png, properties: [:])!
    let names: [String]
    switch size {
    case 16: names = ["icon_16x16.png"]
    case 32: names = ["icon_16x16@2x.png", "icon_32x32.png"]
    case 64: names = ["icon_32x32@2x.png"]
    case 128: names = ["icon_128x128.png"]
    case 256: names = ["icon_128x128@2x.png", "icon_256x256.png"]
    case 512: names = ["icon_256x256@2x.png", "icon_512x512.png"]
    default: names = ["icon_512x512@2x.png"]
    }
    for name in names { try bytes.write(to: destination.appendingPathComponent(name)) }
}
