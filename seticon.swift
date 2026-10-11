// Gives a file a custom Finder icon the way Finder's Get Info paste does (NSWorkspace.setIcon).
// usage: seticon <image> <file>
import AppKit
let image = NSImage(contentsOfFile: CommandLine.arguments[1])!
print(NSWorkspace.shared.setIcon(image, forFile: CommandLine.arguments[2], options: []))
