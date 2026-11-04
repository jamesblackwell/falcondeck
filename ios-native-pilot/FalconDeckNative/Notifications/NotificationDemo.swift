import Foundation

/// The demo workspace's notification history. The threads and reviews it points
/// at are the demo's own, so every row opens something real without a computer.
enum NotificationDemo {
    /// QA: the screen as it looks with the computer out of reach.
    static var offline: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--notification-preview=offline")
        #else
        false
        #endif
    }

    static func records(now: Date) -> [NotificationRecord] {
        func ago(_ seconds: TimeInterval) -> Date { now.addingTimeInterval(-seconds) }
        let hour: TimeInterval = 3600, day: TimeInterval = 86_400
        var rows = [
            NotificationRecord(id: "N-48", seq: 48, kind: .agentNotice, title: "Overnight relay soak finished", preview: "No data loss across 412 reconnects. One slow replay is worth a look.",
                               bot: "Juno", threadID: "relay", workspaceID: "falcondeck", createdAt: ago(12 * 60), target: .thread(workspaceID: "falcondeck", threadID: "relay"), hasBody: true, body: soakReport,
                               report: NotificationReportRef(reportID: "rpt_demo_soak", expiresAt: now.addingTimeInterval(20 * day), hosted: true)),
            NotificationRecord(id: "N-47", seq: 47, kind: .review, title: "Pricing page refresh", preview: "Juno needs a decision: ship the new hero and pricing table this afternoon?",
                               bot: "Juno", threadID: "demo-juno", workspaceID: "falcondeck", createdAt: ago(25 * 60), target: .review("R-12")),
            NotificationRecord(id: "N-46", seq: 46, kind: .inputRequired, title: "Review the new project sidebar", preview: "Choose a sidebar layout",
                               threadID: "review", workspaceID: "falcondeck", createdAt: ago(40 * 60), target: .thread(workspaceID: "falcondeck", threadID: "review")),
            NotificationRecord(id: "N-45", seq: 45, kind: .error, title: "Bring the study flow to SwiftUI", preview: "The test run stopped: three flashcard tests failed.",
                               threadID: "quiz", workspaceID: "quizgecko", createdAt: ago(3 * hour), target: .thread(workspaceID: "quizgecko", threadID: "quiz")),
            NotificationRecord(id: "N-44", seq: 44, kind: .turnComplete, title: "Make reconnects feel instant", preview: "The relay recovery path now restores a fresh snapshot when history has been pruned.",
                               threadID: "relay", workspaceID: "falcondeck", createdAt: ago(5 * hour), readAt: ago(4 * hour), target: .thread(workspaceID: "falcondeck", threadID: "relay"), repeatCount: 2),
            NotificationRecord(id: "N-43", seq: 43, kind: .inputRequired, title: "Polish the voice tutor", preview: "Allow the tutor to read your study calendar?",
                               threadID: "voice", workspaceID: "quizgecko", createdAt: ago(1.2 * day), readAt: ago(1.1 * day), resolvedAt: ago(1.1 * day), target: .thread(workspaceID: "quizgecko", threadID: "voice")),
            NotificationRecord(id: "N-42", seq: 42, kind: .agentNotice, title: "Weekly spend is under budget", preview: "$212 of $300 used. Nothing needs changing.",
                               bot: "Atlas", createdAt: ago(1.3 * day), readAt: ago(1.1 * day)),
            NotificationRecord(id: "N-41", seq: 41, kind: .review, title: "Launch email", preview: "You approved both items.",
                               bot: "Iris", createdAt: ago(1.4 * day), readAt: ago(1.2 * day), resolvedAt: ago(1.2 * day), target: .review("R-9")),
            NotificationRecord(id: "N-40", seq: 40, kind: .agentNotice, title: "Q4 board packet is ready to read", preview: "Numbers match the October close. Two open questions on hiring.",
                               bot: "Atlas", threadID: "demo-atlas", workspaceID: "falcondeck", createdAt: ago(3 * day), readAt: ago(2.9 * day), hasBody: true, body: boardReport),
            NotificationRecord(id: "N-39", seq: 39, kind: .turnComplete, title: "A fresh set of product scenes", preview: "Four directions, with consistent lighting and a quieter background.",
                               threadID: "samples", workspaceID: "lookset", createdAt: ago(3.2 * day), readAt: ago(3 * day), target: .thread(workspaceID: "lookset", threadID: "samples")),
            NotificationRecord(id: "N-38", seq: 38, kind: .turnComplete, title: "Simplify the image library", preview: "The library now groups recent generations into a single collection.",
                               threadID: "images", workspaceID: "lucidpic", createdAt: ago(9 * day), readAt: ago(9 * day), target: .thread(workspaceID: "lucidpic", threadID: "images")),
        ]
        if offline { rows.removeFirst() }
        return rows
    }

    /// The hosted copy the offline preview finds on the relay.
    static func reports(now: Date) -> [String: NotificationReport] {
        let soak = NotificationReport(reportID: "rpt_demo_soak", sessionID: "demo", notificationID: "N-48", title: "Overnight relay soak finished",
                                      summary: "No data loss across 412 reconnects. One slow replay is worth a look.", body: soakReport, bot: "Juno", threadID: "relay",
                                      workspaceID: "falcondeck", createdAt: now.addingTimeInterval(-12 * 60), expiresAt: now.addingTimeInterval(20 * 86_400))
        return [soak.reportID: soak]
    }

    private static let soakReport = """
    The relay soak ran for **nine hours** against the staging relay. Nothing was lost, and the phone recovered from a pruned history every time.

    ## Results

    - 412 forced reconnects, 412 clean recoveries
    - Median time back to a live transcript: 1.4 s
    - 18 replays hit the pruned-history path and rebuilt from a fresh snapshot

    ## One thing to look at

    One replay took 11 s. It lined up with a 40 MB attachment leaving the queue, so the relay held the sequence until the upload finished. It recovered without help, but a phone would have shown *Reconnecting* for the whole wait.

    ## What I would do next

    1. Move large uploads out of the replay path
    2. Run the soak once more with two phones attached

    Nothing is blocked on you. Say if you want the upload change this week.
    """

    private static let boardReport = """
    Both documents are final drafts, and the revenue summary matches the October close.

    **Open questions**

    - Does the hiring plan keep the second designer in Q1?
    - Should the runway slide use the new burn number?
    """
}
