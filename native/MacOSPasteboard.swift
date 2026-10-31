import AppKit
import Foundation

struct PasteboardSnapshot {
    let changeCount: Int
    let items: [[(String, Data)]]
}

@MainActor protocol PasteboardAccess {
    var changeCount: Int { get }
    func advertisedTypes() -> [[String]]
    func data(item: Int, type: String) -> Data?
    func clear() -> Int
    func write(_ items: [[(String, Data)]]) -> Bool
}

@MainActor struct SystemPasteboard: PasteboardAccess {
    let pasteboard = NSPasteboard.general
    var changeCount: Int { pasteboard.changeCount }
    func advertisedTypes() -> [[String]] {
        let items = pasteboard.pasteboardItems ?? []
        let types = items.map { $0.types.map(\.rawValue) }
        // board types 可含系统兼容 alias；多 item 以每个 item 的真实 representations 为准。
        // legacy 剪贴板只有 board types 时，将其完整 representations 当作单个 item 保存。
        if !items.isEmpty { return types }
        let legacy = (pasteboard.types ?? []).map(\.rawValue)
        return legacy.isEmpty ? [] : [legacy]
    }
    func data(item: Int, type: String) -> Data? {
        let items = pasteboard.pasteboardItems ?? []
        if items.indices.contains(item) { return items[item].data(forType: NSPasteboard.PasteboardType(type)) }
        return items.isEmpty && item == 0 ? pasteboard.data(forType: NSPasteboard.PasteboardType(type)) : nil
    }
    func clear() -> Int { pasteboard.clearContents() }
    func write(_ items: [[(String, Data)]]) -> Bool {
        if items.isEmpty { return true }
        var objects: [NSPasteboardItem] = []
        for representations in items {
            let item = NSPasteboardItem()
            for (type, data) in representations {
                guard item.setData(data, forType: NSPasteboard.PasteboardType(type)) else { return false }
            }
            objects.append(item)
        }
        return pasteboard.writeObjects(objects)
    }
}

@MainActor func snapshotPasteboard(_ access: PasteboardAccess) throws -> PasteboardSnapshot {
    let token = access.changeCount, types = access.advertisedTypes()
    guard types.count <= 64, types.allSatisfy({ !$0.isEmpty && $0.count <= 128 }) else {
        throw ReadFailure(code: "clipboard_snapshot_incomplete", message: "The complete clipboard cannot be safely retained in memory.")
    }
    var bytes = 0, items: [[(String, Data)]] = []
    for (index, representations) in types.enumerated() {
        var item: [(String, Data)] = []
        for type in representations {
            guard let data = access.data(item: index, type: type), data.count <= 16 * 1024 * 1024 - bytes else {
                throw ReadFailure(code: "clipboard_snapshot_incomplete", message: "The complete clipboard cannot be safely retained in memory.")
            }
            bytes += data.count
            item.append((type, Data(data)))
        }
        items.append(item)
    }
    guard access.changeCount == token, access.advertisedTypes() == types else {
        throw ReadFailure(code: "clipboard_changed", message: "The clipboard changed before input; refresh and review the window.")
    }
    return PasteboardSnapshot(changeCount: token, items: items)
}

@MainActor final class PasteboardTransaction {
    let access: PasteboardAccess
    let snapshot: PasteboardSnapshot
    private var ownedCount: Int?
    init(_ access: PasteboardAccess, snapshot: PasteboardSnapshot) { self.access = access; self.snapshot = snapshot }
    func install(_ text: String) throws {
        guard access.changeCount == snapshot.changeCount else {
            throw ReadFailure(code: "clipboard_changed", message: "The clipboard changed before input; refresh and review the window.")
        }
        // 保留完整 RAM snapshot，并用 changeCount 保护用户之后复制的内容；原内容不落盘。
        ControlEffect.started = true
        ownedCount = access.clear()
        guard access.write([[(NSPasteboard.PasteboardType.string.rawValue, Data(text.utf8))]]) else {
            throw ReadFailure(code: "clipboard_write_failed", message: "The temporary input clipboard could not be written.")
        }
        try requireOwnership()
    }
    func requireOwnership() throws {
        guard let ownedCount, access.changeCount == ownedCount else {
            throw ReadFailure(code: "clipboard_changed", message: "The clipboard changed before paste; no text was dispatched.")
        }
    }
    func restore() -> String {
        guard let ownedCount else { return "unchanged" }
        self.ownedCount = nil
        guard access.changeCount == ownedCount else { return "skipped-concurrent-change" }
        _ = access.clear()
        return access.write(snapshot.items) ? "restored" : "failed"
    }
}
