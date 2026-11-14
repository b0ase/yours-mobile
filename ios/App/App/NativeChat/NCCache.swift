import CryptoKit
import Foundation

/// The on-device copy of what the native chat last displayed, so a room opens before JS has answered.
///
/// Holds the display rows of the last 50 acknowledged messages per room per account: the same text the app already
/// stores in IndexedDB (chat/threadCache.ts), never more, and never a sealed/e2ee room (JS marks those not cacheable).
/// Files use NSFileProtectionComplete (unreadable while the phone is locked) and are excluded from backups.
final class NCCache {
    static let maxRows = 50
    private let queue = DispatchQueue(label: "bwallet.nativechat.cache", qos: .utility)
    private let root: URL
    private var pendingSaves: [String: DispatchWorkItem] = [:]

    init() {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        root = base.appendingPathComponent("NativeChat", isDirectory: true)
    }

    private static func hash(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func dir(_ me: String) -> URL { root.appendingPathComponent(NCCache.hash(me), isDirectory: true) }
    private func file(_ me: String, _ ticker: String) -> URL {
        dir(me).appendingPathComponent(NCCache.hash(ticker.uppercased()) + ".json")
    }

    /// Main-thread read of a few KB. Nil when absent, or while the phone is locked.
    func load(me: String, ticker: String) -> [NCRow]? {
        guard let data = try? Data(contentsOf: file(me, ticker)) else { return nil }
        return try? JSONDecoder().decode([NCRow].self, from: data)
    }

    /// Only what the bridge marked cacheable, only acknowledged rows, last 50. Debounced per room.
    func save(me: String, ticker: String, rows: [NCRow]) {
        pendingSaves[ticker]?.cancel()
        let snapshot = Array(rows.filter { $0.status == nil || $0.status == "sent" }.suffix(NCCache.maxRows))
        let work = DispatchWorkItem { [weak self] in self?.write(me: me, ticker: ticker, rows: snapshot) }
        pendingSaves[ticker] = work
        queue.asyncAfter(deadline: .now() + 1, execute: work)
    }

    private func write(me: String, ticker: String, rows: [NCRow]) {
        let fm = FileManager.default
        let d = dir(me)
        guard (try? fm.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])) != nil,
            let data = try? JSONEncoder().encode(rows)
        else { return }
        var f = file(me, ticker)
        guard (try? data.write(to: f, options: [.atomic, .completeFileProtection])) != nil else { return }
        var v = URLResourceValues()
        v.isExcludedFromBackup = true
        try? f.setResourceValues(v)
    }

    /// A room that turned out to be sealed: nothing of it stays on disk.
    func remove(me: String, ticker: String) {
        pendingSaves[ticker]?.cancel()
        let f = file(me, ticker)
        queue.async { try? FileManager.default.removeItem(at: f) }
    }

    /// Sign-out or account removal.
    func clearAll() {
        pendingSaves.values.forEach { $0.cancel() }
        pendingSaves.removeAll()
        let r = root
        queue.async { try? FileManager.default.removeItem(at: r) }
    }
}
