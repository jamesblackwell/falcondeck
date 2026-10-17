import Foundation
import Observation

struct NativeAutomation: Identifiable, Hashable, Sendable {
    let raw: JSON
    var id: String { raw["id"].string }
    var name: String { raw["name"].string }
    var revision: Int { raw["revision"].int }
    var enabled: Bool { raw["state"].string == "enabled" }
}

@MainActor @Observable
final class AutomationStore {
    var rows: [NativeAutomation] = []
    var settings: JSON = .null
    var runs: [String: [JSON]] = [:]
    var loading = false
    var error: String?
    var visible = 0
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    func reset() {
        refreshTask?.cancel(); refreshTask = nil
        rows = []; settings = .null; runs = [:]; loading = false; error = nil
    }
    func refresh(model: AppModel) async {
        guard !loading else { return }; loading = true; error = nil
        let current = model.connectionID
        defer { if current == model.connectionID { loading = false } }
        if model.demo {
            if settings == .null { settings = .object(["enabled": .bool(true), "default_timezone": .string(TimeZone.current.identifier), "allow_elevated_automations": .bool(false)]) }
            return
        }
        do {
            async let definitions = model.relay.call("control.get", params: .object(["resource": .string("automations"), "limit": .number(100)]))
            async let controls: JSON? = try? await model.relay.call("control.get", params: .object(["resource": .string("agent_control.settings")]))
            let (response, control) = try await (definitions, controls)
            guard current == model.connectionID else { return }
            rows = response["data"].array.map { NativeAutomation(raw: $0) }; settings = control?["data"] ?? settings
        } catch { if current == model.connectionID { self.error = error.localizedDescription } }
    }
    func scheduleRefresh(model: AppModel) {
        guard visible > 0, refreshTask == nil else { return }
        let current = model.connectionID
        refreshTask = Task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            self.refreshTask = nil
            if current == model.connectionID { await self.refresh(model: model) }
        }
    }
    func read(_ row: NativeAutomation, model: AppModel) async throws -> JSON {
        if model.demo { return row.raw }
        let current = model.connectionID
        let result = try await model.relay.call("control.get", params: .object(["resource": .string("automation"), "id": .string(row.id)]))
        guard current == model.connectionID else { throw CancellationError() }
        guard result["data"]["id"].string == row.id, result["data"]["task"] != .null else { throw PilotError("Couldn't load this automation. Refresh and try again.") }
        return result["data"]
    }
    func loadRuns(_ id: String, model: AppModel) async throws {
        if model.demo { return }
        let current = model.connectionID
        let result = try await model.relay.call("control.get", params: .object(["resource": .string("automation.runs"), "id": .string(id), "limit": .number(50)]))
        guard current == model.connectionID else { throw CancellationError() }
        runs[id] = result["data"].array
    }
    @discardableResult func execute(_ operation: String, arguments: JSON, revision: Int? = nil, model: AppModel) async throws -> JSON {
        let current = model.connectionID
        if model.demo { return executeDemo(operation, arguments: arguments) }
        var params = JSON.object(["operation": .string(operation), "arguments": arguments, "idempotency_key": .string("native-\(UUID())")])
        if let revision { params = params.setting("expected_revision", .number(Double(revision))) }
        let result = try await model.relay.call("control.execute", params: params)
        guard current == model.connectionID else { throw CancellationError() }
        guard result["ok"].bool else {
            if result["error"]["code"].string == "revision_conflict" { await refresh(model: model) }
            throw PilotError(result["error"]["suggested_action"].string.nonempty ?? result["error"]["message"].string.nonempty ?? "The automation could not be updated.")
        }
        let data = result["data"]
        if operation == "automation.delete" { rows.removeAll { $0.id == arguments["automation_id"].string } }
        else if data["target"] != .null, !data["id"].string.isEmpty {
            let automation = NativeAutomation(raw: data)
            if let index = rows.firstIndex(where: { $0.id == automation.id }) { rows[index] = automation } else { rows.insert(automation, at: 0) }
        }
        scheduleRefresh(model: model)
        return data
    }
    private func executeDemo(_ operation: String, arguments: JSON) -> JSON {
        let id = arguments["automation_id"].string
        if operation == "automation.create" {
            let raw = arguments.setting("id", .string(UUID().uuidString)).setting("revision", .number(1)).setting("state", .string("enabled"))
            rows.insert(NativeAutomation(raw: raw), at: 0); return raw
        }
        guard let index = rows.firstIndex(where: { $0.id == id }) else { return .null }
        var raw = rows[index].raw
        switch operation {
        case "automation.delete": rows.remove(at: index); return .null
        case "automation.pause": raw = raw.setting("state", .string("paused"))
        case "automation.resume": raw = raw.setting("state", .string("enabled"))
        case "automation.update": raw = raw.merging(arguments)
        case "automation.run_now":
            let run = JSON.object(["id": .string(UUID().uuidString), "automation_id": .string(id), "status": .string("succeeded"), "queued_at": .string(Date.now.ISO8601Format()), "outcome_preview": .string("Demo run · No agent was started.")])
            runs[id, default: []].insert(run, at: 0); return run
        default: break
        }
        raw = raw.setting("revision", .number(Double(rows[index].revision + 1))); rows[index] = NativeAutomation(raw: raw)
        return raw
    }
}
