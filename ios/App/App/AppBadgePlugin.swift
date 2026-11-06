import Capacitor
import UIKit
import UserNotifications

/// Native side of src/mobile/tabs/iconBadge.ts: the number on the home-screen icon (unread chat + bMail).
///
/// Badges need notification permission that includes .badge. The app already asks for it (alert, sound, badge) through
/// @capacitor/push-notifications when bChat signs in, and @capacitor/local-notifications; this plugin never prompts.
/// Without permission it resolves { applied: false } and the icon stays as it is.
/// iOS 16+: UNUserNotificationCenter.setBadgeCount; iOS 15: UIApplication.applicationIconBadgeNumber.
/// Remote pushes set the icon too (aps.badge from push.bwalletx.com); the app puts its own number back on resume.
@objc(AppBadgePlugin)
public class AppBadgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppBadgePlugin"
    public let jsName = "AppBadge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    static let maxCount = 9999

    static func clamp(_ n: Int?) -> Int { max(0, min(n ?? 0, maxCount)) }

    @objc func set(_ call: CAPPluginCall) {
        let count = AppBadgePlugin.clamp(call.getInt("count"))
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let allowed: Bool
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: allowed = settings.badgeSetting == .enabled
            default: allowed = false
            }
            guard allowed else { return call.resolve(["applied": false, "reason": "not-allowed"]) }
            if #available(iOS 16.0, *) {
                center.setBadgeCount(count) { error in
                    call.resolve(["applied": error == nil])
                }
            } else {
                DispatchQueue.main.async {
                    UIApplication.shared.applicationIconBadgeNumber = count
                    call.resolve(["applied": true])
                }
            }
        }
    }
}
