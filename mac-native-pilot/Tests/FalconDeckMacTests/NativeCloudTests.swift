import Foundation
import XCTest
@testable import FalconDeckMac

private actor CloudRequestRecorder {
    struct Request: Sendable {
        let path: [String]
        let method: String
        let body: JSON?
    }
    private(set) var requests: [Request] = []
    func record(_ path: [String], method: String, body: JSON?) {
        requests.append(.init(path: path, method: method, body: body))
    }
}

final class NativeCloudTests: XCTestCase {
    func testSettingsDraftDoesNotReplayCredentialsFromResponse() {
        let settings = cloudSettings
            .setting("provider_token", .string("unexpected-provider-secret"))
            .setting("openai_api_key", .string("unexpected-model-secret"))
        let payload = NativeCloudSettingsDraft(settings).payload

        XCTAssertNil(payload.fields["provider_token"], "Stored provider credentials are never copied into an editor payload")
        XCTAssertNil(payload.fields["openai_api_key"], "Stored model credentials are never copied into an editor payload")
        XCTAssertNil(payload.fields["has_provider_token"])
        XCTAssertNil(payload.fields["has_openai_api_key"])
        XCTAssertEqual(payload["enabled"], .bool(true))
        XCTAssertEqual(payload["worker_daemon_url"], cloudSettings["worker_daemon_url"])
        XCTAssertEqual(payload["worker_daemon_sha256"], cloudSettings["worker_daemon_sha256"])
    }

    func testCredentialChangesAreExplicitAndCanBeCleared() {
        var draft = NativeCloudSettingsDraft(cloudSettings)
        draft.providerToken = "replacement-token"
        draft.openaiAPIKey = "replacement-api-key"
        XCTAssertEqual(draft.payload["provider_token"], .string("replacement-token"))
        XCTAssertEqual(draft.payload["openai_api_key"], .string("replacement-api-key"))

        draft.providerToken = ""
        draft.openaiAPIKey = ""
        XCTAssertNil(draft.payload.fields["provider_token"])
        XCTAssertNil(draft.payload.fields["openai_api_key"])
        draft.clearProviderToken = true
        draft.clearOpenaiAPIKey = true
        XCTAssertEqual(draft.payload["provider_token"], .string(""))
        XCTAssertEqual(draft.payload["openai_api_key"], .string(""))
    }

    func testPreinstalledWorkerAllowsBothDownloadFieldsToBeEmpty() {
        let settings = cloudSettings
            .setting("worker_daemon_url", .string(""))
            .setting("worker_daemon_sha256", .string(""))
        XCTAssertNil(NativeCloudSettingsDraft.validationError(settings: settings))
    }

    func testWorkerDownloadRequiresURLAndChecksumTogether() {
        let urlOnly = cloudSettings.setting("worker_daemon_sha256", .string(""))
        let checksumOnly = cloudSettings.setting("worker_daemon_url", .string(""))
        XCTAssertNotNil(NativeCloudSettingsDraft.validationError(settings: urlOnly))
        XCTAssertNotNil(NativeCloudSettingsDraft.validationError(settings: checksumOnly))
    }

    func testTaskPayloadUsesReviewedCaptureAndStableSubmissionIdentity() throws {
        var draft = NativeCloudTaskDraft()
        draft.prompt = "  Fix the checkout error.\nKeep the existing layout.  "
        draft.modelID = "gpt-5-codex"
        draft.source = cloudSource
        let first = try draft.payload(workspaceID: "project")
        let retry = try draft.payload(workspaceID: "project")

        XCTAssertEqual(first["workspace_id"], .string("project"))
        XCTAssertEqual(first["source_capture_id"], .string("capture-1"))
        XCTAssertEqual(first["prompt"].string, draft.prompt.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertEqual(first["model_id"], .string("gpt-5-codex"))
        XCTAssertFalse(first["idempotency_key"].string.isEmpty)
        XCTAssertEqual(first["idempotency_key"], retry["idempotency_key"], "Retries must identify the same submission")
        XCTAssertNil(first.fields["path"], "The coordinator receives a workspace ID, never a local path as a remote target")
    }

    func testTaskPayloadRequiresReviewedCapture() {
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Fix the checkout error"
        XCTAssertThrowsError(try draft.payload(workspaceID: "project"))
    }

    @MainActor func testMissingCloudSettingsRetainsDraftWithoutSending() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Keep this unsent request"
        draft.source = cloudSource
        model.drafts["project"] = draft
        let before = draft.idempotencyKey

        let result = await model.create(workspaceID: "project", settings: cloudSettings.setting("has_provider_token", .bool(false))) { path, method, body in
            await recorder.record(path, method: method, body: body)
            return .object(["id": .string("should-not-start")])
        }

        XCTAssertNil(result)
        XCTAssertEqual(model.drafts["project"]?.prompt, draft.prompt)
        XCTAssertEqual(model.drafts["project"]?.idempotencyKey, before)
        let requests = await recorder.requests
        XCTAssertTrue(requests.isEmpty, "Missing credentials must be rejected before a job is sent")
    }

    @MainActor func testMissingProviderScopeKeepsDraftWithoutSending() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Keep this request while configuration is incomplete"
        draft.source = cloudSource
        model.drafts["project"] = draft

        let result = await model.create(workspaceID: "project", settings: cloudSettings.setting("team_id", .null)) { path, method, body in
            await recorder.record(path, method: method, body: body)
            return .object(["id": .string("should-not-start")])
        }

        XCTAssertNil(result)
        XCTAssertEqual(model.drafts["project"]?.prompt, draft.prompt)
        XCTAssertNil(model.drafts["project"]?.submittedPayload, "A local configuration error must not freeze a request as sent")
        let requests = await recorder.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testRemoteCloudProjectionScopesCoordinatorIDsAndKeepsWorkerLocatorOpaque() throws {
        let worker: JSON = .object(["workspace_id": .string("worker-workspace"), "thread_id": .string("worker-thread"), "provider": .string("codex")])
        let raw: JSON = .object(["id": .string("job"), "workspace_id": .string("project"), "source": cloudSource, "worker": worker])
        let projected = NativeCloudScope.response(raw, hostID: "server", path: ["api", "cloud", "jobs", "job"])
        let remoteProject = NativeHostManager.namespace(hostID: "server", id: "project")
        XCTAssertEqual(projected["id"].string, NativeHostManager.namespace(hostID: "server", id: "job"))
        XCTAssertEqual(projected["workspace_id"].string, remoteProject)
        XCTAssertEqual(projected["source"]["workspace_id"].string, remoteProject)
        XCTAssertEqual(projected["worker"], worker, "Worker locator IDs belong only to the job proxy")

        var draft = NativeCloudTaskDraft()
        draft.prompt = "Run on the source host"
        draft.source = projected["source"]
        let payload = try NativeHostProjection.rawIDs(draft.payload(workspaceID: remoteProject), host: "server")
        XCTAssertEqual(payload["workspace_id"], .string("project"))
        XCTAssertEqual(payload["source_capture_id"], .string("capture-1"))
        XCTAssertEqual(NativeCloudScope.response(raw, hostID: "server", path: ["api", "cloud", "jobs", "job", "detail"]), raw)
    }

    @MainActor func testWorkspaceCannotBeSentThroughAnotherCoordinator() async {
        let model = NativeCloudModel(hostID: "other-server")
        let recorder = CloudRequestRecorder()
        let remoteID = NativeHostManager.namespace(hostID: "server", id: "project")
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Keep this source-host request"
        draft.source = cloudSource.setting("workspace_id", .string(remoteID))
        model.drafts[remoteID] = draft

        let result = await model.create(workspaceID: remoteID, settings: cloudSettings) { path, method, body in
            await recorder.record(path, method: method, body: body)
            return .object(["id": .string("wrong-host-job")])
        }

        XCTAssertNil(result)
        XCTAssertEqual(model.drafts[remoteID]?.prompt, draft.prompt)
        let requests = await recorder.requests
        XCTAssertTrue(requests.isEmpty, "Source files must be captured and launched by their owning daemon")
    }

    @MainActor func testFailedCreationRetainsReviewedSourceAndDraftForRetry() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Do not lose this request"
        draft.source = cloudSource
        model.drafts["project"] = draft

        let result = await model.create(workspaceID: "project", settings: cloudSettings) { path, method, body in
            await recorder.record(path, method: method, body: body)
            throw PilotError("The worker could not start")
        }

        XCTAssertNil(result)
        XCTAssertEqual(model.drafts["project"]?.prompt, draft.prompt)
        XCTAssertEqual(model.drafts["project"]?.source, cloudSource)
        XCTAssertEqual(model.drafts["project"]?.idempotencyKey, draft.idempotencyKey)
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.path, ["api", "cloud", "jobs"])
        XCTAssertEqual(requests.first?.method, "POST")
        XCTAssertEqual(requests.first?.body?["source_capture_id"], .string("capture-1"))
    }

    @MainActor func testFailedFollowUpRetainsDraftAndUsesCloudJobRoute() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        model.followUps["cloud-job-1"] = "Keep the follow-up draft"

        await model.sendFollowUp(jobID: "cloud-job-1") { path, method, body in
            await recorder.record(path, method: method, body: body)
            throw PilotError("Worker unavailable")
        }

        XCTAssertEqual(model.followUps["cloud-job-1"], "Keep the follow-up draft")
        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.path, ["api", "cloud", "jobs", "cloud-job-1", "turns"])
        XCTAssertEqual(requests.first?.method, "POST")
        XCTAssertEqual(requests.first?.body?["inputs"].array.first?["text"], .string("Keep the follow-up draft"))
        XCTAssertFalse(requests.first?.body?["user_item_id"].string.isEmpty ?? true)
    }

    @MainActor func testFollowUpRetryReusesMessageIdentityUntilTextChanges() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        let failing: NativeCloudRequest = { path, method, body in
            await recorder.record(path, method: method, body: body)
            throw PilotError("Network response was lost")
        }
        model.followUps["job"] = "Continue checking"
        await model.sendFollowUp(jobID: "job", request: failing)
        await model.sendFollowUp(jobID: "job", request: failing)
        model.followUps["job"] = "Use this revised instruction"
        await model.sendFollowUp(jobID: "job", request: failing)

        let requests = await recorder.requests
        XCTAssertEqual(requests.count, 3)
        let identities = requests.map { $0.body?["user_item_id"].string ?? "" }
        XCTAssertFalse(identities[0].isEmpty)
        XCTAssertEqual(identities[0], identities[1], "An ambiguous retry must not duplicate the worker message")
        XCTAssertNotEqual(identities[1], identities[2], "A revised instruction is a new worker message")
        XCTAssertEqual(model.followUps["job"], "Use this revised instruction")
    }

    @MainActor func testAmbiguousLaunchKeepsTheReviewedSourceFrozen() async throws {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Start this captured request"
        draft.source = cloudSource
        draft.submittedPayload = try draft.payload(workspaceID: "project")
        model.drafts["project"] = draft

        await model.capture(workspaceID: "project") { path, method, body in
            await recorder.record(path, method: method, body: body)
            return cloudSource.setting("id", .string("replacement-capture"))
        }

        XCTAssertEqual(model.drafts["project"]?.source, cloudSource)
        XCTAssertEqual(model.drafts["project"]?.submittedPayload, draft.submittedPayload)
        let requests = await recorder.requests
        XCTAssertTrue(requests.isEmpty, "Changing a source capture cannot silently change an ambiguously submitted job")
    }

    @MainActor func testInteractiveResponseKeepsNativeRequestIDAndProviderOption() async throws {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        let interactive: JSON = .object(["request_id": .string("native-request-1"), "kind": .string("approval")])
        let response: JSON = .object(["kind": .string("approval_option"), "option_id": .string("allow-once-option")])

        try await model.respond(jobID: "cloud-job-1", interactive: interactive, response: response) { path, method, body in
            await recorder.record(path, method: method, body: body)
            return .object(["id": .string("cloud-job-1"), "status": .string("running")])
        }

        let requests = await recorder.requests
        let mutation = try XCTUnwrap(requests.first { $0.method == "POST" })
        XCTAssertEqual(mutation.path, ["api", "cloud", "jobs", "cloud-job-1", "interactive", "native-request-1"])
        XCTAssertEqual(mutation.body?["response"], response)
        XCTAssertNil(mutation.body?.fields["decision"], "Provider-specific approval choices must survive the generic response proxy")
    }

    @MainActor func testInteractiveResponseWithoutNativeRequestIDDoesNotSend() async {
        let model = NativeCloudModel()
        let recorder = CloudRequestRecorder()
        do {
            try await model.respond(jobID: "cloud-job-1", interactive: .object(["id": .string("wrong-field")]), response: .object(["kind": .string("approval"), "decision": .string("allow")])) { path, method, body in
                await recorder.record(path, method: method, body: body)
                return .object([:])
            }
            XCTFail("A response without its native request ID must fail before dispatch")
        } catch { }
        let requests = await recorder.requests
        XCTAssertTrue(requests.isEmpty)
    }

    @MainActor func testSuccessfulFollowUpClearsOnlyTheSubmittedJobDraft() async {
        let model = NativeCloudModel()
        model.followUps["cloud-job-1"] = "Continue"
        model.followUps["cloud-job-2"] = "Keep this draft"

        await model.sendFollowUp(jobID: "cloud-job-1") { path, _, _ in
            if path.last == "turns" { return .object(["ok": .bool(true)]) }
            return .object(["id": .string("cloud-job-1"), "status": .string("running")])
        }

        XCTAssertNil(model.followUps["cloud-job-1"])
        XCTAssertEqual(model.followUps["cloud-job-2"], "Keep this draft")
    }

    @MainActor func testSuccessfulCreationClearsOnlySubmittedWorkspaceDraft() async {
        let model = NativeCloudModel()
        var draft = NativeCloudTaskDraft()
        draft.prompt = "Start this request"
        draft.source = cloudSource
        model.drafts["project"] = draft
        var other = NativeCloudTaskDraft()
        other.prompt = "Keep the other project draft"
        model.drafts["other"] = other

        let result = await model.create(workspaceID: "project", settings: cloudSettings) { _, _, _ in
            .object(["id": .string("cloud-job-1"), "workspace_id": .string("project"), "status": .string("provisioning")])
        }

        XCTAssertEqual(result, "cloud-job-1")
        XCTAssertNil(model.drafts["project"])
        XCTAssertEqual(model.drafts["other"]?.prompt, other.prompt)
    }
}

private var cloudSettings: JSON {
    .object([
        "enabled": .bool(true), "has_provider_token": .bool(true), "has_openai_api_key": .bool(true),
        "team_id": .string("team_test"), "project_id": .string("prj_test"),
        "image": .string("registry.example.com/falcondeck/worker@sha256:" + String(repeating: "b", count: 64)), "timeout_minutes": .number(30),
        "node_binary": .string("node"), "runtime_path": .string("/opt/falcondeck/runtime.mjs"),
        "worker_daemon_url": .string("https://downloads.example.com/worker-linux"),
        "worker_daemon_sha256": .string(String(repeating: "a", count: 64)),
        "allowed_domains": .array([.string("api.openai.com")])
    ])
}

private var cloudSource: JSON {
    .object([
        "id": .string("capture-1"), "workspace_id": .string("project"),
        "tree_hash": .string("source-tree"), "included_paths": .array([.string("src/app.ts")]),
        "excluded_paths": .array([.string(".env"), .string("node_modules")]),
        "total_bytes": .number(120), "created_at": .string("2026-10-30T10:00:00Z")
    ])
}
