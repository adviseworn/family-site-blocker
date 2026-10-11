// Draws a file's Finder icon (what NSWorkspace, and so Finder, shows for it) into a PNG and prints it as base64.
// usage: icon <file> <pixels>
import AppKit
let path = CommandLine.arguments[1]
let side = Int(CommandLine.arguments[2]) ?? 64
let icon = NSWorkspace.shared.icon(forFile: path)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
icon.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
NSGraphicsContext.restoreGraphicsState()
print(rep.representation(using: .png, properties: [:])!.base64EncodedString())
