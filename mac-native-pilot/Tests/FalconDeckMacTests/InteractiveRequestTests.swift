import XCTest
@testable import FalconDeckMac

final class InteractiveRequestTests: XCTestCase {
    func testMalformedQuestionsCannotSubmitAnInvalidResponse() {
        let empty: JSON = .object(["kind": .string("question"), "questions": .array([])])
        let question: JSON = .object(["id": .string("q"), "question": .string("Choose")])
        let duplicate = empty.setting("questions", .array([question, question]))
        XCTAssertNil(InteractiveQuestionResponse.payload(empty, answers: [:]))
        XCTAssertNil(InteractiveQuestionResponse.payload(duplicate, answers: ["q": "Yes"]))
        XCTAssertTrue(InteractiveQuestionResponse.definitionError(empty) != nil)
        XCTAssertTrue(InteractiveQuestionResponse.definitionError(duplicate) != nil)
    }

    func testQuestionPayloadIncludesOnlyOfferedIdentifiersAndRequiresEveryAnswer() {
        let request: JSON = .object(["questions": .array([
            .object(["id": .string("first")]), .object(["id": .string("second")])
        ])])
        XCTAssertNil(InteractiveQuestionResponse.payload(request, answers: ["first": "Yes"]))
        XCTAssertNil(InteractiveQuestionResponse.payload(request, answers: ["first": "Yes", "second": " \n"]))
        let response = InteractiveQuestionResponse.payload(request, answers: ["first": "Yes", "second": "Other answer", "stale": "Ignored"])
        XCTAssertEqual(response?["kind"], .string("question"))
        XCTAssertEqual(response?["answers"], .object(["first": .array([.string("Yes")]), "second": .array([.string("Other answer")])]))
    }
}
