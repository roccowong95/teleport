// macOS-only source. Build with npm run build:mac-helper. Never uses clipboard.
import AppKit
import ApplicationServices

func fail(_ code: Int32 = 1) -> Never { exit(code) }
func focused() -> (AXUIElement, pid_t)? {
    guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &value) == .success,
          let value = value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let element = unsafeBitCast(value, to: AXUIElement.self)
    var roleValue: CFTypeRef?, subroleValue: CFTypeRef?, enabledValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue) == .success,
          let role = roleValue as? String, [kAXTextFieldRole, kAXTextAreaRole].contains(role) else { return nil }
    _ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue)
    if (subroleValue as? String) == kAXSecureTextFieldSubrole { return nil }
    guard AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &enabledValue) == .success,
          (enabledValue as? Bool) == true else { return nil }
    var writable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &writable) == .success, writable.boolValue else { return nil }
    return (element, app.processIdentifier)
}
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 8192, let text = String(data: data, encoding: .utf8), !text.isEmpty,
      let initial = focused() else { fail() }
// Conservative small Unicode chunks; never synthesize Return or clipboard shortcuts.
// Revalidate the same editable AX element and frontmost PID before every chunk.
// A focus race remains possible after the final check; no API provides an atomic
// global-focus-and-post operation. Partial failure must be reported as unknown.
let units = Array(text.utf16)
var offset = 0
while offset < units.count {
    var end = min(offset + 20, units.count)
    if end < units.count && units[end - 1] >= 0xD800 && units[end - 1] <= 0xDBFF { end -= 1 }
    let chunk = Array(units[offset..<end])
    guard let current = focused(), current.1 == initial.1, CFEqual(current.0, initial.0),
          let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { fail() }
    chunk.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress!)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buffer.baseAddress!)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    offset = end
}
