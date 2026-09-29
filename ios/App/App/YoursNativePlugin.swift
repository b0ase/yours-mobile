import Capacitor
import LocalAuthentication
import Security
import UIKit
import WebKit

/// Root view controller: registers the app's own plugin with the bridge.
class YoursBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(YoursNativePlugin())
    }
}

/// Native side of src/mobile/native.ts.
///
/// - secure*:    Keychain, AfterFirstUnlockThisDeviceOnly (never in iCloud or device backups).
/// - biometric*: Keychain item gated by `.biometryCurrentSet`; re-enrolling Face ID makes it unreadable.
/// - browser*:   full-screen WKWebView for dApps. The provider script is injected at document
///               start in the main frame; each message's origin comes from WebKit's frame info.
@objc(YoursNativePlugin)
public class YoursNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "YoursNativePlugin"
    public let jsName = "YoursNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometricRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserSetHidden", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserRespond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "browserEmit", returnType: CAPPluginReturnPromise)
    ]

    private let storageService = "com.bitcoincorp.bwallet.storage"
    private let biometricService = "com.bitcoincorp.bwallet.biometric"
    private let installMarker = "com.bitcoincorp.bwallet.installed"

    override public func load() {
        // Keychain items outlive an uninstall; UserDefaults do not. A fresh install
        // must start empty rather than inherit a previous install's keystore.
        if !UserDefaults.standard.bool(forKey: installMarker) {
            SecItemDelete(query(storageService, nil) as CFDictionary)
            SecItemDelete(query(biometricService, nil) as CFDictionary)
            UserDefaults.standard.set(true, forKey: installMarker)
        }
    }

    // MARK: - Keychain

    private func query(_ service: String, _ key: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        if let key = key { q[kSecAttrAccount as String] = key }
        return q
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        var q = query(storageService, key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return call.resolve(["value": NSNull()]) }
        guard status == errSecSuccess, let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
            return call.reject("Secure read failed (\(status))")
        }
        call.resolve(["value": value])
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("Must provide key and value")
        }
        let data = Data(value.utf8)
        let q = query(storageService, key)
        var status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        status == errSecSuccess ? call.resolve() : call.reject("Secure write failed (\(status))")
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        SecItemDelete(query(storageService, key) as CFDictionary)
        call.resolve()
    }

    @objc func secureKeys(_ call: CAPPluginCall) {
        var q = query(storageService, nil)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return call.resolve(["keys": []]) }
        guard status == errSecSuccess, let items = out as? [[String: Any]] else {
            return call.reject("Secure list failed (\(status))")
        }
        call.resolve(["keys": items.compactMap { $0[kSecAttrAccount as String] as? String }])
    }

    // MARK: - Biometrics

    private func biometryType() -> String {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return "none" }
        switch context.biometryType {
        case .faceID: return "faceId"
        case .touchID: return "touchId"
        default:
            if #available(iOS 17.0, *), context.biometryType == .opticID { return "opticId" }
            return "none"
        }
    }

    @objc func biometricStatus(_ call: CAPPluginCall) {
        let type = biometryType()
        call.resolve(["available": type != "none", "biometryType": type])
    }

    @objc func biometricSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            return call.reject("Must provide key and value")
        }
        guard biometryType() != "none" else { return call.reject("Biometrics unavailable", "unavailable") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error
        ) else {
            return call.reject("Biometric setup failed", "failed")
        }
        SecItemDelete(query(biometricService, key) as CFDictionary)
        var add = query(biometricService, key)
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        status == errSecSuccess ? call.resolve() : call.reject("Biometric setup failed (\(status))", "failed")
    }

    @objc func biometricGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("Must provide key") }
        let context = LAContext()
        context.localizedReason = call.getString("reason") ?? "Unlock your wallet"
        context.localizedCancelTitle = "Use password"
        var q = query(biometricService, key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecUseAuthenticationContext as String] = context
        // Blocks while Face ID runs; Capacitor calls plugin methods off the main thread.
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, let value = String(data: data, encoding: .utf8) else {
                return call.reject("Biometric unlock failed", "failed")
            }
            call.resolve(["value": value])
        case errSecItemNotFound:
            // Never enrolled, or Face ID re-enrolled since (biometryCurrentSet).
            call.resolve(["value": NSNull()])
        case errSecUserCanceled:
            call.reject("Cancelled", "cancelled")
        default:
            call.reject("Biometric unlock failed (\(status))", "failed")
        }
    }

    @objc func biometricRemove(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        SecItemDelete(query(biometricService, key.isEmpty ? nil : key) as CFDictionary)
        call.resolve()
    }

    // MARK: - dApp browser

    private var browser: DappBrowserViewController?
    private var browserHidden = false

    @objc func browserOpen(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let provider = call.getString("provider") else {
            return call.reject("Must provide an http(s) url and provider script")
        }
        DispatchQueue.main.async {
            if let browser = self.browser {
                browser.load(url)
                self.browserHidden = false
                self.present(browser)
                return call.resolve()
            }
            let browser = DappBrowserViewController(provider: provider)
            browser.onRequest = { [weak self] event in self?.notifyListeners("browserRequest", data: event) }
            browser.onClose = { [weak self] in self?.closeBrowser() }
            self.browser = browser
            self.browserHidden = false
            self.present(browser)
            browser.load(url)
            call.resolve()
        }
    }

    private func present(_ browser: DappBrowserViewController) {
        guard browser.presentingViewController == nil, let host = bridge?.viewController else { return }
        browser.modalPresentationStyle = .fullScreen
        host.present(browser, animated: true)
    }

    private func closeBrowser() {
        DispatchQueue.main.async {
            guard let browser = self.browser else { return }
            browser.teardown()
            browser.presentingViewController?.dismiss(animated: true)
            self.browser = nil
            self.notifyListeners("browserClosed", data: [:])
        }
    }

    @objc func browserClose(_ call: CAPPluginCall) {
        closeBrowser()
        call.resolve()
    }

    @objc func browserSetHidden(_ call: CAPPluginCall) {
        let hidden = call.getBool("hidden") ?? false
        DispatchQueue.main.async {
            guard let browser = self.browser, hidden != self.browserHidden else { return call.resolve() }
            self.browserHidden = hidden
            // Approval prompts render in the wallet WebView underneath: step aside for them.
            if hidden { browser.presentingViewController?.dismiss(animated: false) } else { self.present(browser) }
            call.resolve()
        }
    }

    @objc func browserRespond(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId") ?? ""
        let response = call.getString("response") ?? "null"
        DispatchQueue.main.async {
            self.browser?.respond(requestId: requestId, response: response)
            call.resolve()
        }
    }

    @objc func browserEmit(_ call: CAPPluginCall) {
        let event = call.getString("event") ?? ""
        let detail = call.getString("detail") ?? "null"
        DispatchQueue.main.async {
            self.browser?.emit(event: event, detail: detail)
            call.resolve()
        }
    }
}

/// WebKit retains script message handlers strongly; this breaks the cycle.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let target = target else { return replyHandler(nil, "Wallet unavailable") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

final class DappBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    var onRequest: (([String: Any]) -> Void)?
    var onClose: (() -> Void)?

    private let provider: String
    private var webView: WKWebView!
    private let titleButton = UIButton(type: .system)
    private var pending: [String: (generation: Int, reply: (Any?, String?) -> Void)] = [:]
    /// Bumped on every main-frame navigation; replies meant for an older page are refused.
    private var generation = 0

    init(provider: String) {
        self.provider = provider
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 1 / 255, green: 1 / 255, blue: 1 / 255, alpha: 1)

        let config = WKWebViewConfiguration()
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: provider, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        content.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "yours")
        config.userContentController = content
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        let gray = UIColor(red: 156 / 255, green: 163 / 255, blue: 175 / 255, alpha: 1)
        let back = UIButton(type: .system)
        back.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        back.tintColor = gray
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        let close = UIButton(type: .system)
        close.setImage(UIImage(systemName: "xmark"), for: .normal)
        close.tintColor = gray
        close.accessibilityLabel = "Close"
        close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        titleButton.setTitleColor(gray, for: .normal)
        titleButton.titleLabel?.font = .systemFont(ofSize: 13)
        titleButton.titleLabel?.lineBreakMode = .byTruncatingMiddle
        titleButton.addTarget(self, action: #selector(promptForUrl), for: .touchUpInside)

        let bar = UIStackView(arrangedSubviews: [back, titleButton, close])
        bar.axis = .horizontal
        bar.alignment = .center
        bar.distribution = .fill
        titleButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        [bar, webView].forEach {
            $0!.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview($0!)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: guide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 4),
            bar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -4),
            bar.heightAnchor.constraint(equalToConstant: 48),
            back.widthAnchor.constraint(equalToConstant: 48),
            close.widthAnchor.constraint(equalToConstant: 48),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }

    func load(_ url: URL) {
        loadViewIfNeeded()
        webView.load(URLRequest(url: url))
    }

    func teardown() {
        failPending("Browser closed")
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.stopLoading()
    }

    func respond(requestId: String, response: String) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        if entry.generation == generation { entry.reply(response, nil) } else { entry.reply(nil, "Page changed") }
    }

    func emit(event: String, detail: String) {
        guard let eventJSON = try? JSONSerialization.data(withJSONObject: [event, detail], options: .fragmentsAllowed),
              let args = String(data: eventJSON, encoding: .utf8) else { return }
        webView.evaluateJavaScript("(function(a){window.dispatchEvent(new CustomEvent(a[0],{detail:JSON.parse(a[1])}))})(\(args))", in: nil, in: .page)
    }

    /// WebKit requires every reply handler to be called exactly once.
    private func failPending(_ reason: String) {
        let stale = pending
        pending.removeAll()
        stale.values.forEach { $0.reply(nil, reason) }
    }

    // MARK: WKScriptMessageHandlerWithReply

    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        let origin = message.frameInfo.securityOrigin
        let scheme = origin.protocol.lowercased()
        // Only the page the user sees may talk to the wallet; subframes (ads, embeds) may not.
        guard message.frameInfo.isMainFrame, scheme == "https" || scheme == "http",
              let payload = message.body as? String else {
            return replyHandler(nil, "Not allowed")
        }
        let defaultPort = scheme == "https" ? 443 : 80
        let port = origin.port == 0 || origin.port == defaultPort ? "" : ":\(origin.port)"
        let requestId = UUID().uuidString
        pending[requestId] = (generation, replyHandler)
        onRequest?([
            "requestId": requestId,
            "origin": "\(scheme)://\(origin.host)\(port)",
            "url": webView.url?.absoluteString ?? "",
            "payload": payload
        ])
    }

    // MARK: WKNavigationDelegate / WKUIDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let scheme = action.request.url?.scheme?.lowercased() ?? ""
        let allowed = ["https", "http", "about", "blob", "data"].contains(scheme)
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        generation += 1
        failPending("Page changed")
        titleButton.setTitle(webView.url?.host ?? "", for: .normal)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        titleButton.setTitle(webView.url?.host ?? "", for: .normal)
    }

    /// target=_blank / window.open: keep it in this view.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if action.targetFrame == nil, let url = action.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }

    @objc private func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    @objc private func closeTapped() { onClose?() }

    @objc private func promptForUrl() {
        let alert = UIAlertController(title: "Go to", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = self.webView.url?.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.clearButtonMode = .whileEditing
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Go", style: .default) { _ in
            let typed = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !typed.isEmpty else { return }
            let text = typed.contains("://") ? typed : "https://\(typed)"
            if let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? "") { self.load(url) }
        })
        present(alert, animated: true)
    }
}
