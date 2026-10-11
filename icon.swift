// Saves what macOS has as a file's icon to a 128-px PNG: "effective" (URLResourceValues.effectiveIcon, the icon
// Finder normally displays) or "workspace" (NSWorkspace.icon(forFile:)), after giving IconServices a few seconds.
// usage: icon-renderer <file> <effective|workspace> <out.png>
import AppKit
let args = CommandLine.arguments
let url = URL(fileURLWithPath: args[1])
RunLoop.current.run(until: Date().addingTimeInterval(2))
let image: NSImage? = args[2] == "effective"
    ? (try? url.resourceValues(forKeys: [.effectiveIconKey]))?.effectiveIcon as? NSImage
    : NSWorkspace.shared.icon(forFile: args[1])
var rect = NSRect(x: 0, y: 0, width: 128, height: 128)
if let cg = image?.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
    try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[3]))
    print("saved")
} else {
    print("no image")
}
