import SwiftUI

struct ApprovalChoice: Identifiable, Equatable {
    let id: String
    let label: String
    let response: JSON
    let destructive: Bool
    static func choices(for request: JSON) -> [ApprovalChoice] {
        if request["approval_options"] != .null {
            return request["approval_options"].array.map {
                ApprovalChoice(id: $0["option_id"].string, label: $0["label"].string,
                               response: .object(["kind": .string("approval_option"), "option_id": $0["option_id"]]), destructive: $0["decision"].string == "deny")
            }
        }
        let decisions = request["approval_decisions"] == .null ? [JSON.string("allow"), .string("deny")] : request["approval_decisions"].array
        return decisions.compactMap { value in
            let labels = ["allow": "Allow once", "deny": "Deny", "always_allow": "Always allow"]
            guard let label = labels[value.string] else { return nil }
            return ApprovalChoice(id: value.string, label: label, response: .object(["kind": .string("approval"), "decision": value]), destructive: value.string == "deny")
        }
    }
}

struct InteractiveCard: View {
    @Environment(AppModel.self) private var model
    let request: JSON
    @State private var answers: [String: String] = [:]
    @State private var sending = false
    @State private var error: String?
    @State private var showQuestions = false
    @State private var commandHeight: CGFloat = 40
    private var kind: String { request["kind"].string }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(request["title"].string, systemImage: "hand.raised").font(.subheadline.weight(.semibold)).foregroundStyle(.orange)
            if !request["command"].string.isEmpty {
                ScrollView([.horizontal, .vertical]) {
                    Text(request["command"].string).font(.caption.monospaced()).textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true).padding(8)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { commandHeight = $0 }
                }.frame(height: min(commandHeight, 88)).background(FD.raised, in: .rect(cornerRadius: 8)).clipped()
                    .accessibilityIdentifier("approval-command")
            }
            if !request["path"].string.isEmpty { Text(request["path"].string).font(.caption.monospaced()).foregroundStyle(FD.secondary).textSelection(.enabled) }
            if !request["detail"].string.isEmpty {
                ScrollView { NativeMarkdown(text: request["detail"].string) }.frame(maxHeight: 180)
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
            if kind == "approval" {
                let choices = ApprovalChoice.choices(for: request)
                if choices.isEmpty { Text("This request must be answered on your computer.").font(.footnote).foregroundStyle(FD.secondary) }
                ViewThatFits(in: .horizontal) {
                    HStack { ForEach(choices) { choice in choiceButton(choice) } }
                    VStack(alignment: .leading) { ForEach(choices) { choice in choiceButton(choice) } }
                }
            } else if kind == "plan_approval" {
                HStack {
                    Button("Approve plan") { respond(.object(["kind": .string("plan_approval"), "outcome": .string("approved")])) }.buttonStyle(.glassProminent)
                    Button("Keep planning") { respond(.object(["kind": .string("plan_approval"), "outcome": .string("cancelled")])) }.buttonStyle(.glass)
                }
            } else if kind == "question" {
                Button("Answer questions") { showQuestions = true }.buttonStyle(.glassProminent)
            }
            if sending { ActivityDiamond() }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(12).background(FD.surface, in: .rect(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(FD.line) }
        .disabled(sending || (!model.connected && !model.demo))
        .sheet(isPresented: $showQuestions) { questionSheet }
    }
    private func choiceButton(_ choice: ApprovalChoice) -> some View {
        Button(choice.label, role: choice.destructive ? .destructive : nil) { respond(choice.response) }.buttonStyle(.glass)
    }
    private func respond(_ response: JSON) {
        sending = true; error = nil
        Task {
            defer { sending = false }
            do { try await model.respond(request: request, response: response); showQuestions = false }
            catch { self.error = error.localizedDescription }
        }
    }
    private var questionSheet: some View {
        NavigationStack {
            Form {
                ForEach(request["questions"].array, id: \.self) { question in
                    Section(question["header"].string) {
                        Text(question["question"].string)
                        ForEach(question["options"].array, id: \.self) { option in
                            Button {
                                answers[question["id"].string] = option["label"].string
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(option["label"].string)
                                        Text(option["description"].string).font(.footnote).foregroundStyle(FD.secondary)
                                    }
                                    Spacer()
                                    if answers[question["id"].string] == option["label"].string { Image(systemName: "checkmark") }
                                }
                            }
                        }
                        if question["is_secret"].bool {
                            SecureField("Your answer", text: answerBinding(question)).textInputAutocapitalization(.never).autocorrectionDisabled()
                        } else { TextField("Your answer", text: answerBinding(question), axis: .vertical) }
                    }.listRowBackground(FD.surface)
                }
                if let error { Text(error).foregroundStyle(.orange) }
            }
            .scrollContentBackground(.hidden).background(FD.background)
            .navigationTitle("Questions").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showQuestions = false }.disabled(sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Submit") {
                        respond(.object(["kind": .string("question"), "answers": .object(answers.mapValues { .array([.string($0)]) })]))
                    }.disabled(sending || request["questions"].array.contains { answers[$0["id"].string]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false })
                }
            }
        }.interactiveDismissDisabled(sending)
    }
    private func answerBinding(_ question: JSON) -> Binding<String> {
        Binding(get: { answers[question["id"].string, default: ""] }, set: { answers[question["id"].string] = $0 })
    }
}
