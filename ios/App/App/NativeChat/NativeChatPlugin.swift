import Capacitor
import UIKit

/// A full-size container over the WebView that only claims touches where native content is.
/// With no room open, touches outside the list reach the web bars underneath.
final class NCHostView: UIView {
    var listRect: CGRect = .zero
    var roomOpen = false

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if !roomOpen && !listRect.contains(point) { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Holds the native chat screens. Lists, scrolling, gestures and the push transition live here; every decision
/// that needs keys, money, membership or the network is an event to TypeScript.
final class NativeChatCoordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    weak var plugin: NativeChatPlugin?
    private(set) var host: NCHostView?
    private var nav: UINavigationController?
    private var list: NCListViewController?
    private let cache = NCCache()
    private var me = ""
    private var memory: [String: [NCRow]] = [:]
    private var memoryOrder: [String] = []
    private let memoryRooms = 24
    private weak var currentRoom: NCRoomViewController?
    private var pendingRooms: [NCRoom]?
    /// DEBUG bench hook: replaces `plugin` as the action sink.
    var actionSink: (([String: Any]) -> Void)?

    func emit(_ a: [String: Any]) {
        if let s = actionSink { s(a); return }
        plugin?.notifyListeners("action", data: a)
    }

    private func install(in parent: UIViewController) {
        guard host == nil else { return }
        let h = NCHostView(frame: parent.view.bounds)
        h.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        h.backgroundColor = .clear
        let l = NCListViewController(coordinator: self)
        let n = UINavigationController(rootViewController: l)
        n.setNavigationBarHidden(true, animated: false)
        n.delegate = self
        n.interactivePopGestureRecognizer?.delegate = self
        n.view.backgroundColor = .clear
        n.view.frame = h.bounds
        n.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        parent.addChild(n)
        h.addSubview(n.view)
        parent.view.addSubview(h)
        n.didMove(toParent: parent)
        host = h
        nav = n
        list = l
        if let p = pendingRooms { l.loadViewIfNeeded(); l.setRooms(p); pendingRooms = nil }
    }

    func show(in parent: UIViewController, rect: CGRect, me: String, accent: UIColor?) {
        if let a = accent { NCTheme.accent = a }
        if me != self.me {
            self.me = me
            memory.removeAll()
            memoryOrder.removeAll()
        }
        install(in: parent)
        host?.listRect = rect
        list?.listRect = rect
        host?.isHidden = false
        host?.superview?.bringSubviewToFront(host!)
    }

    func hide() { host?.isHidden = true }

    func setRooms(_ rooms: [NCRoom]) {
        guard let l = list else { pendingRooms = rooms; return }
        l.loadViewIfNeeded()
        l.setRooms(rooms)
        warm(rooms.prefix(10).map(\.ticker))
    }

    /// Pull the top rooms' cached rows into memory so the first tap reads nothing.
    private func warm(_ tickers: [String]) {
        for t in tickers where memory[t] == nil {
            if let rows = cache.load(me: me, ticker: t) { remember(t, rows) }
        }
    }

    private func remember(_ ticker: String, _ rows: [NCRow]) {
        memory[ticker] = rows
        memoryOrder.removeAll { $0 == ticker }
        memoryOrder.append(ticker)
        while memoryOrder.count > memoryRooms { memory.removeValue(forKey: memoryOrder.removeFirst()) }
    }

    func cachedRows(_ ticker: String) -> [NCRow] {
        memory[ticker] ?? cache.load(me: me, ticker: ticker) ?? []
    }

    func open(_ room: NCRoom) {
        guard let n = nav else { return }
        host?.roomOpen = true
        let rows = cachedRows(room.ticker)
        if !rows.isEmpty { remember(room.ticker, rows) }
        let vc = NCRoomViewController(room: room, rows: rows, coordinator: self)
        currentRoom = vc
        n.pushViewController(vc, animated: true)
        emit(["type": "open", "ticker": room.ticker])
    }

    func roomDidClose(_ vc: NCRoomViewController) {
        if nav?.viewControllers.count == 1 { host?.roomOpen = false }
        if currentRoom === vc { currentRoom = nil }
        emit(["type": "close", "ticker": vc.room.ticker])
    }

    func popToList() { nav?.popToRootViewController(animated: false) }

    func clearCache() {
        memory.removeAll()
        memoryOrder.removeAll()
        cache.clearAll()
    }

    func applyRoom(ticker: String, from: Int, rows delta: [NCRow], hasMore: Bool, cacheable: Bool, loading: Bool, error: String, composer: NCComposerState) {
        let base = memory[ticker] ?? []
        // JS has nothing yet and is still fetching: keep what the cache put on screen.
        let rows = (delta.isEmpty && from == 0 && loading && !base.isEmpty) ? base : Array(base.prefix(max(0, from))) + delta
        remember(ticker, rows)
        if cacheable { cache.save(me: me, ticker: ticker, rows: rows) } else { cache.remove(me: me, ticker: ticker) }
        if let vc = currentRoom, vc.room.ticker == ticker {
            vc.apply(rows: rows, hasMore: hasMore, loading: loading, error: error, composer: composer)
        }
    }

    #if DEBUG
    func debugDropMemory() {
        memory.removeAll()
        memoryOrder.removeAll()
    }
    func debugRoom(_ ticker: String) -> NCRoom? { list?.room(ticker) }
    var debugCurrentRoom: NCRoomViewController? { currentRoom }
    #endif

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool { (nav?.viewControllers.count ?? 0) > 1 }

    func navigationController(_ n: UINavigationController, didShow vc: UIViewController, animated: Bool) {
        // An interactive pop that was cancelled leaves the room on top; only a real return to the list closes it.
        host?.roomOpen = n.viewControllers.count > 1
    }
}

/// Bridge to src/mobile/nativeChat/plugin.ts. Inert until JS calls `show`, which it does only with the switch on.
@objc(NativeChatPlugin)
public class NativeChatPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeChatPlugin"
    public let jsName = "NativeChat"
    public let pluginMethods: [CAPPluginMethod] = {
        var m: [CAPPluginMethod] = [
            CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "setRooms", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "setRoom", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "popToList", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "clearCache", returnType: CAPPluginReturnPromise),
        ]
        #if DEBUG
        m.append(CAPPluginMethod(name: "benchStart", returnType: CAPPluginReturnPromise)!)
        #endif
        return m
    }()

    static let coordinator = NativeChatCoordinator()

    public override func load() { NativeChatPlugin.coordinator.plugin = self }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String?) -> T? {
        guard let d = json?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: d)
    }

    @objc func show(_ call: CAPPluginCall) {
        let rect = CGRect(
            x: call.getDouble("left") ?? 0, y: call.getDouble("top") ?? 0,
            width: call.getDouble("width") ?? 0, height: call.getDouble("height") ?? 0)
        let me = call.getString("me") ?? ""
        let accent = call.getString("accent").flatMap { UIColor(hex: $0) }
        DispatchQueue.main.async { [weak self] in
            guard let vc = self?.bridge?.viewController else { return call.reject("no view controller") }
            NativeChatPlugin.coordinator.show(in: vc, rect: rect, me: me, accent: accent)
            call.resolve()
        }
    }

    @objc func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NativeChatPlugin.coordinator.hide()
            call.resolve()
        }
    }

    @objc func setRooms(_ call: CAPPluginCall) {
        let rooms = decode([NCRoom].self, call.getString("roomsJson"))
        DispatchQueue.main.async {
            if let rooms { NativeChatPlugin.coordinator.setRooms(rooms) }
            call.resolve()
        }
    }

    @objc func setRoom(_ call: CAPPluginCall) {
        guard let ticker = call.getString("ticker"), let rows = decode([NCRow].self, call.getString("rowsJson")) else {
            return call.reject("bad rows")
        }
        let from = call.getInt("from") ?? 0
        let hasMore = call.getBool("hasMore") ?? false
        let cacheable = call.getBool("cacheable") ?? false
        let loading = call.getBool("loading") ?? false
        let error = call.getString("error") ?? ""
        let composer = decode(NCComposerState.self, call.getString("composerJson")) ?? .open
        DispatchQueue.main.async {
            NativeChatPlugin.coordinator.applyRoom(
                ticker: ticker, from: from, rows: rows, hasMore: hasMore, cacheable: cacheable,
                loading: loading, error: error, composer: composer)
            call.resolve()
        }
    }

    @objc func popToList(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NativeChatPlugin.coordinator.popToList()
            call.resolve()
        }
    }

    #if DEBUG
    @objc func benchStart(_ call: CAPPluginCall) {
        let mode = call.getString("mode") ?? "native"
        DispatchQueue.main.async {
            NCBench.start(mode: mode)
            call.resolve()
        }
    }
    #endif

    @objc func clearCache(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            NativeChatPlugin.coordinator.clearCache()
            call.resolve()
        }
    }
}
