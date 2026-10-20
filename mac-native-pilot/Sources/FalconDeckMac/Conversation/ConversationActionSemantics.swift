import Foundation

/// Wire decisions shared by the action buttons and their execution paths.
enum ConversationActionSemantics {
    static func compactionBody(instructions: String, capabilities: JSON) throws -> JSON {
        guard capabilities["supports_compaction"].bool else {
            throw PilotError("This agent does not support manual context compaction.")
        }
        let instructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard instructions.isEmpty || capabilities["supports_compaction_instructions"].bool else {
            throw PilotError("This agent does not accept compaction instructions. Use /compact without instructions.")
        }
        return .object(instructions.isEmpty ? [:] : ["instructions": .string(instructions)])
    }

    static func canBranch(task: AgentTask, capabilities: JSON) -> Bool {
        capabilities["supports_forking"].bool && task.raw["variant"] == .null && !task.running && !task.awaitingInput
    }

    static func canSetGoalStatus(_ task: AgentTask) -> Bool {
        task.provider == "codex" && task.raw["goal"] != .null && task.raw["goal"]["status"].string != "complete"
    }

    static func retrySource(for message: Message, messages: [Message]) -> Message? {
        guard message.kind == "assistant_message", message.raw["phase"].string != "commentary", !message.streaming,
              let index = messages.firstIndex(where: { $0.id == message.id }),
              let user = messages[..<index].last(where: { $0.kind == "user_message" }),
              !user.raw["turn_id"].string.isEmpty else { return nil }
        return user
    }

    static func retrySources(messages: [Message]) -> [String: Message] {
        var result: [String: Message] = [:]
        var source: Message?
        for message in messages {
            if message.kind == "user_message" {
                source = message.raw["turn_id"].string.isEmpty ? nil : message
            } else if message.kind == "assistant_message", message.raw["phase"].string != "commentary", !message.streaming, let source {
                result[message.id] = source
            }
        }
        return result
    }

    static func branchSettings(_ task: AgentTask) -> [String: JSON] {
        Dictionary(uniqueKeysWithValues: ["model_id", "reasoning_effort", "service_tier", "collaboration_mode_id",
                                         "permission_mode", "approval_policy", "sandbox_mode"].map { ($0, task.raw["agent"][$0]) })
    }

    static func newBranchBody(_ task: AgentTask) -> JSON {
        var fields = branchSettings(task).filter { !["reasoning_effort", "service_tier"].contains($0.key) }
        fields["workspace_id"] = .string(task.projectID)
        fields["provider"] = .string(task.provider)
        fields["isolation"] = .string("project_folder")
        return .object(fields)
    }
}
