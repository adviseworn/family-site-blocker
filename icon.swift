// Shows what macOS has as a file's icon, three ways, each drawn into a 64-px PNG printed as base64:
//   custom    - the custom icon stored with the file (URLResourceValues.customIcon), or "none"
//   effective - the icon Finder normally displays for it (URLResourceValues.effectiveIcon)
//   workspace - NSWorkspace.icon(forFile:), after giving IconServices a few seconds
// usage: icon-renderer <file> <custom|effective|workspace>
import AppKit
func png(_ image: NSImage) -> String {
    var rect = NSRect(x: 0, y: 0, width: 64, height: 64)
    guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { return "none" }
    return NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!.base64EncodedString()
}
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
switch CommandLine.arguments[2] {
case "custom":
    let icon = try? url.resourceValues(forKeys: [.customIconKey]).customIcon
    print(icon.map(png) ?? "none")
case "effective":
    RunLoop.current.run(until: Date().addingTimeInterval(2))
    let icon = (try? url.resourceValues(forKeys: [.effectiveIconKey]))?.effectiveIcon as? NSImage
    print(icon.map(png) ?? "none")
default:
    let icon = NSWorkspace.shared.icon(forFile: path)
    RunLoop.current.run(until: Date().addingTimeInterval(3))
    print(png(icon))
}
