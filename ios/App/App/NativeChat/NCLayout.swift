import UIKit

/// Measures text off the main thread: heights are known before a cell exists, so scrolling never lays out text.
/// One instance per thread; TextKit objects are not shared.
final class NCMeasurer {
    private let storage = NSTextStorage()
    private let manager = NSLayoutManager()
    private let container = NSTextContainer()

    init() {
        container.lineFragmentPadding = 0
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
    }

    struct Result {
        var size: CGSize
        var lastLine: CGFloat
    }

    func measure(_ text: String, font: UIFont, maxWidth: CGFloat) -> Result {
        guard !text.isEmpty else { return Result(size: CGSize(width: 0, height: ceil(font.lineHeight)), lastLine: 0) }
        storage.setAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
        container.size = CGSize(width: maxWidth, height: .greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        var last: CGFloat = 0
        manager.enumerateLineFragments(forGlyphRange: manager.glyphRange(for: container)) { _, r, _, _, _ in
            last = r.width
        }
        return Result(size: CGSize(width: ceil(used.width) + 1, height: ceil(used.height)), lastLine: ceil(last))
    }
}

/// Frames for one row, computed once from its text. No Auto Layout in cells.
struct NCCellLayout {
    var height: CGFloat = 0
    var bubble: CGRect = .zero
    var text: CGRect = .zero
    var name: CGRect = .zero
    var badge: CGRect = .zero
    var quoteBar: CGRect = .zero
    var quoteAuthor: CGRect = .zero
    var quoteText: CGRect = .zero
    var note: CGRect = .zero
    var time: CGRect = .zero
    var avatar: CGRect = .zero
    var hint: CGRect = .zero

    static func timeString(_ r: NCRow) -> String {
        let edited = r.edited == true ? "edited · " : ""
        switch r.status {
        case "failed": return "\(edited)failed · retry"
        case "pending": return "\(edited)sending…"
        default: return edited + (r.time ?? "")
        }
    }

    static let cardHint = "Open in full room"

    static func make(_ r: NCRow, width: CGFloat, m: NCMeasurer) -> NCCellLayout {
        var l = NCCellLayout()
        let margin: CGFloat = 12
        switch r.type {
        case "day":
            let t = m.measure(r.text, font: NCTheme.smallFont, maxWidth: width - 48).size
            let w = t.width + 20
            l.bubble = CGRect(x: floor((width - w) / 2), y: 10, width: w, height: 22)
            l.text = CGRect(x: l.bubble.minX + 10, y: l.bubble.minY + floor((22 - t.height) / 2), width: t.width, height: t.height)
            l.height = 42
            return l
        case "system":
            let t = m.measure(r.text, font: NCTheme.smallFont, maxWidth: floor(width * 0.85) - 20).size
            let w = t.width + 20
            let h = t.height + 8
            l.bubble = CGRect(x: floor((width - w) / 2), y: 6, width: w, height: h)
            l.text = l.bubble.insetBy(dx: 10, dy: 4)
            l.height = h + 12
            return l
        case "card":
            let maxW = floor(width * 0.8)
            let title = m.measure(r.text, font: NCTheme.bodyFont, maxWidth: maxW - 20).size
            let hint = m.measure(cardHint, font: NCTheme.smallFont, maxWidth: maxW - 20).size
            let w = min(maxW, max(title.width, hint.width) + 20)
            let h = title.height + hint.height + 18
            let x = r.isMine ? width - margin - w : margin + 36
            l.bubble = CGRect(x: x, y: 4, width: w, height: h)
            l.text = CGRect(x: x + 10, y: 11, width: w - 20, height: title.height)
            l.hint = CGRect(x: x + 10, y: 11 + title.height + 2, width: w - 20, height: hint.height)
            l.height = h + 8
            return l
        default:
            break
        }
        // message
        let padX: CGFloat = 10
        let padY: CGFloat = 7
        let top: CGFloat = r.isFirst ? 8 : 3
        let leftX = margin + 36
        let maxBubble = r.isMine ? floor(width * 0.8) : min(floor(width * 0.8), width - leftX - margin)
        let textMax = maxBubble - padX * 2
        let body = m.measure(r.text, font: NCTheme.bodyFont, maxWidth: textMax)
        let timeSize = m.measure(timeString(r), font: NCTheme.metaFont, maxWidth: textMax).size
        let showName = !r.isMine && r.isFirst && (r.author?.isEmpty == false)
        var inner = body.size.width
        let inlineTime = body.lastLine + 8 + timeSize.width <= textMax
        var name = CGSize.zero
        var badgeW: CGFloat = 0
        if showName {
            name = m.measure(r.author ?? "", font: NCTheme.nameFont, maxWidth: textMax).size
            if r.badge != nil { badgeW = m.measure(r.badge ?? "", font: NCTheme.badgeFont, maxWidth: 60).size.width + 8 }
            inner = max(inner, min(textMax, name.width + (badgeW > 0 ? badgeW + 6 : 0)))
        }
        var quoteH: CGFloat = 0
        var quoteA = CGSize.zero
        var quoteT = CGSize.zero
        if r.hasQuote {
            quoteA = m.measure(r.quoteAuthor ?? "", font: NCTheme.nameFont, maxWidth: textMax - 10).size
            quoteT = m.measure(r.quoteText ?? "", font: NCTheme.quoteFont, maxWidth: textMax - 10).size
            quoteT.height = min(quoteT.height, ceil(NCTheme.quoteFont.lineHeight) * 2)
            quoteH = quoteA.height + quoteT.height + 4
            inner = max(inner, min(textMax, max(quoteA.width, quoteT.width) + 10))
        }
        var noteH: CGFloat = 0
        if let n = r.note {
            let s = m.measure(n, font: NCTheme.smallFont, maxWidth: textMax).size
            noteH = s.height + 2
            inner = max(inner, s.width)
        }
        var extraTime: CGFloat = 0
        if inlineTime { inner = max(inner, min(textMax, body.lastLine + 8 + timeSize.width)) }
        else { extraTime = timeSize.height + 2; inner = max(inner, timeSize.width) }

        let bubbleW = ceil(inner + padX * 2)
        let bubbleX = r.isMine ? width - margin - bubbleW : leftX
        var y = top + padY
        if showName {
            l.name = CGRect(x: bubbleX + padX, y: y, width: min(name.width, textMax - (badgeW > 0 ? badgeW + 6 : 0)), height: name.height)
            if badgeW > 0 { l.badge = CGRect(x: l.name.maxX + 6, y: y + 1, width: badgeW, height: name.height - 2) }
            y += name.height + 2
        }
        if r.hasQuote {
            l.quoteBar = CGRect(x: bubbleX + padX, y: y + 1, width: 2, height: quoteH - 4)
            l.quoteAuthor = CGRect(x: bubbleX + padX + 8, y: y, width: min(quoteA.width, textMax - 8), height: quoteA.height)
            l.quoteText = CGRect(x: bubbleX + padX + 8, y: y + quoteA.height + 1, width: min(quoteT.width, textMax - 8), height: quoteT.height)
            y += quoteH + 3
        }
        l.text = CGRect(x: bubbleX + padX, y: y, width: body.size.width, height: body.size.height)
        y += body.size.height
        if r.note != nil {
            l.note = CGRect(x: bubbleX + padX, y: y + 2, width: textMax, height: noteH - 2)
            y += noteH
        }
        y += extraTime
        l.time = CGRect(
            x: bubbleX + bubbleW - padX - timeSize.width, y: y - timeSize.height, width: timeSize.width, height: timeSize.height)
        y += padY
        l.bubble = CGRect(x: bubbleX, y: top, width: bubbleW, height: y - top)
        if !r.isMine && r.isFirst { l.avatar = CGRect(x: margin, y: y - 28, width: 28, height: 28) }
        l.height = y
        return l
    }
}

/// Fixed-height layout over pre-measured rows, bottom-aligned when the content is short.
/// Visible-range lookup is a binary search, so a 5,000-row room costs the same to scroll as a 50-row one.
final class NCChatLayout: UICollectionViewLayout {
    private(set) var tops: [CGFloat] = []
    private(set) var heights: [CGFloat] = []
    private var contentHeight: CGFloat = 0
    private var dirty = true

    func setHeights(_ h: [CGFloat]) {
        heights = h
        dirty = true
        invalidateLayout()
    }

    var totalHeight: CGFloat { heights.reduce(0, +) }

    private var boundsSize: CGSize { collectionView?.bounds.size ?? .zero }
    private var topPad: CGFloat { max(0, boundsSize.height - contentHeight) }

    override func prepare() {
        super.prepare()
        guard dirty else { return }
        dirty = false
        tops.removeAll(keepingCapacity: true)
        tops.reserveCapacity(heights.count)
        var y: CGFloat = 0
        for h in heights {
            tops.append(y)
            y += h
        }
        contentHeight = y
    }

    override var collectionViewContentSize: CGSize {
        CGSize(width: boundsSize.width, height: max(contentHeight, boundsSize.height))
    }

    private func attrs(_ i: Int) -> UICollectionViewLayoutAttributes {
        let a = UICollectionViewLayoutAttributes(forCellWith: IndexPath(item: i, section: 0))
        a.frame = CGRect(x: 0, y: tops[i] + topPad, width: boundsSize.width, height: heights[i])
        return a
    }

    private func firstIndex(atOrBelow y: CGFloat) -> Int {
        var lo = 0
        var hi = tops.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if tops[mid] + heights[mid] + topPad <= y { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        guard !tops.isEmpty else { return [] }
        var out: [UICollectionViewLayoutAttributes] = []
        var i = firstIndex(atOrBelow: rect.minY)
        while i < tops.count, tops[i] + topPad < rect.maxY {
            out.append(attrs(i))
            i += 1
        }
        return out
    }

    override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
        indexPath.item < tops.count ? attrs(indexPath.item) : nil
    }

    override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
        guard let cv = collectionView else { return false }
        return newBounds.width != cv.bounds.width
            || (newBounds.height != cv.bounds.height && contentHeight < max(newBounds.height, cv.bounds.height))
    }

    /// A rotation or width change invalidates and re-measures in the VC; a height change only moves the pad.
    override func invalidationContext(forBoundsChange newBounds: CGRect) -> UICollectionViewLayoutInvalidationContext {
        super.invalidationContext(forBoundsChange: newBounds)
    }
}

/// How a new row list relates to the old one (ids only), so a prepend keeps its place and a send can animate.
enum NCChange: Equatable {
    case same
    case appended(Int)
    case prepended(Int)
    case other

    static func classify(old: [String], new: [String]) -> NCChange {
        if old == new { return .same }
        if old.isEmpty { return .other }
        if new.count > old.count {
            if Array(new.prefix(old.count)) == old { return .appended(new.count - old.count) }
            if Array(new.suffix(old.count)) == old { return .prepended(new.count - old.count) }
        }
        return .other
    }
}
