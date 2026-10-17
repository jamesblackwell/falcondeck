import Foundation

struct AutomationDraft {
    var name = ""
    var description = ""
    var scheduleKind = "cron"
    var expression = "0 8 * * 1-5"
    var timezone = TimeZone.current.identifier
    var everySeconds = "3600"
    var runAt = Date.now.addingTimeInterval(3600)
    var instruction = ""
    var conditional = false
    var noActionMarker = "FALCONDECK_NO_ACTION"
    var workspacePath = ""
    var provider = "codex"
    var threadKind = "managed"
    var threadID = ""
    var modelID = ""
    var permissionMode = ""
    var sandboxMode = ""
    var connectors = ""
    var skills = ""
    var concurrency = "skip"
    var misfire = "skip"
    var anchorAt = ""
    var originalTarget = JSON.object([:])
    init(definition: JSON? = nil, settings: JSON = .null, workspacePath: String = "") {
        self.workspacePath = workspacePath
        timezone = settings["default_timezone"].string.nonempty ?? timezone
        guard let raw = definition else { return }
        name = raw["name"].string; description = raw["description"].string
        scheduleKind = raw["trigger"]["kind"].string
        expression = raw["trigger"]["expression"].string
        timezone = raw["trigger"]["timezone"].string.nonempty ?? timezone
        everySeconds = raw["trigger"]["every_seconds"].optionalInt.map(String.init) ?? "3600"
        anchorAt = raw["trigger"]["anchor_at"].string
        runAt = Self.parseDate(raw["trigger"]["run_at"].string) ?? runAt
        instruction = raw["task"]["instruction"].string; conditional = raw["task"]["kind"].string == "conditional_prompt"
        noActionMarker = raw["task"]["no_action_marker"].string.nonempty ?? noActionMarker
        originalTarget = raw["target"]
        self.workspacePath = raw["target"]["workspace_path"].string
        provider = raw["target"]["provider"].string.nonempty ?? "codex"
        threadKind = raw["target"]["thread"]["kind"].string.nonempty ?? "managed"
        threadID = raw["target"]["thread"]["thread_id"].string
        modelID = raw["target"]["model_id"].string
        permissionMode = raw["target"]["permission_mode"].string; sandboxMode = raw["target"]["sandbox_mode"].string
        connectors = raw["required_connectors"].array.map(\.string).joined(separator: ", ")
        skills = raw["target"]["selected_skills"].array.map(\.string).joined(separator: ", ")
        concurrency = raw["concurrency_policy"].string.nonempty ?? "skip"; misfire = raw["misfire_policy"].string.nonempty ?? "skip"
    }
    var elevated: Bool { permissionMode.trimmingCharacters(in: .whitespacesAndNewlines) == "bypassPermissions" || sandboxMode.trimmingCharacters(in: .whitespacesAndNewlines) == "danger-full-access" }
    var validationError: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "A name is required." }
        if instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "An instruction is required." }
        if !["cron", "interval", "once"].contains(scheduleKind) { return "Choose a supported schedule." }
        if !workspacePath.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") { return "Project path must be absolute on your computer." }
        if scheduleKind == "cron", expression.split(whereSeparator: \.isWhitespace).count != 5 { return "Cron expressions use exactly five fields." }
        if scheduleKind == "cron", TimeZone(identifier: timezone) == nil { return "Enter a valid timezone, such as Europe/London." }
        if scheduleKind == "interval", Int(everySeconds.trimmingCharacters(in: .whitespacesAndNewlines)).map({ $0 >= 60 && $0 <= 9_007_199_254_740_991 }) != true { return "Intervals must be a whole number of at least 60 seconds." }
        if threadKind == "existing", threadID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Choose an existing task." }
        if conditional, noActionMarker.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Conditional automations need a no-action marker." }
        return nil
    }
    func arguments(includeTrigger: Bool) throws -> JSON {
        if let validationError { throw PilotError(validationError) }
        let trim: (String) -> String = { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        var target: [String: JSON] = [:]
        if originalTarget["provider"].string == provider, case .object(let original) = originalTarget { target = original }
        target["workspace_path"] = .string(trim(workspacePath)); target["provider"] = .string(provider)
        var thread = JSON.object(["kind": .string(threadKind)])
        if threadKind != "new_each_run", !trim(threadID).isEmpty { thread = thread.setting("thread_id", .string(trim(threadID))) }
        target["thread"] = thread
        if trim(permissionMode) != originalTarget["permission_mode"].string {
            target.removeValue(forKey: "approval_policy")
            if provider == "codex", !trim(permissionMode).isEmpty { target["approval_policy"] = .string(trim(permissionMode) == "default" ? "on-request" : trim(permissionMode)) }
        }
        for (key, value) in [("model_id", modelID), ("permission_mode", permissionMode), ("sandbox_mode", sandboxMode)] { target.removeValue(forKey: key); if !trim(value).isEmpty { target[key] = .string(trim(value)) } }
        target["selected_skills"] = .array(Self.list(skills).map(JSON.string))
        var task = JSON.object(["kind": .string(conditional ? "conditional_prompt" : "prompt"), "instruction": .string(instruction)])
        if conditional { task = task.setting("no_action_marker", .string(trim(noActionMarker))) }
        var value = JSON.object(["name": .string(trim(name)), "description": .string(trim(description)), "task": task, "target": .object(target), "required_connectors": .array(Self.list(connectors).map(JSON.string)), "concurrency_policy": .string(concurrency), "misfire_policy": .string(misfire)])
        if includeTrigger {
            let trigger: JSON
            switch scheduleKind {
            case "interval": trigger = .object(["kind": .string("interval"), "every_seconds": .number(Double(Int(everySeconds.trimmingCharacters(in: .whitespacesAndNewlines))!)), "anchor_at": .string(anchorAt.nonempty ?? Date.now.ISO8601Format())])
            case "once": trigger = .object(["kind": .string("once"), "run_at": .string(runAt.ISO8601Format())])
            default: trigger = .object(["kind": .string("cron"), "expression": .string(trim(expression)), "timezone": .string(trim(timezone))])
            }
            value = value.setting("trigger", trigger)
        }
        return value
    }
    static func list(_ value: String) -> [String] { value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    static func parseDate(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}
