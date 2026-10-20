import Foundation
import XCTest
@testable import FalconDeckMac

final class TransportTests: XCTestCase {
    func testListenerDiscoveryOnlyUsesNamedDaemonLoopbackSockets() {
        let output = """
        p1
        cnode
        n127.0.0.1:9999
        p2
        cfalcondeck-desktop
        n127.0.0.1:49572
        n127.0.0.1:49572
        n*:7000
        n192.168.1.2:7001
        p3
        cfalcondeck-daemon
        n[::1]:4123
        p4
        cFalconDeckMac
        n127.0.0.1:7002
        """
        XCTAssertEqual(DaemonClient.listenerCandidates(from: output).map(\.absoluteString), ["http://127.0.0.1:49572", "http://[::1]:4123"])
    }

    func testEndpointRejectsRemoteOrAmbiguousAddresses() throws {
        for text in ["https://127.0.0.1:4123", "http://example.com:4123", "http://fixture-user@localhost:4123", "http://localhost:4123/api", "http://localhost:4123?token=x", "http://localhost:4123#fragment"] {
            XCTAssertThrowsError(try DaemonClient.validateEndpoint(URL(string: text)!), text)
        }
        XCTAssertEqual(try DaemonClient.validateEndpoint(URL(string: "http://localhost:4123/")!).absoluteString, "http://localhost:4123")
    }

    func testPathIdentifiersAndHistoryCursorAreEncodedAsData() {
        let url = DaemonClient.apiURL(base: URL(string: "http://127.0.0.1:4123")!, path: ["api", "workspaces", "project/a", "threads", "thread?#"], query: [URLQueryItem(name: "before_item_id", value: "item&x=1")])
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath, "/api/workspaces/project%2Fa/threads/thread%3F%23")
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "item&x=1")
    }

    func testSendPreservesThreadPermissionsAndClientMessageIdentity() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder, result: .object(["ok": .bool(true)]))
        let result = try await client.sendTurn(projectID: "project", threadID: "thread", text: "Hello, 👋", userItemID: "user-123")
        XCTAssertTrue(result["ok"].bool)
        let request = try XCTUnwrap(recorder.requests.last)
        XCTAssertEqual(request.url?.path, "/api/workspaces/project/threads/thread/turns")
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSON.decode(try XCTUnwrap(request.httpBody))
        XCTAssertEqual(body["inputs"].array.first?["text"].string, "Hello, 👋")
        XCTAssertEqual(body["user_item_id"].string, "user-123")
        for field in ["sandbox_mode", "permission_mode", "approval_policy", "model_id", "service_tier"] { XCTAssertEqual(body[field], .null, field) }
    }

    func testHistoryUsesPagedTailWithoutInlineImages() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder, result: .object(["items": .array([])]))
        _ = try await client.threadDetail(projectID: "project", threadID: "thread", before: "older&id")
        let request = try XCTUnwrap(recorder.requests.last)
        let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["mode"], "before")
        XCTAssertEqual(query["before_item_id"], "older&id")
        XCTAssertEqual(query["inline_images"], "false")
        XCTAssertEqual(query["compact_workspace"], "true")
        XCTAssertEqual(query["strict_limit"], "true")
    }

    func testDaemonMutationErrorsReachCallerWithoutRetry() async throws {
        let recorder = RequestRecorder()
        let client = makeClient(recorder: recorder, result: .object(["error": .string("This thread is unavailable.")]), status: 409)
        do {
            _ = try await client.sendTurn(projectID: "project", threadID: "thread", text: "Hello")
            XCTFail("Expected the mutation to fail")
        } catch {
            XCTAssertEqual(error.localizedDescription, "This thread is unavailable.")
        }
        XCTAssertEqual(recorder.requests.filter { $0.httpMethod == "POST" }.count, 1)
    }

    private func makeClient(recorder: RequestRecorder, result: JSON, status: Int = 200) -> DaemonClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        // Each client uses a different port so parallel tests route independently.
        let port = StubURLProtocol.install { request in
            recorder.record(request)
            if request.url?.path == "/api/health" {
                return (200, try JSON.object(["ok": .bool(true), "version": .string("test"), "workspaces": .number(1)]).data())
            }
            return (status, try result.data())
        }
        return DaemonClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!, session: URLSession(configuration: configuration))
    }
}

private final class RequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { storage } }
    func record(_ request: URLRequest) {
        var captured = request
        // URLSession moves upload bodies into a stream before URLProtocol.
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            captured.httpBody = data
        }
        lock.withLock { storage.append(captured) }
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)
    private static let lock = NSLock()
    private static var handlers: [Int: Handler] = [:]
    private static var nextPort = 20000

    static func install(_ handler: @escaping Handler) -> Int {
        lock.withLock {
            nextPort += 1
            handlers[nextPort] = handler
            return nextPort
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let handler = Self.lock.withLock { Self.handlers[request.url?.port ?? 0] }
            guard let handler else { throw PilotError("Missing request fixture.") }
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
