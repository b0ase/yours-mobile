import UIKit

/// What the native chat draws. Display rows only, built in TypeScript (src/mobile/nativeChat/rows.ts):
/// no keys, seeds, signatures, sealed envelopes or payment data ever reach Swift.
struct NCRow: Codable, Equatable {
    var id: String
    var type: String  // day | system | message | card
    var text: String
    var author: String?
    var initial: String?
    var nameColor: String?
    var bubble: String?
    var time: String?
    var mine: Bool?
    var first: Bool?
    var status: String?  // sent | pending | failed
    var edited: Bool?
    var badge: String?
    var note: String?
    var quoteAuthor: String?
    var quoteText: String?
    var variant: String?
    var localId: String?

    var isMine: Bool { mine == true }
    var isFirst: Bool { first == true }
    var hasQuote: Bool { quoteText != nil || quoteAuthor != nil }
}

struct NCRoom: Codable, Equatable {
    var ticker: String
    var key: String
    var title: String
    var preview: String
    var time: String
    var unread: Int
    var muted: Bool
    var pinned: Bool
    var marked: Bool
    var initial: String
    var members: Int
    var direct: Bool
}

struct NCComposerState: Decodable, Equatable {
    var kind: String  // open | readonly | classic
    var note: String?
    static let open = NCComposerState(kind: "open", note: nil)
}

/// House look: true black, gold accent, angular small-radius controls of one height. Theme values only.
enum NCTheme {
    static var accent = UIColor(hex: "#F2C230") ?? .systemYellow
    static let background = UIColor.black
    static let surface = UIColor(hex: "#141414")!
    static let line = UIColor(hex: "#222222")!
    static let text = UIColor(hex: "#F2F2F0")!
    static let muted = UIColor(hex: "#8A8F98")!
    static let bubbleOther = UIColor(hex: "#211F1D")!
    static let bubbleMineText = UIColor(hex: "#1A1300")!
    static let bubbleMineMeta = UIColor(hex: "#5C4800")!
    static let danger = UIColor(hex: "#F97066")!
    static let swipeDark = UIColor(hex: "#2A2208")!
    static let swipeGrey = UIColor(hex: "#2B2B2B")!

    static let radius: CGFloat = 5
    static let controlHeight: CGFloat = 40

    static let bodyFont = UIFont.systemFont(ofSize: 15)
    static let nameFont = UIFont.systemFont(ofSize: 12, weight: .semibold)
    static let metaFont = UIFont.systemFont(ofSize: 10)
    static let smallFont = UIFont.systemFont(ofSize: 11)
    static let quoteFont = UIFont.systemFont(ofSize: 12)
    static let titleFont = UIFont.systemFont(ofSize: 16, weight: .semibold)
    static let previewFont = UIFont.systemFont(ofSize: 13)
    static let badgeFont = UIFont.systemFont(ofSize: 9, weight: .bold)
}

extension UIColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(
            red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
            blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}
