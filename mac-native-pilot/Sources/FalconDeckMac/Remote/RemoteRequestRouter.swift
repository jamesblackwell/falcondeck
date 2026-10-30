import Foundation

struct NativeRemoteRPC: Equatable, Sendable {
    let method: String
    let params: JSON
}

/// Translates the shared HTTP operations to the daemon's registered relay RPCs.
/// Local-only routes deliberately fail here, before sending anything remotely.
enum NativeRemoteRequestRouter {
    static func route(_ path: [String], method: String = "GET", query: [URLQueryItem] = [], body: JSON? = nil) throws -> NativeRemoteRPC {
        let verb = method.uppercased()
        guard let match = routes.lazy.compactMap({ route -> (Route, [String: JSON])? in
            guard route.verb == verb, let identifiers = route.match(path) else { return nil }
            return (route, identifiers)
        }).first else {
            throw PilotError("This action is not supported by the remote daemon (\(verb) /\(path.joined(separator: "/"))).")
        }

        var params: [String: JSON]
        switch body {
        case .object(let fields): params = fields
        case nil: params = [:]
        default: throw PilotError("The remote request must contain a JSON object.")
        }
        // HTTP query/path parameters are authoritative, just as in api.rs.
        // Remove their camelCase aliases too: the RPC dispatcher accepts both
        // spellings and otherwise a body could change the target of a request.
        for item in query {
            guard let value = item.value else { continue }
            assignIdentifier(item.name, value: try queryValue(value, for: item.name), into: &params)
        }
        for (key, value) in match.1 { assignIdentifier(key, value: value, into: &params) }
        if match.0.rpc == "chat.create" { params["create"] = .bool(true) }
        return NativeRemoteRPC(method: match.0.rpc, params: .object(params))
    }

    private static func assignIdentifier(_ key: String, value: JSON, into params: inout [String: JSON]) {
        params.removeValue(forKey: camelCase(key))
        params[key] = value
    }

    private static func camelCase(_ value: String) -> String {
        let parts = value.split(separator: "_")
        return (parts.first.map(String.init) ?? "") + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
    }

    private static func queryValue(_ value: String, for key: String) throws -> JSON {
        // Identifiers and paths, even strings such as "001" or "true", stay
        // strings. Only typed HTTP query fields become JSON scalars.
        if booleanQueryKeys.contains(key) {
            guard value == "true" || value == "false" else { throw PilotError("Invalid Boolean query parameter: \(key).") }
            return .bool(value == "true")
        }
        if integerQueryKeys.contains(key) {
            guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }),
                  let integer = UInt64(value), integer <= 9_007_199_254_740_991 else {
                throw PilotError("Invalid integer query parameter: \(key).")
            }
            return .number(Double(integer))
        }
        return .string(value)
    }

    private static let booleanQueryKeys: Set<String> = [
        "include_workspace_skills", "include_archived_threads", "include_thread_plans", "include_thread_diffs", "include_agent_skills",
        "inline_images", "strict_limit", "compact_workspace", "refresh_native", "refresh"
    ]
    private static let integerQueryKeys: Set<String> = ["limit", "tool_output_bytes"]

    private struct Route {
        let verb: String
        let components: [String]
        let rpc: String

        init(_ verb: String, _ path: String, _ rpc: String) {
            self.verb = verb
            components = path.split(separator: "/").map(String.init)
            self.rpc = rpc
        }

        func match(_ path: [String]) -> [String: JSON]? {
            guard path.count == components.count else { return nil }
            var identifiers: [String: JSON] = [:]
            for (pattern, value) in zip(components, path) {
                if pattern.hasPrefix(":") {
                    guard !value.isEmpty else { return nil }
                    identifiers[String(pattern.dropFirst())] = .string(value)
                } else if pattern != value { return nil }
            }
            return identifiers
        }
    }

    // Keep these bounded by REMOTE_RPC_METHODS in app/remote_bridge.rs. RPCs
    // without an HTTP counterpart (sync.*, turn.steer) are called directly by
    // the remote transport when needed, rather than inventing HTTP endpoints.
    private static let routes: [Route] = [
        Route("GET", "api/cloud/settings", "cloud.settings.get"),
        Route("PUT", "api/cloud/settings", "cloud.settings.update"),
        Route("POST", "api/cloud/capture", "cloud.capture"),
        Route("GET", "api/cloud/jobs", "cloud.jobs.list"),
        Route("POST", "api/cloud/jobs", "cloud.jobs.create"),
        Route("GET", "api/cloud/jobs/:job_id", "cloud.jobs.get"),
        Route("GET", "api/cloud/jobs/:job_id/detail", "cloud.jobs.detail"),
        Route("POST", "api/cloud/jobs/:job_id/turns", "cloud.jobs.turn"),
        Route("POST", "api/cloud/jobs/:job_id/interrupt", "cloud.jobs.interrupt"),
        Route("POST", "api/cloud/jobs/:job_id/approvals/:request_id", "cloud.jobs.approval"),
        Route("POST", "api/cloud/jobs/:job_id/interactive/:request_id", "cloud.jobs.interactive"),
        Route("POST", "api/cloud/jobs/:job_id/collect", "cloud.jobs.collect"),
        Route("POST", "api/cloud/jobs/:job_id/import", "cloud.jobs.import"),
        Route("POST", "api/cloud/jobs/:job_id/stop", "cloud.jobs.stop"),
        Route("POST", "api/cloud/jobs/:job_id/resume", "cloud.jobs.resume"),
        Route("GET", "api/snapshot", "snapshot.current"),
        Route("GET", "api/preferences", "preferences.read"),
        Route("PATCH", "api/preferences", "preferences.update"),
        Route("POST", "api/control/get", "control.get"),
        Route("POST", "api/control/execute", "control.execute"),
        Route("GET", "api/speech/openrouter-key", "speech.status"),
        Route("GET", "api/speech/models", "speech.models"),
        Route("POST", "api/speech/transcribe", "speech.transcribe"),
        Route("POST", "api/speech/synthesize", "speech.synthesize"),
        Route("POST", "api/threads/search", "thread.search"),
        Route("POST", "api/chats", "chat.create"),
        Route("POST", "api/workspaces/connect", "workspace.connect"),
        Route("DELETE", "api/workspaces/:workspace_id", "workspace.remove"),
        Route("POST", "api/workspaces/:workspace_id/close", "workspace.close"),
        Route("GET", "api/workspaces/:workspace_id/skills", "workspace.skills"),
        Route("GET", "api/workspaces/:workspace_id/prompts", "workspace.prompts"),
        Route("POST", "api/workspaces/:workspace_id/providers/:provider/hydrate", "provider.hydrate"),
        Route("POST", "api/workspaces/:workspace_id/threads", "thread.start"),
        Route("POST", "api/workspaces/:workspace_id/threads/archive", "thread.archiveAll"),
        Route("GET", "api/workspaces/:workspace_id/threads/:thread_id", "thread.detail"),
        Route("PATCH", "api/workspaces/:workspace_id/threads/:thread_id", "thread.update"),
        Route("DELETE", "api/workspaces/:workspace_id/threads/:thread_id", "thread.delete"),
        Route("GET", "api/workspaces/:workspace_id/threads/:thread_id/items/:item_id", "thread.item"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/fork", "thread.fork"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/suggest-title", "thread.suggestTitle"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/archive", "thread.archive"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/unarchive", "thread.unarchive"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/turns", "turn.start"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/read", "thread.mark_read"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/unread", "thread.mark_unread"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/goal", "thread.goal.set"),
        Route("DELETE", "api/workspaces/:workspace_id/threads/:thread_id/goal", "thread.goal.clear"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/interrupt", "turn.interrupt"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/compact", "thread.compact"),
        Route("DELETE", "api/workspaces/:workspace_id/threads/:thread_id/queue/:queued_id", "thread.queue.remove"),
        Route("PATCH", "api/workspaces/:workspace_id/threads/:thread_id/queue/:queued_id", "thread.queue.edit"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/queue/reorder", "thread.queue.reorder"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/queue/:queued_id/steer", "thread.queue.steer"),
        Route("GET", "api/workspaces/:workspace_id/threads/:thread_id/queue/:queued_id/attachment-preview", "thread.queue.attachment_preview"),
        Route("POST", "api/workspaces/:workspace_id/interactive-requests/:request_id/respond", "interactive.respond"),
        Route("POST", "api/workspaces/:workspace_id/approvals/:request_id/respond", "approval.respond"),
        Route("GET", "api/connectors", "connectors.read"),
        Route("PUT", "api/connectors", "connectors.update"),
        Route("GET", "api/skills", "skills.read"),
        Route("GET", "api/skills/registry", "skills.registry.search"),
        Route("POST", "api/skills/install", "skills.install"),
        Route("DELETE", "api/skills/:skill", "skills.uninstall"),
        Route("GET", "api/providers", "providers.read"),
        Route("PUT", "api/providers", "providers.update"),
        Route("GET", "api/provider-usage", "providers.usage"),
        Route("POST", "api/provider-usage/codex/reset-credits/consume", "providers.usage.consumeReset"),
        Route("GET", "api/harnesses", "harnesses.read"),
        Route("POST", "api/harnesses/refresh", "harnesses.refresh"),
        Route("POST", "api/harnesses/upgrade", "harnesses.upgrade"),
        Route("GET", "api/harnesses/jobs/:job_id", "harnesses.job"),
        Route("GET", "api/extensions", "extensions.read"),
        Route("PATCH", "api/extensions/:extension_id", "extensions.update"),
        Route("PATCH", "api/extensions/:extension_id/permissions", "extensions.permission.update"),
        Route("POST", "api/extensions/:extension_id/actions/:action_id", "extensions.action.invoke"),
        Route("GET", "api/scheduled-tasks", "scheduled.list"),
        Route("POST", "api/scheduled-tasks", "scheduled.create"),
        Route("GET", "api/scheduled-tasks/:task_id", "scheduled.detail"),
        Route("PATCH", "api/scheduled-tasks/:task_id", "scheduled.update"),
        Route("DELETE", "api/scheduled-tasks/:task_id", "scheduled.delete"),
        Route("POST", "api/scheduled-tasks/:task_id/run", "scheduled.run"),
        Route("GET", "api/scheduled-tasks/:task_id/runs", "scheduled.runs"),
        Route("GET", "api/computer-use", "computerUse.read"),
        Route("POST", "api/computer-use", "computerUse.update"),
        Route("POST", "api/computer-use/restart", "computerUse.restart"),
        Route("POST", "api/computer-use/test", "computerUse.test"),
        Route("GET", "api/workspace-icons/:workspace_id", "workspace.icon"),
        Route("GET", "api/workspaces/:workspace_id/git/status", "git.status"),
        Route("GET", "api/workspaces/:workspace_id/git/diff", "git.diff"),
        Route("POST", "api/workspaces/:workspace_id/git/commit", "git.commit"),
        Route("POST", "api/workspaces/:workspace_id/threads/:thread_id/ship", "thread.ship"),
        Route("GET", "api/workspaces/:workspace_id/files", "workspace.files"),
        Route("GET", "api/workspaces/:workspace_id/files/content", "workspace.file.read"),
        Route("PUT", "api/workspaces/:workspace_id/files/content", "workspace.file.write")
    ]
}
