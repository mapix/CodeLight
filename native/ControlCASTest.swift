import ApplicationServices
import Foundation

@MainActor final class MemoryPasteboard: PasteboardAccess {
    var changeCount = 10
    var items: [[(String, Data)]] = [[("type-one", Data([1, 2])), ("empty-type", Data())], [("type-two", Data([3]))]]
    var unreadable = false
    var changeDuringRead = false
    var writeFails = false
    func advertisedTypes() -> [[String]] { items.map { $0.map { $0.0 } } }
    func data(item: Int, type: String) -> Data? {
        if changeDuringRead { changeCount += 1 }
        return unreadable ? nil : items[item].first { $0.0 == type }?.1
    }
    func clear() -> Int { changeCount += 1; items = []; return changeCount }
    func write(_ items: [[(String, Data)]]) -> Bool { if writeFails { return false }; self.items = items; return true }
}

@main struct ControlCASTest {
    @MainActor static func main() throws {
        let stop: [String: Any] = ["nodeId": "stop-id", "path": [0, 2, 1], "role": "AXButton", "enabled": true,
            "actions": [kAXPressAction], "bounds": ["x": 950.0, "y": 650.0, "width": 30.0, "height": 30.0],
            "text": ["description": "Stop"]]
        let oldBody: [String: Any] = ["nodeId": "body", "role": "AXStaticText", "actions": ["AXShowMenu", "AXScrollToVisible"],
            "bounds": ["x": 300.0, "y": 180.0, "width": 100.0, "height": 20.0], "text": ["value": "token one"]]
        let newBody: [String: Any] = ["nodeId": "body", "role": "AXStaticText", "actions": ["AXShowMenu", "AXScrollToVisible"],
            "bounds": ["x": 300.0, "y": 180.0, "width": 600.0, "height": 300.0], "text": ["value": "many newly streamed tokens"]]
        guard try controlLayout([stop, oldBody]) == controlLayout([stop, newBody]) else { fatalError("Passive token text changed control layout.") }
        var oldPressBody = oldBody; oldPressBody["actions"] = [kAXPressAction]
        var newPressBody = newBody; newPressBody["actions"] = [kAXPressAction]
        let chromeBounds = CGRect(x: 0, y: 0, width: 1000, height: 700)
        guard try axContext([stop, oldPressBody], chromeOnly: true, bounds: chromeBounds) == axContext([stop, newPressBody], chromeOnly: true, bounds: chromeBounds),
              try axContext([stop, oldPressBody], bounds: chromeBounds) != axContext([stop, newPressBody], bounds: chromeBounds) else {
            fatalError("Actionable streaming body leaked into chrome, or full context stopped checking it.")
        }
        let bounds = ["x": 0.0, "y": 0.0, "width": 1000.0, "height": 700.0]
        let activationIdentity: [String: Any] = ["runtimeGeneration": "runtime", "windowGeneration": "window", "bounds": bounds, "axWindowHash": 42]
        var thumbnailStamp = activationIdentity
        thumbnailStamp["physicalBounds"] = ["x": -242.0, "y": 130.0, "width": 175.0, "height": 178.0]
        // Stage Manager物理缩略窗不改变已捕获的AX对象身份；必须在副作用之前按逻辑身份批准。
        try validateActivationIdentity(thumbnailStamp, current: activationIdentity)
        for field in ["runtimeGeneration", "windowGeneration", "bounds", "axWindowHash"] {
            var staleIdentity = activationIdentity
            switch field {
            case "bounds": staleIdentity[field] = ["x": 1.0, "y": 0.0, "width": 1000.0, "height": 700.0]
            case "axWindowHash": staleIdentity[field] = 43
            default: staleIdentity[field] = "other"
            }
            do { try validateActivationIdentity(thumbnailStamp, current: staleIdentity); fatalError("A stale activation identity was accepted.") }
            catch let error as ReadFailure { guard error.code == "stale_view" else { throw error } }
        }
        let composer: [String: Any] = ["nodeId": "composer", "path": [0, 2, 0], "role": "AXTextArea", "valueSettable": true,
            "bounds": ["x": 300.0, "y": 600.0, "width": 650.0, "height": 40.0], "text": ["value": "\n", "placeholder": "Keep typing to queue follow-up changes"]]
        var bottomBody = oldPressBody; bottomBody["path"] = [0, 1, 1]
        bottomBody["bounds"] = ["x": 300.0, "y": 620.0, "width": 650.0, "height": 20.0]
        var bottomUpdate = bottomBody; bottomUpdate["text"] = ["value": "streamed token in bottom 20 percent"]
        let title: [String: Any] = ["role": "AXStaticText", "path": [0, 0, 0],
            "bounds": ["x": 300.0, "y": 12.0, "width": 200.0, "height": 20.0], "text": ["value": "Task A"]]
        let baselineChrome = try axContext([composer, stop, title, bottomBody], chromeOnly: true, bounds: chromeBounds)
        guard baselineChrome == (try axContext([composer, stop, title, bottomUpdate], chromeOnly: true, bounds: chromeBounds)) else {
            fatalError("Bottom response line leaked into actual composer subtree.")
        }
        var switchedTitle = title; switchedTitle["text"] = ["value": "Task B"]
        var changedInput = composer; changedInput["text"] = ["value": "another user draft", "placeholder": "Keep typing to queue follow-up changes"]
        guard baselineChrome != (try axContext([composer, stop, switchedTitle, bottomBody], chromeOnly: true, bounds: chromeBounds)),
              baselineChrome != (try axContext([changedInput, stop, title, bottomBody], chromeOnly: true, bounds: chromeBounds)) else {
            fatalError("Task switch or user draft change stopped invalidating composer context.")
        }
        let expected: [String: Any] = ["runtimeGeneration": "runtime", "windowGeneration": "window", "bounds": bounds,
            "layoutGeneration": "old-layout", "imageLayoutHash": "old-body-image", "contextImageLayoutHash": "same-chrome",
            "semanticTargets": ["stop-id": try targetFingerprint(stop)]]
        var current = expected; current["layoutGeneration"] = "new-layout"; current["imageLayoutHash"] = "new-body-image"
        try validateStamp(expected, current, node: stop, operation: "press")
        func rejects(_ changed: [String: Any], node: [String: Any]?, action: String) throws {
            do { try validateStamp(expected, changed, node: node, operation: action); fatalError("A stale action was accepted.") }
            catch let error as ReadFailure { guard error.code == "stale_view" else { throw error } }
        }
        try rejects(current, node: stop, action: "click")
        var changedContext = current; changedContext["contextImageLayoutHash"] = "different-session-or-chrome"
        try rejects(changedContext, node: stop, action: "press")
        var changedBounds = stop; changedBounds["bounds"] = ["x": 900.0, "y": 650.0, "width": 30.0, "height": 30.0]
        try rejects(current, node: changedBounds, action: "press")
        var allow = stop; allow["text"] = ["description": "Allow"]
        try rejects(current, node: allow, action: "press")
        var disabled = stop; disabled["enabled"] = false
        try rejects(current, node: disabled, action: "press")
        var changedRuntime = current; changedRuntime["runtimeGeneration"] = "next-runtime"
        try rejects(changedRuntime, node: stop, action: "press")
        let clipboard = MemoryPasteboard(), original = clipboard.advertisedTypes()
        let readRequest = try Request(["operation": "probe", "bundleId": "dev.agent-session-bridge.test.absent-app"])
        let textReader = SnapshotReader(readRequest, windowGeneration: "test-window")
        textReader.textBudget = 0
        guard textReader.boundedText("Stop", control: true) == "Stop",
              textReader.boundedText("完整中文😀", control: true, editableValue: true) == "完整中文😀",
              textReader.textBudget == 0, textReader.boundedText("body") == "" else {
            fatalError("Body preview budget removed protected control labels/editor values.")
        }
        let snapshot = try snapshotPasteboard(clipboard)
        let transaction = PasteboardTransaction(clipboard, snapshot: snapshot)
        try transaction.install("中文\\n😀")
        try transaction.requireOwnership()
        guard transaction.restore() == "restored", clipboard.advertisedTypes() == original,
              clipboard.items[0][0].1 == Data([1, 2]), clipboard.items[0][1].1.isEmpty,
              clipboard.items[1][0].1 == Data([3]) else { fatalError("Multi-item/type clipboard was not fully restored.") }
        let next = PasteboardTransaction(clipboard, snapshot: try snapshotPasteboard(clipboard))
        try next.install("test")
        _ = clipboard.clear(); _ = clipboard.write([[("user-copy", Data([99]))]])
        guard next.restore() == "skipped-concurrent-change", clipboard.items[0][0].0 == "user-copy" else { fatalError("Later user copy was overwritten.") }
        func rejectsSnapshot(_ board: MemoryPasteboard, code: String) throws {
            let count = board.changeCount, types = board.advertisedTypes()
            do { _ = try snapshotPasteboard(board); fatalError("Incomplete clipboard accepted.") }
            catch let error as ReadFailure { guard error.code == code, board.advertisedTypes() == types,
                  board.changeDuringRead || board.changeCount == count else { throw error } }
        }
        let unreadable = MemoryPasteboard(); unreadable.unreadable = true
        try rejectsSnapshot(unreadable, code: "clipboard_snapshot_incomplete")
        let tooLarge = MemoryPasteboard(); tooLarge.items = [[("large", Data(count: 16 * 1024 * 1024 + 1))]]
        try rejectsSnapshot(tooLarge, code: "clipboard_snapshot_incomplete")
        let changed = MemoryPasteboard(); changed.changeDuringRead = true
        try rejectsSnapshot(changed, code: "clipboard_changed")
        let stale = MemoryPasteboard(), staleSnapshot = try snapshotPasteboard(stale)
        stale.changeCount += 1
        do { try PasteboardTransaction(stale, snapshot: staleSnapshot).install("x"); fatalError("Stale CAS accepted.") }
        catch let error as ReadFailure { guard error.code == "clipboard_changed", stale.changeCount == 11 else { throw error } }
        let empty = MemoryPasteboard(); empty.items = []
        let emptyTx = PasteboardTransaction(empty, snapshot: try snapshotPasteboard(empty))
        try emptyTx.install("x")
        guard emptyTx.restore() == "restored", empty.items.isEmpty else { fatalError("Empty clipboard was not restored.") }
        let failed = MemoryPasteboard(), failedTx = PasteboardTransaction(failed, snapshot: try snapshotPasteboard(failed))
        failed.writeFails = true
        do { try failedTx.install("x"); fatalError("Failed write accepted.") }
        catch let error as ReadFailure { guard error.code == "clipboard_write_failed" else { throw error } }
        failed.writeFails = false
        guard failedTx.restore() == "restored", failed.items.count == 2 else { fatalError("Failed install did not restore.") }
        print("{\"passed\":26,\"realUIAccessed\":false,\"bodyStreamingStopControlAccepted\":true,\"clipboardSafetyGates\":8,\"activationIdentityGates\":5}")
    }
}
