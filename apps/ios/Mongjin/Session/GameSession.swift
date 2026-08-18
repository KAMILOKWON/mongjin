import Foundation
import Observation

enum PlayMode: Equatable {
    case local
    case ai(AiDifficulty)
    case ghost(GhostTape)
    case tutorial
    case online(opponentName: String, opponentRating: Int, isBot: Bool)

    var title: String {
        switch self {
        case .local: return "같이 두기"
        case .ai(let difficulty): return "컴퓨터 · \(difficulty.label)"
        case .ghost(let tape): return tape.ownerName
        case .tutorial: return "튜토리얼"
        case .online(let name, _, _): return name
        }
    }
}

enum HumanColorChoice: String, CaseIterable, Identifiable {
    case black
    case white
    case random

    var id: String { rawValue }

    var label: String {
        switch self {
        case .black: return "흑 · 선공"
        case .white: return "백 · 후공"
        case .random: return "랜덤"
        }
    }

    func resolve() -> Player {
        switch self {
        case .black: return .black
        case .white: return .white
        case .random: return Bool.random() ? .black : .white
        }
    }
}

@MainActor
@Observable
final class GameSession {
    let config: RuleConfig
    private(set) var mode: PlayMode
    private(set) var state: GameState
    private(set) var result: GameResult?
    private(set) var selected: Coord?
    private(set) var lastMove: Move?
    private(set) var humanSide: Player
    private(set) var legal: [Move]
    private(set) var thinking = false
    private(set) var ghostNote: String?
    private(set) var lastGhostStyle: GhostStyle?
    private(set) var ghostFidelity: Double = 1
    private(set) var undoStack: [GameState] = []
    /// 빠른 대전에서 지금 수를 두어야 하는 시각. 내 차례가 아니면 nil.
    private(set) var moveDeadline: Date?
    private(set) var tutorialStep = 0
    private(set) var tutorialFinished = false
    private(set) var tutorialTitle = ""
    private(set) var tutorialCoach = ""
    private(set) var tutorialHint = ""
    private(set) var tutorialShowsGoals = false
    private var tutorialAllowed: [Move]?
    private var tutorialHintIdle = ""
    private var tutorialHintArmed = ""

    static let moveLimit: TimeInterval = 60

    private var ghost: GhostController?
    private var turnToken = 0
    var onOnlineMove: ((Move) -> Void)?

    init(mode: PlayMode, humanColor: HumanColorChoice = .black, config: RuleConfig = .default) {
        self.config = config
        self.mode = mode
        let start = initialState(config)
        self.state = start
        self.result = nil
        self.selected = nil
        self.lastMove = nil
        switch mode {
        case .ghost(let tape):
            self.humanSide = tape.challengerSide
            self.ghost = GhostController(tape: tape)
        case .local:
            self.humanSide = .black
        case .ai:
            self.humanSide = humanColor.resolve()
        case .tutorial:
            self.humanSide = .black
        case .online:
            self.humanSide = .black
        }
        self.legal = legalMoves(start, config)
        if mode == .tutorial {
            TutorialGuide.assertLessonsLegal(config: config)
            loadTutorialLesson(0)
        }
    }

    var isMyTurn: Bool {
        if result != nil { return false }
        switch mode {
        case .local, .tutorial:
            return true
        case .ai, .ghost, .online:
            return state.turn == humanSide && !thinking
        }
    }

    var canUndo: Bool {
        if isTutorial || isQuickMatch { return false }
        return !undoStack.isEmpty && !thinking && result == nil
    }

    var isQuickMatch: Bool {
        switch mode {
        case .ghost, .online: return true
        default: return false
        }
    }

    var isOnline: Bool {
        if case .online = mode { return true }
        return false
    }

    var isTutorial: Bool { mode == .tutorial }

    var canResign: Bool {
        isQuickMatch && result == nil
    }

    var canPlace: Bool {
        isMyTurn && (state.guardsInHand[state.turn] ?? 0) > 0
    }

    var turnLabel: String {
        if let result { return result.label }
        if thinking {
            switch mode {
            case .ghost, .online: return "상대가 두는 중"
            case .ai: return "컴퓨터가 생각하는 중"
            case .local, .tutorial: return "\(state.turn.korean) 차례"
            }
        }
        return "\(state.turn.korean) 차례"
    }

    func start() {
        if isTutorial { return }
        Task {
            await playOpponentIfNeeded()
            startMoveClockIfNeeded()
        }
    }

    func tap(_ coord: Coord) {
        guard isMyTurn, result == nil else { return }
        if isTutorial {
            tutorialTap(coord)
            return
        }
        let mine = legal.filter { candidate in
            switch candidate {
            case .place(let to):
                return to == coord
            case .move(let from, let to):
                return from == coord || to == coord
            }
        }

        if let selected {
            if let move = legal.first(where: { $0.from == selected && $0.to == coord }) {
                playHuman(move)
                return
            }
            if let piece = state.piece(at: coord), piece.player == state.turn {
                self.selected = coord
                refreshTutorialHint()
                return
            }
            if selected == coord {
                self.selected = nil
                refreshTutorialHint()
                return
            }
        }

        if let piece = state.piece(at: coord), piece.player == state.turn {
            selected = coord
            refreshTutorialHint()
            return
        }

        if selected == nil, let place = legal.first(where: { $0 == .place(to: coord) }) {
            playHuman(place)
            return
        }

        if mine.isEmpty {
            selected = nil
        }
    }

    private func tutorialTap(_ coord: Coord) {
        guard !tutorialFinished, let allowed = tutorialAllowed else { return }

        if let place = allowed.first(where: { $0 == .place(to: coord) }) {
            playHuman(place)
            return
        }

        if let selected,
           let move = allowed.first(where: { $0.from == selected && $0.to == coord }) {
            playHuman(move)
            return
        }

        if allowed.contains(where: { $0.from == coord }) {
            self.selected = coord
            refreshTutorialHint()
        }
    }

    /// 빠른 대전에서 사람이 나가거나 항복하면 상대 승리로 끝낸다.
    func resign() {
        guard canResign else { return }
        finishAsLoss(reason: .forfeit)
    }

    func undo() {
        guard canUndo, let previous = undoStack.popLast() else { return }
        state = previous
        selected = nil
        lastMove = state.history.last
        result = getResult(state, config)
        legal = legalMoves(state, config)
        ghostNote = nil
    }

    func highlights(for coord: Coord) -> CellHighlight {
        var highlight = CellHighlight()
        let showGoals = !isTutorial || tutorialShowsGoals
        if showGoals {
            highlight.isGoalBlack = isGoalCell(player: .black, coord: coord, config: config)
            highlight.isGoalWhite = isGoalCell(player: .white, coord: coord, config: config)
        }
        highlight.isSelected = selected == coord
        if let lastMove, !isTutorial {
            highlight.isLastMove = lastMove.to == coord || lastMove.from == coord
        }
        if isTutorial, !tutorialFinished, let pool = tutorialAllowed {
            for move in pool {
                if case .place(let to) = move, to == coord {
                    highlight.isHint = true
                    highlight.isPlace = true
                }
                if let from = move.from, from == coord, selected == nil || selected == from {
                    highlight.isHint = true
                }
                if let from = move.from, move.to == coord {
                    let occupied = state.piece(at: coord) != nil
                    if selected == from {
                        highlight.isHint = true
                        highlight.isTarget = true
                        highlight.isCapture = occupied
                    } else if selected == nil, !occupied {
                        highlight.isHint = true
                        highlight.isTarget = true
                    }
                }
            }
        } else if isMyTurn {
            if let selected, legal.contains(.move(from: selected, to: coord)) {
                highlight.isTarget = true
                highlight.isCapture = state.piece(at: coord) != nil
            } else if selected == nil, legal.contains(.place(to: coord)) {
                highlight.isPlace = true
            }
        }
        return highlight
    }

    func makeGhostFromResult(ownerName: String, ownerRating: Int) -> GhostTape? {
        guard let result else { return nil }
        return GhostTape.make(
            from: state,
            result: result,
            ownerName: ownerName,
            ownerRating: ownerRating,
            side: humanSide,
            source: .local,
            note: "빠른 대전에서 남긴 기보"
        )
    }

    private func playHuman(_ move: Move) {
        if isTutorial, let allowed = tutorialAllowed, !allowed.contains(move) {
            return
        }
        turnToken += 1
        moveDeadline = nil
        if isOnline {
            selected = nil
            thinking = true
            onOnlineMove?(move)
            return
        }
        undoStack.append(state)
        apply(move)
        selected = nil
        if isTutorial {
            advanceTutorial()
            return
        }
        Task {
            await playOpponentIfNeeded()
            startMoveClockIfNeeded()
        }
    }

    func bindOnlineSide(_ side: Player) {
        humanSide = side
    }

    func applyServerState(_ next: GameState) {
        state = next
        lastMove = next.history.last
        result = getResult(next, config)
        selected = nil
        thinking = next.turn != humanSide && result == nil
        refreshLegal()
    }

    func applyServerResult(winner: Player, reason: WinReason) {
        result = GameResult(winner: winner, reason: reason)
        thinking = false
        selected = nil
        legal = []
        moveDeadline = nil
    }

    private func loadTutorialLesson(_ index: Int) {
        tutorialStep = index
        tutorialFinished = false
        let lesson = TutorialGuide.lesson(index, config: config)
        state = lesson.state
        tutorialTitle = lesson.title
        tutorialCoach = lesson.coach
        tutorialHintIdle = lesson.hintIdle
        tutorialHintArmed = lesson.hintArmed
        tutorialAllowed = lesson.allowed
        tutorialShowsGoals = lesson.showGoals
        selected = nil
        lastMove = nil
        result = nil
        refreshLegal()
        refreshTutorialHint()
    }

    private func refreshTutorialHint() {
        guard isTutorial, !tutorialFinished else {
            tutorialHint = ""
            return
        }
        tutorialHint = selected == nil ? tutorialHintIdle : tutorialHintArmed
    }

    private func advanceTutorial() {
        if tutorialStep >= TutorialGuide.lastIndex {
            tutorialFinished = true
            tutorialAllowed = nil
            tutorialShowsGoals = true
            tutorialTitle = "이제 기본 규칙을 모두 익혔어요"
            tutorialCoach = "컴퓨터와 한 판 두면서 연습해 보세요."
            tutorialHint = ""
            return
        }
        loadTutorialLesson(tutorialStep + 1)
    }

    private func refreshLegal() {
        let all = result == nil ? legalMoves(state, config) : []
        if let allowed = tutorialAllowed {
            legal = all.filter { allowed.contains($0) }
        } else {
            legal = all
        }
    }

    private func startMoveClockIfNeeded() {
        guard case .ghost = mode, result == nil, state.turn == humanSide, !thinking else {
            moveDeadline = nil
            return
        }
        turnToken += 1
        let token = turnToken
        moveDeadline = Date().addingTimeInterval(Self.moveLimit)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(Self.moveLimit))
            guard token == turnToken, result == nil else { return }
            finishAsLoss(reason: .timeout)
        }
    }

    private func finishAsLoss(reason: WinReason) {
        turnToken += 1
        thinking = false
        selected = nil
        legal = []
        ghostNote = nil
        moveDeadline = nil
        result = GameResult(winner: humanSide.opponent, reason: reason)
    }

    private func apply(_ move: Move) {
        state = applyMove(state, move)
        lastMove = move
        result = getResult(state, config)
        if isTutorial, tutorialStep < TutorialGuide.lastIndex {
            result = nil
            state.turn = humanSide
        }
        refreshLegal()
        if case .ghost = mode, let ghost {
            ghostFidelity = ghost.fidelity
        }
    }

    private func playOpponentIfNeeded() async {
        guard result == nil else { return }
        switch mode {
        case .local, .tutorial, .online:
            return
        case .ai(let difficulty):
            guard state.turn != humanSide else { return }
            await playAI(options: difficulty.options)
        case .ghost:
            guard state.turn != humanSide else { return }
            await playGhost()
        }
    }

    private func playAI(options: AiOptions) async {
        turnToken += 1
        let token = turnToken
        thinking = true
        ghostNote = nil
        let snapshot = state
        let config = config
        let move = await Task.detached(priority: .userInitiated) {
            chooseMove(snapshot, config, options: options)
        }.value
        guard token == turnToken, result == nil, let move else {
            thinking = false
            return
        }
        try? await Task.sleep(for: .milliseconds(280))
        apply(move)
        thinking = false
        await playOpponentIfNeeded()
    }

    private func playGhost() async {
        guard var ghost else { return }
        turnToken += 1
        let token = turnToken
        thinking = true
        let snapshot = state
        let config = config
        let decision = await Task.detached(priority: .userInitiated) {
            var copy = ghost
            let picked = copy.choose(state: snapshot, config: config)
            return (copy, picked)
        }.value
        guard token == turnToken, result == nil, let picked = decision.1 else {
            thinking = false
            return
        }
        ghost = decision.0
        self.ghost = ghost
        lastGhostStyle = picked.style
        ghostNote = "\(mode.title) · \(picked.style.korean)"
        ghostFidelity = ghost.fidelity
        try? await Task.sleep(for: .milliseconds(picked.style == .recorded ? 420 : 560))
        apply(picked.move)
        thinking = false
        await playOpponentIfNeeded()
    }
}

struct CellHighlight {
    var isGoalBlack = false
    var isGoalWhite = false
    var isSelected = false
    var isLastMove = false
    var isTarget = false
    var isPlace = false
    var isCapture = false
    var isHint = false
}
