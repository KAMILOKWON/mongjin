import Foundation

private let winScore = 10_000
private let blockedDist = 30

private final class SearchContext {
    let config: RuleConfig
    let nodeLimit: Int
    let strategyLevel: Int
    var nodes = 0
    var aborted = false
    var tt: [String: (depth: Int, score: Int, move: Move?)] = [:]

    init(config: RuleConfig, nodeLimit: Int, strategyLevel: Int) {
        self.config = config
        self.nodeLimit = nodeLimit
        self.strategyLevel = strategyLevel
    }

    func tick() -> Bool {
        nodes += 1
        if nodes >= nodeLimit {
            aborted = true
            return true
        }
        return false
    }
}

private func buildDangerMask(_ state: GameState, player: Player, config: RuleConfig) -> [UInt8] {
    let n = state.size
    var danger = [UInt8](repeating: 0, count: n * n)
    guard config.kingCapture else { return danger }
    for r in 0..<n {
        for c in 0..<n {
            guard let piece = state.board[r][c],
                  piece.player != player,
                  piece.type == .escort else { continue }
            for (dr, dc) in ortho {
                let nr = r + dr
                let nc = c + dc
                if inBoard(n, nr, nc) {
                    danger[nr * n + nc] = 1
                }
            }
        }
    }
    return danger
}

private func bfsKingDist(_ state: GameState, player: Player, config: RuleConfig) -> Int {
    let n = state.size
    guard let king = findKing(in: state, player: player) else { return blockedDist + 15 }
    let goals = Set(goalCells(for: player, config: config))
    if goals.contains(king) { return 0 }

    let danger = buildDangerMask(state, player: player, config: config)
    var dist = [Int](repeating: -1, count: n * n)
    var queue = [king.r * n + king.c]
    dist[queue[0]] = 0
    var qi = 0
    while qi < queue.count {
        let cur = queue[qi]
        qi += 1
        let r = cur / n
        let c = cur % n
        let d = dist[cur]
        for (dr, dc) in all8 {
            let nr = r + dr
            let nc = c + dc
            guard inBoard(n, nr, nc) else { continue }
            let idx = nr * n + nc
            if dist[idx] != -1 || state.board[nr][nc] != nil { continue }
            let next = Coord(r: nr, c: nc)
            if goals.contains(next) { return d + 1 }
            if danger[idx] == 1 { continue }
            dist[idx] = d + 1
            queue.append(idx)
        }
    }
    return blockedDist
}

private func kingThreatened(_ state: GameState, player: Player) -> Bool {
    guard let king = findKing(in: state, player: player) else { return false }
    let n = state.size
    for (dr, dc) in ortho {
        let r = king.r + dr
        let c = king.c + dc
        guard inBoard(n, r, c), let piece = state.board[r][c] else { continue }
        if piece.player != player && piece.type == .escort { return true }
    }
    return false
}

private func escortCount(_ state: GameState, player: Player) -> Int {
    guard let king = findKing(in: state, player: player) else { return 0 }
    let n = state.size
    var count = 0
    for (dr, dc) in all8 {
        let r = king.r + dr
        let c = king.c + dc
        guard inBoard(n, r, c), let piece = state.board[r][c] else { continue }
        if piece.player == player && piece.type == .escort { count += 1 }
    }
    return count
}

private func forwardProgress(player: Player, king: Coord?, n: Int) -> Int {
    guard let king else { return 0 }
    return player == .black ? n - 1 - king.r : king.r
}

private func safeKingMoves(_ state: GameState, king: Coord?, danger: [UInt8]) -> Int {
    guard let king else { return 0 }
    let n = state.size
    var count = 0
    for (dr, dc) in all8 {
        let r = king.r + dr
        let c = king.c + dc
        guard inBoard(n, r, c), state.board[r][c] == nil, danger[r * n + c] == 0 else { continue }
        count += 1
    }
    return count
}

private func evaluate(_ state: GameState, _ config: RuleConfig, strategyLevel: Int) -> Int {
    let me = state.turn
    let opp = me.opponent
    let myKing = findKing(in: state, player: me)
    let oppKing = findKing(in: state, player: opp)
    let myD = bfsKingDist(state, player: me, config: config)
    let oppD = bfsKingDist(state, player: opp, config: config)

    var myTotal = state.guardsInHand[me] ?? 0
    var oppTotal = state.guardsInHand[opp] ?? 0
    for row in state.board {
        for piece in row {
            guard let piece, piece.type == .escort else { continue }
            if piece.player == me { myTotal += 1 } else { oppTotal += 1 }
        }
    }

    var score = 7 * (myTotal - oppTotal)
    score += 2 * ((state.guardsInHand[me] ?? 0) - (state.guardsInHand[opp] ?? 0))

    if config.kingCapture {
        if kingThreatened(state, player: opp) { score += 5_000 }
        if kingThreatened(state, player: me) { score -= 220 }
        score += 5 * (min(escortCount(state, player: me), 3) - min(escortCount(state, player: opp), 3))
    }

    if strategyLevel >= 2 {
        let myDanger = buildDangerMask(state, player: me, config: config)
        let oppDanger = buildDangerMask(state, player: opp, config: config)
        score += 12 * (safeKingMoves(state, king: myKing, danger: myDanger)
            - safeKingMoves(state, king: oppKing, danger: oppDanger))
    }

    let routeCap = state.size + 3
    let myRoute = min(myD, routeCap)
    let oppRoute = min(oppD, routeCap)
    score += 52 * (oppRoute - myRoute)
    score += 14 * (routeCap - myRoute)
    score -= 10 * (routeCap - oppRoute)
    score += 64 * (forwardProgress(player: me, king: myKing, n: state.size)
        - forwardProgress(player: opp, king: oppKing, n: state.size))

    return max(-winScore + 100, min(winScore - 100, score))
}

private func orderMoves(_ state: GameState, _ moves: [Move], _ config: RuleConfig) -> [Move] {
    let me = state.turn
    let oppKing = findKing(in: state, player: me.opponent)
    let myKing = findKing(in: state, player: me)
    let goalR = goalRow(player: me, n: state.size)
    let myEsc = escortCount(state, player: me)

    return moves.sorted { a, b in
        scoreMove(state, a, config, oppKing, myKing, goalR, myEsc)
            > scoreMove(state, b, config, oppKing, myKing, goalR, myEsc)
    }
}

private func scoreMove(
    _ state: GameState,
    _ move: Move,
    _ config: RuleConfig,
    _ oppKing: Coord?,
    _ myKing: Coord?,
    _ goalR: Int,
    _ myEsc: Int
) -> Int {
    switch move {
    case .move(let from, let to):
        var s = 0
        if let target = state.board[to.r][to.c] {
            s += target.type == .king ? 10_000 : 500
        }
        if let piece = state.board[from.r][from.c], piece.type == .king {
            let closer = abs(from.r - goalR) - abs(to.r - goalR)
            s += closer > 0 ? closer * 30 : closer * 5
            if isGoalCell(player: state.turn, coord: to, config: config) { s += 10_000 }
        } else if let oppKing {
            s += 8 - oppKing.chebyshev(to: to)
        }
        return s
    case .place(let to):
        var s = 0
        if let oppKing { s += 8 - oppKing.chebyshev(to: to) }
        let adjOpp = oppKing.map { $0.chebyshev(to: to) <= 1 } ?? false
        let adjMe = myKing.map { $0.chebyshev(to: to) <= 1 } ?? false
        s += (adjOpp || (adjMe && myEsc < 2)) ? 5 : -25
        return s
    }
}

private func terminalWinner(_ state: GameState, _ config: RuleConfig) -> Player? {
    for player in Player.allCases {
        guard let king = findKing(in: state, player: player) else { return player.opponent }
        if isGoalCell(player: player, coord: king, config: config) { return player }
        if config.kingSurroundLoss {
            let n = state.size
            let surrounded = ortho.allSatisfy { dr, dc in
                let r = king.r + dr
                let c = king.c + dc
                if !inBoard(n, r, c) { return true }
                if let piece = state.board[r][c] { return piece.player != player }
                return false
            }
            if surrounded { return player.opponent }
        }
    }
    return nil
}

private func negamax(
    _ state: GameState,
    _ ctx: SearchContext,
    depth: Int,
    alpha: Int,
    beta: Int
) -> Int {
    if ctx.tick() {
        return evaluate(state, ctx.config, strategyLevel: ctx.strategyLevel)
    }
    if let winner = terminalWinner(state, ctx.config) {
        return winner == state.turn ? winScore + depth : -(winScore + depth)
    }
    if depth <= 0 {
        return evaluate(state, ctx.config, strategyLevel: ctx.strategyLevel)
    }

    let key = positionKey(state)
    if let hit = ctx.tt[key], hit.depth >= depth {
        return hit.score
    }

    var moves = legalMoves(state, ctx.config)
    if moves.isEmpty { return -(winScore + depth) }
    moves = orderMoves(state, moves, ctx.config)

    var best = Int.min / 4
    var bestMove: Move?
    var a = alpha
    for move in moves {
        let value = -negamax(childState(state, move), ctx, depth: depth - 1, alpha: -beta, beta: -a)
        if ctx.aborted { break }
        if value > best {
            best = value
            bestMove = move
        }
        if value > a { a = value }
        if a >= beta { break }
    }
    if !ctx.aborted {
        ctx.tt[key] = (depth, best, bestMove)
    }
    return best
}

public func chooseMove(
    _ state: GameState,
    _ config: RuleConfig,
    options: AiOptions = AiOptions()
) -> Move? {
    let legal = legalMoves(state, config)
    guard !legal.isEmpty else { return nil }

    if let instant = findWinningMove(state, legal, config) {
        return instant
    }

    let safe = legal.filter { !allowsImmediateReplyWin(state, $0, config) }
    var moves = orderMoves(state, safe.isEmpty ? legal : safe, config)

    let ctx = SearchContext(
        config: config,
        nodeLimit: options.maxNodes,
        strategyLevel: options.strategyLevel
    )

    var best = moves[0]
    var bestScore = Int.min / 4

    for depth in 1...options.maxDepth {
        if ctx.aborted { break }
        var depthBest = best
        var depthScore = Int.min / 4
        var complete = true
        moves = orderMoves(state, moves, config)
        for move in moves {
            let value = -negamax(childState(state, move), ctx, depth: depth - 1, alpha: Int.min / 4, beta: Int.max / 4)
            if ctx.aborted {
                complete = false
                break
            }
            if value > depthScore {
                depthScore = value
                depthBest = move
            }
        }
        if complete {
            best = depthBest
            bestScore = depthScore
            moves = [best] + moves.filter { $0 != best }
            if bestScore >= winScore { break }
        }
    }

    if options.choiceWindow > 0, moves.count > 1 {
        let window = moves.prefix(min(4, moves.count))
        return window.randomElement() ?? best
    }
    return best
}

public func playSelfGame(
    config: RuleConfig = .default,
    black: AiOptions,
    white: AiOptions,
    maxPlies: Int = 160
) -> (state: GameState, result: GameResult?) {
    var state = initialState(config)
    for _ in 0..<maxPlies {
        if let result = getResult(state, config) {
            return (state, result)
        }
        let options = state.turn == .black ? black : white
        guard let move = chooseMove(state, config, options: options) else { break }
        state = applyMove(state, move)
    }
    return (state, getResult(state, config))
}
