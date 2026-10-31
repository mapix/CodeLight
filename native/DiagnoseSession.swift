import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import IOKit
import ScreenCaptureKit

// Read-only GUI-session diagnostics: numeric identity/geometry/API status only.
@main struct DiagnoseSession {
    @MainActor static func main() async throws {
        let bundle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "dev.zcode.app"
        let request = try Request(["operation": "probe", "bundleId": bundle])
        let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        var result: [String: Any] = ["pid": getpid(), "parentPid": getppid(), "uid": getuid(), "euid": geteuid(),
            "sessionAccess": sessionAccess(), "permissions": permissions(),
            "consoleOn": (session[kCGSessionOnConsoleKey as String] as? NSNumber)?.boolValue ?? false,
            "loginDone": (session[kCGSessionLoginDoneKey as String] as? NSNumber)?.boolValue ?? false]
        if let uid = session[kCGSessionUserIDKey as String] as? NSNumber { result["consoleUid"] = uid }
        if let front = NSWorkspace.shared.frontmostApplication { result["frontmostPid"] = front.processIdentifier }
        let visible = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        result["visibleWindowCount"] = visible.count
        result["visibleWindows"] = visible.prefix(64).compactMap { window -> [String: Any]? in
            guard let owner = window[kCGWindowOwnerPID as String], let id = window[kCGWindowNumber as String],
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
            return ["ownerPid": owner, "windowId": id, "layer": window[kCGWindowLayer as String] ?? -1, "bounds": rectangle(rect)]
        }
        if let target = try resolveTarget(request) {
            result["targetPid"] = target.pid
            let app = AXUIElementCreateApplication(target.pid)
            var rootRole: CFTypeRef?
            let rootRoleStatus = AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &rootRole)
            result["rootRoleReadStatus"] = rootRoleStatus.rawValue
            if let role = rootRole as? String { result["rootRole"] = role }
            for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute, kAXFocusedUIElementAttribute] {
                var element: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(app, name as CFString, &element)
                var metadata: [String: Any] = ["readStatus": status.rawValue]
                if let element {
                    metadata["cfTypeId"] = CFGetTypeID(element)
                    metadata["isAXElement"] = CFGetTypeID(element) == AXUIElementGetTypeID()
                    if CFGetTypeID(element) == AXUIElementGetTypeID() {
                        let ax = element as! AXUIElement
                        metadata["role"] = attribute(ax, kAXRoleAttribute) as? String ?? "unknown"
                        if let bounds = axBounds(ax) { metadata["bounds"] = rectangle(bounds) }
                        var minimized: CFTypeRef?
                        metadata["minimizedReadStatus"] = AXUIElementCopyAttributeValue(ax, kAXMinimizedAttribute as CFString, &minimized).rawValue
                        if let flag = minimized as? NSNumber { metadata["minimized"] = flag.boolValue }
                        var children: CFTypeRef?
                        metadata["childrenReadStatus"] = AXUIElementCopyAttributeValue(ax, kAXChildrenAttribute as CFString, &children).rawValue
                        if let children, CFGetTypeID(children) == CFArrayGetTypeID() { metadata["childrenCount"] = CFArrayGetCount((children as! CFArray)) }
                    }
                }
                result[name] = metadata
            }
            for name in ["AXEnhancedUserInterface", "AXManualAccessibility"] {
                var flag = DarwinBoolean(false)
                result[name] = ["settableStatus": AXUIElementIsAttributeSettable(app, name as CFString, &flag).rawValue, "settable": flag.boolValue]
            }
            var raw: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw)
            result["axWindowsReadStatus"] = status.rawValue
            if let raw {
                result["axWindowsCFTypeId"] = CFGetTypeID(raw); result["expectedArrayCFTypeId"] = CFArrayGetTypeID()
                if CFGetTypeID(raw) == CFArrayGetTypeID() { result["rawCFArrayCount"] = CFArrayGetCount((raw as! CFArray)) }
                result["swiftArrayCastCount"] = (raw as? [AXUIElement])?.count ?? -1
            }
            result["axWindowElements"] = axElements(raw).map { element -> [String: Any] in
                var value: [String: Any] = ["sameAsApplication": CFEqual(app, element), "elementHash": CFHash(element)]
                var pid: pid_t = 0
                value["pidReadStatus"] = AXUIElementGetPid(element, &pid).rawValue
                value["ownerPid"] = pid
                for (key, attributeName) in [("role", kAXRoleAttribute), ("position", kAXPositionAttribute), ("size", kAXSizeAttribute)] {
                    var item: CFTypeRef?
                    let readStatus = AXUIElementCopyAttributeValue(element, attributeName as CFString, &item)
                    value[key + "ReadStatus"] = readStatus.rawValue
                    if key == "role", let role = item as? String { value["role"] = role }
                }
                if let bounds = axBounds(element) { value["bounds"] = rectangle(bounds) }
                return value
            }
            if CGPreflightScreenCaptureAccess(), sessionAccess()["screenLocked"] == false {
                if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) {
                    result["captureKitWindows"] = content.windows.filter { $0.owningApplication?.processID == target.pid }.map { item in
                        let filter = SCContentFilter(desktopIndependentWindow: item)
                        return ["windowId": item.windowID, "ownerPid": target.pid, "bounds": rectangle(item.frame), "onScreen": item.isOnScreen,
                            "contentRect": rectangle(filter.contentRect), "pointPixelScale": filter.pointPixelScale] as [String: Any]
                    }
                }
            }
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
    }
}
