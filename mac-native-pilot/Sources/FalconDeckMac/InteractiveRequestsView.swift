import SwiftUI

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

struct InteractiveRequestsView: View {
    let store: AppStore
    var body: some View {
        ForEach(store.pendingRequests, id: \.self) { request in
            RequestCard(store: store, request: request)
        }
    }
}

private struct RequestCard: View {
    let store: AppStore
    let request: JSON
    @State private var answers: [String: String] = [:]
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(request["title"].string, systemImage: "hand.raised.fill")
                .font(.headline).foregroundStyle(.orange)
            if !request["detail"].string.isEmpty {
                ScrollView { Text(request["detail"].string).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    .frame(maxHeight: 140)
            }
            if !request["command"].string.isEmpty {
                ScrollView(.horizontal) { Text(request["command"].string).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }
            if !request["path"].string.isEmpty { Text(request["path"].string).font(.caption).foregroundStyle(.secondary) }
            if request["kind"].string == "question" {
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
                    respond(.object(["kind": .string("question"), "answers": .object(answers.mapValues { .array([.string($0)]) })]))
                }.disabled(request["questions"].array.contains { answers[$0["id"].string, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            } else if request["kind"].string == "plan_approval" {
                HStack {
                    Button("Approve plan") { respond(.object(["kind": .string("plan_approval"), "outcome": .string("approved")])) }
                    Button("Keep planning") { respond(.object(["kind": .string("plan_approval"), "outcome": .string("cancelled")])) }
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
        .disabled(sending || !store.isConnected)
    }

    private func binding(_ question: JSON) -> Binding<String> {
        Binding(get: { answers[question["id"].string, default: ""] }, set: { answers[question["id"].string] = $0 })
    }
    private func respond(_ response: JSON) {
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do { try await store.respond(request: request, response: response) }
            catch { self.error = error.localizedDescription }
        }
    }
}
