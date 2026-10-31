import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import ImageIO
import IOKit
import ScreenCaptureKit
import UniformTypeIdentifiers

struct ReadFailure: Error {
    let code: String
    let message: String
    var effectMayHaveOccurred: Bool = false
}

struct Request {
    let id: String?
    let operation: String
    let bundleId: String
    let pid: pid_t?
    let windowId: CGWindowID?
    let runtimeGeneration: String?
    let windowGeneration: String?
    let includeText: Bool
    let maxNodes: Int
    let maxDepth: Int
    let outputDirectory: String?

    init(_ object: [String: Any]) throws {
        let allowed: Set<String> = ["id", "operation", "bundleId", "pid", "windowId",
            "expectedRuntimeGeneration", "expectedWindowGeneration", "includeText",
            "maxNodes", "maxDepth", "outputDirectory"]
        guard Set(object.keys).isSubset(of: allowed) else {
            throw ReadFailure(code: "invalid_request", message: "Unknown request field.")
        }
        id = object["id"] as? String
        if object["id"] != nil && (id == nil || id!.count > 128) {
            throw ReadFailure(code: "invalid_request", message: "Invalid request id.")
        }
        guard let action = object["operation"] as? String,
              ["probe", "snapshot", "screenshot"].contains(action) else {
            throw ReadFailure(code: "unsupported_operation", message: "Only read operations are available.")
        }
        operation = action
        guard let bundle = object["bundleId"] as? String,
              bundle.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$", options: .regularExpression) != nil else {
            throw ReadFailure(code: "invalid_request", message: "Invalid bundle identifier.")
        }
        bundleId = bundle
        pid = try Self.integer(object, "pid", range: 2...Int(Int32.max)).map { pid_t($0) }
        windowId = try Self.integer(object, "windowId", range: 1...Int(UInt32.max)).map { CGWindowID($0) }
        runtimeGeneration = try Self.optionalString(object, "expectedRuntimeGeneration", max: 64)
        windowGeneration = try Self.optionalString(object, "expectedWindowGeneration", max: 64)
        outputDirectory = try Self.optionalString(object, "outputDirectory", max: 4096)
        if let value = object["includeText"] {
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
                throw ReadFailure(code: "invalid_request", message: "includeText must be boolean.")
            }
            includeText = number.boolValue
        } else { includeText = false }
        maxNodes = try Self.integer(object, "maxNodes", range: 1...5000) ?? 1500
        maxDepth = try Self.integer(object, "maxDepth", range: 0...80) ?? 18
        if operation != "probe" && (windowId == nil || runtimeGeneration == nil || windowGeneration == nil) {
            throw ReadFailure(code: "generation_required", message: "A window id and both expected generations are required.")
        }
        if operation == "screenshot" && outputDirectory == nil {
            throw ReadFailure(code: "invalid_request", message: "Screenshot outputDirectory is required.")
        }
    }

    static func integer(_ object: [String: Any], _ key: String, range: ClosedRange<Int>) throws -> Int? {
        guard let raw = object[key] else { return nil }
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
              value.doubleValue >= Double(range.lowerBound), value.doubleValue <= Double(range.upperBound) else {
            throw ReadFailure(code: "invalid_request", message: "Invalid numeric request field.")
        }
        return value.intValue
    }

    static func optionalString(_ object: [String: Any], _ key: String, max: Int) throws -> String? {
        guard let raw = object[key] else { return nil }
        guard let value = raw as? String, !value.isEmpty, value.count <= max else {
            throw ReadFailure(code: "invalid_request", message: "Invalid string request field.")
        }
        return value
    }
}

struct RunningTarget {
    let app: NSRunningApplication
    let bundleId: String
    let pid: pid_t
    let launchDate: Date
    var runtimeGeneration: String {
        digest([bundleId, String(pid), String(format: "%.6f", launchDate.timeIntervalSince1970)].joined(separator: "|"))
    }
}

struct WindowTarget {
    let id: CGWindowID
    let bounds: CGRect
    let layer: Int
    let onScreen: Bool
    let info: [String: Any]
    func generation(_ runtime: String) -> String { digest("\(runtime)|\(id)") }
    func metadata(_ runtime: String, includeText: Bool, appName: String? = nil) -> [String: Any] {
        var result: [String: Any] = ["windowId": id, "bounds": rectangle(bounds), "layer": layer,
            "onScreen": onScreen, "windowGeneration": generation(runtime)]
        if includeText, let title = info[kCGWindowName as String] as? String {
            result["title"] = String(title.prefix(2048))
        }
        if let appName { result["applicationWindow"] = info[kCGWindowName as String] as? String == appName }
        return result
    }
}

func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

func rectangle(_ value: CGRect) -> [String: Double] {
    ["x": value.origin.x, "y": value.origin.y, "width": value.width, "height": value.height]
}

func permissions() -> [String: Bool] {
    // Preflight only: these calls do not request a grant or show a prompt.
    ["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(), "postEvents": CGPreflightPostEventAccess()]
}

func sessionAccess() -> [String: Bool] {
    let root = IORegistryGetRootEntry(kIOMainPortDefault)
    var ioLocked: Bool?
    if root != 0 {
        defer { IOObjectRelease(root) }
        if let raw = IORegistryEntryCreateCFProperty(root, "IOConsoleLocked" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
           let flag = raw as? NSNumber { ioLocked = flag.boolValue }
    }
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let cgLocked = (session?["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue
    if ioLocked == true || cgLocked == true {
        return ["screenLocked": true, "lockStateKnown": true, "iokitLockAvailable": ioLocked != nil]
    }
    let onConsole = (session?[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue
    let loggedIn = (session?[kCGSessionLoginDoneKey as String] as? NSNumber)?.boolValue
    guard (ioLocked != nil || cgLocked != nil), onConsole == true && loggedIn == true else {
        return ["screenLocked": true, "lockStateKnown": false, "iokitLockAvailable": ioLocked != nil]
    }
    return ["screenLocked": false, "lockStateKnown": true, "iokitLockAvailable": ioLocked != nil]
}

func requireUnlocked() throws {
    let access = sessionAccess()
    guard access["lockStateKnown"] == true && access["screenLocked"] == false else {
        throw ReadFailure(code: "screen_locked", message: "Unlock the Mac manually before reading or controlling its windows.")
    }
}

@MainActor func resolveTarget(_ request: Request) throws -> RunningTarget? {
    let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: request.bundleId)
        .filter { !$0.isTerminated && (request.pid == nil || $0.processIdentifier == request.pid) }
    guard !candidates.isEmpty else { return nil }
    guard candidates.count == 1 else {
        throw ReadFailure(code: "ambiguous_application", message: "Multiple matching app instances; specify pid.")
    }
    let app = candidates[0]
    guard let launchDate = app.launchDate else {
        throw ReadFailure(code: "generation_unavailable", message: "The process launch identity is unavailable.")
    }
    return RunningTarget(app: app, bundleId: request.bundleId, pid: app.processIdentifier, launchDate: launchDate)
}

func windows(_ pid: pid_t) -> [WindowTarget] {
    let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return raw.compactMap { item in
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              let number = item[kCGWindowNumber as String] as? NSNumber,
              let coordinates = item[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: coordinates), bounds.width > 0, bounds.height > 0 else { return nil }
        let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        guard layer == 0 else { return nil }
        return WindowTarget(id: number.uint32Value, bounds: bounds, layer: layer,
            onScreen: (item[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false, info: item)
    }.sorted { $0.id < $1.id }
}

@MainActor func verifiedWindow(_ request: Request, _ target: RunningTarget) throws -> WindowTarget {
    guard request.runtimeGeneration == target.runtimeGeneration else {
        throw ReadFailure(code: "stale_runtime", message: "The application process generation changed.")
    }
    guard let window = windows(target.pid).first(where: { $0.id == request.windowId }) else {
        throw ReadFailure(code: "window_missing", message: "The requested application window is unavailable.")
    }
    guard request.windowGeneration == window.generation(target.runtimeGeneration) else {
        throw ReadFailure(code: "stale_window", message: "The window generation changed.")
    }
    return window
}

@MainActor func verifyStillCurrent(_ request: Request, _ original: RunningTarget) throws {
    try requireUnlocked()
    guard let current = try resolveTarget(request), current.pid == original.pid,
          current.runtimeGeneration == original.runtimeGeneration else {
        throw ReadFailure(code: "stale_runtime", message: "The application process changed during the read.")
    }
    _ = try verifiedWindow(request, current)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axElements(_ raw: CFTypeRef?) -> [AXUIElement] {
    guard let raw, CFGetTypeID(raw) == CFArrayGetTypeID() else { return [] }
    let array = raw as! CFArray
    return (0..<CFArrayGetCount(array)).compactMap { index in
        guard let pointer = CFArrayGetValueAtIndex(array, index) else { return nil }
        let element = Unmanaged<AXUIElement>.fromOpaque(pointer).takeUnretainedValue()
        guard CFGetTypeID(element) == AXUIElementGetTypeID() else { return nil }
        return element
    }
}

func allLogicalWindows(_ target: RunningTarget) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(target.pid)
    var elements = axElements(attribute(app, kAXWindowsAttribute))
    for name in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
        if let raw = attribute(app, name), CFGetTypeID(raw) == AXUIElementGetTypeID() {
            let window = raw as! AXUIElement
            var owner: pid_t = 0
            if AXUIElementGetPid(window, &owner) == .success, owner == target.pid,
               attribute(window, kAXRoleAttribute) as? String == "AXWindow",
               !elements.contains(where: { CFEqual($0, window) }) { elements.append(window) }
        }
    }
    return elements
}

func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let rawPosition = attribute(element, kAXPositionAttribute),
          let rawSize = attribute(element, kAXSizeAttribute),
          CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    let position = rawPosition as! AXValue
    let size = rawSize as! AXValue
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func sameBounds(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 &&
        abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
}

func axWindow(_ target: RunningTarget, _ window: WindowTarget) throws -> AXUIElement {
    let application = AXUIElementCreateApplication(target.pid)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value)
    guard status == .success, value != nil, CFGetTypeID(value!) == CFArrayGetTypeID() else {
        throw ReadFailure(code: "ax_windows_unavailable", message: "The application did not expose AX windows.")
    }
    let candidates = axElements(value)
    let matching = candidates.filter { element in
        guard let bounds = axBounds(element) else { return false }
        return sameBounds(bounds, window.bounds)
    }
    guard matching.count == 1 else {
        throw ReadFailure(code: "ax_window_ambiguous", message: "CG and AX window identities cannot be uniquely matched.")
    }
    return matching[0]
}

func axWindowMetadata(_ target: RunningTarget) -> [String: Any] {
    let application = AXUIElementCreateApplication(target.pid)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value)
    guard status == .success, value != nil, CFGetTypeID(value!) == CFArrayGetTypeID() else {
        return ["readStatus": status.rawValue, "windows": []]
    }
    let elements = allLogicalWindows(target)
    return ["readStatus": status.rawValue, "windows": elements.enumerated().map { index, element -> [String: Any] in
        var metadata: [String: Any] = ["index": index, "role": attribute(element, kAXRoleAttribute) as? String ?? "unknown", "axWindowHash": CFHash(element)]
        if let bounds = axBounds(element) { metadata["bounds"] = rectangle(bounds) }
        return metadata
    }]
}

final class SnapshotReader {
    let request: Request
    let windowGeneration: String
    private(set) var nodes: [[String: Any]] = []
    var elements: [AXUIElement] = []
    private(set) var truncated = false
    private(set) var structuralTruncated = false
    private(set) var childReadFailures = 0
    var textBudget = 32768
    var ancestry: [AXUIElement] = []

    init(_ request: Request, windowGeneration: String) {
        self.request = request
        self.windowGeneration = windowGeneration
    }

    func read(_ element: AXUIElement, path: [Int] = [], depth: Int = 0) {
        guard nodes.count < request.maxNodes else { truncated = true; structuralTruncated = true; return }
        if ancestry.contains(where: { CFEqual($0, element) }) { childReadFailures += 1; return }
        ancestry.append(element)
        defer { ancestry.removeLast() }
        let role = attribute(element, kAXRoleAttribute) as? String ?? "unknown"
        let subrole = attribute(element, kAXSubroleAttribute) as? String
        let identifier = attribute(element, kAXIdentifierAttribute) as? String
        let identityKey = "\(windowGeneration)|\(path.map(String.init).joined(separator: "/"))|\(role)|\(subrole ?? "")|\(identifier ?? "")"
        var node: [String: Any] = ["nodeId": digest(identityKey), "path": path, "role": role,
            "identityKind": identifier?.isEmpty == false ? "identifier_candidate" : "structural"]
        if let subrole { node["subrole"] = subrole }
        if let identifier { node["identifier"] = String(identifier.prefix(512)) }
        if let bounds = axBounds(element) { node["bounds"] = rectangle(bounds) }
        for (key, name) in [("enabled", kAXEnabledAttribute), ("focused", kAXFocusedAttribute), ("selected", kAXSelectedAttribute)] {
            if let value = attribute(element, name) as? NSNumber,
               CFGetTypeID(value) == CFBooleanGetTypeID() { node[key] = value.boolValue }
        }
        var actions: CFArray?
        let actionStatus = AXUIElementCopyActionNames(element, &actions)
        node["actions"] = actionStatus == .success ? (actions as? [String] ?? []) : []
        var valueSettable = DarwinBoolean(false)
        let writableStatus = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &valueSettable)
        node["valueSettable"] = writableStatus == .success && valueSettable.boolValue
        if ["AXTextArea", "AXTextField", "AXComboBox"].contains(role), subrole != "AXSecureTextField",
           let rawRange = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(rawRange) == AXValueGetTypeID() {
            var range = CFRange(location: 0, length: 0)
            if AXValueGetValue(rawRange as! AXValue, .cfRange, &range) {
                node["selectionRange"] = ["location": range.location, "length": range.length]
                if range.length == 0 {
                    var rawBounds: CFTypeRef?
                    if AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, rawRange, &rawBounds) == .success,
                       let rawBounds, CFGetTypeID(rawBounds) == AXValueGetTypeID() {
                        var rect = CGRect.zero
                        if AXValueGetValue(rawBounds as! AXValue, .cgRect, &rect) { node["caretBounds"] = rectangle(rect) }
                    }
                }
            }
        }
        if request.includeText {
            var texts: [String: String] = [:]
            let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
            let editable = ["AXTextArea", "AXTextField", "AXComboBox"].contains(role)
            let control = editable || ["AXButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXSlider", "AXScrollBar"].contains(role)
            for (key, name) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute),
                ("placeholder", kAXPlaceholderValueAttribute), ("value", kAXValueAttribute)] {
                if key == "value" && secure { continue }
                if let raw = attribute(element, name) as? String {
                    texts[key] = boundedText(raw, control: control, editableValue: editable && key == "value")
                    if editable && key == "value" && raw.utf16.count > 8000 { node["editableValueTruncated"] = true }
                }
            }
            node["text"] = texts
            if secure { node["secureValueRedacted"] = true }
        }
        let index = nodes.count
        nodes.append(node)
        elements.append(element)
        var childrenValue: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if status == .success, childrenValue != nil, CFGetTypeID(childrenValue!) == CFArrayGetTypeID() {
            let children = axElements(childrenValue)
            nodes[index]["childCount"] = children.count
            if depth >= request.maxDepth && !children.isEmpty { truncated = true; structuralTruncated = true; return }
            if children.count > 400 { truncated = true; structuralTruncated = true }
            for (childIndex, child) in children.prefix(400).enumerated() {
                if nodes.count >= request.maxNodes { truncated = true; structuralTruncated = true; break }
                read(child, path: path + [childIndex], depth: depth + 1)
            }
        } else {
            nodes[index]["childrenReadStatus"] = status.rawValue
            if status != .attributeUnsupported && status != .noValue { childReadFailures += 1 }
        }
    }

    func boundedText(_ raw: String, control: Bool = false, editableValue: Bool = false) -> String {
        // 长会话正文先读，不能耗尽 footer 控件预算并把 Send 的真实输入值截成空串。
        let limit = editableValue ? 8000 : control ? 2048 : min(2048, textBudget)
        let text = String(raw.prefix(limit))
        if !control { textBudget -= text.count }
        if text.count < raw.count { truncated = true }
        return text
    }

    func finalizeIdentity() {
        var counts: [String: Int] = [:]
        for node in nodes { if let identifier = node["identifier"] as? String, !identifier.isEmpty { counts[identifier, default: 0] += 1 } }
        for index in nodes.indices {
            if let identifier = nodes[index]["identifier"] as? String, !identifier.isEmpty {
                nodes[index]["identityKind"] = counts[identifier] == 1 ? "unique_identifier" : "structural"
            }
            nodes[index]["stableAcrossUIChanges"] = false
        }
    }
}

@MainActor func screenshot(_ request: Request, _ target: RunningTarget, _ window: WindowTarget) async throws -> [String: Any] {
    try requireUnlocked()
    // 锁状态元数据与窗口可见性可能暂时不一致；已有 AX 授权却无法确认窗口时不截图绕过。
    if AXIsProcessTrusted() { _ = try axWindow(target, window) }
    guard #available(macOS 14.0, *) else {
        throw ReadFailure(code: "screenshot_unsupported", message: "Target-window screenshots require macOS 14 or newer.")
    }
    guard CGPreflightScreenCaptureAccess() else {
        throw ReadFailure(code: "screen_capture_permission_required", message: "Screen capture permission is not granted.")
    }
    guard let outputDirectory = request.outputDirectory, outputDirectory.hasPrefix("/") else {
        throw ReadFailure(code: "invalid_output_directory", message: "An existing absolute output directory is required.")
    }
    var isDirectory = ObjCBool(false)
    let output = URL(fileURLWithPath: outputDirectory).resolvingSymlinksInPath()
    guard FileManager.default.fileExists(atPath: output.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        throw ReadFailure(code: "invalid_output_directory", message: "The output directory does not exist.")
    }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
    catch { throw ReadFailure(code: "capture_inventory_failed", message: "The system window capture inventory is unavailable.") }
    guard let selected = content.windows.first(where: {
        $0.windowID == window.id && $0.owningApplication?.processID == target.pid
    }) else { throw ReadFailure(code: "capture_window_missing", message: "The requested window is not capturable.") }
    let filter = SCContentFilter(desktopIndependentWindow: selected)
    let config = SCStreamConfiguration()
    let size = selected.frame.size
    guard size.width > 0, size.height > 0 else {
        throw ReadFailure(code: "capture_window_invalid", message: "The target window has invalid dimensions.")
    }
    let scale = min(2.0, 4096.0 / max(size.width, size.height))
    config.width = max(1, Int(size.width * scale))
    config.height = max(1, Int(size.height * scale))
    config.showsCursor = false
    config.preservesAspectRatio = true
    if #available(macOS 14.2, *) { config.includeChildWindows = false; config.ignoreShadowsSingleWindow = true }
    let image: CGImage
    do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    catch { throw ReadFailure(code: "capture_failed", message: "The requested window screenshot failed.") }
    try verifyStillCurrent(request, target)
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
        throw ReadFailure(code: "image_encoding_failed", message: "PNG encoding is unavailable.")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw ReadFailure(code: "image_encoding_failed", message: "PNG encoding failed.")
    }
    let path = output.appendingPathComponent("window-\(UUID().uuidString.lowercased()).png").path
    let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ReadFailure(code: "image_write_failed", message: "The screenshot file cannot be created.") }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    do { try handle.write(contentsOf: data as Data); try handle.close() }
    catch {
        try? handle.close()
        try? FileManager.default.removeItem(atPath: path)
        throw ReadFailure(code: "image_write_failed", message: "The screenshot file cannot be written.")
    }
    return ["path": path, "width": image.width, "height": image.height,
        "captureScope": "desktopIndependentWindow", "includesCursor": false, "includesChildWindows": false]
}

@MainActor func execute(_ request: Request) async throws -> [String: Any] {
    var result: [String: Any] = ["readOnly": true, "operation": request.operation,
        "permissions": permissions(), "sessionAccess": sessionAccess(), "bundleId": request.bundleId, "capturedAt": ISO8601DateFormatter().string(from: Date())]
    guard let target = try resolveTarget(request) else {
        if request.operation == "probe" { result["running"] = false; result["windows"] = []; return result }
        throw ReadFailure(code: "application_not_running", message: "The requested application is not running.")
    }
    result["running"] = true
    result["pid"] = target.pid
    result["launchDate"] = ISO8601DateFormatter().string(from: target.launchDate)
    result["runtimeGeneration"] = target.runtimeGeneration
    if request.operation == "probe" {
        if sessionAccess()["screenLocked"] == true { result["windows"] = []; return result }
        result["windows"] = windows(target.pid).map { $0.metadata(target.runtimeGeneration, includeText: request.includeText, appName: target.app.localizedName) }
        result["hidden"] = target.app.isHidden
        result["active"] = target.app.isActive
        if AXIsProcessTrusted() {
            let inventory = axWindowMetadata(target)
            result["axWindowInventory"] = inventory
            result["windowUIAvailable"] = (inventory["windows"] as? [[String: Any]] ?? []).contains { item in
                item["role"] as? String == "AXWindow" && item["bounds"] != nil
            }
            if let main = attribute(AXUIElementCreateApplication(target.pid), kAXMainWindowAttribute), CFGetTypeID(main) == AXUIElementGetTypeID() {
                result["mainWindowHash"] = CFHash(main)
                if let bounds = axBounds(main as! AXUIElement) { result["mainWindowBounds"] = rectangle(bounds) }
            }
        } else { result["windowUIAvailable"] = false }
        return result
    }
    try requireUnlocked()
    let window = try verifiedWindow(request, target)
    result["window"] = window.metadata(target.runtimeGeneration, includeText: request.includeText)
    if request.operation == "screenshot" {
        result["screenshot"] = try await screenshot(request, target, window)
        return result
    }
    guard AXIsProcessTrusted() else {
        throw ReadFailure(code: "accessibility_permission_required", message: "Accessibility permission is not granted.")
    }
    let reader = SnapshotReader(request, windowGeneration: window.generation(target.runtimeGeneration))
    reader.read(try axWindow(target, window))
    reader.finalizeIdentity()
    try verifyStillCurrent(request, target)
    result["nodes"] = reader.nodes
    result["nodeCount"] = reader.nodes.count
    result["truncated"] = reader.truncated
    result["childReadFailures"] = reader.childReadFailures
    result["includeText"] = request.includeText
    let structure = reader.nodes.map { node -> [String: Any] in
        node.filter { $0.key != "text" }
    }
    let encoded = try JSONSerialization.data(withJSONObject: structure, options: [.sortedKeys])
    result["snapshotGeneration"] = digest(String(decoding: encoded, as: UTF8.self))
    result["sessionIdentityVerified"] = false
    return result
}

#if !CONTROL_HELPER
@main struct MacOSAXReadOnly {
    @MainActor static func main() async {
        var id: String?
        let response: [String: Any]
        do {
            guard let line = readLine(), line.utf8.count <= 16384,
                  let raw = line.data(using: .utf8) else {
                throw ReadFailure(code: "invalid_request", message: "A single bounded JSON object is required.")
            }
            let parsed: Any
            do { parsed = try JSONSerialization.jsonObject(with: raw) }
            catch { throw ReadFailure(code: "invalid_request", message: "A valid JSON request is required.") }
            guard let object = parsed as? [String: Any] else {
                throw ReadFailure(code: "invalid_request", message: "A JSON object is required.")
            }
            id = object["id"] as? String
            let request = try Request(object)
            var success: [String: Any] = ["ok": true, "result": try await execute(request)]
            if let id = request.id { success["id"] = id }
            response = success
        } catch let error as ReadFailure {
            var failure: [String: Any] = ["ok": false, "readOnly": true, "error": ["code": error.code, "message": error.message]]
            if let id, id.count <= 128 { failure["id"] = id }
            response = failure
        } catch {
            response = ["ok": false, "readOnly": true, "error": ["code": "read_failed", "message": "The requested native read failed."]]
        }
        if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
        else { print("{\"ok\":false,\"readOnly\":true,\"error\":{\"code\":\"encoding_failed\",\"message\":\"Response encoding failed.\"}}") }
    }
}

#endif
