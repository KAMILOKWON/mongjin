import XCTest
@testable import MongjinCore

final class EngineTests: XCTestCase {
    let config = RuleConfig.default

    func testInitialKings() {
        let state = initialState(config)
        XCTAssertEqual(findKing(in: state, player: .black), Coord(r: 8, c: 4))
        XCTAssertEqual(findKing(in: state, player: .white), Coord(r: 0, c: 4))
        XCTAssertEqual(state.guardsInHand[.black], 8)
        XCTAssertEqual(state.turn, .black)
    }

    func testCannotPlaceOnGoal() {
        let state = initialState(config)
        let legal = legalMoves(state, config)
        XCTAssertTrue(legal.contains(.place(to: Coord(r: 7, c: 4))))
        XCTAssertFalse(legal.contains(.place(to: Coord(r: 8, c: 3))))
        XCTAssertFalse(legal.contains(.place(to: Coord(r: 8, c: 5))))
        XCTAssertFalse(legal.contains(.place(to: Coord(r: 0, c: 4))))
    }

    func testPlaceConsumesGuard() {
        var state = initialState(config)
        state = applyMove(state, .place(to: Coord(r: 7, c: 4)))
        XCTAssertEqual(state.guardsInHand[.black], 7)
        XCTAssertEqual(state.board[7][4]?.type, .escort)
        XCTAssertEqual(state.turn, .white)
    }

    func testKingReachingGoalWins() {
        var state = initialState(config)
        state.board[8][4] = nil
        state.board[0][3] = Piece(player: .black, type: .king)
        let result = getResult(state, config)
        XCTAssertEqual(result?.winner, .black)
        XCTAssertEqual(result?.reason, .goal)
    }

    func testGuardCannotEnterEmptyGoal() {
        var state = initialState(config)
        state.board[0][4] = nil
        state.board[1][4] = Piece(player: .black, type: .escort)
        state.turn = .black
        XCTAssertFalse(isLegal(.move(from: Coord(r: 1, c: 4), to: Coord(r: 0, c: 4)), in: state, config: config))
        XCTAssertFalse(isLegal(.move(from: Coord(r: 1, c: 4), to: Coord(r: 0, c: 3)), in: state, config: config))
    }

    func testCapturingKingOnGoalIsAllowed() {
        var state = initialState(config)
        state.board[1][4] = Piece(player: .black, type: .escort)
        state.turn = .black
        let move = Move.move(from: Coord(r: 1, c: 4), to: Coord(r: 0, c: 4))
        XCTAssertTrue(isLegal(move, in: state, config: config))
        state = applyMove(state, move)
        let result = getResult(state, config)
        XCTAssertEqual(result?.winner, .black)
        XCTAssertEqual(result?.reason, .capture)
    }

    func testCapturingKingOffGoalWins() {
        var state = initialState(config)
        state.board[0][4] = nil
        state.board[2][4] = Piece(player: .white, type: .king)
        state.board[3][4] = Piece(player: .black, type: .escort)
        state.turn = .black
        let move = Move.move(from: Coord(r: 3, c: 4), to: Coord(r: 2, c: 4))
        XCTAssertTrue(isLegal(move, in: state, config: config))
        state = applyMove(state, move)
        let result = getResult(state, config)
        XCTAssertEqual(result?.winner, .black)
        XCTAssertEqual(result?.reason, .capture)
    }

    func testSurroundLoss() {
        var state = initialState(config)
        state.board[0][3] = Piece(player: .black, type: .escort)
        state.board[0][5] = Piece(player: .black, type: .escort)
        state.board[1][4] = Piece(player: .black, type: .escort)
        let result = getResult(state, config)
        XCTAssertEqual(result?.winner, .black)
        XCTAssertEqual(result?.reason, .surround)
    }

    func testAIFindsImmediateWin() {
        var state = initialState(config)
        state.board[1][4] = Piece(player: .black, type: .escort)
        state.turn = .black
        let move = chooseMove(state, config, options: .ghostFallback)
        XCTAssertEqual(move, .move(from: Coord(r: 1, c: 4), to: Coord(r: 0, c: 4)))
    }

    func testMoveCodecRoundTrip() throws {
        let moves: [Move] = [
            .place(to: Coord(r: 7, c: 4)),
            .move(from: Coord(r: 8, c: 4), to: Coord(r: 7, c: 3)),
        ]
        let data = try JSONEncoder().encode(moves)
        let decoded = try JSONDecoder().decode([Move].self, from: data)
        XCTAssertEqual(decoded, moves)
        let text = String(data: data, encoding: .utf8) ?? ""
        XCTAssertTrue(text.contains("PLACE"))
        XCTAssertTrue(text.contains("MOVE"))
    }

    func testForfeitResultCodec() throws {
        let result = GameResult(winner: .white, reason: .forfeit)
        let data = try JSONEncoder().encode(result)
        let decoded = try JSONDecoder().decode(GameResult.self, from: data)
        XCTAssertEqual(decoded.winner, .white)
        XCTAssertEqual(decoded.reason, .forfeit)
        XCTAssertEqual(decoded.reason.korean, "상대가 항복함")
    }

    func testTimeoutResultCodec() throws {
        let result = GameResult(winner: .black, reason: .timeout)
        let data = try JSONEncoder().encode(result)
        let decoded = try JSONDecoder().decode(GameResult.self, from: data)
        XCTAssertEqual(decoded.reason, .timeout)
        XCTAssertEqual(decoded.reason.korean, "상대가 시간 초과")
    }
}
