import Foundation

/// Project only daemon-owned relationships. Provider item/model identifiers and
/// extension-defined JSON are opaque, even when their keys happen to say `id`.
enum NativeHostProjection {
    static func id(_ value: JSON, host: String) -> JSON {
        guard case .string(let string) = value, !string.isEmpty else { return value }
        if NativeHostManager.split(string).hostID == host { return value }
        return .string(NativeHostManager.namespace(hostID: host, id: string))
    }

    private static func ids(_ value: JSON, keys: [String], host: String) -> JSON {
        keys.reduce(value) { result, key in
            result[key] == .null ? result : result.setting(key, id(result[key], host: host))
        }
    }

    private static func rows(_ value: JSON, key: String, transform: (JSON) -> JSON) -> JSON {
        guard case .array(let values) = value[key] else { return value }
        return value.setting(key, .array(values.map(transform)))
    }

    private static func keyedIDs(_ value: JSON, host: String) -> JSON {
        guard case .object(let fields) = value else { return value }
        return .object(fields.reduce(into: [:]) { result, entry in
            result[id(.string(entry.key), host: host).string] = entry.value
        })
    }

    static func workspace(_ value: JSON, host: String) -> JSON {
        ids(value, keys: ["id", "current_thread_id"], host: host).setting("host_id", .string(host))
    }

    static func task(_ value: JSON, host: String) -> JSON {
        var result = ids(value, keys: ["id", "workspace_id"], host: host).setting("host_id", .string(host))
        if result["handoff_from"] != .null {
            result = result.setting("handoff_from", ids(result["handoff_from"], keys: ["thread_id"], host: host))
        }
        let origin = result["origin"]
        let originKey: String?
        switch origin["kind"].string {
        case "agent_spawn": originKey = "parent_thread_id"
        case "scheduled_task": originKey = "task_id"
        case "automation": originKey = "automation_id"
        default: originKey = nil
        }
        if let originKey { result = result.setting("origin", ids(origin, keys: [originKey], host: host)) }
        return result
    }

    static func request(_ value: JSON, host: String) -> JSON {
        ids(value, keys: ["request_id", "workspace_id", "thread_id"], host: host)
    }

    static func item(_ value: JSON, host: String) -> JSON {
        guard value["kind"].string == "interactive_request" else { return value }
        return value.setting("request", request(value["request"], host: host))
    }

    static func scheduledRun(_ value: JSON, host: String) -> JSON {
        ids(value, keys: ["id", "task_id", "workspace_id", "thread_id"], host: host)
    }

    static func scheduledTask(_ value: JSON, host: String) -> JSON {
        var result = ids(value, keys: ["id", "workspace_id"], host: host).setting("host_id", .string(host))
        if value["last_run"] != .null { result = result.setting("last_run", scheduledRun(value["last_run"], host: host)) }
        return result
    }

    private static func scope(_ value: JSON, host: String) -> JSON {
        guard ["thread", "workspace"].contains(value["kind"].string) else { return value }
        return ids(value, keys: ["id"], host: host)
    }

    private static func extensionView(_ value: JSON, host: String) -> JSON {
        guard value["scope"] != .null else { return value }
        return value.setting("scope", scope(value["scope"], host: host))
    }

    static func extensions(_ value: JSON, host: String) -> JSON {
        rows(value, key: "views") { extensionView($0, host: host) }
    }

    static func snapshot(_ value: JSON, host: String) -> JSON {
        var result = rows(value, key: "workspaces") { workspace($0, host: host) }
        result = rows(result, key: "threads") { task($0, host: host) }
        result = rows(result, key: "library_workspaces") { workspace($0, host: host) }
        result = rows(result, key: "interactive_requests") { request($0, host: host) }
        result = rows(result, key: "scheduled_tasks") { scheduledTask($0, host: host) }
        for key in ["service_notices", "operational_conditions"] {
            result = rows(result, key: key) { ids($0, keys: ["id", "workspace_id", "thread_id"], host: host) }
        }
        if value["thread_token_usage"] != .null { result = result.setting("thread_token_usage", keyedIDs(value["thread_token_usage"], host: host)) }
        if value["preferences"] != .null { result = result.setting("preferences", preferences(value["preferences"], host: host)) }
        if value["extensions"] != .null { result = result.setting("extensions", extensions(value["extensions"], host: host)) }
        return result
    }

    static func preferences(_ value: JSON, host: String) -> JSON {
        var result = value
        for key in ["workspace_order", "hidden_workspace_ids"] {
            result = rows(result, key: key) { id($0, host: host) }
        }
        for key in ["workspace_colors", "workspace_icons"] where value[key] != .null {
            result = result.setting(key, keyedIDs(value[key], host: host))
        }
        return rows(result, key: "project_folders") {
            rows(ids($0, keys: ["id", "workspace_id"], host: host), key: "thread_ids") { id($0, host: host) }
        }
    }

    static func envelope(_ value: JSON, host: String) -> JSON {
        var event = value["event"]
        switch event["type"].string {
        case "snapshot": event = event.setting("snapshot", snapshot(event["snapshot"], host: host))
        case "thread-started", "thread-updated": event = event.setting("thread", task(event["thread"], host: host))
        case "workspace-updated": event = event.setting("workspace", workspace(event["workspace"], host: host))
        case "interactive-request": event = event.setting("request", request(event["request"], host: host))
        case "preferences-updated": event = event.setting("preferences", preferences(event["preferences"], host: host))
        case "conversation-item-added", "conversation-item-updated": event = event.setting("item", item(event["item"], host: host))
        case "scheduled-task-created", "scheduled-task-updated": event = event.setting("task", scheduledTask(event["task"], host: host))
        case "scheduled-task-deleted": event = ids(event, keys: ["task_id"], host: host)
        case "scheduled-task-run-started", "scheduled-task-run-updated":
            event = ids(event, keys: ["task_id"], host: host).setting("run", scheduledRun(event["run"], host: host))
        case "extension-view-updated":
            event = event.setting("scope", scope(event["scope"], host: host))
            if event["view"] != .null { event = event.setting("view", extensionView(event["view"], host: host)) }
        case "service":
            if event["notice"] != .null { event = event.setting("notice", ids(event["notice"], keys: ["id", "workspace_id", "thread_id"], host: host)) }
        case "operational-condition-upserted": event = event.setting("condition", ids(event["condition"], keys: ["id", "workspace_id", "thread_id"], host: host))
        case "operational-condition-cleared": event = ids(event, keys: ["condition_id"], host: host)
        default: break
        }
        return ids(value, keys: ["workspace_id", "thread_id"], host: host).setting("event", event)
    }

    static func response(_ value: JSON, host: String, path: [String]) -> JSON {
        if path == ["api", "snapshot"] { return snapshot(value, host: host) }
        if path == ["api", "preferences"] { return preferences(value, host: host) }
        if path == ["api", "workspaces", "connect"] || path == ["api", "chats"] { return workspace(value, host: host) }
        if path == ["api", "extensions"] { return extensions(value, host: host) }
        if path.count >= 2, path[1] == "scheduled-tasks" {
            if case .array(let values) = value {
                return .array(values.map { path.last == "runs" ? scheduledRun($0, host: host) : scheduledTask($0, host: host) })
            }
            if value["workspace_id"] != .null {
                return path.last == "run" ? scheduledRun(value, host: host) : scheduledTask(value, host: host)
            }
        }
        var result = value
        if value["workspace"] != .null { result = result.setting("workspace", workspace(value["workspace"], host: host)) }
        if value["thread"] != .null { result = result.setting("thread", task(value["thread"], host: host)) }
        result = rows(result, key: "threads") { task($0, host: host) }
        result = rows(result, key: "workspaces") { workspace($0, host: host) }
        result = rows(result, key: "items") { item($0, host: host) }
        result = rows(result, key: "interactive_requests") { request($0, host: host) }
        result = rows(result, key: "matches") { ids($0, keys: ["workspace_id", "thread_id"], host: host) }
        result = rows(result, key: "updated_views") { extensionView($0, host: host) }
        if path.count == 7, path[1] == "workspaces", path[3] == "threads", path[5] == "items" {
            return item(result, host: host)
        }
        // Some mutation endpoints return a bare entity rather than a handle.
        if path.count >= 3, path[0] == "api", path[1] == "workspaces", value["id"] != .null {
            if path.count >= 5, path[3] == "threads", value["workspace_id"] != .null { return task(result, host: host) }
            if path.count == 3 { return workspace(result, host: host) }
        }
        return result
    }

    private static let relationKeys: Set<String> = [
        "workspace_id", "thread_id", "request_id", "folder_id", "current_thread_id", "parent_thread_id",
        "before_thread_id", "after_thread_id", "task_id", "automation_id"
    ].reduce(into: Set<String>()) { keys, key in
        keys.insert(key)
        let words = key.split(separator: "_")
        keys.insert(String(words[0]) + words.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined())
    }
    private static let relationArrays: Set<String> = ["workspace_order", "hidden_workspace_ids", "thread_ids"]
    private static let relationMaps: Set<String> = ["workspace_colors", "workspace_icons", "thread_token_usage"]
    private static let opaqueKeys: Set<String> = ["input", "inputs", "arguments", "payload", "value", "result", "answers", "input_schema"]

    /// Compatibility for callers already operating inside a known host scope.
    static func rawIDs(_ value: JSON, key: String = "") -> JSON {
        (try? unproject(value, key: key, host: nil)) ?? value
    }

    /// Validate every typed relationship before dispatching to the selected host.
    static func rawIDs(_ value: JSON, host: String) throws -> JSON {
        try unproject(value, key: "", host: host)
    }

    static func rawQuery(_ query: [URLQueryItem], host: String) throws -> [URLQueryItem] {
        try query.map { item in
            guard relationKeys.contains(item.name), let value = item.value else { return item }
            return URLQueryItem(name: item.name, value: try rawID(value, host: host))
        }
    }

    /// Read operations keep the thread's recency unchanged. A replay with the
    /// same timestamp must preserve read/activity watermarks from the snapshot.
    static func mergeTask(previous: JSON, incoming: JSON) -> JSON {
        guard previous["id"] == incoming["id"] else { return incoming }
        func timestamp(_ value: JSON) -> Date? {
            (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value["updated_at"].string))
                ?? (try? Date.ISO8601FormatStyle().parse(value["updated_at"].string))
        }
        let previousAt = timestamp(previous), incomingAt = timestamp(incoming)
        let isNewer: Bool
        if let previousAt, let incomingAt {
            if incomingAt < previousAt { return previous }
            let terminal: Set<String> = ["idle", "error"]
            if incomingAt == previousAt, terminal.contains(previous["status"].string), !terminal.contains(incoming["status"].string) { return previous }
            isNewer = incomingAt > previousAt
        } else { isNewer = false }
        guard case .object = incoming["attention"] else { return incoming }
        let activity = max(previous["attention"]["last_agent_activity_seq"].double, incoming["attention"]["last_agent_activity_seq"].double)
        let read = isNewer ? incoming["attention"]["last_read_seq"].double : max(previous["attention"]["last_read_seq"].double, incoming["attention"]["last_read_seq"].double)
        let unread = activity > read
        var attention = incoming["attention"].setting("last_agent_activity_seq", .number(activity))
            .setting("last_read_seq", .number(read)).setting("unread", .bool(unread))
        if ["none", "unread"].contains(attention["level"].string) {
            attention = attention.setting("level", .string(unread ? "unread" : "none"))
        }
        return incoming.setting("attention", attention)
    }

    private static func rawID(_ value: String, host: String?) throws -> String {
        let split = NativeHostManager.split(value)
        if let host, let actual = split.hostID, host != actual {
            throw PilotError("This operation combines projects from different servers.")
        }
        return split.id
    }

    private static func unproject(_ value: JSON, key: String, host: String?) throws -> JSON {
        if opaqueKeys.contains(key) { return value }
        switch value {
        case .string(let string) where relationKeys.contains(key) || relationArrays.contains(key):
            return .string(try rawID(string, host: host))
        case .object(let fields):
            var result: [String: JSON] = [:]
            if relationMaps.contains(key) {
                for (mapKey, field) in fields {
                    let rawKey = try rawID(mapKey, host: host)
                    guard result[rawKey] == nil else { throw PilotError("This operation contains duplicate project identifiers.") }
                    result[rawKey] = field
                }
                return .object(result)
            }
            for (fieldKey, field) in fields {
                if fieldKey == "host_id" { continue }
                let isEntityID = fieldKey == "id" && (key == "project_folders" || (["scope", "target"].contains(key) && ["thread", "workspace"].contains(fields["kind"]?.string ?? "")))
                if isEntityID, case .string(let string) = field { result[fieldKey] = .string(try rawID(string, host: host)) }
                else { result[fieldKey] = try unproject(field, key: fieldKey, host: host) }
            }
            return .object(result)
        case .array(let values): return .array(try values.map { try unproject($0, key: key, host: host) })
        default: return value
        }
    }

    /// Apply the daemon's bounded snapshot projections so unrelated host updates
    /// cannot restore stale sidebar state on the next combined snapshot.
    static func reduce(_ snapshot: JSON, envelope: JSON) -> JSON {
        let event = envelope["event"]
        var result = snapshot
        func upsert(_ key: String, value: JSON, identifier: String = "id") {
            guard !value[identifier].string.isEmpty else { return }
            var values = result[key].array
            if let index = values.firstIndex(where: { $0[identifier] == value[identifier] }) {
                if key == "threads" { values[index] = mergeTask(previous: values[index], incoming: value) }
                else {
                    if values[index]["updated_at"].string > value["updated_at"].string { return }
                    values[index] = value
                }
            } else { values.append(value) }
            result = result.setting(key, .array(values))
        }
        switch event["type"].string {
        case "snapshot": return event["snapshot"]
        case "thread-started":
            upsert("threads", value: event["thread"])
            result = rows(result, key: "workspaces") {
                $0["id"] == event["thread"]["workspace_id"] ? $0.setting("current_thread_id", event["thread"]["id"]) : $0
            }
        case "thread-updated": upsert("threads", value: event["thread"])
        case "workspace-updated": upsert("workspaces", value: event["workspace"])
        case "preferences-updated": result = result.setting("preferences", event["preferences"])
        case "interactive-request": upsert("interactive_requests", value: event["request"], identifier: "request_id")
        case "conversation-item-added", "conversation-item-updated":
            let item = event["item"]
            if item["kind"].string == "interactive_request", item["resolved"].bool {
                result = result.setting("interactive_requests", .array(result["interactive_requests"].array.filter { $0["request_id"] != item["request"]["request_id"] }))
            }
        case "extension-catalog-updated": result = result.setting("extensions", result["extensions"].setting("catalog", event["catalog"]))
        case "extension-view-updated":
            let views = result["extensions"]["views"].array.filter {
                !($0["extension_id"] == event["extension_id"] && $0["view_id"] == event["view_id"] && $0["scope"] == event["scope"])
            } + (event["view"] == .null ? [] : [event["view"]])
            result = result.setting("extensions", result["extensions"].setting("views", .array(views)))
        case "scheduled-task-created", "scheduled-task-updated": upsert("scheduled_tasks", value: event["task"])
        case "scheduled-task-deleted": result = result.setting("scheduled_tasks", .array(result["scheduled_tasks"].array.filter { $0["id"] != event["task_id"] }))
        case "scheduled-task-run-started", "scheduled-task-run-updated":
            let run = event["run"]
            if run["task_id"] == event["task_id"] {
                result = rows(result, key: "scheduled_tasks") { $0["id"] == event["task_id"] ? $0.setting("last_run", run) : $0 }
            }
        case "service":
            let notice = event["notice"]
            if !notice["id"].string.isEmpty, !result["service_notices"].array.contains(where: { $0["id"] == notice["id"] }) {
                result = result.setting("service_notices", .array(Array((result["service_notices"].array + [notice]).suffix(32))))
            }
        case "operational-condition-upserted":
            let condition = event["condition"]
            let values = result["operational_conditions"].array.filter {
                !($0["workspace_id"] == condition["workspace_id"] && $0["thread_id"] == condition["thread_id"] && $0["key"] == condition["key"])
            }
            result = result.setting("operational_conditions", .array(values + [condition]))
        case "operational-condition-cleared":
            result = result.setting("operational_conditions", .array(result["operational_conditions"].array.filter { !($0["id"] == event["condition_id"] && $0["workspace_id"] == envelope["workspace_id"]) }))
            result = result.setting("service_notices", .array(result["service_notices"].array.filter { $0["id"] != event["condition_id"] }))
        case "thread-token-usage-updated":
            if !envelope["thread_id"].string.isEmpty {
                let usage = result["thread_token_usage"] == .null ? JSON.object([:]) : result["thread_token_usage"]
                result = result.setting("thread_token_usage", usage.setting(envelope["thread_id"].string, event["usage"]))
            }
        default: break
        }
        return result
    }
}
