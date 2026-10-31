import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import ScreenCaptureKit

struct ControlRequest {
    let operation: String
    let readRequest: Request
    let captureStamp: [String: Any]?
    let nodeId: String?
    let text: String?
    let key: String?
    let x: Double?
    let y: Double?
    let deltaY: Int?
    init(_ object: [String: Any]) throws {
        let readKeys: Set<String> = ["id", "bundleId", "pid", "windowId", "expectedRuntimeGeneration", "expectedWindowGeneration", "includeText", "maxNodes", "maxDepth", "outputDirectory"]
        let extra: Set<String> = ["operation", "captureStamp", "nodeId", "text", "key", "x", "y", "deltaY"]
        guard Set(object.keys).isSubset(of: readKeys.union(extra)),
              let op = object["operation"] as? String,
              ["probe", "mirror", "axSnapshot", "launch", "activate", "activateApp", "enableAccessibility", "press", "click", "type", "key", "scroll"].contains(op) else {
            throw ReadFailure(code: "invalid_control_request", message: "Unsupported control request.")
        }
        operation = op
        var base = object.filter { readKeys.contains($0.key) }
        base["operation"] = "probe"
        if ["mirror", "axSnapshot", "press", "click", "type", "key", "scroll"].contains(op) { base["includeText"] = true }
        base["maxNodes"] = 5000; base["maxDepth"] = 80
        readRequest = try Request(base)
        captureStamp = object["captureStamp"] as? [String: Any]
        nodeId = object["nodeId"] as? String
        text = object["text"] as? String
        key = object["key"] as? String
        func number(_ field: String) -> Double? {
            guard let n = object[field] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        x = number("x"); y = number("y")
        let scroll = number("deltaY")
        deltaY = scroll != nil && abs(scroll!) <= 2000 && scroll!.rounded() == scroll! ? Int(scroll!) : nil
        if !["launch", "probe"].contains(op) && readRequest.runtimeGeneration == nil {
            throw ReadFailure(code: "generation_required", message: "A runtime generation is required.")
        }
        if ["mirror", "activate", "press", "click", "type", "key", "scroll"].contains(op) &&
            (readRequest.windowId == nil || readRequest.windowGeneration == nil) {
            throw ReadFailure(code: "generation_required", message: "The target window and its generation are required.")
        }
        if ["press", "click", "type", "key", "scroll"].contains(op), captureStamp == nil {
            throw ReadFailure(code: "capture_stamp_required", message: "A current window capture stamp is required.")
        }
        if op == "press" && nodeId == nil { throw ReadFailure(code: "node_required", message: "A control node is required.") }
        if op == "type" && (nodeId == nil || text == nil || text!.isEmpty || text!.utf16.count > 8000) {
            throw ReadFailure(code: "invalid_text", message: "A target input and bounded non-empty text are required.")
        }
        if ["click", "scroll"].contains(op) && (x == nil || y == nil) { throw ReadFailure(code: "coordinates_required", message: "Window-local coordinates are required.") }
        if op == "scroll" && deltaY == nil { throw ReadFailure(code: "invalid_scroll", message: "A bounded scroll delta is required.") }
        if op == "key" && !["enter", "escape", "tab", "shift-enter", "command-enter", "command-a", "backspace", "command-n", "up", "down", "left", "right"].contains(key ?? "") {
            throw ReadFailure(code: "invalid_key", message: "The requested key is not supported.")
        }
    }
}

struct MirrorRead {
    let result: [String: Any]
    let reader: SnapshotReader?
}

enum ControlEffect {
    @MainActor static var started = false
    @MainActor static var clipboardRestoration: String?
}

func layoutHash(_ image: CGImage, contextOnly: Bool = false, caretRegions: [CGRect] = []) throws -> String {
    // 缩略布局 CAS 忽略极小光标闪烁；可操作 AX 控件身份/值另有严格语义 CAS。
    let dimension = 64
    var pixels = [UInt8](repeating: 0, count: dimension * dimension)
    let success = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: dimension, height: dimension,
            bitsPerComponent: 8, bytesPerRow: dimension, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: dimension, height: dimension))
        return true
    }
    guard success else { throw ReadFailure(code: "layout_image_failed", message: "The screenshot layout cannot be measured.") }
    let quantized = pixels.enumerated().map { index, value -> UInt8 in
        let x = Double(index % dimension) / Double(dimension)
        let y = Double(index / dimension) / Double(dimension)
        if contextOnly && x > 0.18 && y > 0.10 && y < 0.80 { return 0 }
        let tile = CGRect(x: x, y: y, width: 1.0 / Double(dimension), height: 1.0 / Double(dimension))
        if caretRegions.contains(where: { $0.intersects(tile) }) { return 0 }
        return value / 16
    }
    return SHA256.hash(data: Data(quantized)).map { String(format: "%02x", $0) }.joined()
}

func isActionableControl(_ node: [String: Any]) -> Bool {
    let actions = node["actions"] as? [String] ?? []
    let role = node["role"] as? String ?? ""
    let input = ["AXTextArea", "AXTextField", "AXComboBox", "AXSlider", "AXScrollBar"].contains(role)
    return actions.contains(kAXPressAction) || (input && node["valueSettable"] as? Bool == true)
}

func controlLayout(_ nodes: [[String: Any]]) throws -> String {
    let layout = nodes.filter { node in
        isActionableControl(node) || node["role"] as? String == "AXWindow"
    }.map { node -> [String: Any] in
        var item = node.filter { $0.key != "text" && $0.key != "caretBounds" }
        let role = node["role"] as? String ?? ""
        if !(node["actions"] as? [String] ?? []).isEmpty || ["AXTextArea", "AXTextField", "AXWindow"].contains(role) {
            if let text = node["text"] { item["text"] = text }
        }
        return item
    }
    return digest(String(decoding: try JSONSerialization.data(withJSONObject: layout, options: [.sortedKeys]), as: UTF8.self))
}

func axContext(_ nodes: [[String: Any]], chromeOnly: Bool = false, bounds: CGRect) throws -> String {
    let composer = nodes.filter { isMainComposerInput($0, windowBounds: rectangle(bounds)) }
    let primary = nodes.filter { node in
        guard node["role"] as? String == "AXButton", let texts = node["text"] as? [String: String],
              let rect = node["bounds"] as? [String: Double], let y = rect["y"], y - bounds.minY > bounds.height * 0.8 else { return false }
        return texts.values.contains { ["send", "send now", "stop", "发送", "立即发送", "停止"].contains($0.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
    let paths = (composer + primary).compactMap { $0["path"] as? [Int] }
    var composerPath = paths.first ?? []
    for path in paths.dropFirst() {
        composerPath = Array(zip(composerPath, path).prefix { $0.0 == $0.1 }.map { $0.0 })
    }
    let selected = nodes.filter { node in
        guard chromeOnly else { return true }
        if !composerPath.isEmpty, let path = node["path"] as? [Int], path.starts(with: composerPath) { return true }
        guard let rect = node["bounds"] as? [String: Double], let x = rect["x"], let y = rect["y"],
              let width = rect["width"], let height = rect["height"] else { return false }
        // 底部20%仍会含滚动正文，顶部10%也可能含正文首行；仅按真实composer子树与header/sidebar取上下文。
        let sidebar = x - bounds.minX <= bounds.width * 0.18 && width <= bounds.width * 0.45
        let header = y >= bounds.minY && y + height <= bounds.minY + 64
        return sidebar || header
    }.map { $0.filter { !["caretBounds", "focused"].contains($0.key) } }
    return digest(String(decoding: try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys]), as: UTF8.self))
}

func logicalWindows(_ target: RunningTarget) -> [AXUIElement] {
    allLogicalWindows(target)
}

@MainActor func readAXSnapshot(_ request: ControlRequest, target: RunningTarget) throws -> [String: Any] {
    let read = request.readRequest
    let physical = try verifiedWindow(read, target)
    guard let hash = request.captureStamp?["axWindowHash"] as? NSNumber else { throw ReadFailure(code: "capture_stamp_required", message: "A bound AX window identity is required.") }
    let matches = logicalWindows(target).filter { CFHash($0) == hash.uintValue }
    guard matches.count == 1, let logical = axBounds(matches[0]) else { throw ReadFailure(code: "window_ambiguous", message: "The logical AX window cannot be uniquely resolved.") }
    let reader = SnapshotReader(read, windowGeneration: read.windowGeneration!)
    reader.read(matches[0]); reader.finalizeIdentity()
    let controls = reader.nodes.filter(isActionableControl).map { node -> [String: Any] in
        var item = node
        if let rect = node["bounds"] as? [String: Double], let x = rect["x"], let y = rect["y"] {
            item["localBounds"] = ["x": x - logical.minX, "y": y - logical.minY, "width": rect["width"] ?? 0, "height": rect["height"] ?? 0]
        }
        return item
    }
    var stops: [String: String] = [:]
    for node in reader.nodes where isSemanticTarget(node, windowBounds: rectangle(logical)) { if let id = node["nodeId"] as? String { stops[id] = try targetFingerprint(node) } }
    let stamp: [String: Any] = ["runtimeGeneration": target.runtimeGeneration, "windowGeneration": read.windowGeneration!, "bounds": rectangle(logical),
        "physicalBounds": rectangle(physical.bounds), "axWindowHash": CFHash(matches[0]), "axContextGeneration": try axContext(reader.nodes, bounds: logical),
        "axChromeGeneration": try axContext(reader.nodes, chromeOnly: true, bounds: logical), "layoutGeneration": try controlLayout(reader.nodes),
        "imageLayoutHash": "ax-only", "semanticTargets": stops]
    try verifyStillCurrent(read, target)
    return ["kind": "window-mirror", "captureMode": "ax-only", "imagePath": NSNull(), "controls": controls, "captureStamp": stamp,
        "contentFreshness": "ax-observation-only", "presentationVerified": false,
        "window": physical.metadata(target.runtimeGeneration, includeText: false), "logicalBounds": rectangle(logical), "physicalBounds": rectangle(physical.bounds),
        "coordinateControlAvailable": false, "semanticControlAvailable": true, "sessionIdentityVerified": false, "axNodeCount": reader.nodes.count,
        "axTruncated": reader.truncated, "axText": reader.nodes.compactMap { node in (node["text"] as? [String: String])?["value"] }.filter { !$0.isEmpty },
        "capturedAt": ISO8601DateFormatter().string(from: Date()), "runtimeGeneration": target.runtimeGeneration]
}

@MainActor func semanticControl(_ request: ControlRequest, target: RunningTarget) async throws -> [String: Any] {
    let read = request.readRequest
    _ = try verifiedWindow(read, target)
    guard let stamp = request.captureStamp, let expectedHash = stamp["axWindowHash"] as? NSNumber else {
        throw ReadFailure(code: "capture_stamp_required", message: "A captured AX window identity is required.")
    }
    let matching = logicalWindows(target).filter { CFHash($0) == expectedHash.uintValue }
    guard matching.count == 1, let bounds = axBounds(matching[0]), stamp["bounds"] as? [String: Double] == rectangle(bounds) else {
        throw ReadFailure(code: "stale_view", message: "The logical application window identity or layout changed.")
    }
    let window = matching[0]
    var owner: pid_t = 0
    guard AXUIElementGetPid(window, &owner) == .success, owner == target.pid,
          attribute(window, kAXRoleAttribute) as? String == "AXWindow" else {
        throw ReadFailure(code: "stale_view", message: "The captured window owner cannot be verified.")
    }
    let reader = SnapshotReader(read, windowGeneration: read.windowGeneration!)
    reader.read(window); reader.finalizeIdentity()
    guard !reader.structuralTruncated, let index = reader.nodes.firstIndex(where: { $0["nodeId"] as? String == request.nodeId }) else {
        throw ReadFailure(code: "control_unavailable", message: "The original control is not available in this window.")
    }
    let node = reader.nodes[index], element = reader.elements[index]
    let stop = request.operation == "press" && isStopControl(node, windowBounds: rectangle(bounds))
    let composerAction = stop || request.operation == "type" && isMainComposerInput(node, windowBounds: rectangle(bounds)) || request.operation == "press" && isComposerSendControl(node, windowBounds: rectangle(bounds))
    guard !reader.nodes.contains(where: { isMainComposerInput($0, windowBounds: rectangle(bounds)) && $0["editableValueTruncated"] as? Bool == true }),
          composerAction || !reader.truncated else {
        throw ReadFailure(code: "context_truncated", message: "The complete input/control context is not available; review it in the desktop application.")
    }
    if composerAction {
        guard let saved = (stamp["semanticTargets"] as? [String: String])?[request.nodeId!], saved == (try targetFingerprint(node)) else {
            throw ReadFailure(code: "stale_view", message: "The captured composer/Stop target fingerprint changed.")
        }
        guard stamp["axChromeGeneration"] as? String == (try axContext(reader.nodes, chromeOnly: true, bounds: bounds)) else {
            throw ReadFailure(code: "stale_view", message: "The captured window chrome context changed.")
        }
    } else {
        guard stamp["axContextGeneration"] as? String == (try axContext(reader.nodes, bounds: bounds)) else {
            throw ReadFailure(code: "stale_view", message: "The captured control or its AX context changed.")
        }
    }
    if ["type", "key"].contains(request.operation) {
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(node["role"] as? String ?? ""),
              request.operation == "key" || (attribute(element, kAXValueAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ReadFailure(code: "draft_conflict", message: "The target input is not empty; its existing draft is preserved.")
        }
        if request.operation == "type" { _ = try await pasteText(request.text!, input: element, window: window, request: read, target: target) }
        else {
            try await focusInput(element, window: window, request: read, target: target)
            try postKey(request.key!, pid: target.pid)
        }

    } else {
        guard node["enabled"] as? Bool != false, (node["actions"] as? [String] ?? []).contains(kAXPressAction) else {
            throw ReadFailure(code: "control_unavailable", message: "The captured control is not enabled for pressing.")
        }
        ControlEffect.started = true
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else {
            throw ReadFailure(code: "press_effect_unconfirmed", message: "The native control action result is not confirmed.")
        }
    }
    try verifyStillCurrent(read, target)
    return ["performed": true, "operation": request.operation, "semanticAX": true, "injectionMethod": request.operation == "type" ? "standard-paste" : request.operation == "key" ? "standard-key" : "AXPress", "businessAcceptanceVerified": false,
        "runtimeGeneration": target.runtimeGeneration, "windowGeneration": read.windowGeneration!]
}

@MainActor func requireExactInputFocus(_ input: AXUIElement, _ window: AXUIElement, _ target: RunningTarget) throws {
    try requireUnlocked()
    let app = AXUIElementCreateApplication(target.pid)
    let focusedWindow = attribute(app, kAXFocusedWindowAttribute)
    let focusedInput = attribute(app, kAXFocusedUIElementAttribute)
    var owner: pid_t = 0
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
          AXUIElementGetPid(input, &owner) == .success, owner == target.pid,
          focusedWindow != nil, CFEqual(focusedWindow!, window),
          focusedInput != nil, CFEqual(focusedInput!, input) else {
        throw ReadFailure(code: "input_focus_unconfirmed", message: "The exact application/window/input focus is not confirmed.")
    }
}

@MainActor func focusInput(_ input: AXUIElement, window: AXUIElement, request: Request, target: RunningTarget) async throws {
    ControlEffect.started = true
    _ = target.app.activate(options: [])
    guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success,
          AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
        throw ReadFailure(code: "input_focus_failed", message: "The verified target input cannot be focused.")
    }
    let focusDeadline = Date().addingTimeInterval(1.5)
    while Date() < focusDeadline {
        if (try? requireExactInputFocus(input, window, target)) != nil { break }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    try verifyStillCurrent(request, target)
    try requireExactInputFocus(input, window, target)
}

@MainActor func pasteText(_ text: String, input: AXUIElement, window: AXUIElement, request: Request, target: RunningTarget) async throws -> String {
    let access = SystemPasteboard()
    let snapshot = try snapshotPasteboard(access)
    let transaction = PasteboardTransaction(access, snapshot: snapshot)
    var restored: String?
    defer { ControlEffect.clipboardRestoration = restored ?? transaction.restore() }
    try await focusInput(input, window: window, request: request, target: target)
    guard (attribute(input, kAXValueAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw ReadFailure(code: "draft_conflict", message: "The target draft changed before paste; it was preserved.")
    }
    try transaction.install(text)
    try verifyStillCurrent(request, target)
    try requireExactInputFocus(input, window, target)
    try transaction.requireOwnership()
    guard (attribute(input, kAXValueAttribute) as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw ReadFailure(code: "draft_conflict", message: "The draft changed immediately before paste; it was preserved.")
    }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
        throw ReadFailure(code: "keyboard_event_failed", message: "A standard paste event cannot be created.")
    }
    down.flags = .maskCommand; up.flags = .maskCommand
    down.post(tap: .cgSessionEventTap); up.post(tap: .cgSessionEventTap)
    let deadline = Date().addingTimeInterval(1.5)
    var confirmed = false
    repeat {
        try verifyStillCurrent(request, target)
        try requireExactInputFocus(input, window, target)
        let actual = attribute(input, kAXValueAttribute) as? String ?? ""
        if actual == text || (actual.hasSuffix("\n") && String(actual.dropLast()) == text) { confirmed = true; break }
        try await Task.sleep(nanoseconds: 20_000_000)
    } while Date() < deadline
    guard confirmed else {
        throw ReadFailure(code: "input_effect_unconfirmed", message: "Paste was dispatched once but the full editor text is not confirmed.")
    }
    restored = transaction.restore()
    guard restored != "failed" else { throw ReadFailure(code: "clipboard_restore_failed", message: "Input was confirmed but clipboard restoration failed.") }
    return restored!
}

func targetFingerprint(_ node: [String: Any]) throws -> String {
    let fields = ["nodeId", "path", "role", "subrole", "identifier", "actions", "enabled", "bounds", "text"]
    let descriptor = node.filter { fields.contains($0.key) }
    return digest(String(decoding: try JSONSerialization.data(withJSONObject: descriptor, options: [.sortedKeys]), as: UTF8.self))
}

func isSemanticTarget(_ node: [String: Any], windowBounds: [String: Double]?) -> Bool {
    isStopControl(node, windowBounds: windowBounds) || isComposerSendControl(node, windowBounds: windowBounds) || ["AXTextArea", "AXTextField", "AXComboBox"].contains(node["role"] as? String ?? "")
}

func isMainComposerInput(_ node: [String: Any], windowBounds: [String: Double]?) -> Bool {
    guard node["role"] as? String == "AXTextArea", node["valueSettable"] as? Bool == true,
          let placeholder = (node["text"] as? [String: String])?["placeholder"], !placeholder.isEmpty,
          let windowBounds, let rect = node["bounds"] as? [String: Double],
          let y = rect["y"], let width = rect["width"], let height = rect["height"],
          let wy = windowBounds["y"], let ww = windowBounds["width"], let wh = windowBounds["height"] else { return false }
    return y - wy > wh * 0.8 && width > ww * 0.3 && height < wh * 0.2
}

func isComposerSendControl(_ node: [String: Any], windowBounds: [String: Double]?) -> Bool {
    guard node["role"] as? String == "AXButton", (node["actions"] as? [String] ?? []).contains(kAXPressAction),
          node["enabled"] as? Bool != false, let texts = node["text"] as? [String: String],
          let windowBounds, let bounds = node["bounds"] as? [String: Double], let x = bounds["x"], let y = bounds["y"],
          let ox = windowBounds["x"], let oy = windowBounds["y"], let width = windowBounds["width"], let height = windowBounds["height"],
          x - ox > width * 0.6, y - oy > height * 0.8 else { return false }
    return texts.values.contains { ["send", "send now", "发送", "立即发送"].contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
}

func isStopControl(_ node: [String: Any], windowBounds: [String: Double]?) -> Bool {
    guard node["role"] as? String == "AXButton", (node["actions"] as? [String] ?? []).contains(kAXPressAction),
          node["enabled"] as? Bool != false, let texts = node["text"] as? [String: String] else { return false }
    guard let windowBounds, let bounds = node["bounds"] as? [String: Double],
          let x = bounds["x"], let y = bounds["y"], let originX = windowBounds["x"], let originY = windowBounds["y"],
          let width = windowBounds["width"], let height = windowBounds["height"], x - originX > width * 0.6, y - originY > height * 0.6 else { return false }
    return texts.values.contains { ["stop", "stop generating", "停止", "停止生成"].contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
}

func validateStamp(_ expected: [String: Any], _ current: [String: Any], node: [String: Any]?, operation: String) throws {
    for key in ["runtimeGeneration", "windowGeneration"] {
        guard expected[key] is String, expected[key] as? String == current[key] as? String else {
            throw ReadFailure(code: "stale_view", message: "The application process or window changed.")
        }
    }
    guard expected["bounds"] as? [String: Double] == current["bounds"] as? [String: Double] else {
        throw ReadFailure(code: "stale_view", message: "The application window moved or resized.")
    }
    if operation == "press", let node, isStopControl(node, windowBounds: current["bounds"] as? [String: Double]), let id = node["nodeId"] as? String,
       let targets = expected["semanticTargets"] as? [String: String], let saved = targets[id] {
        guard saved == (try targetFingerprint(node)), expected["contextImageLayoutHash"] is String,
              expected["contextImageLayoutHash"] as? String == current["contextImageLayoutHash"] as? String else {
            throw ReadFailure(code: "stale_view", message: "The Stop control or its window context changed.")
        }
        return
    }
    for key in ["layoutGeneration", "imageLayoutHash"] {
        guard expected[key] is String, expected[key] as? String == current[key] as? String else {
            throw ReadFailure(code: "stale_view", message: "The application layout changed; refresh before acting.")
        }
    }
}

@MainActor func readMirror(_ request: Request, _ target: RunningTarget, _ window: WindowTarget, consistent: Bool = true) async throws -> MirrorRead {
    var before: String?
    if AXIsProcessTrusted(), let firstWindow = try? axWindow(target, window) {
        let first = SnapshotReader(request, windowGeneration: window.generation(target.runtimeGeneration))
        first.read(firstWindow); first.finalizeIdentity()
        before = try controlLayout(first.nodes)
    }
    let captured = try await screenshot(request, target, window)
    guard let path = captured["path"] as? String,
          let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
        throw ReadFailure(code: "image_read_failed", message: "The captured image is unavailable.")
    }
    var reader: SnapshotReader?
    var axError: String?
    if AXIsProcessTrusted() {
        do {
            let value = SnapshotReader(request, windowGeneration: window.generation(target.runtimeGeneration))
            value.read(try axWindow(target, window)); value.finalizeIdentity(); reader = value
        } catch let error as ReadFailure { axError = error.code }
    } else { axError = "accessibility_permission_required" }
    try verifyStillCurrent(request, target)
    let nodes = reader?.nodes ?? []
    let generation = try controlLayout(nodes)
    if consistent, let before, before != generation {
        try? FileManager.default.removeItem(atPath: path)
        throw ReadFailure(code: "stale_read", message: "The window layout changed while the mirror was captured.")
    }
    var targets: [String: String] = [:]
    for node in nodes where isSemanticTarget(node, windowBounds: rectangle(window.bounds)) {
        if let id = node["nodeId"] as? String { targets[id] = try targetFingerprint(node) }
    }
    let caretRegions = nodes.compactMap { node -> CGRect? in
        let caret = node["caretBounds"] as? [String: Double]
        let selected = node["selectionRange"] as? [String: Int]
        let texts = node["text"] as? [String: String]
        let emptyInput = ["AXTextArea", "AXTextField"].contains(node["role"] as? String ?? "") &&
            selected?["location"] == 0 && selected?["length"] == 0 &&
            (texts?["value"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Chromium 空 contenteditable 的 boundsForRange 可能是零矩形；其值/选区另有严格CAS。
        let effective = (caret?["height"] ?? 0) > 0 ? caret : emptyInput ? node["bounds"] as? [String: Double] : nil
        guard let effective, let x = effective["x"], let y = effective["y"],
              let width = effective["width"], let height = effective["height"], height > 0 else { return nil }
        return CGRect(x: (x - window.bounds.minX - 2) / window.bounds.width,
            y: (y - window.bounds.minY - 2) / window.bounds.height,
            width: max(4, width + 4) / window.bounds.width, height: (height + 4) / window.bounds.height)
    }
    let stamp: [String: Any] = ["runtimeGeneration": target.runtimeGeneration, "windowGeneration": window.generation(target.runtimeGeneration),
        "layoutGeneration": generation, "imageLayoutHash": try layoutHash(image, caretRegions: caretRegions), "contextImageLayoutHash": try layoutHash(image, contextOnly: true, caretRegions: caretRegions),
        "semanticTargets": targets, "bounds": rectangle(window.bounds), "axWindowHash": reader?.elements.first.map { CFHash($0) } ?? 0,
        "axContextGeneration": try axContext(nodes, bounds: window.bounds), "axChromeGeneration": try axContext(nodes, chromeOnly: true, bounds: window.bounds)]
    let controls = nodes.compactMap { node -> [String: Any]? in
        guard isActionableControl(node) else { return nil }
        var control = node
        if let bounds = node["bounds"] as? [String: Double], let x = bounds["x"], let y = bounds["y"] {
            control["localBounds"] = ["x": x - window.bounds.minX, "y": y - window.bounds.minY,
                "width": bounds["width"] ?? 0, "height": bounds["height"] ?? 0]
        }
        return control
    }
    var result: [String: Any] = ["kind": "window-mirror", "sessionIdentityVerified": false, "runtimeGeneration": target.runtimeGeneration,
        "contentFreshness": "captured-window-image", "presentationVerified": true,
        "window": window.metadata(target.runtimeGeneration, includeText: false), "captureStamp": stamp,
        "imagePath": path, "imageWidth": image.width, "imageHeight": image.height, "controls": controls,
        "axNodeCount": nodes.count, "axTruncated": reader?.truncated ?? false,
        "capturedAt": ISO8601DateFormatter().string(from: Date())]
    if let axError { result["axUnavailable"] = axError }
    return MirrorRead(result: result, reader: reader)
}

@MainActor func activateWindow(_ target: RunningTarget, _ window: WindowTarget) throws {
    try requireUnlocked()
    _ = target.app.activate(options: [])
    let element = try axWindow(target, window)
    guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success else {
        throw ReadFailure(code: "window_activation_failed", message: "The target window cannot be raised.")
    }
    guard let focused = attribute(AXUIElementCreateApplication(target.pid), kAXFocusedWindowAttribute),
          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, element) else {
        throw ReadFailure(code: "window_focus_unconfirmed", message: "The target window focus could not be confirmed.")
    }
}

func validateActivationIdentity(_ expected: [String: Any], current: [String: Any]) throws {
    for field in ["runtimeGeneration", "windowGeneration"] {
        guard let value = expected[field] as? String, value == current[field] as? String else {
            throw ReadFailure(code: "stale_view", message: "The captured activation owner/window generation changed.")
        }
    }
    guard let bounds = expected["bounds"] as? [String: Double], bounds == current["bounds"] as? [String: Double],
          let hash = expected["axWindowHash"] as? NSNumber, hash == current["axWindowHash"] as? NSNumber else {
        throw ReadFailure(code: "stale_view", message: "The captured logical window identity or bounds changed.")
    }
}

@MainActor func capturedActivationWindow(_ request: ControlRequest, target: RunningTarget, physical: WindowTarget) throws -> AXUIElement {
    guard let stamp = request.captureStamp else { return try axWindow(target, physical) }
    guard let expectedHash = stamp["axWindowHash"] as? NSNumber else {
        throw ReadFailure(code: "capture_stamp_required", message: "The captured activation AX window identity is required.")
    }
    let matches = logicalWindows(target).filter { CFHash($0) == expectedHash.uintValue }
    guard matches.count == 1, let bounds = axBounds(matches[0]) else {
        throw ReadFailure(code: "window_ambiguous", message: "The captured activation window cannot be uniquely resolved.")
    }
    let element = matches[0]
    var owner: pid_t = 0
    guard AXUIElementGetPid(element, &owner) == .success, owner == target.pid,
          attribute(element, kAXRoleAttribute) as? String == "AXWindow" else {
        throw ReadFailure(code: "stale_view", message: "The captured activation window owner cannot be verified.")
    }
    try validateActivationIdentity(stamp, current: ["runtimeGeneration": target.runtimeGeneration,
        "windowGeneration": physical.generation(target.runtimeGeneration), "bounds": rectangle(bounds), "axWindowHash": CFHash(element)])
    return element
}

@MainActor func activateCapturedWindow(_ request: ControlRequest, target: RunningTarget, physical: WindowTarget) async throws -> [String: Any] {
    let read = request.readRequest
    // Stage Manager的旧CG缩略窗尺寸与AX逻辑窗口不相等；必须先绑定原AX对象，不能激活后再按旧物理尺寸找窗口。
    let element = try capturedActivationWindow(request, target: target, physical: physical)
    try verifyStillCurrent(read, target)
    ControlEffect.started = true
    _ = target.app.activate(options: [])
    guard AXUIElementPerformAction(element, kAXRaiseAction as CFString) == .success else {
        throw ReadFailure(code: "window_activation_failed", message: "The captured original window cannot be raised.")
    }
    // 激活只派发一次；等待期间只读相同owner/CG ID/AX对象和焦点，不换窗口或重试动作。
    let deadline = Date().addingTimeInterval(1.5)
    while Date() < deadline {
        try verifyStillCurrent(read, target)
        let current = try verifiedWindow(read, target)
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == target.pid,
              attribute(element, kAXRoleAttribute) as? String == "AXWindow",
              logicalWindows(target).filter({ CFEqual($0, element) }).count == 1 else {
            throw ReadFailure(code: "stale_view", message: "The original activation AX window identity changed.")
        }
        let focused = attribute(AXUIElementCreateApplication(target.pid), kAXFocusedWindowAttribute)
        if target.app.isActive, NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
           let focused, CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, element),
           let logical = axBounds(element), current.onScreen, sameBounds(current.bounds, logical) {
            return ["performed": true, "operation": "activate", "activationRequested": true, "activationCompleted": true,
                "runtimeGeneration": target.runtimeGeneration, "windowGeneration": current.generation(target.runtimeGeneration),
                "requiresFreshMirror": true, "businessAcceptanceVerified": false]
        }
        try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw ReadFailure(code: "activation_effect_unconfirmed", message: "The captured window activation was requested but its presentation is not confirmed.")
}

@MainActor func postKey(_ key: String, pid: pid_t) throws {
    let map: [String: CGKeyCode] = ["enter":36, "escape":53, "tab":48, "shift-enter":36, "command-enter":36,
        "command-a":0, "backspace":51, "command-n":45, "up":126, "down":125, "left":123, "right":124]
    guard let code = map[key], let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        throw ReadFailure(code: "keyboard_event_failed", message: "A keyboard event cannot be created.")
    }
    if key.hasPrefix("command-") { down.flags = .maskCommand; up.flags = .maskCommand }
    if key.hasPrefix("shift-") { down.flags = .maskShift; up.flags = .maskShift }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        throw ReadFailure(code: "input_focus_unconfirmed", message: "The target application is not the current key application.")
    }
    ControlEffect.started = true
    down.post(tap: .cgSessionEventTap); up.post(tap: .cgSessionEventTap)
}


@MainActor func control(_ request: ControlRequest) async throws -> [String: Any] {
    let read = request.readRequest
    if request.operation == "probe" { return try await execute(read) }
    try requireUnlocked()
    if request.operation == "launch" {
        if let target = try resolveTarget(read) { return ["performed": false, "alreadyRunning": true, "runtimeGeneration": target.runtimeGeneration] }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: read.bundleId) else {
            throw ReadFailure(code: "application_not_installed", message: "The requested application is not installed.")
        }
        let configuration = NSWorkspace.OpenConfiguration(); configuration.createsNewApplicationInstance = false
        configuration.activates = true; configuration.arguments = []
        ControlEffect.started = true
        do { _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration) }
        catch { throw ReadFailure(code: "launch_failed", message: "The application could not be launched.") }
        return ["performed": true, "operation": "launch", "readOnly": false]
    }
    guard let target = try resolveTarget(read), target.runtimeGeneration == read.runtimeGeneration else {
        throw ReadFailure(code: "stale_runtime", message: "The expected application process is unavailable.")
    }
    if request.operation == "axSnapshot" { return try readAXSnapshot(request, target: target) }
    if request.operation == "activateApp" {
        let application = AXUIElementCreateApplication(target.pid)
        guard let raw = attribute(application, kAXMainWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw ReadFailure(code: "main_window_unavailable", message: "The existing application main window is unavailable.")
        }
        let main = raw as! AXUIElement
        var owner: pid_t = 0
        guard AXUIElementGetPid(main, &owner) == .success, owner == target.pid,
              attribute(main, kAXRoleAttribute) as? String == "AXWindow" else {
            throw ReadFailure(code: "main_window_unavailable", message: "The main window owner cannot be verified.")
        }
        ControlEffect.started = true
        _ = target.app.activate(options: [])
        if (attribute(main, kAXMinimizedAttribute) as? NSNumber)?.boolValue == true {
            guard AXUIElementSetAttributeValue(main, kAXMinimizedAttribute as CFString, kCFBooleanFalse) == .success else {
                throw ReadFailure(code: "restore_window_failed", message: "The existing main window cannot be restored.")
            }
        }
        guard AXUIElementPerformAction(main, kAXRaiseAction as CFString) == .success else {
            throw ReadFailure(code: "raise_window_failed", message: "The existing main window cannot be raised.")
        }
        // 正常 activate/Stage Manager 是异步。只在观测到 AX 与物理窗口几何一致时确认，
        // 等待期间不重发任何激活或输入；未确认按副作用未知收口。
        let deadline = Date().addingTimeInterval(1.5)
        var confirmed = false
        while Date() < deadline {
            try requireUnlocked()
            if target.app.isActive, let logical = axBounds(main), windows(target.pid).contains(where: { sameBounds($0.bounds, logical) && $0.onScreen }) {
                confirmed = true; break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard confirmed else { throw ReadFailure(code: "activation_effect_unconfirmed", message: "The existing window activation was requested but its presentation is not confirmed.") }
        return ["performed": true, "activationRequested": true, "activationCompleted": true, "runtimeGeneration": target.runtimeGeneration,
            "requiresFreshMirror": true, "businessAcceptanceVerified": false]
    }
    if request.operation == "enableAccessibility" {
        guard AXIsProcessTrusted() else { throw ReadFailure(code: "accessibility_permission_required", message: "Accessibility permission is required.") }
        let app = AXUIElementCreateApplication(target.pid)
        ControlEffect.started = true
        let status = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        guard status == .success else { throw ReadFailure(code: "ax_enable_failed", message: "Enhanced accessibility could not be enabled.") }
        return ["performed": true, "operation": request.operation, "readOnly": false, "runtimeGeneration": target.runtimeGeneration]
    }
    if (["type", "press"].contains(request.operation) || request.operation == "key" && request.nodeId != nil), request.captureStamp?["axWindowHash"] != nil {
        return try await semanticControl(request, target: target)
    }
    let window = try verifiedWindow(read, target)
    if request.operation == "activate" {
        return try await activateCapturedWindow(request, target: target, physical: window)
    }
    let mirror = try await readMirror(read, target, window, consistent: request.operation != "press")
    if request.operation == "mirror" { return mirror.result }
    defer { if let path = mirror.result["imagePath"] as? String { try? FileManager.default.removeItem(atPath: path) } }
    guard let expected = request.captureStamp, let current = mirror.result["captureStamp"] as? [String: Any] else {
        throw ReadFailure(code: "capture_stamp_required", message: "A capture stamp is required.")
    }
    let reader = mirror.reader
    if request.operation != "scroll", reader?.truncated == true { throw ReadFailure(code: "context_truncated", message: "The complete control context is not available; review it in the desktop application.") }
    let selectedNode = reader?.nodes.first(where: { $0["nodeId"] as? String == request.nodeId })
    try validateStamp(expected, current, node: selectedNode, operation: request.operation)
    func element(_ id: String?) throws -> AXUIElement {
        guard let id, let reader, !reader.structuralTruncated,
              let index = reader.nodes.firstIndex(where: { $0["nodeId"] as? String == id }) else {
            throw ReadFailure(code: "control_unavailable", message: "The target control is unavailable in the current layout.")
        }
        return reader.elements[index]
    }
    let selectedElement: AXUIElement?
    if request.operation == "press" || request.operation == "type" { selectedElement = try element(request.nodeId) }
    else { selectedElement = nil }
    if request.operation == "type" {
        let input = selectedElement!
        let role = attribute(input, kAXRoleAttribute) as? String ?? ""
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(role) else {
            throw ReadFailure(code: "input_unavailable", message: "The selected control is not a text input.")
        }
        // 不把手机新文本混入已有桌面草稿；用户可从镜像明确选择、删除或编辑。
        if let existing = attribute(input, kAXValueAttribute) as? String, !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ReadFailure(code: "draft_conflict", message: "The selected input already contains text; edit it explicitly through the window.")
        }
    }
    if request.operation == "click" || request.operation == "scroll" {
        guard request.x! >= 0, request.y! >= 0, request.x! < window.bounds.width, request.y! < window.bounds.height else {
            throw ReadFailure(code: "outside_window", message: "The requested point is outside the target window.")
        }
    }
    try activateWindow(target, window)
    try verifyStillCurrent(read, target)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid else {
        throw ReadFailure(code: "input_focus_unconfirmed", message: "The target application is not the current key application.")
    }
    if request.operation == "press" {
        let targetElement = selectedElement!
        var actions: CFArray?; _ = AXUIElementCopyActionNames(targetElement, &actions)
        guard (actions as? [String] ?? []).contains(kAXPressAction) else {
            throw ReadFailure(code: "press_failed", message: "The target control could not be pressed.")
        }
        ControlEffect.started = true
        guard AXUIElementPerformAction(targetElement, kAXPressAction as CFString) == .success else {
            throw ReadFailure(code: "press_failed", message: "The target control could not be pressed.")
        }
    } else if request.operation == "type" {
        let input = selectedElement!
        let role = attribute(input, kAXRoleAttribute) as? String ?? ""
        guard ["AXTextArea", "AXTextField", "AXComboBox"].contains(role),
              AXUIElementSetAttributeValue(input, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
            throw ReadFailure(code: "input_focus_failed", message: "The target text input cannot be focused.")
        }
        _ = try await pasteText(request.text!, input: input, window: try axWindow(target, window), request: read, target: target)

    } else if request.operation == "key" {
        try postKey(request.key!, pid: target.pid)
    } else {
        let x = request.x!, y = request.y!
        guard x >= 0, y >= 0, x < window.bounds.width, y < window.bounds.height else {
            throw ReadFailure(code: "outside_window", message: "The requested point is outside the target window.")
        }
        let point = CGPoint(x: window.bounds.minX + x, y: window.bounds.minY + y)
        if request.operation == "click" {
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw ReadFailure(code: "mouse_event_failed", message: "A mouse event cannot be created.")
            }
            ControlEffect.started = true
            down.post(tap: .cgSessionEventTap); up.post(tap: .cgSessionEventTap)
        } else if request.operation == "scroll" {
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(request.deltaY!), wheel2: 0, wheel3: 0) else {
                throw ReadFailure(code: "scroll_event_failed", message: "A scroll event cannot be created.")
            }
            event.location = point; ControlEffect.started = true; event.post(tap: .cgSessionEventTap)
        }
    }
    try verifyStillCurrent(read, target)
    return ["performed": true, "operation": request.operation, "readOnly": false,
        "runtimeGeneration": target.runtimeGeneration, "windowGeneration": window.generation(target.runtimeGeneration),
        "businessAcceptanceVerified": false]
}

#if !CONTROL_CAS_TEST
@main struct MacOSAXControl {
    @MainActor static func main() async {
        var id: String?
        var response: [String: Any]
        do {
            guard let line = readLine(), line.utf8.count <= 32768, let data = line.data(using: .utf8),
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ReadFailure(code: "invalid_control_request", message: "A bounded JSON request is required.")
            }
            id = object["id"] as? String
            response = ["ok": true, "result": try await control(ControlRequest(object))]
        } catch let error as ReadFailure {
            let unknown = ControlEffect.started || error.effectMayHaveOccurred
            response = ["ok": false, "effectMayHaveOccurred": unknown, "error": ["code": unknown ? "delivery-unknown" : error.code,
                "cause": error.code, "message": unknown ? "The native action may have occurred; inspect the window before sending another action." : error.message]]
        } catch {
            response = ["ok": false, "effectMayHaveOccurred": ControlEffect.started,
                "error": ["code": ControlEffect.started ? "delivery-unknown" : "control_failed", "message": "The native operation did not complete."]]
        }
        if let id, id.count <= 128 { response["id"] = id }
        if let status = ControlEffect.clipboardRestoration {
            response["clipboardRestoration"] = status
            if var result = response["result"] as? [String: Any] { result["clipboardRestoration"] = status; response["result"] = result }
        }
        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
            print(String(decoding: data, as: UTF8.self))
        } else { print("{\"ok\":false,\"error\":{\"code\":\"encoding_failed\"}}") }
    }
}
#endif
