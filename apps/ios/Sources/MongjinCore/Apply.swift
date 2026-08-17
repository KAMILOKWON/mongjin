import Foundation

/// 합법 수라고 가정하고 적용한다. 검증은 `legalMoves` 쪽 책임.
public func applyMove(_ state: GameState, _ move: Move) -> GameState {
    var board = state.board
    var guardsInHand = state.guardsInHand

    switch move {
    case .place(let to):
        board[to.r][to.c] = Piece(player: state.turn, type: .escort)
        guardsInHand[state.turn, default: 0] -= 1
    case .move(let from, let to):
        let piece = board[from.r][from.c]
        board[from.r][from.c] = nil
        board[to.r][to.c] = piece
    }

    var next = GameState(
        board: board,
        turn: state.turn.opponent,
        guardsInHand: guardsInHand,
        history: state.history + [move],
        positionCounts: state.positionCounts
    )
    let key = positionKey(next)
    next.positionCounts[key, default: 0] += 1
    return next
}

/// 탐색용: history·positionCounts를 비운 가벼운 자식 국면
public func childState(_ state: GameState, _ move: Move) -> GameState {
    var board = state.board
    var guardsInHand = state.guardsInHand
    switch move {
    case .place(let to):
        board[to.r][to.c] = Piece(player: state.turn, type: .escort)
        guardsInHand[state.turn, default: 0] -= 1
    case .move(let from, let to):
        let piece = board[from.r][from.c]
        board[from.r][from.c] = nil
        board[to.r][to.c] = piece
    }
    return GameState(
        board: board,
        turn: state.turn.opponent,
        guardsInHand: guardsInHand,
        history: [],
        positionCounts: [:]
    )
}
