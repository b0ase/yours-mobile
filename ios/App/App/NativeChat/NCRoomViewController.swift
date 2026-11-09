import UIKit

final class NCMessageCell: UICollectionViewCell {
    static let id = "m"
    private let bubble = UIView()
    private let bodyLabel = UILabel()
    private let nameLabel = UILabel()
    private let badgeLabel = UILabel()
    private let timeLabel = UILabel()
    private let noteLabel = UILabel()
    private let quoteBar = UIView()
    private let quoteAuthor = UILabel()
    private let quoteText = UILabel()
    private let hintLabel = UILabel()
    private let avatar = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = NCTheme.background
        bubble.layer.cornerRadius = NCTheme.radius
        bubble.layer.cornerCurve = .continuous
        contentView.addSubview(bubble)
        for l in [bodyLabel, nameLabel, badgeLabel, timeLabel, noteLabel, quoteAuthor, quoteText, hintLabel] {
            contentView.addSubview(l)
        }
        contentView.addSubview(quoteBar)
        bodyLabel.numberOfLines = 0
        bodyLabel.font = NCTheme.bodyFont
        nameLabel.font = NCTheme.nameFont
        badgeLabel.font = NCTheme.badgeFont
        badgeLabel.textAlignment = .center
        badgeLabel.layer.cornerRadius = 2
        badgeLabel.layer.masksToBounds = true
        timeLabel.font = NCTheme.metaFont
        noteLabel.font = NCTheme.smallFont
        quoteAuthor.font = NCTheme.nameFont
        quoteText.font = NCTheme.quoteFont
        quoteText.numberOfLines = 2
        hintLabel.font = NCTheme.smallFont
        hintLabel.textColor = NCTheme.accent
        avatar.font = NCTheme.nameFont
        avatar.textAlignment = .center
        avatar.textColor = NCTheme.accent
        avatar.backgroundColor = NCTheme.surface
        avatar.layer.cornerRadius = NCTheme.radius
        avatar.layer.masksToBounds = true
        contentView.addSubview(avatar)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(_ r: NCRow, _ l: NCCellLayout) {
        bubble.frame = l.bubble
        bubble.layer.borderWidth = 0
        let mine = r.isMine
        let surface: UIColor
        var bodyColor = NCTheme.text
        var metaColor = NCTheme.muted
        switch r.type {
        case "day", "system":
            surface = NCTheme.surface
            bodyColor = r.type == "day" ? UIColor(hex: "#C9C3AD")! : NCTheme.muted
            bodyLabel.font = NCTheme.smallFont
            bodyLabel.textAlignment = .center
        case "card":
            surface = NCTheme.surface
            bubble.layer.borderWidth = 1
            bubble.layer.borderColor = NCTheme.accent.cgColor
            bodyLabel.font = NCTheme.bodyFont
            bodyLabel.textAlignment = .left
        default:
            bodyLabel.font = NCTheme.bodyFont
            bodyLabel.textAlignment = .left
            if mine {
                surface = NCTheme.accent
                bodyColor = NCTheme.bubbleMineText
                metaColor = NCTheme.bubbleMineMeta
            } else if r.variant == "b" {
                surface = UIColor(hex: "#1A1610")!
                bubble.layer.borderWidth = 1.5
                bubble.layer.borderColor = NCTheme.accent.cgColor
            } else {
                surface = r.bubble.flatMap { UIColor(hex: $0) } ?? NCTheme.bubbleOther
            }
        }
        bubble.backgroundColor = surface
        bubble.alpha = r.status == "pending" ? 0.75 : 1

        func place(_ lab: UILabel, _ text: String?, _ frame: CGRect, color: UIColor) {
            lab.isHidden = frame == .zero || text == nil
            guard !lab.isHidden else { return }
            lab.text = text
            lab.frame = frame
            lab.textColor = color
            // Opaque labels avoid blending while scrolling.
            lab.backgroundColor = surface
        }
        place(bodyLabel, r.text, l.text, color: bodyColor)
        let nameColor = r.nameColor.flatMap { UIColor(hex: $0) } ?? NCTheme.accent
        place(nameLabel, r.author, l.name, color: nameColor)
        place(badgeLabel, r.badge, l.badge, color: .black)
        badgeLabel.backgroundColor = NCTheme.accent
        let time = r.type == "message" ? NCCellLayout.timeString(r) : nil
        place(timeLabel, time, l.time, color: r.status == "failed" ? NCTheme.danger : metaColor)
        place(noteLabel, r.note, l.note, color: metaColor)
        place(quoteAuthor, r.quoteAuthor, l.quoteAuthor, color: nameColor)
        place(quoteText, r.quoteText, l.quoteText, color: metaColor)
        place(hintLabel, r.type == "card" ? NCCellLayout.cardHint : nil, l.hint, color: NCTheme.accent)
        quoteBar.isHidden = l.quoteBar == .zero
        quoteBar.frame = l.quoteBar
        quoteBar.backgroundColor = nameColor
        avatar.isHidden = l.avatar == .zero
        if !avatar.isHidden {
            avatar.frame = l.avatar
            avatar.text = r.initial ?? "?"
        }
    }
}

/// The composer: a text view and a gold send control of one height, or a note with the full-room button.
final class NCComposerView: UIView, UITextViewDelegate {
    var onSend: ((String) -> Void)?
    var onClassic: (() -> Void)?
    private let textView = UITextView()
    private let placeholder = UILabel()
    private let send = UIButton(type: .system)
    private let noteLabel = UILabel()
    private let classicButton = UIButton(type: .system)
    private var heightC: NSLayoutConstraint!
    private let maxHeight: CGFloat = 112

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = NCTheme.background
        let line = UIView()
        line.backgroundColor = NCTheme.line
        line.translatesAutoresizingMaskIntoConstraints = false
        addSubview(line)

        textView.backgroundColor = NCTheme.surface
        textView.textColor = NCTheme.text
        textView.tintColor = NCTheme.accent
        textView.font = NCTheme.bodyFont
        textView.layer.cornerRadius = NCTheme.radius
        textView.layer.cornerCurve = .continuous
        textView.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        textView.isScrollEnabled = false
        textView.keyboardAppearance = .dark
        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false
        placeholder.text = "Message"
        placeholder.font = NCTheme.bodyFont
        placeholder.textColor = NCTheme.muted
        placeholder.translatesAutoresizingMaskIntoConstraints = false

        send.setImage(UIImage(systemName: "arrow.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .bold)), for: .normal)
        send.tintColor = NCTheme.bubbleMineText
        send.backgroundColor = NCTheme.accent
        send.layer.cornerRadius = NCTheme.radius
        send.layer.cornerCurve = .continuous
        send.accessibilityLabel = "Send"
        send.addTarget(self, action: #selector(sendTapped), for: .touchUpInside)
        send.translatesAutoresizingMaskIntoConstraints = false

        noteLabel.font = NCTheme.smallFont
        noteLabel.textColor = NCTheme.muted
        noteLabel.numberOfLines = 2
        noteLabel.translatesAutoresizingMaskIntoConstraints = false
        classicButton.setTitle("Full room", for: .normal)
        classicButton.titleLabel?.font = NCTheme.nameFont
        classicButton.setTitleColor(NCTheme.bubbleMineText, for: .normal)
        classicButton.backgroundColor = NCTheme.accent
        classicButton.layer.cornerRadius = NCTheme.radius
        classicButton.addTarget(self, action: #selector(classicTapped), for: .touchUpInside)
        classicButton.translatesAutoresizingMaskIntoConstraints = false

        for v in [textView, placeholder, send, noteLabel, classicButton] { addSubview(v) }
        heightC = textView.heightAnchor.constraint(equalToConstant: NCTheme.controlHeight)
        NSLayoutConstraint.activate([
            line.topAnchor.constraint(equalTo: topAnchor),
            line.leadingAnchor.constraint(equalTo: leadingAnchor),
            line.trailingAnchor.constraint(equalTo: trailingAnchor),
            line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
            textView.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            textView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            textView.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -8),
            textView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
            heightC,
            send.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            send.bottomAnchor.constraint(equalTo: textView.bottomAnchor),
            send.widthAnchor.constraint(equalToConstant: NCTheme.controlHeight),
            send.heightAnchor.constraint(equalToConstant: NCTheme.controlHeight),
            placeholder.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 13),
            placeholder.centerYAnchor.constraint(equalTo: textView.centerYAnchor),
            noteLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            noteLabel.centerYAnchor.constraint(equalTo: textView.centerYAnchor),
            noteLabel.trailingAnchor.constraint(equalTo: classicButton.leadingAnchor, constant: -10),
            classicButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            classicButton.centerYAnchor.constraint(equalTo: textView.centerYAnchor),
            classicButton.heightAnchor.constraint(equalToConstant: NCTheme.controlHeight),
            classicButton.widthAnchor.constraint(equalToConstant: 92),
        ])
        apply(.open)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func apply(_ s: NCComposerState) {
        let open = s.kind == "open"
        textView.isHidden = !open
        send.isHidden = !open
        placeholder.isHidden = !open || !textView.text.isEmpty
        noteLabel.isHidden = open
        noteLabel.text = s.note
        classicButton.isHidden = s.kind != "classic"
    }

    func textViewDidChange(_ t: UITextView) {
        placeholder.isHidden = !t.text.isEmpty
        let h = min(maxHeight, max(NCTheme.controlHeight, ceil(t.sizeThatFits(CGSize(width: t.bounds.width, height: .greatestFiniteMagnitude)).height)))
        t.isScrollEnabled = h >= maxHeight
        if h != heightC.constant { heightC.constant = h }
    }

    @objc private func sendTapped() {
        let text = textView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        textView.text = ""
        textViewDidChange(textView)
        onSend?(text)
    }

    @objc private func classicTapped() { onClassic?() }
}

/// One group room. Opens on what the cache has, in the first frame; the bridge updates it after.
final class NCRoomViewController: UIViewController, UICollectionViewDataSource, UICollectionViewDelegate {
    let room: NCRoom
    private weak var coordinator: NativeChatCoordinator?
    private var rows: [NCRow]
    private var layouts: [NCCellLayout] = []
    private var measured: [String: (row: NCRow, layout: NCCellLayout)] = [:]
    private let chatLayout = NCChatLayout()
    private lazy var collection = UICollectionView(frame: .zero, collectionViewLayout: chatLayout)
    private let header = UIView()
    private let composer = NCComposerView()
    private let statusLabel = UILabel()
    private let measurer = NCMeasurer()
    private let bgQueue = DispatchQueue(label: "bwallet.nativechat.layout", qos: .userInitiated)
    private let bgMeasurer = NCMeasurer()
    private var generation = 0
    private var width: CGFloat = 0
    private var lastHeight: CGFloat = 0
    private var stick = true
    private var hasMore = false
    private var olderAskedAt = -1
    private var didInitialScroll = false
    private var composerState = NCComposerState.open
    private var loading = false
    private var errorText = ""
    /// DEBUG bench: called once the first rows are on screen.
    var onFirstContent: (() -> Void)?
    private var firstContentFired = false

    init(room: NCRoom, rows: [NCRow], coordinator: NativeChatCoordinator) {
        self.room = room
        self.rows = rows
        self.coordinator = coordinator
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = NCTheme.background

        collection.backgroundColor = NCTheme.background
        collection.dataSource = self
        collection.delegate = self
        collection.register(NCMessageCell.self, forCellWithReuseIdentifier: NCMessageCell.id)
        collection.contentInsetAdjustmentBehavior = .never
        collection.keyboardDismissMode = .interactive
        collection.alwaysBounceVertical = true
        collection.isPrefetchingEnabled = true
        collection.translatesAutoresizingMaskIntoConstraints = false

        composer.translatesAutoresizingMaskIntoConstraints = false
        composer.onSend = { [weak self] text in self?.sendText(text) }
        composer.onClassic = { [weak self] in self?.openClassic() }

        let composerFloor = UIView()
        composerFloor.backgroundColor = NCTheme.background
        composerFloor.translatesAutoresizingMaskIntoConstraints = false

        header.backgroundColor = NCTheme.background
        header.translatesAutoresizingMaskIntoConstraints = false
        buildHeader()

        statusLabel.font = NCTheme.smallFont
        statusLabel.textColor = NCTheme.muted
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 3
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        for v in [collection, composerFloor, composer, statusLabel, header] { view.addSubview(v) }
        view.keyboardLayoutGuide.followsUndockedKeyboard = true
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: view.topAnchor),
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            header.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 52),
            collection.topAnchor.constraint(equalTo: header.bottomAnchor),
            collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collection.bottomAnchor.constraint(equalTo: composer.topAnchor),
            composer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            composerFloor.topAnchor.constraint(equalTo: composer.bottomAnchor),
            composerFloor.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerFloor.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerFloor.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            statusLabel.centerXAnchor.constraint(equalTo: collection.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: collection.centerYAnchor),
            statusLabel.widthAnchor.constraint(equalTo: collection.widthAnchor, multiplier: 0.8),
        ])
        composer.apply(composerState)
    }

    private func buildHeader() {
        let back = UIButton(type: .system)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        back.tintColor = NCTheme.accent
        back.accessibilityLabel = "Back"
        back.addTarget(self, action: #selector(backTapped), for: .touchUpInside)
        let tile = UILabel()
        tile.text = room.initial
        tile.font = NCTheme.titleFont
        tile.textAlignment = .center
        tile.textColor = NCTheme.accent
        tile.backgroundColor = NCTheme.surface
        tile.layer.cornerRadius = NCTheme.radius
        tile.layer.masksToBounds = true
        let title = UILabel()
        title.text = room.title
        title.font = NCTheme.titleFont
        title.textColor = NCTheme.text
        title.lineBreakMode = .byTruncatingTail
        let sub = UILabel()
        sub.text = room.direct ? "Direct message" : "\(room.members) member\(room.members == 1 ? "" : "s")"
        sub.font = NCTheme.smallFont
        sub.textColor = NCTheme.muted
        let full = UIButton(type: .system)
        full.setTitle("Full room", for: .normal)
        full.titleLabel?.font = NCTheme.nameFont
        full.setTitleColor(NCTheme.accent, for: .normal)
        full.layer.cornerRadius = NCTheme.radius
        full.layer.borderWidth = 1
        full.layer.borderColor = NCTheme.accent.cgColor
        full.addTarget(self, action: #selector(classicTapped), for: .touchUpInside)
        let line = UIView()
        line.backgroundColor = NCTheme.line
        for v in [back, tile, title, sub, full, line] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            header.addSubview(v)
        }
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        full.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            back.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 4),
            back.bottomAnchor.constraint(equalTo: header.bottomAnchor, constant: -6),
            back.widthAnchor.constraint(equalToConstant: NCTheme.controlHeight),
            back.heightAnchor.constraint(equalToConstant: NCTheme.controlHeight),
            tile.leadingAnchor.constraint(equalTo: back.trailingAnchor, constant: 2),
            tile.centerYAnchor.constraint(equalTo: back.centerYAnchor),
            tile.widthAnchor.constraint(equalToConstant: 36),
            tile.heightAnchor.constraint(equalToConstant: 36),
            title.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 10),
            title.trailingAnchor.constraint(lessThanOrEqualTo: full.leadingAnchor, constant: -8),
            title.topAnchor.constraint(equalTo: tile.topAnchor, constant: -1),
            sub.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            sub.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 1),
            sub.trailingAnchor.constraint(lessThanOrEqualTo: full.leadingAnchor, constant: -8),
            full.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -10),
            full.centerYAnchor.constraint(equalTo: back.centerYAnchor),
            full.heightAnchor.constraint(equalToConstant: 32),
            full.widthAnchor.constraint(equalToConstant: 76),
            line.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            line.bottomAnchor.constraint(equalTo: header.bottomAnchor),
            line.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = collection.bounds
        guard bounds.width > 0 else { return }
        if bounds.width != width {
            width = bounds.width
            measured.removeAll(keepingCapacity: true)
            layouts = rows.map { layout(for: $0, with: measurer) }
            chatLayout.setHeights(layouts.map(\.height))
            UIView.performWithoutAnimation { collection.reloadData() }
            collection.layoutIfNeeded()
        }
        if !didInitialScroll && !rows.isEmpty {
            didInitialScroll = true
            collection.layoutIfNeeded()
            scrollToBottom(animated: false)
            fireFirstContent()
        }
        if bounds.height != lastHeight {
            let delta = lastHeight - bounds.height
            lastHeight = bounds.height
            if stick { scrollToBottom(animated: false) }
            else if abs(delta) > 0 { collection.contentOffset.y = max(0, collection.contentOffset.y + delta) }
        }
    }

    private func fireFirstContent() {
        guard !firstContentFired, !rows.isEmpty else { return }
        firstContentFired = true
        onFirstContent?()
    }

    private func layout(for r: NCRow, with m: NCMeasurer) -> NCCellLayout {
        if let hit = measured[r.id], hit.row == r { return hit.layout }
        let l = NCCellLayout.make(r, width: width, m: m)
        measured[r.id] = (r, l)
        return l
    }

    func apply(rows newRows: [NCRow], hasMore: Bool, loading: Bool, error: String, composer state: NCComposerState) {
        self.hasMore = hasMore
        self.loading = loading
        self.errorText = error
        composerState = state
        guard isViewLoaded else {
            rows = newRows
            return
        }
        composer.apply(state)
        updateStatus(newRowsEmpty: newRows.isEmpty)
        guard width > 0 else {
            rows = newRows
            return
        }
        let unmeasured = newRows.filter { measured[$0.id]?.row != $0 }
        generation += 1
        let token = generation
        if rows.isEmpty && unmeasured.count <= 200 {
            // First paint: measure here so the rows are in this frame's layout.
            let ls = newRows.map { layout(for: $0, with: measurer) }
            commit(newRows, ls)
        } else {
            // A long page: measure off the main thread, then commit in one go.
            let w = width
            let m = bgMeasurer
            bgQueue.async { [weak self] in
                var done: [String: (NCRow, NCCellLayout)] = [:]
                for r in unmeasured where done[r.id]?.0 != r { done[r.id] = (r, NCCellLayout.make(r, width: w, m: m)) }
                DispatchQueue.main.async {
                    guard let self, token == self.generation, self.width == w else { return }
                    for (id, v) in done { self.measured[id] = (v.0, v.1) }
                    self.commit(newRows, newRows.map { self.layout(for: $0, with: self.measurer) })
                }
            }
        }
    }

    private func updateStatus(newRowsEmpty: Bool) {
        if !errorText.isEmpty && newRowsEmpty { statusLabel.text = errorText; statusLabel.textColor = NCTheme.danger }
        else if loading && newRowsEmpty { statusLabel.text = "Loading…"; statusLabel.textColor = NCTheme.muted }
        else if newRowsEmpty { statusLabel.text = "No messages yet."; statusLabel.textColor = NCTheme.muted }
        else { statusLabel.text = nil }
    }

    private func commit(_ newRows: [NCRow], _ newLayouts: [NCCellLayout]) {
        let change = NCChange.classify(old: rows.map(\.id), new: newRows.map(\.id))
        let oldTotal = chatLayout.totalHeight
        let oldOffset = collection.contentOffset.y
        rows = newRows
        layouts = newLayouts
        chatLayout.setHeights(newLayouts.map(\.height))
        // Keep the id → frame cache from growing without limit in a very long session.
        if measured.count > 12_000 { measured = Dictionary(uniqueKeysWithValues: zip(newRows.map(\.id), zip(newRows, newLayouts)).map { ($0, (row: $1.0, layout: $1.1)) }) }
        switch change {
        case .prepended:
            UIView.performWithoutAnimation {
                collection.reloadData()
                collection.layoutIfNeeded()
                collection.contentOffset.y = oldOffset + (chatLayout.totalHeight - oldTotal)
            }
            olderAskedAt = -1
        case .appended(let n) where n <= 3 && stick && oldTotal > 0:
            let start = rows.count - n
            collection.performBatchUpdates({
                collection.insertItems(at: (start..<rows.count).map { IndexPath(item: $0, section: 0) })
            }, completion: nil)
            collection.layoutIfNeeded()
            scrollToBottom(animated: true)
        case .same:
            // Same rows, e.g. "sending…" became the time: redraw in place.
            UIView.performWithoutAnimation {
                collection.reloadData()
                collection.layoutIfNeeded()
            }
            if stick { scrollToBottom(animated: false) }
        default:
            UIView.performWithoutAnimation {
                collection.reloadData()
                collection.layoutIfNeeded()
            }
            if stick || !didInitialScroll {
                didInitialScroll = true
                scrollToBottom(animated: false)
            }
        }
        updateStatus(newRowsEmpty: rows.isEmpty)
        fireFirstContent()
    }

    private var bottomOffset: CGFloat {
        max(0, chatLayout.collectionViewContentSize.height - collection.bounds.height)
    }

    private func scrollToBottom(animated: Bool) {
        collection.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: animated)
    }

    func collectionView(_ c: UICollectionView, numberOfItemsInSection s: Int) -> Int { rows.count }

    func collectionView(_ c: UICollectionView, cellForItemAt i: IndexPath) -> UICollectionViewCell {
        let cell = c.dequeueReusableCell(withReuseIdentifier: NCMessageCell.id, for: i) as! NCMessageCell
        cell.configure(rows[i.item], layouts[i.item])
        return cell
    }

    func collectionView(_ c: UICollectionView, shouldSelectItemAt i: IndexPath) -> Bool {
        let r = rows[i.item]
        return r.type == "card" || r.status == "failed"
    }

    func collectionView(_ c: UICollectionView, didSelectItemAt i: IndexPath) {
        c.deselectItem(at: i, animated: false)
        let r = rows[i.item]
        if r.type == "card" { openClassic() }
        else if r.status == "failed", let id = r.localId { coordinator?.emit(["type": "retry", "ticker": room.ticker, "localId": id]) }
    }

    func scrollViewDidScroll(_ s: UIScrollView) {
        stick = bottomOffset - s.contentOffset.y < 80
        if s.contentOffset.y < 800 && hasMore && olderAskedAt != rows.count && !rows.isEmpty {
            olderAskedAt = rows.count
            coordinator?.emit(["type": "older", "ticker": room.ticker])
        }
    }

    private func sendText(_ text: String) {
        stick = true
        coordinator?.emit(["type": "send", "ticker": room.ticker, "text": text])
    }

    private func openClassic() { coordinator?.emit(["type": "classicRoom", "ticker": room.ticker]) }
    @objc private func classicTapped() { openClassic() }
    @objc private func backTapped() { navigationController?.popViewController(animated: true) }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { coordinator?.roomDidClose(self) }
    }
}
