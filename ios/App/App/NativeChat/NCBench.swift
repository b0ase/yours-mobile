#if DEBUG
import Capacitor
import UIKit

/// Developer bench (DEBUG builds only): launched with `-NativeChatBench native|shots|web`. Times the native room on the
/// same fixture the WebView room is timed on (src/mobile/nativeChat/bench). Nothing user-facing reaches this.
enum NCBench {
    static var arg: String? {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: "-NativeChatBench"), i + 1 < a.count else { return nil }
        return a[i + 1]
    }

    static func maybeLoad(_ vc: CAPBridgeViewController) {
        guard let mode = arg else { return }
        // The disk cache survives relaunches: without this a "cold" room is cached from the previous run.
        NativeChatPlugin.coordinator.clearCache()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let url = URL(string: "capacitor://localhost/ncbench.html?mode=\(mode)")!
            vc.webView?.load(URLRequest(url: url))
        }
    }

    private static var results: [String: Any] = [:]
    private static let c = NativeChatPlugin.coordinator

    static func start(mode: String) {
        if mode == "shots" { return shots() }
        if mode == "paging" { return paging() }
        results["screen"] = "\(UIScreen.main.bounds.size)"
        results["maxFPS"] = UIScreen.main.maximumFramesPerSecond
        let sequence: [(String, () -> Void)] = [
            ("warmup", {}),
            ("memoryCached50", {}),
            ("diskCached50", { c.debugDropMemory() }),
            ("cold50", {}),
            ("cold5000", {}),
        ]
        let tickers = ["CACHED50", "CACHED50", "CACHED50", "COLD50", "COLD5000"]
        func step(_ i: Int) {
            guard i < sequence.count else { return scroll() }
            sequence[i].1()
            measureOpen(name: sequence[i].0, ticker: tickers[i]) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { step(i + 1) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { step(0) }
    }

    private static func measureOpen(name: String, ticker: String, done: @escaping () -> Void) {
        guard let room = c.debugRoom(ticker) else { fatalError("no room") }
        var paintAt: CFTimeInterval?
        var contentAt: CFTimeInterval?
        var contentFired = false
        let t0 = CACurrentMediaTime()
        c.open(room)
        c.debugCurrentRoom?.onFirstContent = { contentFired = true }
        // Same rule as the WebView run's two requestAnimationFrames: the frame after the commit is the one on screen.
        var ticks = 0
        var contentTicks = 0
        let link = Ticker { _ in
            let now = CACurrentMediaTime()
            ticks += 1
            if ticks == 2 && paintAt == nil { paintAt = now }
            if contentFired {
                contentTicks += 1
                if contentTicks == 2 && contentAt == nil { contentAt = now }
            }
        }
        link.start()
        let hold: Double = ticker == "COLD5000" ? 4 : 1.5
        DispatchQueue.main.asyncAfter(deadline: .now() + hold) {
            link.stop()
            let msPaint = paintAt.map { ($0 - t0) * 1000 } ?? -1
            let msContent = contentAt.map { ($0 - t0) * 1000 } ?? -1
            results[name] = ["firstPaintMs": round(msPaint * 10) / 10, "contentMs": round(msContent * 10) / 10]
            if ticker != "COLD5000" { c.popToList() }
            done()
        }
    }

    /// Scrolls the 5,000-row room upwards at 3,000 pt/s for 8 s from the display link, like the WebView run.
    private static func scroll() {
        guard let vc = c.debugCurrentRoom, let cv = vc.debugCollection else { return finish() }
        var stamps: [CFTimeInterval] = []
        var last = CACurrentMediaTime()
        let start = last
        var offset = cv.contentOffset.y
        var ticker: Ticker!
        ticker = Ticker { link in
            let now = link.timestamp
            stamps.append(now)
            offset = max(0, offset - 3000 * (now - last))
            last = now
            cv.contentOffset.y = offset
            if CACurrentMediaTime() - start > 8 || offset <= 0 {
                ticker.stop()
                var d: [Double] = []
                for i in 1..<max(stamps.count, 1) { d.append((stamps[i] - stamps[i - 1]) * 1000) }
                let ft = 1000.0 / Double(UIScreen.main.maximumFramesPerSecond)
                let sorted = d.sorted()
                let pct = { (p: Double) -> Double in sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
                let hitches = d.filter { $0 > ft * 1.5 }
                let total: Double = d.reduce(0, +) / 1000
                let hitchSum: Double = hitches.reduce(0) { (n: Double, x: Double) in n + (x - ft) }
                var r: [String: Any] = [:]
                r["frames"] = d.count
                r["seconds"] = total
                r["p50Ms"] = pct(0.5)
                r["p95Ms"] = pct(0.95)
                r["maxMs"] = sorted.last ?? 0
                r["hitches"] = hitches.count
                r["hitchMsPerSec"] = hitchSum / max(total, 0.001)
                results["scroll5000"] = r
                finish()
            }
        }
        ticker.start()
    }

    private static func finish() {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        if let d = try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: dir.appendingPathComponent("nc-bench-native.json"))
        }
        NSLog("NCBENCH DONE")
    }

    /// Holds the list, then a room, for screenshots.
    private static func shots() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            if let r = c.debugRoom("CACHED50") { c.open(r) }
            NSLog("NCBENCH ROOM")
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                c.debugCurrentRoom?.debugSend("Sent through the bridge")
                NSLog("NCBENCH SENT")
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    c.debugCurrentRoom?.debugFocusComposer()
                    NSLog("NCBENCH KEYBOARD")
                }
            }
        }
    }

    /// Long-history paging: scroll near the top, let JS prepend a page, and check the row on screen did not move.
    private static func paging() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            guard let room = c.debugRoom("PAGING200") else { fatalError("no room") }
            c.open(room)
            var checks: [[String: Any]] = []
            func step(_ n: Int) {
                guard n < 3, let vc = c.debugCurrentRoom, let cv = vc.debugCollection else {
                    results["pagingChecks"] = checks
                    return finish()
                }
                cv.contentOffset.y = 900
                cv.layoutIfNeeded()
                let rowsBefore = vc.debugRowCount
                let cell = cv.indexPathsForVisibleItems.sorted()[3]
                let id = vc.debugRowId(cell.item)
                let yBefore = cv.layoutAttributesForItem(at: cell)!.frame.minY - cv.contentOffset.y
                cv.contentOffset.y = 300  // inside the 800 pt trigger: asks JS for the older page
                let yAt300 = cv.layoutAttributesForItem(at: cell)!.frame.minY - cv.contentOffset.y
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    let newIndex = vc.debugIndex(id: id)
                    let yAfter = newIndex.map { cv.layoutAttributesForItem(at: IndexPath(item: $0, section: 0))!.frame.minY - cv.contentOffset.y } ?? -99999
                    checks.append(["rowsBefore": rowsBefore, "rowsAfter": vc.debugRowCount, "yBeforeScroll": yBefore, "yAt300": yAt300, "yAfterPrepend": yAfter, "movedPt": abs(yAfter - yAt300)])
                    step(n + 1)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { step(0) }
        }
    }

    final class Ticker: NSObject {
        private var link: CADisplayLink?
        private let fn: (CADisplayLink) -> Void
        init(_ fn: @escaping (CADisplayLink) -> Void) { self.fn = fn }
        func start() {
            link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link?.add(to: .main, forMode: .common)
        }
        func stop() { link?.invalidate(); link = nil }
        @objc private func tick(_ l: CADisplayLink) { fn(l) }
    }
}
#endif
