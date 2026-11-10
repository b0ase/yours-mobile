import UIKit

final class NCRoomCell: UITableViewCell {
    static let id = "room"
    static let height: CGFloat = 72
    private let tile = UILabel()
    private let title = UILabel()
    private let preview = UILabel()
    private let time = UILabel()
    private let badge = UILabel()
    private let pin = UIImageView(image: UIImage(systemName: "pin.fill"))
    private let mute = UIImageView(image: UIImage(systemName: "bell.slash.fill"))
    private let line = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        // Square, full-bleed row: the swipe actions sit in the row's own rect, with nothing rounded to leak behind.
        backgroundColor = NCTheme.background
        contentView.backgroundColor = NCTheme.background
        selectionStyle = .none
        tile.font = UIFont.systemFont(ofSize: 20, weight: .semibold)
        tile.textAlignment = .center
        tile.textColor = NCTheme.accent
        tile.backgroundColor = NCTheme.surface
        tile.layer.cornerRadius = NCTheme.radius
        tile.layer.masksToBounds = true
        title.font = NCTheme.titleFont
        title.textColor = NCTheme.text
        preview.font = NCTheme.previewFont
        preview.textColor = NCTheme.muted
        time.font = NCTheme.smallFont
        time.textAlignment = .right
        badge.font = UIFont.systemFont(ofSize: 11, weight: .bold)
        badge.textAlignment = .center
        badge.layer.cornerRadius = 4
        badge.layer.masksToBounds = true
        pin.tintColor = NCTheme.muted
        pin.contentMode = .scaleAspectFit
        mute.tintColor = NCTheme.muted
        mute.contentMode = .scaleAspectFit
        line.backgroundColor = NCTheme.line
        for v in [tile, title, preview, time, badge, pin, mute, line] as [UIView] { contentView.addSubview(v) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func setHighlighted(_ on: Bool, animated: Bool) {
        contentView.backgroundColor = on ? NCTheme.surface : NCTheme.background
    }

    func configure(_ r: NCRoom) {
        tile.text = r.initial
        title.text = r.title
        preview.text = r.preview
        time.text = r.time
        pin.isHidden = !r.pinned
        mute.isHidden = !r.muted
        let count = r.unread
        let showBadge = count > 0 || r.marked
        badge.isHidden = !showBadge
        badge.text = count > 0 ? (count > 999 ? "999+" : String(count)) : " "
        badge.backgroundColor = r.muted ? NCTheme.swipeGrey : NCTheme.accent
        badge.textColor = r.muted ? NCTheme.text : NCTheme.bubbleMineText
        time.textColor = count > 0 && !r.muted ? NCTheme.accent : NCTheme.muted
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = contentView.bounds.width
        tile.frame = CGRect(x: 14, y: 12, width: 48, height: 48)
        let x: CGFloat = 74
        let timeW: CGFloat = 76
        time.frame = CGRect(x: w - 14 - timeW, y: 14, width: timeW, height: 16)
        var titleRight = time.frame.minX - 6
        if !mute.isHidden {
            titleRight -= 16
            mute.frame = CGRect(x: titleRight + 2, y: 16, width: 13, height: 13)
        }
        title.frame = CGRect(x: x, y: 12, width: max(0, titleRight - x), height: 21)
        var previewRight = w - 14
        if !badge.isHidden {
            let bw = max(22, min(52, (badge.text?.size(withAttributes: [.font: badge.font!]).width ?? 0) + 12))
            badge.frame = CGRect(x: w - 14 - bw, y: 37, width: bw, height: 22)
            previewRight = badge.frame.minX - 8
        }
        if !pin.isHidden {
            pin.frame = CGRect(x: previewRight - 13, y: 41, width: 13, height: 13)
            previewRight -= 19
        }
        preview.frame = CGRect(x: x, y: 38, width: max(0, previewRight - x), height: 20)
        line.frame = CGRect(x: x, y: NCRoomCell.height - 1 / UIScreen.main.scale, width: w - x, height: 1 / UIScreen.main.scale)
    }
}

/// The room list between the web top bar and the web tab bar.
final class NCListViewController: UIViewController, UITableViewDelegate {
    private weak var coordinator: NativeChatCoordinator?
    let table = UITableView(frame: .zero, style: .plain)
    private let header = UIView()
    private let empty = UILabel()
    private var source: UITableViewDiffableDataSource<Int, String>!
    private var rooms: [String: NCRoom] = [:]
    private var order: [String] = []
    private var pending: [NCRoom]?
    var listRect: CGRect = .zero {
        didSet { if listRect != oldValue { view.setNeedsLayout() } }
    }
    private let headerHeight: CGFloat = 44

    init(coordinator: NativeChatCoordinator) {
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Clear: the web bars show through, and touches outside the list go to them (NCHostView).
        view.backgroundColor = .clear
        table.backgroundColor = NCTheme.background
        table.separatorStyle = .none
        table.rowHeight = NCRoomCell.height
        table.estimatedRowHeight = NCRoomCell.height
        table.contentInsetAdjustmentBehavior = .never
        table.delegate = self
        table.register(NCRoomCell.self, forCellReuseIdentifier: NCRoomCell.id)
        source = UITableViewDiffableDataSource<Int, String>(tableView: table) { [weak self] tv, ip, ticker in
            let c = tv.dequeueReusableCell(withIdentifier: NCRoomCell.id, for: ip) as! NCRoomCell
            if let r = self?.rooms[ticker] { c.configure(r) }
            return c
        }
        source.defaultRowAnimation = .none

        header.backgroundColor = NCTheme.background
        let title = UILabel()
        title.text = "Chats"
        title.font = UIFont.systemFont(ofSize: 20, weight: .bold)
        title.textColor = NCTheme.text
        title.frame = CGRect(x: 14, y: 8, width: 160, height: 28)
        header.addSubview(title)
        let classic = UIButton(type: .system)
        classic.setTitle("Classic view", for: .normal)
        classic.titleLabel?.font = NCTheme.nameFont
        classic.setTitleColor(NCTheme.accent, for: .normal)
        classic.layer.cornerRadius = NCTheme.radius
        classic.layer.borderWidth = 1
        classic.layer.borderColor = NCTheme.accent.cgColor
        classic.tag = 7
        classic.addTarget(self, action: #selector(classicTapped), for: .touchUpInside)
        header.addSubview(classic)
        empty.text = "No chats yet."
        empty.font = NCTheme.previewFont
        empty.textColor = NCTheme.muted
        empty.textAlignment = .center
        empty.isHidden = true
        view.addSubview(header)
        view.addSubview(table)
        view.addSubview(empty)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        header.frame = CGRect(x: listRect.minX, y: listRect.minY, width: listRect.width, height: headerHeight)
        header.viewWithTag(7)?.frame = CGRect(x: listRect.width - 14 - 96, y: 8, width: 96, height: 28)
        table.frame = CGRect(x: listRect.minX, y: listRect.minY + headerHeight, width: listRect.width, height: max(0, listRect.height - headerHeight))
        empty.frame = table.frame
    }

    @objc private func classicTapped() { coordinator?.emit(["type": "classicList"]) }

    func setRooms(_ list: [NCRoom]) {
        // Keep the order still while the list is moving; the fresh order lands once it stops.
        if isViewLoaded && (table.isDragging || table.isDecelerating) {
            pending = list
            return
        }
        pending = nil
        let changed = list.filter { rooms[$0.ticker] != $0 }.map(\.ticker)
        let newOrder = list.map(\.ticker)
        rooms = Dictionary(uniqueKeysWithValues: list.map { ($0.ticker, $0) })
        empty.isHidden = !list.isEmpty
        var snap = NSDiffableDataSourceSnapshot<Int, String>()
        snap.appendSections([0])
        snap.appendItems(Array(NSOrderedSet(array: newOrder)) as! [String])
        let reconfigure = changed.filter { order.contains($0) && newOrder.contains($0) }
        if !reconfigure.isEmpty { snap.reconfigureItems(reconfigure) }
        order = newOrder
        source.apply(snap, animatingDifferences: false)
    }

    func room(_ ticker: String) -> NCRoom? { rooms[ticker] }

    private func flushPending() {
        if let p = pending { setRooms(p) }
    }

    func scrollViewDidEndDecelerating(_ s: UIScrollView) { flushPending() }
    func scrollViewDidEndDragging(_ s: UIScrollView, willDecelerate d: Bool) { if !d { flushPending() } }

    func tableView(_ t: UITableView, didSelectRowAt ip: IndexPath) {
        t.deselectRow(at: ip, animated: false)
        if let ticker = source.itemIdentifier(for: ip), let r = rooms[ticker] { coordinator?.open(r) }
    }

    private func action(_ title: String, _ image: String, _ color: UIColor, _ ticker: String, _ name: String) -> UIContextualAction {
        let a = UIContextualAction(style: .normal, title: title) { [weak self] _, _, done in
            self?.coordinator?.emit(["type": "swipe", "ticker": ticker, "action": name])
            done(true)
        }
        a.backgroundColor = color
        a.image = UIImage(systemName: image)
        return a
    }

    func tableView(_ t: UITableView, leadingSwipeActionsConfigurationForRowAt ip: IndexPath) -> UISwipeActionsConfiguration? {
        guard let ticker = source.itemIdentifier(for: ip), let r = rooms[ticker] else { return nil }
        let unread = r.unread > 0 || r.marked
        let cfg = UISwipeActionsConfiguration(actions: [
            action(unread ? "Read" : "Unread", unread ? "envelope.open.fill" : "envelope.badge.fill", NCTheme.accent.withAlphaComponent(0.85), ticker, unread ? "read" : "unread"),
            action(r.pinned ? "Unpin" : "Pin", r.pinned ? "pin.slash.fill" : "pin.fill", NCTheme.swipeDark, ticker, r.pinned ? "unpin" : "pin"),
        ])
        cfg.performsFirstActionWithFullSwipe = true
        return cfg
    }

    func tableView(_ t: UITableView, trailingSwipeActionsConfigurationForRowAt ip: IndexPath) -> UISwipeActionsConfiguration? {
        guard let ticker = source.itemIdentifier(for: ip), let r = rooms[ticker] else { return nil }
        let cfg = UISwipeActionsConfiguration(actions: [
            action("Archive", "archivebox.fill", NCTheme.swipeDark, ticker, "archive"),
            action(r.muted ? "Unmute" : "Mute", r.muted ? "bell.fill" : "bell.slash.fill", NCTheme.swipeGrey, ticker, r.muted ? "unmute" : "mute"),
        ])
        cfg.performsFirstActionWithFullSwipe = true
        return cfg
    }
}
