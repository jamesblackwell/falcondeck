import SwiftUI
import AppKit

struct ApprovalChoice: Identifiable {
    let id: String
    let label: String
    let response: JSON
    let destructive: Bool

    static func choices(for request: JSON) -> [ApprovalChoice] {
        if request["approval_options"] != .null {
            return request["approval_options"].array.compactMap {
                guard !$0["option_id"].string.isEmpty else { return nil }
                return ApprovalChoice(id: $0["option_id"].string, label: $0["label"].string,
                    response: .object(["kind": .string("approval_option"), "option_id": $0["option_id"]]),
                    destructive: $0["decision"].string == "deny")
            }
        }
        let decisions = request["approval_decisions"] == .null ? [JSON.string("allow"), .string("deny")] : request["approval_decisions"].array
        return decisions.compactMap {
            let labels = ["allow": "Allow once", "deny": "Deny", "always_allow": "Always allow"]
            guard let label = labels[$0.string] else { return nil }
            return ApprovalChoice(id: $0.string, label: label,
                response: .object(["kind": .string("approval"), "decision": $0]), destructive: $0.string == "deny")
        }
    }
}

enum InteractiveQuestionResponse {
    static func definitionError(_ request: JSON) -> String? {
        let questions = request["questions"].array
        guard !questions.isEmpty else { return "This provider did not supply any questions to answer." }
        let ids = questions.map { $0["id"].string }
        guard !ids.contains(""), Set(ids).count == ids.count else {
            return "This provider supplied questions without distinct identifiers."
        }
        return nil
    }

    static func payload(_ request: JSON, answers: [String: String]) -> JSON? {
        guard definitionError(request) == nil else { return nil }
        var values: [String: JSON] = [:]
        for question in request["questions"].array {
            let id = question["id"].string
            guard let answer = answers[id], !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            values[id] = .array([.string(answer)])
        }
        return .object(["kind": .string("question"), "answers": .object(values)])
    }
}

struct InteractiveRequestsView: View {
    let store: AppStore
    var body: some View {
        ForEach(store.pendingRequests, id: \.self) { request in
            NativeInteractiveRequestCard(request: request, preferences: store.preferences, connected: store.isSelectedHostConnected) { response in
                try await store.respond(request: request, response: response)
            }
        }
    }
}

struct NativeInteractiveRequestCard: View {
    let request: JSON
    let preferences: JSON
    let connected: Bool
    var onRespond: (JSON) async throws -> Void
    @State private var answers: [String: String] = [:]
    @State private var sending = false
    @State private var error: String?
    @State private var planFeedback = ""
    @State private var detailsExpanded = true
    private var isElicitation: Bool { ["mcpServer/elicitation/request", "elicitation/create"].contains(request["method"].string) }
    private var signInURL: URL? {
        guard isElicitation, let url = URL(string: request["path"].string), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(request["title"].string, systemImage: "hand.raised.fill")
                .font(.headline).foregroundStyle(.orange)
            if !request["detail"].string.isEmpty || !request["command"].string.isEmpty || !request["path"].string.isEmpty {
                DisclosureGroup("Details", isExpanded: $detailsExpanded) {
                    VStack(alignment: .leading, spacing: 9) {
                        if !request["detail"].string.isEmpty {
                            ScrollView { NativeMarkdownView(text: request["detail"].string).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 160)
                        }
                        if !request["command"].string.isEmpty {
                            ScrollView(.horizontal) { Text(request["command"].string).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                        }
                        if !request["path"].string.isEmpty { Text(request["path"].string).font(.caption).foregroundStyle(.secondary) }
                    }.padding(.top, 8)
                }.font(.caption)
            }
            if let signInURL { Link("Open sign-in page", destination: signInURL).font(.caption) }
            if request["kind"].string == "question" {
                if let definitionError = InteractiveQuestionResponse.definitionError(request) {
                    Text(definitionError).font(.caption).foregroundStyle(FDTheme.warning)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(request["questions"].array, id: \.self) { question in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(question["question"].string).font(.subheadline.weight(.medium))
                                ForEach(question["options"].array, id: \.self) { option in
                                    Button {
                                        answers[question["id"].string] = option["label"].string
                                    } label: {
                                        Label(option["label"].string, systemImage: answers[question["id"].string] == option["label"].string ? "checkmark.circle.fill" : "circle")
                                    }.buttonStyle(.plain)
                                    if !option["description"].string.isEmpty {
                                        Text(option["description"].string).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                if question["is_secret"].bool { SecureField("Your answer", text: binding(question)) }
                                else { TextField("Your answer", text: binding(question)) }
                            }
                        }
                    }
                }.frame(maxHeight: 240)
                Button("Send answers") {
                    if let response = InteractiveQuestionResponse.payload(request, answers: answers) { respond(response) }
                }.disabled(InteractiveQuestionResponse.payload(request, answers: answers) == nil)
                if isElicitation {
                    Button("Decline", role: .destructive) { respond(.object(["kind": .string("approval"), "decision": .string("deny")])) }
                }
            } else if request["kind"].string == "plan_approval" {
                TextField("Optional feedback for the agent", text: $planFeedback, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(2...5)
                HStack {
                    Button("Approve plan") { respond(planResponse("approved")) }
                    Button("Request changes") { respond(planResponse("cancelled")) }.disabled(planFeedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Abandon plan", role: .destructive) { respond(planResponse("abandoned")) }
                }
            } else {
                let choices = ApprovalChoice.choices(for: request)
                if choices.isEmpty { Text("This request has no supported choices. Open the current FalconDeck app to inspect it.").font(.caption) }
                HStack {
                    ForEach(choices) { choice in
                        Button(choice.label, role: choice.destructive ? .destructive : nil) { respond(choice.response) }
                    }
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
            if sending { ProgressView().controlSize(.small) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.orange.opacity(0.3)) }
        .disabled(sending || !connected)
        .onAppear {
            let setting = preferences["conversation"]["auto_expand"]["approvals"]
            detailsExpanded = setting == .null || setting.bool
        }
    }

    private func binding(_ question: JSON) -> Binding<String> {
        Binding(get: { answers[question["id"].string, default: ""] }, set: { answers[question["id"].string] = $0 })
    }
    private func planResponse(_ outcome: String) -> JSON {
        let feedback = planFeedback.trimmingCharacters(in: .whitespacesAndNewlines)
        return .object(["kind": .string("plan_approval"), "outcome": .string(outcome), "feedback": feedback.isEmpty ? .null : .string(feedback)])
    }
    private func respond(_ response: JSON) {
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                try await onRespond(response)
                if response["decision"].string == "allow", let signInURL { NSWorkspace.shared.open(signInURL) }
            }
            catch { self.error = error.localizedDescription }
        }
    }
}
