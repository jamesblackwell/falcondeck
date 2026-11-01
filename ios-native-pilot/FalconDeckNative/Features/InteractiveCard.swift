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

enum PlanReviewAction: String {
    case approve = "approved", requestChanges = "cancelled", abandon = "abandoned"

    func response(for request: JSON, feedback: String) -> JSON? {
        guard request["kind"].string == "plan_approval" else { return nil }
        let feedback = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
        if self == .approve, request["detail"].string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if self == .requestChanges, feedback.isEmpty { return nil }
        var response = JSON.object(["kind": .string("plan_approval"), "outcome": .string(rawValue)])
        if self == .requestChanges { response = response.setting("feedback", .string(feedback)) }
        return response
    }
}

struct InteractiveCard: View {
    @Environment(AppModel.self) private var model
    let request: JSON
    @State private var answers: [String: String] = [:]
    @State private var planFeedback = ""
    @FocusState private var planFeedbackFocused: Bool
    @State private var sending = false
    @State private var error: String?
    @State private var showQuestions = false
    @State private var showPlan = false
    @State private var commandHeight: CGFloat = 40
    private var kind: String { request["kind"].string }
    private var offline: Bool { !model.connected && !model.demo }
    private var plan: String { request["detail"].string.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            switch kind {
            case "plan_approval": planSummary
            case "question": questionSummary
            default: approvalBody
            }
            if let error, !showPlan, !showQuestions { Text(error).font(.footnote).foregroundStyle(FD.danger) }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(14)
        .background(FD.surface, in: .rect(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(FD.warning.opacity(0.28)) }
        .sheet(isPresented: $showQuestions) { questionSheet }
        .sheet(isPresented: $showPlan) { planSheet }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: kind == "plan_approval" ? "list.bullet.clipboard" : kind == "question" ? "questionmark.bubble" : "hand.raised")
                .font(.subheadline.weight(.semibold)).foregroundStyle(FD.warning)
            Text(kind == "plan_approval" ? "Plan ready for review" : kind == "question" ? "Your agent has a question" : "Approval needed")
                .font(.subheadline.weight(.semibold)).foregroundStyle(FD.foreground)
            Spacer(minLength: 4)
            if sending { ActivityDiamond(size: 7) }
        }
    }

    // MARK: Approvals

    @ViewBuilder private var approvalBody: some View {
        if !request["title"].string.isEmpty { Text(request["title"].string).font(.footnote).foregroundStyle(FD.secondary).lineLimit(3) }
        if !request["command"].string.isEmpty {
            ScrollView([.horizontal, .vertical]) {
                Text(request["command"].string).font(.caption.monospaced()).foregroundStyle(FD.body).textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true).padding(10)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { commandHeight = $0 }
            }.frame(height: min(commandHeight, 96)).background(FD.raised, in: .rect(cornerRadius: 10, style: .continuous)).clipped()
                .accessibilityIdentifier("approval-command")
        }
        if !request["path"].string.isEmpty { Text(request["path"].string).font(.caption.monospaced()).foregroundStyle(FD.secondary).textSelection(.enabled).lineLimit(2).truncationMode(.middle) }
        if !request["detail"].string.isEmpty {
            ScrollView { NativeMarkdown(text: request["detail"].string, font: .footnote, foreground: FD.secondary) }.frame(maxHeight: 120)
        }
        let choices = ApprovalChoice.choices(for: request)
        if choices.isEmpty { Text("This request must be answered on your computer.").font(.footnote).foregroundStyle(FD.secondary) }
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { ForEach(choices) { choiceButton($0).frame(maxWidth: .infinity) } }
            VStack(spacing: 8) { ForEach(choices) { choiceButton($0).frame(maxWidth: .infinity) } }
        }.disabled(sending || offline)
    }
    private func choiceButton(_ choice: ApprovalChoice) -> some View {
        let primary = choice.id == "allow" || (!choice.destructive && choice.label.localizedCaseInsensitiveContains("once"))
        return Button(role: choice.destructive ? .destructive : nil) { respond(choice.response) } label: {
            Text(choice.label).lineLimit(1).minimumScaleFactor(0.85).frame(maxWidth: .infinity)
        }
        .tint(choice.destructive ? FD.danger : FD.accent)
        .modifier(ReviewButtonStyle(prominent: primary))
    }

    // MARK: Plan review

    @ViewBuilder private var planSummary: some View {
        if plan.isEmpty {
            Text("This provider did not supply a plan to review.").font(.footnote).foregroundStyle(FD.secondary)
        } else {
            Text(Self.preview(plan)).font(.footnote).foregroundStyle(FD.secondary).lineLimit(3)
        }
        HStack(spacing: 8) {
            Button { showPlan = true } label: { Text(plan.isEmpty ? "Respond" : "Review plan").frame(maxWidth: .infinity) }
                .modifier(ReviewButtonStyle(prominent: false)).accessibilityIdentifier("plan-review")
            Button { respondToPlan(.approve) } label: { Text("Approve").frame(maxWidth: .infinity) }
                .modifier(ReviewButtonStyle(prominent: true))
                .disabled(sending || offline || PlanReviewAction.approve.response(for: request, feedback: "") == nil)
                .accessibilityIdentifier("plan-quick-approve")
        }
    }

    private var planSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !request["title"].string.isEmpty { Text(request["title"].string).font(.title3.weight(.semibold)) }
                    if plan.isEmpty { Text("This provider did not supply a plan to review.").foregroundStyle(FD.secondary) }
                    else { NativeMarkdown(text: plan) }
                }.padding(20).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(FD.background)
            .safeAreaInset(edge: .bottom, spacing: 0) { planControls }
            .navigationTitle("Review plan").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { showPlan = false }.disabled(sending) }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { planFeedbackFocused = false } }
            }
        }
        .interactiveDismissDisabled(sending)
        .presentationDragIndicator(.visible)
    }

    private var planControls: some View {
        VStack(spacing: 10) {
            if let error { Text(error).font(.footnote).foregroundStyle(FD.danger).frame(maxWidth: .infinity, alignment: .leading) }
            TextField("Changes you want before implementation", text: $planFeedback, axis: .vertical)
                .lineLimit(1...5).focused($planFeedbackFocused)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(FD.raised, in: .rect(cornerRadius: 16, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(planFeedbackFocused ? FD.accent.opacity(0.6) : FD.line) }
                .accessibilityLabel("Requested plan changes").accessibilityIdentifier("plan-feedback")
            HStack(spacing: 8) {
                Button("Abandon", role: .destructive) { respondToPlan(.abandon) }
                    .tint(FD.danger).modifier(ReviewButtonStyle(prominent: false)).accessibilityIdentifier("plan-abandon")
                Button { respondToPlan(.requestChanges) } label: { Text("Request changes").lineLimit(1).minimumScaleFactor(0.85).frame(maxWidth: .infinity) }
                    .modifier(ReviewButtonStyle(prominent: false))
                    .disabled(PlanReviewAction.requestChanges.response(for: request, feedback: planFeedback) == nil)
                    .accessibilityIdentifier("plan-request-changes")
            }
            Button { respondToPlan(.approve) } label: {
                Label("Approve and implement", systemImage: "checkmark").frame(maxWidth: .infinity)
            }
            .modifier(ReviewButtonStyle(prominent: true))
            .disabled(PlanReviewAction.approve.response(for: request, feedback: planFeedback) == nil)
            .accessibilityIdentifier("plan-approve")
        }
        .disabled(sending || offline)
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 8)
        .frame(maxWidth: 720).frame(maxWidth: .infinity)
        .background(.bar)
    }

    private static func preview(_ markdown: String) -> String {
        markdown.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#>*-+ ")) }
            .filter { !$0.isEmpty }.prefix(3).joined(separator: " · ")
    }

    // MARK: Questions

    @ViewBuilder private var questionSummary: some View {
        let questions = request["questions"].array
        Text(questions.first?["question"].string.nonempty ?? request["title"].string)
            .font(.footnote).foregroundStyle(FD.secondary).lineLimit(3)
        Button { showQuestions = true } label: {
            Text(questions.count > 1 ? "Answer \(questions.count) questions" : "Answer").frame(maxWidth: .infinity)
        }
        .modifier(ReviewButtonStyle(prominent: true)).disabled(sending || offline)
        .accessibilityLabel("Answer questions")
    }

    private func respondToPlan(_ action: PlanReviewAction) {
        guard let response = action.response(for: request, feedback: planFeedback) else { return }
        planFeedbackFocused = false
        respond(response)
    }
    private func respond(_ response: JSON) {
        guard !sending else { return }
        sending = true; error = nil
        Task {
            defer { sending = false }
            do { try await model.respond(request: request, response: response); showQuestions = false; showPlan = false }
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
                if let error { Text(error).foregroundStyle(FD.danger) }
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

/// Review actions use a consistent 44pt glass control; the one recommended
/// action is prominent.
private struct ReviewButtonStyle: ViewModifier {
    let prominent: Bool
    func body(content: Content) -> some View {
        // Palette ink on the accent keeps contrast in dark themes, matching Send.
        if prominent { content.buttonStyle(.glassProminent).controlSize(.large).font(.subheadline.weight(.semibold)).foregroundStyle(FD.background) }
        else { content.buttonStyle(.glass).controlSize(.large).font(.subheadline.weight(.medium)) }
    }
}
