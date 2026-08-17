import XCTest
@testable import MongjinCore

final class GhostTests: XCTestCase {
    let config = RuleConfig.default

    func testGhostPlaysRecordedMove() {
        let tape = GhostTape(
            ownerName: "시험",
            ownerRating: 1200,
            side: .white,
            moves: [.place(to: Coord(r: 1, c: 4))],
            result: GameResult(winner: .white, reason: .goal),
            plyCount: 2,
            source: .seed
        )
        var ghost = GhostController(tape: tape)
        var state = initialState(config)
        state = applyMove(state, .place(to: Coord(r: 7, c: 4)))
        let decision = ghost.choose(state: state, config: config)
        XCTAssertEqual(decision?.style, .recorded)
        XCTAssertEqual(decision?.move, .place(to: Coord(r: 1, c: 4)))
    }

    func testGhostAdaptsWhenRecordedMoveIsIllegal() {
        let tape = GhostTape(
            ownerName: "시험",
            ownerRating: 1200,
            side: .white,
            moves: [.place(to: Coord(r: 2, c: 4))],
            result: GameResult(winner: .white, reason: .goal),
            plyCount: 2,
            source: .seed
        )
        var ghost = GhostController(tape: tape)
        var state = initialState(config)
        state = applyMove(state, .place(to: Coord(r: 7, c: 4)))
        let decision = ghost.choose(state: state, config: config)
        XCTAssertEqual(decision?.style, .adapted)
        XCTAssertTrue(decision?.move.isPlace ?? false)
        if case .place(let to) = decision?.move {
            XCTAssertTrue(legalMoves(state, config).contains(.place(to: to)))
        }
    }

    func testGhostImprovisesAfterBookEnds() {
        let tape = GhostTape(
            ownerName: "시험",
            ownerRating: 1200,
            side: .white,
            moves: [],
            result: GameResult(winner: .white, reason: .goal),
            plyCount: 0,
            source: .seed
        )
        var ghost = GhostController(tape: tape)
        var state = initialState(config)
        state = applyMove(state, .place(to: Coord(r: 7, c: 4)))
        let decision = ghost.choose(state: state, config: config)
        XCTAssertEqual(decision?.style, .improvised)
        XCTAssertNotNil(decision?.move)
    }

    func testSideMovesExtractsOwnerPlies() {
        let history: [Move] = [
            .place(to: Coord(r: 7, c: 4)),
            .place(to: Coord(r: 1, c: 4)),
            .place(to: Coord(r: 7, c: 3)),
            .place(to: Coord(r: 1, c: 3)),
        ]
        XCTAssertEqual(sideMoves(from: history, side: .black).count, 2)
        XCTAssertEqual(sideMoves(from: history, side: .white).first, .place(to: Coord(r: 1, c: 4)))
    }

    func testEloMovesTowardWinner() {
        let next = Elo.next(rating: 1200, opponent: 1200, score: 1)
        XCTAssertGreaterThan(next, 1200)
        let down = Elo.next(rating: 1200, opponent: 1200, score: 0)
        XCTAssertLessThan(down, 1200)
    }
}
