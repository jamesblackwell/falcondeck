import Foundation
import UIKit

/// The demo workspace's reviews: several items, image evidence drawn on the
/// device (so nothing is bundled), a Markdown body and a few bots. Everything
/// here runs without a computer, including opening evidence in the viewer.
enum ReviewDemo {
    static var root: URL { FileManager.default.temporaryDirectory.appending(path: "ReviewDemoFiles", directoryHint: .isDirectory) }

    static func reviews(now: Date) -> [Review] {
        ReviewDemoArt.writeAll(to: root)
        func path(_ name: String) -> String { root.appending(path: name).path }
        func image(_ id: String, _ file: String, _ title: String, _ caption: String? = nil) -> ReviewEvidence {
            ReviewEvidence(id: id, kind: .image, title: title, caption: caption, openPath: path(file), originalPath: "~/Design/\(file)", contentType: "image/png")
        }
        func doc(_ id: String, _ file: String, _ title: String, _ caption: String? = nil) -> ReviewEvidence {
            ReviewEvidence(id: id, kind: .file, title: title, caption: caption, openPath: path(file), originalPath: "~/Docs/\(file)", contentType: "text/markdown")
        }
        let pricing = Review(
            id: "R-12", title: "Pricing page refresh", ask: "Ship the new hero and pricing table this afternoon?",
            recommendation: "Ship the hero and the pricing table. The footer can wait for a second pass.",
            goingAheadAt: now.addingTimeInterval(2 * 3600),
            body: """
            The draft survey (212 trial users) preferred the new hero **18% more often** than the current one, and the annual toggle fixes the billing mix-up we saw in support.

            - Hero: new headline, device mock-up, shorter nav
            - Pricing: annual billing is now the default, Pro carries a badge
            - Footer: three columns instead of five

            Nothing here changes prices. The full numbers are in the pricing analysis.
            """,
            items: [
                ReviewItem(id: "i1", title: "Hero", note: "New headline and the device mock-up. On mobile the call to action sits under the headline.",
                           evidence: [image("e1", "hero-desktop.png", "Desktop", "1440 px wide"), image("e2", "hero-mobile.png", "Mobile", "iPhone 17")]),
                ReviewItem(id: "i2", title: "Pricing table", note: "Annual billing is the default now, and the Pro plan carries a badge.",
                           evidence: [image("e3", "pricing.png", "Pricing table"), doc("e4", "pricing-analysis.md", "Pricing analysis", "Survey of 212 trial users"),
                                      ReviewEvidence(id: "e5", kind: .url, title: "Staging preview", caption: "Live on the staging site", snapshotted: false, url: "https://example.com/pricing-preview")]),
                ReviewItem(id: "i3", title: "Footer", note: "Trimmed from five columns to three.", evidence: [image("e6", "footer.png", "Footer")]),
            ],
            sourceThreadID: "demo-juno", sourceWorkspaceID: "falcondeck", bot: "Juno", createdAt: now.addingTimeInterval(-25 * 60))
        let board = Review(
            id: "R-11", title: "Q4 board packet", ask: "Is the packet ready to send to the board on Friday?",
            recommendation: "Send it after you read the hiring plan. The revenue summary has no open questions.",
            body: "Both documents are final drafts. Numbers match the October close.",
            items: [
                ReviewItem(id: "i1", title: "Revenue summary", note: "One page, October close.", evidence: [doc("e1", "board-summary.md", "Revenue summary")]),
                ReviewItem(id: "i2", title: "Hiring plan", note: "Two engineering roles, one designer.", evidence: [doc("e2", "hiring-plan.md", "Hiring plan")]),
            ],
            sourceThreadID: "demo-atlas", sourceWorkspaceID: "falcondeck", bot: "Atlas", createdAt: now.addingTimeInterval(-3 * 3600))
        let launch = Review(
            id: "R-9", title: "Launch email", ask: "Which subject line goes out?", recommendation: "Option B.",
            status: .approved,
            items: [ReviewItem(id: "i1", title: "Subject lines", note: "Three options.", decision: .approve, feedback: "Go with option B."),
                    ReviewItem(id: "i2", title: "Body copy", note: "Shorter than the last send.", decision: .approve)],
            bot: "Iris", createdAt: now.addingTimeInterval(-26 * 3600), updatedAt: now.addingTimeInterval(-20 * 3600),
            respondedAt: now.addingTimeInterval(-20 * 3600), delivery: .delivered(at: now.addingTimeInterval(-20 * 3600)))
        let vendor = Review(
            id: "R-8", title: "Vendor contract renewal", ask: "Renew on the proposed terms?", recommendation: "Renew for one year.",
            status: .changesRequested,
            items: [ReviewItem(id: "i1", title: "Renewal terms", note: "Price up 6%.", decision: .requestChanges, feedback: "Ask for a two-year price lock first.")],
            bot: "Libra", createdAt: now.addingTimeInterval(-3 * 86_400), updatedAt: now.addingTimeInterval(-2 * 86_400),
            respondedAt: now.addingTimeInterval(-2 * 86_400), delivery: .failed(at: now.addingTimeInterval(-2 * 86_400), error: "The thread is gone"))
        return [pricing, board, launch, vendor]
    }

    /// What the daemon would store: each item's own decision or the overall one,
    /// and the status it derives (changes beat rejection beat approval).
    static func respond(_ review: Review, _ request: ReviewResponseRequest, now: Date) -> Review {
        var closed = review
        closed.items = review.items.map { item in
            var item = item
            let own = request.items.first { $0.itemID == item.id }
            item.decision = own?.decision ?? request.decision
            item.feedback = own?.feedback
            return item
        }
        let decisions = closed.items.compactMap(\.decision)
        closed.status = decisions.contains(.requestChanges) ? .changesRequested : decisions.contains(.reject) ? .rejected : .approved
        closed.overallDecision = request.decision; closed.overallNote = request.note
        closed.respondedAt = now; closed.updatedAt = now; closed.delivery = .delivered(at: now)
        return closed
    }
}

/// Serves the demo's evidence files through the same two RPCs as the daemon, and
/// leaves every other call to the relay it wraps.
struct ReviewDemoFileRelay: RelayServing {
    let base: any RelayServing
    let root: URL

    func events() async -> AsyncStream<RelayUpdate> { await base.events() }
    func pair(_ input: PairingInput, connectionID: UUID) async throws { try await base.pair(input, connectionID: connectionID) }
    func restore(connectionID: UUID) async throws -> Bool { try await base.restore(connectionID: connectionID) }
    func disconnect(forget: Bool) async throws { try await base.disconnect(forget: forget) }
    func refresh() async { await base.refresh() }
    func selectThread(_ id: String?) async { await base.selectThread(id) }
    func setForeground(_ active: Bool) async { await base.setForeground(active) }
    func detail(task: AgentTask, before: String?) async throws -> JSON { try await base.detail(task: task, before: before) }

    func call(_ method: String, params: JSON) async throws -> JSON {
        guard ["file.stat", "file.read_range"].contains(method) else { return try await base.call(method, params: params) }
        let url = URL(fileURLWithPath: params["path"].string).standardizedFileURL
        guard url.path.hasPrefix(root.standardizedFileURL.path + "/") else { return try await base.call(method, params: params) }
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), let size = attributes[.size] as? Int else {
            throw PilotError("file_not_found: This file no longer exists on your Mac.")
        }
        let modified = (attributes[.modificationDate] as? Date) ?? .now
        let isImage = url.pathExtension.lowercased() == "png"
        var meta: [String: JSON] = [
            "path": .string(url.path), "name": .string(url.lastPathComponent), "size_bytes": .number(Double(size)),
            "modified_ms": .number((modified.timeIntervalSince1970 * 1000).rounded()), "version": .string("\(Int(modified.timeIntervalSince1970 * 1000)):\(size)"),
            "content_type": .string(isImage ? "image/png" : "text/markdown"), "kind": .string(isImage ? "image" : "markdown"), "max_range_bytes": .number(262_144),
        ]
        if method == "file.stat" { return .object(meta) }
        let offset = min(params["offset"].int, size), length = min(params["length"].int, 262_144, size - offset)
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let raw = try handle.read(upToCount: length) ?? Data()
        meta["offset"] = .number(Double(offset)); meta["length"] = .number(Double(raw.count)); meta["eof"] = .bool(offset + raw.count >= size)
        meta["encoding"] = .string("identity"); meta["data_base64"] = .string(raw.base64EncodedString())
        return .object(meta)
    }
}

/// Wireframes for the fixture, drawn rather than bundled. They carry real text
/// so zooming in the viewer shows something worth zooming.
enum ReviewDemoArt {
    static func writeAll(to root: URL) {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let files: [(String, () -> Data?)] = [
            ("hero-desktop.png", { png(CGSize(width: 1200, height: 760), heroDesktop) }),
            ("hero-mobile.png", { png(CGSize(width: 390, height: 844), heroMobile, scale: 2) }),
            ("pricing.png", { png(CGSize(width: 1200, height: 860), pricing) }),
            ("footer.png", { png(CGSize(width: 1200, height: 340), footer) }),
        ]
        for (name, make) in files where !FileManager.default.fileExists(atPath: root.appending(path: name).path) {
            if let data = make() { try? data.write(to: root.appending(path: name)) }
        }
        let texts: [String: String] = [
            "pricing-analysis.md": """
            # Pricing analysis

            Survey of 212 trial users, October.

            | Plan | Chose it | Median trial length |
            | --- | --- | --- |
            | Free | 31% | 9 days |
            | Pro | 54% | 14 days |
            | Team | 15% | 21 days |

            ## What we learned

            - Monthly billing as the default hid the annual discount. Support saw 14 tickets about it.
            - The **Pro** badge raised its share from 41% to 54% in the draft.
            - Nobody asked about the footer.
            """,
            "board-summary.md": "# Revenue summary\n\nOctober close: **$412k** recurring, up 7% on September.\n\n- Churn 1.8%\n- Net new 38 teams\n",
            "hiring-plan.md": "# Hiring plan\n\n1. Staff engineer, platform\n2. Engineer, mobile\n3. Product designer\n\nAll three open in January.\n",
        ]
        for (name, text) in texts where !FileManager.default.fileExists(atPath: root.appending(path: name).path) {
            try? Data(text.utf8).write(to: root.appending(path: name))
        }
    }

    private static func png(_ size: CGSize, _ draw: (Canvas) -> Void, scale: CGFloat = 1) -> Data? {
        let format = UIGraphicsImageRendererFormat(); format.scale = scale; format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
            draw(Canvas(context: context.cgContext, size: size))
        }
    }

    struct Canvas {
        let context: CGContext
        let size: CGSize
        static let ink = UIColor(red: 0.10, green: 0.11, blue: 0.14, alpha: 1)
        static let soft = UIColor(red: 0.60, green: 0.62, blue: 0.67, alpha: 1)
        static let paper = UIColor(red: 0.97, green: 0.97, blue: 0.98, alpha: 1)
        static let line = UIColor(red: 0.87, green: 0.88, blue: 0.90, alpha: 1)
        static let accent = UIColor(red: 0.12, green: 0.62, blue: 0.47, alpha: 1)

        func fill(_ rect: CGRect, radius: CGFloat = 0, color: UIColor, stroke: UIColor? = nil) {
            let path = UIBezierPath(roundedRect: rect, cornerRadius: radius)
            color.setFill(); path.fill()
            if let stroke { stroke.setStroke(); path.lineWidth = 1; path.stroke() }
        }
        func text(_ string: String, at point: CGPoint, size: CGFloat, weight: UIFont.Weight = .regular, color: UIColor = Canvas.ink, width: CGFloat? = nil, align: NSTextAlignment = .left) {
            let style = NSMutableParagraphStyle(); style.alignment = align; style.lineSpacing = size * 0.12
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: style]
            let box = CGRect(x: point.x, y: point.y, width: width ?? size * CGFloat(string.count), height: 10_000)
            (string as NSString).draw(with: box, options: [.usesLineFragmentOrigin], attributes: attributes, context: nil)
        }
        func bar(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat = 10, color: UIColor = Canvas.line) { fill(CGRect(x: x, y: y, width: w, height: h), radius: h / 2, color: color) }
        func background(_ color: UIColor = Canvas.paper) { fill(CGRect(origin: .zero, size: size), color: color) }
    }

    private static func device(_ c: Canvas, _ rect: CGRect) {
        c.fill(rect, radius: 36, color: UIColor(red: 0.12, green: 0.13, blue: 0.17, alpha: 1))
        let screen = rect.insetBy(dx: 10, dy: 10)
        c.fill(screen, radius: 28, color: UIColor(red: 0.93, green: 0.97, blue: 0.95, alpha: 1))
        c.fill(CGRect(x: screen.minX + 18, y: screen.minY + 30, width: screen.width - 36, height: 54), radius: 12, color: .white, stroke: Canvas.line)
        for row in 0..<4 {
            let y = screen.minY + 104 + CGFloat(row) * 70
            c.fill(CGRect(x: screen.minX + 18, y: y, width: screen.width - 36, height: 58), radius: 12, color: .white, stroke: Canvas.line)
            c.fill(CGRect(x: screen.minX + 30, y: y + 17, width: 24, height: 24), radius: 12, color: row == 0 ? Canvas.accent : Canvas.line)
            c.bar(screen.minX + 66, y + 18, screen.width * 0.42, 9, color: Canvas.soft.withAlphaComponent(0.5))
            c.bar(screen.minX + 66, y + 34, screen.width * 0.28, 7)
        }
    }

    private static func chrome(_ c: Canvas, url: String) {
        c.fill(CGRect(x: 0, y: 0, width: c.size.width, height: 52), color: .white)
        for (i, color) in [UIColor.systemRed, .systemYellow, .systemGreen].enumerated() {
            c.fill(CGRect(x: 22 + CGFloat(i) * 22, y: 19, width: 14, height: 14), radius: 7, color: color.withAlphaComponent(0.75))
        }
        c.fill(CGRect(x: 150, y: 10, width: c.size.width - 300, height: 32), radius: 16, color: Canvas.paper, stroke: Canvas.line)
        c.text(url, at: CGPoint(x: 150, y: 17), size: 15, color: Canvas.soft, width: c.size.width - 300, align: .center)
        c.fill(CGRect(x: 0, y: 52, width: c.size.width, height: 1), color: Canvas.line)
    }

    private static func heroDesktop(_ c: Canvas) {
        c.background()
        chrome(c, url: "falcondeck.com")
        c.fill(CGRect(x: 60, y: 92, width: 28, height: 28), radius: 8, color: Canvas.accent)
        c.text("FalconDeck", at: CGPoint(x: 100, y: 94), size: 22, weight: .semibold, width: 200)
        for (i, link) in ["Product", "Pricing", "Docs"].enumerated() {
            c.text(link, at: CGPoint(x: 700 + CGFloat(i) * 110, y: 97), size: 17, color: Canvas.soft, width: 100)
        }
        c.fill(CGRect(x: 1010, y: 88, width: 130, height: 40), radius: 20, color: Canvas.ink)
        c.text("Get started", at: CGPoint(x: 1010, y: 98), size: 16, weight: .medium, color: .white, width: 130, align: .center)
        c.text("Run every agent\nfrom one desk.", at: CGPoint(x: 60, y: 210), size: 66, weight: .bold, width: 620)
        c.text("Codex, Claude and your own bots, with one inbox for the decisions only you can make.", at: CGPoint(x: 60, y: 392), size: 22, color: Canvas.soft, width: 520)
        c.fill(CGRect(x: 60, y: 490, width: 190, height: 56), radius: 28, color: Canvas.accent)
        c.text("Start free", at: CGPoint(x: 60, y: 505), size: 21, weight: .semibold, color: .white, width: 190, align: .center)
        c.fill(CGRect(x: 268, y: 490, width: 190, height: 56), radius: 28, color: .white, stroke: Canvas.soft)
        c.text("Watch demo", at: CGPoint(x: 268, y: 505), size: 21, weight: .medium, width: 190, align: .center)
        device(c, CGRect(x: 800, y: 160, width: 290, height: 560))
        for i in 0..<3 {
            let x = 60 + CGFloat(i) * 230
            c.fill(CGRect(x: x, y: 620, width: 210, height: 100), radius: 14, color: .white, stroke: Canvas.line)
            c.bar(x + 18, 640, 90, 10, color: Canvas.soft.withAlphaComponent(0.5))
            c.bar(x + 18, 664, 150); c.bar(x + 18, 684, 110)
        }
    }

    private static func heroMobile(_ c: Canvas) {
        c.background()
        c.text("9:41", at: CGPoint(x: 28, y: 16), size: 16, weight: .semibold, width: 60)
        c.fill(CGRect(x: 20, y: 60, width: 24, height: 24), radius: 7, color: Canvas.accent)
        c.text("FalconDeck", at: CGPoint(x: 54, y: 60), size: 19, weight: .semibold, width: 160)
        c.bar(330, 66, 24, 3, color: Canvas.ink); c.bar(330, 74, 24, 3, color: Canvas.ink); c.bar(330, 82, 24, 3, color: Canvas.ink)
        c.text("Run every agent from one desk.", at: CGPoint(x: 24, y: 140), size: 40, weight: .bold, width: 340)
        c.text("One inbox for the decisions only you can make.", at: CGPoint(x: 24, y: 300), size: 18, color: Canvas.soft, width: 330)
        c.fill(CGRect(x: 24, y: 372, width: 342, height: 54), radius: 27, color: Canvas.accent)
        c.text("Start free", at: CGPoint(x: 24, y: 387), size: 19, weight: .semibold, color: .white, width: 342, align: .center)
        device(c, CGRect(x: 70, y: 470, width: 250, height: 420))
    }

    private static func pricing(_ c: Canvas) {
        c.background()
        chrome(c, url: "falcondeck.com/pricing")
        c.text("Simple pricing", at: CGPoint(x: 0, y: 90), size: 46, weight: .bold, width: c.size.width, align: .center)
        c.fill(CGRect(x: 470, y: 164, width: 260, height: 44), radius: 22, color: .white, stroke: Canvas.line)
        c.fill(CGRect(x: 600, y: 168, width: 126, height: 36), radius: 18, color: Canvas.ink)
        c.text("Monthly", at: CGPoint(x: 474, y: 175), size: 16, color: Canvas.soft, width: 126, align: .center)
        c.text("Annual", at: CGPoint(x: 600, y: 175), size: 16, weight: .medium, color: .white, width: 126, align: .center)
        let plans: [(String, String, [String], Bool)] = [
            ("Free", "$0", ["1 project", "Community support"], false),
            ("Pro", "$16", ["Unlimited projects", "Review inbox", "Priority support"], true),
            ("Team", "$32", ["Everything in Pro", "Shared bots", "Audit log"], false),
        ]
        for (i, plan) in plans.enumerated() {
            let x = 100 + CGFloat(i) * 330, y: CGFloat = 250
            c.fill(CGRect(x: x, y: y, width: 300, height: 520), radius: 22, color: .white, stroke: plan.3 ? Canvas.accent : Canvas.line)
            if plan.3 {
                c.fill(CGRect(x: x + 82, y: y - 16, width: 136, height: 32), radius: 16, color: Canvas.accent)
                c.text("Most popular", at: CGPoint(x: x + 82, y: y - 9), size: 15, weight: .semibold, color: .white, width: 136, align: .center)
            }
            c.text(plan.0, at: CGPoint(x: x + 28, y: y + 36), size: 24, weight: .semibold, width: 240)
            c.text(plan.1, at: CGPoint(x: x + 28, y: y + 80), size: 64, weight: .bold, width: 200)
            c.text("per month, billed yearly", at: CGPoint(x: x + 28, y: y + 160), size: 15, color: Canvas.soft, width: 240)
            for (row, feature) in plan.2.enumerated() {
                let fy = y + 214 + CGFloat(row) * 48
                c.fill(CGRect(x: x + 28, y: fy + 2, width: 20, height: 20), radius: 10, color: Canvas.accent.withAlphaComponent(0.18))
                c.text("✓", at: CGPoint(x: x + 28, y: fy + 3), size: 14, weight: .bold, color: Canvas.accent, width: 20, align: .center)
                c.text(feature, at: CGPoint(x: x + 60, y: fy), size: 18, width: 220)
            }
            c.fill(CGRect(x: x + 28, y: y + 444, width: 244, height: 50), radius: 25, color: plan.3 ? Canvas.accent : Canvas.paper, stroke: plan.3 ? nil : Canvas.line)
            c.text("Choose \(plan.0)", at: CGPoint(x: x + 28, y: y + 457), size: 18, weight: .semibold, color: plan.3 ? .white : Canvas.ink, width: 244, align: .center)
        }
    }

    private static func footer(_ c: Canvas) {
        c.background(UIColor(red: 0.10, green: 0.11, blue: 0.14, alpha: 1))
        c.fill(CGRect(x: 60, y: 60, width: 28, height: 28), radius: 8, color: Canvas.accent)
        c.text("FalconDeck", at: CGPoint(x: 100, y: 62), size: 22, weight: .semibold, color: .white, width: 200)
        c.text("The control plane for your coding agents.", at: CGPoint(x: 60, y: 108), size: 17, color: Canvas.soft, width: 300)
        let columns: [(String, [String])] = [("Product", ["Desktop", "iPhone", "Reviews"]), ("Company", ["About", "Changelog", "Contact"]), ("Legal", ["Privacy", "Terms", "Security"])]
        for (i, column) in columns.enumerated() {
            let x = 560 + CGFloat(i) * 200
            c.text(column.0.uppercased(), at: CGPoint(x: x, y: 62), size: 14, weight: .semibold, color: Canvas.soft, width: 180)
            for (row, link) in column.1.enumerated() { c.text(link, at: CGPoint(x: x, y: 100 + CGFloat(row) * 38), size: 18, color: .white, width: 180) }
        }
        c.text("© 2026 FalconDeck", at: CGPoint(x: 60, y: 280), size: 15, color: Canvas.soft, width: 300)
    }
}
