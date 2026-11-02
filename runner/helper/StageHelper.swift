// Stage's native half: sees the screen, reads the accessibility tree, drives mouse and keyboard, watches hotkeys.
// Speaks JSON lines: {"id":1,"cmd":"click",...} on stdin, {"id":1,"ok":true,...} or {"event":"hotkey",...} on stdout.
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

typealias Json = [String: Any]

struct HelperError: Error { let message: String }

/* ---------- output ---------- */

let outLock = NSLock()
func emit(_ obj: Json) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  outLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
  outLock.unlock()
}

/* ---------- input ---------- */

// Marks our own events, so the hotkey tap can tell the agent's keys from the presenter's.
let OWN_EVENT: Int64 = 0x5354_4147
let eventSource: CGEventSource = {
  let s = CGEventSource(stateID: .privateState)!
  s.userData = OWN_EVENT
  return s
}()

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

func point(_ req: Json) throws -> CGPoint {
  guard let x = num(req["x"]), let y = num(req["y"]) else { throw HelperError(message: "x and y are required") }
  return CGPoint(x: x, y: y)
}

func post(_ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1, flags: CGEventFlags = []) {
  guard let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: at, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.flags = flags
  e.post(tap: .cghidEventTap)
}

/// Glide the real cursor to the target with an ease-out, so the audience can follow it.
func glide(to target: CGPoint, ms: Int, dragging: Bool = false) {
  let start = CGEvent(source: nil)?.location ?? target
  let steps = max(1, ms / 8)
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let e = 1 - pow(1 - t, 3)
    let p = CGPoint(x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e)
    post(dragging ? .leftMouseDragged : .mouseMoved, p)
    usleep(8000)
  }
}

let MODIFIERS: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "super": .maskCommand, "meta": .maskCommand, "win": .maskCommand,
  "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
  "shift": .maskShift,
]

func modifierFlags(_ text: String?) -> CGEventFlags {
  var f: CGEventFlags = []
  for part in (text ?? "").lowercased().split(separator: "+") {
    if let m = MODIFIERS[String(part)] { f.insert(m) }
  }
  return f
}

func click(_ req: Json) throws {
  let p = try point(req)
  let count = Int64(num(req["count"]) ?? 1)
  let name = req["button"] as? String ?? "left"
  let flags = modifierFlags(req["modifiers"] as? String)
  let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
    name == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  glide(to: p, ms: Int(num(req["glideMs"]) ?? 250))
  for i in 1...max(1, count) {
    post(down, p, button, clicks: i, flags: flags)
    usleep(15000)
    post(up, p, button, clicks: i, flags: flags)
    if i < count { usleep(40000) }
  }
}

func drag(_ req: Json) throws {
  guard let fx = num(req["fromX"]), let fy = num(req["fromY"]) else { throw HelperError(message: "fromX and fromY are required") }
  let to = try point(req)
  let from = CGPoint(x: fx, y: fy)
  glide(to: from, ms: 200)
  post(.leftMouseDown, from)
  usleep(60000)
  glide(to: to, ms: 350, dragging: true)
  post(.leftMouseUp, to)
}

let KEYS: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
  "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "page_up": 116,
  "pagedown": 121, "page_down": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressKey(_ req: Json) throws {
  guard let combo = req["combo"] as? String else { throw HelperError(message: "combo is required") }
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for part in combo.split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }) {
    if let m = MODIFIERS[part] { flags.insert(m) } else { code = KEYS[part] }
  }
  guard let code else { throw HelperError(message: "Unknown key: \(combo)") }
  for _ in 0..<max(1, Int(num(req["repeat"]) ?? 1)) {
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down) else { continue }
      e.flags = flags
      e.post(tap: .cghidEventTap)
      usleep(8000)
    }
  }
}

func typeText(_ req: Json) throws {
  guard let text = req["text"] as? String else { throw HelperError(message: "text is required") }
  let delay = useconds_t((num(req["charMs"]) ?? 18) * 1000)
  for ch in text {
    if ch == "\n" {
      try pressKey(["combo": "return"])
    } else {
      let units = Array(String(ch).utf16)
      for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down) else { continue }
        e.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        e.post(tap: .cghidEventTap)
      }
    }
    usleep(delay)
  }
}

func scroll(_ req: Json) throws {
  if req["x"] != nil { glide(to: try point(req), ms: 120) }
  let dx = Int32(num(req["dx"]) ?? 0)
  let dy = Int32(num(req["dy"]) ?? 0)
  guard let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return }
  e.post(tap: .cghidEventTap)
}

/* ---------- screen ---------- */

func displays() -> [Json] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16)
  var count: UInt32 = 0
  CGGetActiveDisplayList(16, &ids, &count)
  let names = Dictionary(
    NSScreen.screens.compactMap { s -> (CGDirectDisplayID, String)? in
      guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
      return (n.uint32Value, s.localizedName)
    },
    uniquingKeysWith: { a, _ in a })
  return ids.prefix(Int(count)).map { id in
    let b = CGDisplayBounds(id)
    return [
      "id": id, "name": names[id] ?? "Display \(id)", "x": b.origin.x, "y": b.origin.y, "width": b.width, "height": b.height,
      "pixelWidth": CGDisplayPixelsWide(id), "pixelHeight": CGDisplayPixelsHigh(id), "main": CGDisplayIsMain(id) != 0,
    ]
  }
}

var filters: [CGDirectDisplayID: SCContentFilter] = [:]

func await_<T>(_ work: @escaping () async throws -> T) throws -> T {
  let done = DispatchSemaphore(value: 0)
  var result: Result<T, Error>?
  Task {
    do { result = .success(try await work()) } catch { result = .failure(error) }
    done.signal()
  }
  done.wait()
  return try result!.get()
}

func filter(for id: CGDirectDisplayID) throws -> SCContentFilter {
  if let f = filters[id] { return f }
  let content = try await_ { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
  guard let d = content.displays.first(where: { $0.displayID == id }) else { throw HelperError(message: "No display \(id)") }
  let f = SCContentFilter(display: d, excludingWindows: [])
  filters[id] = f
  return f
}

/// A 16×9 grayscale thumbnail: a cheap way to ask "did the screen change?"
func grid(_ image: CGImage) -> [Int] {
  let w = 16, h = 9
  var px = [UInt8](repeating: 0, count: w * h)
  px.withUnsafeMutableBytes { buf in
    let ctx = CGContext(
      data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
      bitmapInfo: CGImageAlphaInfo.none.rawValue)
    ctx?.interpolationQuality = .low
    ctx?.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  return px.map(Int.init)
}

func capture(_ req: Json) throws -> Json {
  guard let id = num(req["display"]).map({ CGDirectDisplayID($0) }) else { throw HelperError(message: "display is required") }
  let f = try filter(for: id)
  let bounds = CGDisplayBounds(id)
  let maxSide = num(req["maxSide"]) ?? 2000
  let scale = min(1, maxSide / max(bounds.width, bounds.height))
  let cfg = SCStreamConfiguration()
  cfg.width = Int(bounds.width * scale)
  cfg.height = Int(bounds.height * scale)
  cfg.showsCursor = true
  let image = try await_ { try await SCScreenshotManager.captureImage(contentFilter: f, configuration: cfg) }
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
    throw HelperError(message: "Couldn't encode the screenshot")
  }
  CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
  CGImageDestinationFinalize(dest)
  return ["data": (out as Data).base64EncodedString(), "width": image.width, "height": image.height, "grid": grid(image)]
}

/* ---------- accessibility ---------- */

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func text(_ el: AXUIElement, _ name: String) -> String? {
  guard let s = attr(el, name) as? String, !s.isEmpty else { return nil }
  return s
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var origin = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &origin)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: origin, size: size)
}

let ACTIONABLE: Set<String> = [
  "AXButton", "AXCheckBox", "AXComboBox", "AXLink", "AXMenuButton", "AXMenuItem", "AXPopUpButton", "AXRadioButton",
  "AXRow", "AXSlider", "AXTab", "AXTextArea", "AXTextField",
]

/// The owner of the top window. NSWorkspace's answer can go stale in a process with no NSApplication.
func frontApp() -> NSRunningApplication? {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for w in windows where (w[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
    guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, let app = NSRunningApplication(processIdentifier: pid) else { continue }
    if app.activationPolicy == .regular { return app }
  }
  return NSWorkspace.shared.frontmostApplication
}

func frontmost() -> Json {
  guard let app = frontApp() else { return [:] }
  var out: Json = ["app": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier]
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(el, 0.25)
  if let w = attr(el, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
    let window = w as! AXUIElement
    out["title"] = text(window, kAXTitleAttribute) ?? ""
    if let f = frame(window) { out["frame"] = ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height] }
  }
  return out
}

func tree(_ req: Json) -> Json {
  guard let app = frontApp() else { return ["elements": []] }
  let root = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(root, 0.25)
  guard let w = attr(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return ["elements": []] }
  let limit = Int(num(req["limit"]) ?? 150)
  var visited = 0
  var found: [Json] = []
  func walk(_ el: AXUIElement, _ depth: Int) {
    visited += 1
    if visited > 3000 || depth > 40 || found.count >= limit { return }
    let role = text(el, kAXRoleAttribute) ?? ""
    if ACTIONABLE.contains(role), let f = frame(el), f.width > 1, f.height > 1 {
      let secure = text(el, kAXSubroleAttribute) == "AXSecureTextField"
      let name = text(el, kAXTitleAttribute) ?? text(el, kAXDescriptionAttribute) ?? text(el, kAXHelpAttribute) ?? ""
      var item: Json = ["role": String(role.dropFirst(2)), "name": name, "x": f.minX, "y": f.minY, "width": f.width, "height": f.height]
      if !secure, let v = attr(el, kAXValueAttribute) as? String, !v.isEmpty { item["value"] = String(v.prefix(80)) }
      found.append(item)
    }
    for child in (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth + 1) }
  }
  walk(w as! AXUIElement, 0)
  return ["elements": found]
}

/// Move and size the frontmost window, so an app lands on the stage display at a known place.
func place(_ req: Json) throws {
  guard let app = frontApp() else { throw HelperError(message: "No frontmost app") }
  let el = AXUIElementCreateApplication(app.processIdentifier)
  guard let w = attr(el, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else {
    throw HelperError(message: "\(app.localizedName ?? "App") has no focused window")
  }
  var origin = try point(req)
  var size = CGSize(width: num(req["width"]) ?? 1200, height: num(req["height"]) ?? 800)
  if let v = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(w as! AXUIElement, kAXPositionAttribute as CFString, v) }
  if let v = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(w as! AXUIElement, kAXSizeAttribute as CFString, v) }
}

/* ---------- hotkeys ---------- */

var tap: CFMachPort?
var lastEsc: UInt64 = 0
let DOUBLE_ESC_NS: UInt64 = 400_000_000

// Double Esc stops everything, whichever app has focus. A clicker's PageDown/PageUp are swallowed so the app can't see them.
let onKey: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if event.getIntegerValueField(.eventSourceUserData) == OWN_EVENT { return Unmanaged.passUnretained(event) }
  switch event.getIntegerValueField(.keyboardEventKeycode) {
  case 53:
    let now = DispatchTime.now().uptimeNanoseconds
    if now - lastEsc < DOUBLE_ESC_NS { emit(["event": "hotkey", "name": "stop"]) }
    lastEsc = now
    return Unmanaged.passUnretained(event)
  case 121:
    emit(["event": "hotkey", "name": "advance"])
    return nil
  case 116:
    emit(["event": "hotkey", "name": "back"])
    return nil
  default:
    return Unmanaged.passUnretained(event)
  }
}

func startHotkeys() throws {
  if tap != nil { return }
  let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
  guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: onKey, userInfo: nil) else {
    throw HelperError(message: "Couldn't watch the keyboard. Grant Accessibility permission.")
  }
  tap = t
  DispatchQueue.main.async {
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, t, 0), .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
  }
}

/* ---------- recording ---------- */

// Only runs during Teach. Listens without changing anything, ignores the agent's own events, and reports what the
// presenter does. Nothing typed into a password field gets past focusIsSecure.
var recordTap: CFMachPort?
var recordSource: CFRunLoopSource?
let recordQueue = DispatchQueue(label: "stage.record")
let KEY_NAMES = Dictionary(KEYS.map { ($0.value, $0.key) }, uniquingKeysWith: { a, b in min(a, b) })
let NAMED_ONLY: Set<CGKeyCode> = [36, 48, 51, 53, 115, 116, 117, 119, 121, 123, 124, 125, 126]

func focusIsSecure() -> Bool {
  if IsSecureEventInputEnabled() { return true }
  guard let f = attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID() else { return false }
  return text(f as! AXUIElement, kAXSubroleAttribute) == "AXSecureTextField"
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func emitClick(_ p: CGPoint, button: String, t: Double) {
  var out: Json = ["event": "input", "kind": "click", "x": p.x, "y": p.y, "button": button, "t": t, "app": frontApp()?.localizedName ?? ""]
  var hit: AXUIElement?
  if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let hit {
    out["role"] = (text(hit, kAXRoleAttribute) ?? "").replacingOccurrences(of: "AX", with: "")
    out["name"] = text(hit, kAXTitleAttribute) ?? text(hit, kAXDescriptionAttribute) ?? ""
  }
  emit(out)
}

func emitKey(code: CGKeyCode, flags: CGEventFlags, chars: String, t: Double) {
  if focusIsSecure() { return emit(["event": "input", "kind": "secure", "t": t]) }
  var out: Json = ["event": "input", "kind": "key", "t": t, "app": frontApp()?.localizedName ?? ""]
  let mods = [(CGEventFlags.maskCommand, "cmd"), (.maskControl, "ctrl"), (.maskAlternate, "alt")].filter { flags.contains($0.0) }.map { $0.1 }
  if !mods.isEmpty || NAMED_ONLY.contains(code) {
    out["combo"] = (mods + [KEY_NAMES[code] ?? "key\(code)"]).joined(separator: "+")
  } else {
    out["text"] = chars
  }
  emit(out)
}

let onInput: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let recordTap { CGEvent.tapEnable(tap: recordTap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if event.getIntegerValueField(.eventSourceUserData) == OWN_EVENT { return Unmanaged.passUnretained(event) }
  let t = nowMs()
  if type == .keyDown {
    let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags
    var length = 0
    var units = [UniChar](repeating: 0, count: 8)
    event.keyboardGetUnicodeString(maxStringLength: 8, actualStringLength: &length, unicodeString: &units)
    let chars = String(utf16CodeUnits: units, count: length)
    recordQueue.async { emitKey(code: code, flags: flags, chars: chars, t: t) }
  } else {
    let p = event.location
    let button = type == .rightMouseDown ? "right" : "left"
    recordQueue.async { emitClick(p, button: button, t: t) }
  }
  return Unmanaged.passUnretained(event)
}

func setRecording(_ on: Bool) throws {
  if !on {
    DispatchQueue.main.async {
      if let recordTap { CGEvent.tapEnable(tap: recordTap, enable: false) }
      if let recordSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), recordSource, .commonModes) }
      recordTap = nil
      recordSource = nil
    }
    return
  }
  if recordTap != nil { return }
  let mask = CGEventMask(1 << CGEventType.keyDown.rawValue | 1 << CGEventType.leftMouseDown.rawValue | 1 << CGEventType.rightMouseDown.rawValue)
  guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly, eventsOfInterest: mask, callback: onInput, userInfo: nil) else {
    throw HelperError(message: "Couldn't record input. Grant Accessibility permission.")
  }
  recordTap = t
  let source = CFMachPortCreateRunLoopSource(nil, t, 0)
  recordSource = source
  DispatchQueue.main.async {
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
  }
}

/* ---------- dispatch ---------- */

func handle(_ req: Json) throws -> Json {
  switch req["cmd"] as? String {
  case "status": return ["accessibility": AXIsProcessTrusted(), "screen": CGPreflightScreenCaptureAccess()]
  case "request_permissions":
    let opt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return ["accessibility": AXIsProcessTrustedWithOptions(opt), "screen": CGRequestScreenCaptureAccess()]
  case "displays": return ["displays": displays()]
  case "capture": return try capture(req)
  case "frontmost": return frontmost()
  case "tree": return tree(req)
  case "click": try click(req)
  case "drag": try drag(req)
  case "move": glide(to: try point(req), ms: Int(num(req["glideMs"]) ?? 250))
  case "type": try typeText(req)
  case "key": try pressKey(req)
  case "scroll": try scroll(req)
  case "place": try place(req)
  case "hotkeys": try startHotkeys()
  case "record": try setRecording(req["on"] as? Bool ?? false)
  default: throw HelperError(message: "Unknown command: \(req["cmd"] ?? "none")")
  }
  return [:]
}

Thread.detachNewThread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let req = (try? JSONSerialization.jsonObject(with: data)) as? Json else { continue }
    var reply: Json
    do {
      reply = try handle(req)
      reply["ok"] = true
    } catch {
      reply = ["ok": false, "error": (error as? HelperError)?.message ?? "\(error)"]
    }
    reply["id"] = req["id"]
    emit(reply)
  }
  exit(0)
}

// The event tap needs the main run loop.
RunLoop.main.run()
