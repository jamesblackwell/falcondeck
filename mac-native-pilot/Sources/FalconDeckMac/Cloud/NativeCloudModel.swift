import Foundation
import Observation

typealias NativeCloudRequest = ([String], String, JSON?) async throws -> JSON

/// Credentials are write-only. Sanitized settings can never refill a secret field.
struct NativeCloudSettingsDraft {
    var enabled: Bool
    var providerToken = ""
    var openaiAPIKey = ""
    var clearProviderToken = false
    var clearOpenaiAPIKey = false
    var teamID: String
    var projectID: String
    var image: String
    var timeoutMinutes: Int
    var nodeBinary: String
    var runtimePath: String
    var workerDaemonURL: String
    var workerDaemonSHA256: String
    var allowedDomains: String

    init(_ raw: JSON = .null) {
        enabled = raw["enabled"].bool
        teamID = raw["team_id"].string; projectID = raw["project_id"].string
        image = raw["image"].string
        timeoutMinutes = raw["timeout_minutes"].optionalInt ?? 60
        nodeBinary = raw["node_binary"].string
        runtimePath = raw["runtime_path"].string
        workerDaemonURL = raw["worker_daemon_url"].string
        workerDaemonSHA256 = raw["worker_daemon_sha256"].string
        allowedDomains = raw["allowed_domains"].array.map(\.string).joined(separator: "\n")
    }

    var payload: JSON {
        var fields: [String: JSON] = [
            "enabled": .bool(enabled), "team_id": .string(teamID), "project_id": .string(projectID),
            "image": .string(image), "timeout_minutes": .number(Double(timeoutMinutes)),
            "node_binary": .string(nodeBinary), "runtime_path": .string(runtimePath),
            "worker_daemon_url": .string(workerDaemonURL), "worker_daemon_sha256": .string(workerDaemonSHA256),
            "allowed_domains": .array(allowedDomains.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.map(JSON.string))
        ]
        if clearProviderToken || !providerToken.isEmpty { fields["provider_token"] = .string(clearProviderToken ? "" : providerToken) }
        if clearOpenaiAPIKey || !openaiAPIKey.isEmpty { fields["openai_api_key"] = .string(clearOpenaiAPIKey ? "" : openaiAPIKey) }
        return .object(fields)
    }

    static func validationError(settings: JSON) -> String? {
        guard settings["enabled"].bool else { return "Enable Cloud execution in Settings before launching." }
        guard settings["has_provider_token"].bool else { return "Add a Vercel access token in Cloud execution settings." }
        guard settings["has_openai_api_key"].bool else { return "Add an OpenAI API key in Cloud execution settings." }
        guard !settings["team_id"].string.isEmpty, !settings["project_id"].string.isEmpty else { return "Add the Vercel team and project IDs in Cloud execution settings." }
        let image = settings["image"].string.components(separatedBy: "@sha256:")
        guard image.count == 2, !image[0].isEmpty, isSHA256(image[1]),
              image[0].utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [46, 47, 95, 45].contains($0) }) else {
            return "Set a digest-pinned worker image in Cloud execution settings."
        }
        guard settings["runtime_path"].string.hasPrefix("/") else { return "Set an absolute runtime adapter path on the coordinator." }
        let workerURL = settings["worker_daemon_url"].string
        let workerSHA256 = settings["worker_daemon_sha256"].string
        if !workerURL.isEmpty || !workerSHA256.isEmpty {
            guard let url = URLComponents(string: workerURL), url.scheme == "https",
                  url.host?.isEmpty == false, url.user == nil, url.password == nil else { return "Set the Linux worker binary HTTPS URL, or leave both download fields empty for a preinstalled worker." }
            guard isSHA256(workerSHA256) else { return "Set the Linux worker binary SHA-256, or leave both download fields empty for a preinstalled worker." }
        }
        return nil
    }

    private static func isSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

struct NativeCloudTaskDraft {
    var prompt = ""
    var modelID = ""
    var source: JSON = .null
    var idempotencyKey = UUID().uuidString
    /// Preserve the exact accepted request across ambiguous network failures.
    var submittedPayload: JSON?

    func payload(workspaceID: String) throws -> JSON {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PilotError("Describe the cloud task first.") }
        guard !source["id"].string.isEmpty, source["workspace_id"].string == workspaceID else {
            throw PilotError("Review a source capture for this project before launching.")
        }
        var fields: [String: JSON] = ["workspace_id": .string(workspaceID), "prompt": .string(prompt.trimmingCharacters(in: .whitespacesAndNewlines)),
            "source_capture_id": source["id"], "idempotency_key": .string(idempotencyKey)]
        if !modelID.isEmpty { fields["model_id"] = .string(modelID) }
        return .object(fields)
    }
}

struct NativeCloudJob: Identifiable {
    let raw: JSON
    var id: String { raw["id"].string }
    var status: String { raw["status"].string }
    var title: String { NativePlainText.line(raw["prompt"].string) }
    var hasWorker: Bool { raw["worker"] != .null }
    var stopped: Bool { ["stopped", "expired"].contains(status) }
    var working: Bool { ["provisioning", "running", "stopping"].contains(status) }
    var statusLabel: String {
        switch status {
        case "provisioning": "Starting worker"
        case "running": "Working"
        case "awaiting_input": "Needs you"
        case "completed": "Ready"
        case "failed": "Failed"
        case "unknown": "Status unknown"
        case "stopping": "Stopping worker"
        case "stopped": "Worker stopped"
        case "expired": "Worker expired"
        default: status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

@MainActor @Observable final class NativeCloudModel {
    static let shared = NativeCloudModel()
    private static var coordinators: [String: NativeCloudModel] = [:]
    static func forHost(_ hostID: String?) -> NativeCloudModel {
        guard let hostID else { return shared }
        if let existing = coordinators[hostID] { return existing }
        let model = NativeCloudModel(hostID: hostID)
        coordinators[hostID] = model
        return model
    }
    let hostID: String?
    init(hostID: String? = nil) { self.hostID = hostID }
    var settings: JSON = .null
    var jobs: [NativeCloudJob] = []
    var selectedProjectID = ""
    var selectedJobID: String?
    var drafts: [String: NativeCloudTaskDraft] = [:]
    var followUps: [String: String] = [:]
    private var followUpSubmissions: [String: (text: String, itemID: String)] = [:]
    var details: [String: JSON] = [:]
    var loading = false
    var busy = false
    var error: String?
    var detailError: String?
    private var refreshID = UUID()
    private var detailIDs: [String: UUID] = [:]

    func refresh(request: NativeCloudRequest) async {
        guard !loading else { return }
        let identity = UUID()
        refreshID = identity
        loading = true
        defer { loading = false }
        do {
            let configuration = try await request(["api", "cloud", "settings"], "GET", nil)
            let rows = try await request(["api", "cloud", "jobs"], "GET", nil)
            guard refreshID == identity, !Task.isCancelled else { return }
            settings = configuration
            jobs = rows.array.map(NativeCloudJob.init)
            error = nil
        } catch { if refreshID == identity { self.error = error.localizedDescription } }
    }

    func capture(workspaceID: String, request: NativeCloudRequest) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            try validateOwner(workspaceID)
            guard drafts[workspaceID]?.submittedPayload == nil else { throw PilotError("Retry the saved launch before replacing its source capture.") }
            let source = try await request(["api", "cloud", "capture"], "POST", .object(["workspace_id": .string(workspaceID)]))
            var draft = drafts[workspaceID] ?? NativeCloudTaskDraft()
            draft.source = source
            drafts[workspaceID] = draft
        } catch { self.error = error.localizedDescription }
    }

    @discardableResult func create(workspaceID: String, settings: JSON, request: NativeCloudRequest) async -> String? {
        guard !busy else { return nil }
        refreshID = UUID()
        busy = true; error = nil
        defer { busy = false }
        do {
            try validateOwner(workspaceID)
            if let issue = NativeCloudSettingsDraft.validationError(settings: settings) { throw PilotError(issue) }
            var draft = drafts[workspaceID] ?? NativeCloudTaskDraft()
            let body = try draft.submittedPayload ?? draft.payload(workspaceID: workspaceID)
            draft.submittedPayload = body
            drafts[workspaceID] = draft
            let job = NativeCloudJob(raw: try await request(["api", "cloud", "jobs"], "POST", body))
            guard !job.id.isEmpty else { throw PilotError("The daemon did not return a cloud task. Refresh tasks before retrying.") }
            jobs.removeAll { $0.id == job.id }; jobs.insert(job, at: 0)
            drafts.removeValue(forKey: workspaceID)
            selectedJobID = job.id
            return job.id
        } catch { self.error = error.localizedDescription; return nil }
    }

    private func validateOwner(_ workspaceID: String) throws {
        guard NativeHostManager.split(workspaceID).hostID == hostID else {
            throw PilotError("Choose the cloud coordinator that owns this project. Source files are captured by their own daemon.")
        }
    }

    func refreshDetail(jobID: String, request: NativeCloudRequest) async {
        let identity = UUID()
        detailIDs[jobID] = identity
        do {
            let raw = try await request(["api", "cloud", "jobs", jobID], "GET", nil)
            guard detailIDs[jobID] == identity, !Task.isCancelled else { return }
            if let i = jobs.firstIndex(where: { $0.id == jobID }) { jobs[i] = NativeCloudJob(raw: raw) }
            if raw["worker"] != .null {
                let detail = try await request(["api", "cloud", "jobs", jobID, "detail"], "GET", nil)
                guard detailIDs[jobID] == identity, !Task.isCancelled else { return }
                details[jobID] = detail
            }
            detailError = nil
        } catch { if detailIDs[jobID] == identity { detailError = error.localizedDescription } }
    }

    func operate(jobID: String, action: String, request: NativeCloudRequest) async {
        guard !busy else { return }
        refreshID = UUID(); detailIDs[jobID] = UUID()
        busy = true; error = nil
        defer { busy = false }
        do {
            let raw = try await request(["api", "cloud", "jobs", jobID, action], "POST", nil)
            if !raw["id"].string.isEmpty, let i = jobs.firstIndex(where: { $0.id == jobID }) { jobs[i] = NativeCloudJob(raw: raw) }
            await refreshDetail(jobID: jobID, request: request)
        } catch { self.error = error.localizedDescription }
    }

    func sendFollowUp(jobID: String, request: NativeCloudRequest) async {
        guard !busy, let text = followUps[jobID], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let prior = followUpSubmissions[jobID]
            let itemID = prior.flatMap { $0.text == text ? $0.itemID : nil } ?? "user-\(UUID().uuidString)"
            followUpSubmissions[jobID] = (text, itemID)
            _ = try await request(["api", "cloud", "jobs", jobID, "turns"], "POST", .object([
                "workspace_id": .string(""), "thread_id": .string(""),
                "inputs": .array([.object(["type": .string("text"), "text": .string(text)])]),
                "user_item_id": .string(itemID)
            ]))
            if followUps[jobID] == text { followUps.removeValue(forKey: jobID) }
            followUpSubmissions.removeValue(forKey: jobID)
            await refreshDetail(jobID: jobID, request: request)
        } catch { self.error = error.localizedDescription }
    }

    func respond(jobID: String, interactive: JSON, response: JSON, request: NativeCloudRequest) async throws {
        let requestID = interactive["request_id"].string
        guard !requestID.isEmpty else { throw PilotError("The worker request is missing its native identifier. Refresh this task before answering.") }
        // The structured endpoint preserves exact provider approval option IDs
        // as well as question and plan responses.
        _ = try await request(["api", "cloud", "jobs", jobID, "interactive", requestID], "POST", .object(["response": response]))
        await refreshDetail(jobID: jobID, request: request)
    }
}

/// Keep the coordinator's identifiers scoped while worker identifiers stay
/// opaque. Only the job proxy is allowed to operate on the worker.
enum NativeCloudScope {
    static func response(_ raw: JSON, hostID: String?, path: [String]) -> JSON {
        guard let hostID, path.count >= 3, path[1] == "cloud" else { return raw }
        func scoped(_ value: JSON) -> JSON {
            guard !value.string.isEmpty else { return value }
            if NativeHostManager.split(value.string).hostID == hostID { return value }
            return .string(NativeHostManager.namespace(hostID: hostID, id: value.string))
        }
        func source(_ value: JSON) -> JSON {
            value.setting("workspace_id", scoped(value["workspace_id"]))
        }
        func job(_ value: JSON) -> JSON {
            value.setting("id", scoped(value["id"]))
                .setting("workspace_id", scoped(value["workspace_id"]))
                .setting("source", source(value["source"]))
        }
        if path[2] == "capture" { return source(raw) }
        guard path[2] == "jobs", path.last != "detail" else { return raw }
        if case .array(let values) = raw { return .array(values.map(job)) }
        return raw["id"].string.isEmpty ? raw : job(raw)
    }
}
