import Foundation

/// Why a hosted report could not be used. Every case falls back to the
/// daemon, then to "This report is on your computer".
enum NotificationReportError: Error, Equatable {
    /// Absent, expired, or the relay would not serve it.
    case unavailable
    /// The session key rotated (a device was revoked) or the bytes were altered.
    case undecryptable
    case unsupportedVersion
    /// The decrypted contents are for another report or session: a swap.
    case mismatch
    case malformed
}

/// A report opened with the session data key.
struct NotificationReport: Equatable, Sendable {
    static let version = 1
    let reportID: String
    let sessionID: String
    let notificationID: String
    let title: String
    let summary: String
    let body: String
    let bot: String?
    let threadID: String?
    let workspaceID: String?
    let createdAt: Date
    let expiresAt: Date?

    /// Opens a `GET …/reports/{id}` response. The ids inside the ciphertext are
    /// what count: the relay holds the envelope, so it could otherwise answer
    /// one request with another report it was given.
    static func open(_ response: JSON, reportID requested: String, session: SavedSession) throws -> NotificationReport {
        guard let key = session.dataKey else { throw NotificationReportError.undecryptable }
        guard response["report_id"].string == requested else { throw NotificationReportError.mismatch }
        let json: JSON
        do { json = try RelayCrypto.decrypt(response["envelope"], key: key) }
        catch { throw NotificationReportError.undecryptable }
        guard json["version"].optionalInt == version else { throw NotificationReportError.unsupportedVersion }
        guard json["report_id"].string == requested, json["session_id"].string == session.sessionID else { throw NotificationReportError.mismatch }
        guard !json["notification_id"].string.isEmpty, !json["title"].string.isEmpty,
              let createdAt = ReviewDecoding.date(json["created_at"].string) else { throw NotificationReportError.malformed }
        return NotificationReport(
            reportID: requested, sessionID: session.sessionID, notificationID: json["notification_id"].string, title: json["title"].string,
            summary: json["summary"].string, body: json["body"].string, bot: json["bot"].string.trimmingCharacters(in: .whitespacesAndNewlines).nonempty,
            threadID: json["thread_id"].string.nonempty, workspaceID: json["workspace_id"].string.nonempty, createdAt: createdAt,
            expiresAt: ReviewDecoding.date(response["expires_at"].string))
    }

    /// The row a report shows as while the computer is out of reach.
    var record: NotificationRecord {
        var target: NotificationTarget?
        if let workspaceID, let threadID { target = .thread(workspaceID: workspaceID, threadID: threadID) }
        return NotificationRecord(id: notificationID, seq: 0, kind: .agentNotice, title: title, preview: summary, bot: bot, threadID: threadID, workspaceID: workspaceID,
                                  createdAt: createdAt, target: target, hasBody: !body.isEmpty, body: body.nonempty,
                                  report: NotificationReportRef(reportID: reportID, expiresAt: expiresAt, hosted: true))
    }
}

struct NotificationReportSummary: Equatable, Sendable {
    let reportID: String
    let expiresAt: Date?
    let sizeBytes: Int
}

/// What the relay says it can host. Nil everywhere means an older relay, and
/// then not one report call is made.
struct NotificationReportCapability: Equatable, Sendable {
    let maxBytes: Int
    let maxTTLSeconds: Int
    init?(_ json: JSON) {
        guard let maxBytes = json["max_bytes"].optionalInt, maxBytes > 0 else { return nil }
        self.maxBytes = maxBytes; maxTTLSeconds = json["max_ttl_seconds"].int
    }
}

/// Reads hosted reports from the relay over HTTP with the client token. It works
/// without a daemon, which is the point. Only encrypted reports pass through it.
actor NotificationReportClient {
    /// Fits a 256 KiB report once it is encrypted, encoded and wrapped.
    static let responseLimit = 1024 * 1024
    private let http: any PushHTTP
    private var capabilities: [String: (value: NotificationReportCapability?, checked: Date)] = [:]
    private let capabilityLifetime: TimeInterval = 300

    init(http: any PushHTTP = PushURLSession(limit: NotificationReportClient.responseLimit)) { self.http = http }

    /// Relay ids go into a URL path, and one can arrive in a push.
    static func isValid(id: String) -> Bool {
        !id.isEmpty && id.utf8.count <= 128 && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-" }
    }

    func forgetCapabilities() { capabilities = [:] }

    /// Asked again every few minutes, because a relay can be upgraded under a
    /// running app. A failed check makes no report calls and is not remembered.
    func capability(_ session: SavedSession) async -> NotificationReportCapability? {
        let relay = session.relay.absoluteString
        if let known = capabilities[relay], Date.now.timeIntervalSince(known.checked) < capabilityLifetime { return known.value }
        guard let (data, status) = try? await http.send(URLRequest(url: session.relay.appending(path: "v1/push-capabilities"))) else { return nil }
        var value: NotificationReportCapability?
        if status == 200, let json = try? JSON.decode(data) { value = NotificationReportCapability(json["reports"]) }
        else if status != 404 { return nil }
        capabilities[relay] = (value, .now)
        return value
    }

    private func request(_ path: String, session: SavedSession) -> URLRequest {
        var request = URLRequest(url: session.relay.appending(path: "v1/sessions/\(session.sessionID)/\(path)"))
        request.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// Newest first, as the relay returns them.
    func list(session: SavedSession) async throws -> [NotificationReportSummary] {
        let (data, status) = try await http.send(request("reports", session: session))
        guard status == 200 else { throw NotificationReportError.unavailable }
        return try JSON.decode(data)["reports"].array.compactMap { row in
            guard Self.isValid(id: row["report_id"].string) else { return nil }
            return NotificationReportSummary(reportID: row["report_id"].string, expiresAt: ReviewDecoding.date(row["expires_at"].string), sizeBytes: row["size_bytes"].int)
        }
    }

    func fetch(_ id: String, session: SavedSession) async throws -> NotificationReport {
        guard Self.isValid(id: id) else { throw NotificationReportError.unavailable }
        let (data, status) = try await http.send(request("reports/\(id)", session: session))
        guard status == 200 else { throw NotificationReportError.unavailable }
        // Not JSON from a 200 is a portal or a proxy, not the report.
        guard let response = try? JSON.decode(data) else { throw NotificationReportError.unavailable }
        return try NotificationReport.open(response, reportID: id, session: session)
    }

    /// Opens many reports with a bounded number in flight. A report that
    /// cannot be read is left out; the rest still show. `failed` holds only
    /// ciphertext this key will never open: a network or relay failure may
    /// clear, so it is reported as neither and is asked for again.
    func fetch(_ ids: [String], session: SavedSession, concurrency: Int = 4) async -> (reports: [NotificationReport], failed: [String]) {
        await withTaskGroup(of: (String, Result<NotificationReport, any Error>).self) { group in
            var remaining = ids.makeIterator()
            var reports: [NotificationReport] = [], failed: [String] = []
            func start(_ id: String) {
                group.addTask {
                    do { return (id, .success(try await self.fetch(id, session: session))) } catch { return (id, .failure(error)) }
                }
            }
            for _ in 0..<max(1, concurrency) { if let id = remaining.next() { start(id) } }
            while let (id, result) = await group.next() {
                switch result {
                case .success(let report): reports.append(report)
                case .failure(let error):
                    if let error = error as? NotificationReportError, error != .unavailable { failed.append(id) }
                }
                if let id = remaining.next() { start(id) }
            }
            return (reports, failed)
        }
    }
}
