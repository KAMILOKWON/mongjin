import Foundation

private let winScore = 10_000

public func moveWinsNow(_ state: GameState, _ move: Move, _ config: RuleConfig) -> Bool {
    let next = applyMove(state, move)
    return getResult(next, config)?.winner == state.turn
}

public func findWinningMove(_ state: GameState, _ moves: [Move], _ config: RuleConfig) -> Move? {
    moves.first { moveWinsNow(state, $0, config) }
}

public func allowsImmediateReplyWin(_ state: GameState, _ move: Move, _ config: RuleConfig) -> Bool {
    let next = childState(state, move)
    return findWinningMove(next, legalMoves(next, config), config) != nil
}

public func isCapture(_ state: GameState, _ move: Move) -> Bool {
    if case .move(_, let to) = move {
        return state.board[to.r][to.c] != nil
    }
    return false
}

public func sideMoves(from history: [Move], side: Player) -> [Move] {
    history.enumerated().compactMap { index, move in
        let mover: Player = index % 2 == 0 ? .black : .white
        return mover == side ? move : nil
    }
}
