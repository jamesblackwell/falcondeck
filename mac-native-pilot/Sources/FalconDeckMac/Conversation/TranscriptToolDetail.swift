import SwiftUI

/// Structured provider metadata is preferred over dumping the retained payload.
struct TranscriptToolDetail: View {
    @Environment(\.transcriptOpenFile) private var openFile
    let detail: JSON
    var mediaURL: ((JSON) -> URL?)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch detail["kind"].string {
            case "command_execution": command
            case "mcp", "dynamic": invocation
            case "collab_agent": collaboration
            case "subagent_activity":
                Label("\(detail["agent_path"].string) · \(detail["activity"].string)", systemImage: "person.2")
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.secondary)
                if !detail["agent_thread_id"].string.isEmpty { metadata("Task", detail["agent_thread_id"].string) }
            case "hook": hook
            case "guardian_review": guardianReview
            default:
                if detail != .null { TranscriptCodeBlock(text: TranscriptPresentation.pretty(detail), language: "Details") }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var command: some View {
        VStack(alignment: .leading, spacing: 9) {
            if !detail["cwd"].string.isEmpty { metadata("Directory", detail["cwd"].string) }
            if !detail["command"].string.isEmpty { TranscriptCodeBlock(text: detail["command"].string, language: "shell") }
            ForEach(Array(detail["actions"].array.enumerated()), id: \.offset) { _, action in
                let target = TranscriptPresentation.nonempty(action["path"].string, action["name"].string, action["query"].string, action["command"].string)
                Group {
                    if !action["path"].string.isEmpty, let openFile {
                        Button { openFile(action["path"].string, nil) } label: {
                            Label(target, systemImage: action["action_kind"].string == "search" ? "magnifyingglass" : "doc.text")
                        }.buttonStyle(.plain)
                    } else {
                        Label(target, systemImage: action["action_kind"].string == "search" ? "magnifyingglass" : "doc.text").textSelection(.enabled)
                    }
                }.font(NativePreferences.shared.font(size: 13, surface: "code")).foregroundStyle(FDTheme.muted)
            }
        }
    }

    private var invocation: some View {
        VStack(alignment: .leading, spacing: 10) {
            let app = detail["app_context"]
            if !app["app_name"].string.isEmpty {
                Label(app["app_name"].string, systemImage: "app.connected.to.app.below.fill")
                    .font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .medium)).foregroundStyle(FDTheme.secondary)
            }
            let namespace = TranscriptPresentation.nonempty(detail["server"].string, detail["namespace"].string)
            if !namespace.isEmpty { metadata("Tool", "\(namespace).\(detail["tool"].string)") }
            if detail["arguments"] != .null {
                DisclosureGroup("Input") { TranscriptCodeBlock(text: TranscriptPresentation.pretty(detail["arguments"]), language: "json") }
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
            }
            if !detail["error"].string.isEmpty {
                Label(detail["error"].string, systemImage: "exclamationmark.circle")
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.danger).textSelection(.enabled)
            }
            if detail["result"] != .null { TranscriptProviderContent(value: detail["result"], mediaURL: mediaURL) }
            ForEach(Array(detail["content_items"].array.enumerated()), id: \.offset) { _, item in
                TranscriptContentItem(item: item, mediaURL: mediaURL)
            }
        }
    }

    private var collaboration: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !detail["prompt"].string.isEmpty { NativeMarkdownView(text: detail["prompt"].string) }
            let choice = [detail["model"].string, detail["reasoning_effort"].string].filter { !$0.isEmpty }.joined(separator: " · ")
            if !choice.isEmpty { metadata("Model", choice) }
            ForEach(detail["receiver_thread_ids"].array, id: \.self) { id in
                let state = detail["agent_states"][id.string]
                HStack(alignment: .top, spacing: 8) {
                    TaskStatusMark(status: state["status"].string)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(id.string).font(NativePreferences.shared.font(size: 13, surface: "code")).textSelection(.enabled)
                        if !state["message"].string.isEmpty { Text(state["message"].string).font(NativePreferences.shared.font(size: 12, surface: "chat")) }
                    }.foregroundStyle(FDTheme.secondary)
                }
            }
        }
    }

    private var hook: some View {
        VStack(alignment: .leading, spacing: 9) {
            metadata(detail["event_name"].string, [detail["handler_type"].string, detail["execution_mode"].string, detail["scope"].string].filter { !$0.isEmpty }.joined(separator: " · "))
            if !detail["source_path"].string.isEmpty { metadata("Source", detail["source_path"].string) }
            if !detail["status_message"].string.isEmpty { Text(detail["status_message"].string).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.secondary) }
            ForEach(Array(detail["entries"].array.enumerated()), id: \.offset) { _, entry in
                Label(entry["text"].string, systemImage: entry["entry_kind"].string == "error" ? "exclamationmark.circle" : "text.bubble")
                    .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(entry["entry_kind"].string == "error" ? FDTheme.danger : FDTheme.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private var guardianReview: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(detail["status"].string.capitalized, systemImage: detail["status"].string == "denied" ? "xmark.shield" : "checkmark.shield")
                .font(NativePreferences.shared.font(size: 12, surface: "chat", weight: .medium)).foregroundStyle(detail["status"].string == "denied" ? FDTheme.danger : FDTheme.secondary)
            if !detail["action"].string.isEmpty { TranscriptCodeBlock(text: detail["action"].string, language: detail["action_kind"].string) }
            if !detail["cwd"].string.isEmpty { metadata("Directory", detail["cwd"].string) }
            if !detail["risk_level"].string.isEmpty { metadata("Risk", detail["risk_level"].string) }
            if !detail["user_authorization"].string.isEmpty { metadata("Authorization", detail["user_authorization"].string) }
            if !detail["rationale"].string.isEmpty { NativeMarkdownView(text: detail["rationale"].string) }
        }
    }

    private func metadata(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label).foregroundStyle(FDTheme.muted)
            if ["Directory", "Source"].contains(label), let openFile {
                Button(value) { openFile(value, nil) }.buttonStyle(.plain).foregroundStyle(FDTheme.secondary)
            } else { Text(value).foregroundStyle(FDTheme.secondary).textSelection(.enabled) }
        }.font(NativePreferences.shared.font(size: 13, surface: "code"))
    }
}

struct TranscriptProviderContent: View {
    let value: JSON
    var mediaURL: ((JSON) -> URL?)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !value["content"].array.isEmpty {
                ForEach(Array(value["content"].array.enumerated()), id: \.offset) { _, item in
                    TranscriptContentItem(item: item, mediaURL: mediaURL)
                }
                let structured = value["structuredContent"] == .null ? value["structured_content"] : value["structuredContent"]
                if structured != .null {
                    DisclosureGroup("Structured result") { TranscriptCodeBlock(text: TranscriptPresentation.pretty(structured), language: "json") }
                        .font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted)
                }
            } else if !value.array.isEmpty {
                ForEach(Array(value.array.enumerated()), id: \.offset) { _, item in TranscriptContentItem(item: item, mediaURL: mediaURL) }
            } else if value != .null {
                if !value["type"].string.isEmpty || !value["kind"].string.isEmpty { TranscriptContentItem(item: value, mediaURL: mediaURL) }
                else { TranscriptCodeBlock(text: TranscriptPresentation.pretty(value), language: "json") }
            }
        }
    }
}

private struct TranscriptContentItem: View {
    let item: JSON
    var mediaURL: ((JSON) -> URL?)? = nil
    private var kind: String { TranscriptPresentation.nonempty(item["type"].string, item["kind"].string) }

    var body: some View {
        Group {
            switch kind {
            case "text":
                NativeMarkdownView(text: item["text"].string)
            case "image", "image_url":
                let reference = normalizedMedia(prefix: "image")
                TranscriptMediaView(reference: reference, resolvedURL: mediaURL?(reference))
            case "audio", "audio_url", "output_audio", "input_audio":
                let reference = normalizedMedia(prefix: "audio")
                TranscriptMediaView(reference: reference, resolvedURL: mediaURL?(reference))
            case "resource_link":
                if let url = TranscriptPresentation.externalURL(item["uri"].string) {
                    Link(destination: url) { Label(TranscriptPresentation.nonempty(item["title"].string, item["name"].string, url.absoluteString), systemImage: "link") }
                        .font(NativePreferences.shared.font(size: 12, surface: "chat"))
                } else { Text(TranscriptPresentation.nonempty(item["name"].string, item["uri"].string)).font(NativePreferences.shared.font(size: 12, surface: "chat")).textSelection(.enabled) }
                if !item["description"].string.isEmpty { Text(item["description"].string).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted) }
            case "resource":
                let resource = item["resource"]
                if !resource["text"].string.isEmpty {
                    if resource["mimeType"].string.contains("markdown") { NativeMarkdownView(text: resource["text"].string) }
                    else { TranscriptCodeBlock(text: resource["text"].string, language: TranscriptPresentation.nonempty(resource["mimeType"].string, "text")) }
                } else if !resource["blob"].string.isEmpty {
                    let reference = JSON.object(["name": resource["uri"], "mime_type": resource["mimeType"],
                                                 "url": .string("data:\(resource["mimeType"].string);base64,\(resource["blob"].string)")])
                    TranscriptMediaView(reference: reference, resolvedURL: mediaURL?(reference))
                } else {
                    Text(TranscriptPresentation.nonempty(resource["uri"].string, "Embedded resource")).font(NativePreferences.shared.font(size: 12, surface: "chat")).foregroundStyle(FDTheme.muted).textSelection(.enabled)
                }
            default:
                TranscriptCodeBlock(text: TranscriptPresentation.pretty(item), language: "Details")
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func normalizedMedia(prefix: String) -> JSON {
        let nested = item["\(prefix)_url"]
        var url = TranscriptPresentation.nonempty(item["url"].string, nested["url"].string, nested.string)
        let mime = TranscriptPresentation.nonempty(item["mimeType"].string, item["mime_type"].string, prefix == "image" ? "image/png" : "audio/wav")
        if url.isEmpty, !item["data"].string.isEmpty { url = "data:\(mime);base64,\(item["data"].string)" }
        return .object(["url": .string(url), "name": .string(prefix.capitalized), "mime_type": .string(mime)])
    }
}
