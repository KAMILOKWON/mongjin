import Foundation

struct TutorialLesson {
    var title: String
    var coach: String
    var hintIdle: String
    var hintArmed: String
    var state: GameState
    var allowed: [Move]
    /// 목적지 세 칸을 칸 색으로 보여줄지. 초반 레슨에서는 꺼 두어 "파란 칸"과 헷갈리지 않게 한다.
    var showGoals: Bool
}

enum TutorialGuide {
    static let lastIndex = 4

    static func assertLessonsLegal(config: RuleConfig = .default) {
        for index in 0...lastIndex {
            let lesson = lesson(index, config: config)
            let legal = legalMoves(lesson.state, config)
            for move in lesson.allowed {
                precondition(
                    legal.contains(move),
                    "튜토리얼 \(index)의 수 \(move.signature)가 불갑니다"
                )
            }
        }
    }

    static func lesson(_ index: Int, config: RuleConfig) -> TutorialLesson {
        switch index {
        case 0:
            return TutorialLesson(
                title: "호위를 놓아 볼까요?",
                coach: "흑부터 시작해요. 검은 왕 바로 위에 파랗게 깜빡이는 칸이 보이죠? 그 칸을 눌러 호위를 놓아 보세요.",
                hintIdle: "파란 칸을 눌러 호위를 놓아 보세요",
                hintArmed: "파란 칸을 눌러 호위를 놓아 보세요",
                state: initialState(config),
                allowed: [.place(to: Coord(r: 7, c: 4))],
                showGoals: false
            )
        case 1:
            var state = initialState(config)
            state = applyMove(state, .place(to: Coord(r: 7, c: 4)))
            state.turn = .black
            return TutorialLesson(
                title: "왕을 움직여 볼까요?",
                coach: "한 번에 한 가지 행동만 할 수 있어요. 파랗게 빛나는 왕을 누른 다음, 옆의 파란 칸으로 옮겨 보세요.",
                hintIdle: "파란 왕을 먼저 눌러 보세요",
                hintArmed: "파란 칸을 눌러 왕을 옮겨 보세요",
                state: state,
                allowed: [.move(from: Coord(r: 8, c: 4), to: Coord(r: 7, c: 3))],
                showGoals: false
            )
        case 2:
            return TutorialLesson(
                title: "호위로 잡아 볼까요?",
                coach: "호위는 위, 아래, 왼쪽, 오른쪽으로 한 칸씩 움직여요. 상대 호위가 있는 칸으로 이동하면 잡을 수 있어요. 파란 호위를 눌러 흰 호위를 잡아 보세요.",
                hintIdle: "파란 호위를 먼저 눌러 보세요",
                hintArmed: "흰 호위를 눌러 잡아 보세요",
                state: makeBoard(
                    config: config,
                    pieces: [
                        (8, 4, .black, .king),
                        (6, 4, .black, .escort),
                        (0, 4, .white, .king),
                        (5, 4, .white, .escort),
                    ],
                    blackHand: 7,
                    whiteHand: 7
                ),
                allowed: [.move(from: Coord(r: 6, c: 4), to: Coord(r: 5, c: 4))],
                showGoals: false
            )
        case 3:
            return TutorialLesson(
                title: "왕을 잡으면 끝나요",
                coach: "호위는 위쪽 가운데 세 칸(목적지)에는 들어갈 수 없어요. 하지만 그 칸에 왕이 있으면 잡을 수 있어요. 왕을 잡으면 대국이 끝나요. 파란 호위로 흰 왕을 잡아 보세요.",
                hintIdle: "파란 호위를 먼저 눌러 보세요",
                hintArmed: "흰 왕을 눌러 잡아 보세요",
                state: makeBoard(
                    config: config,
                    pieces: [
                        (8, 4, .black, .king),
                        (1, 4, .black, .escort),
                        (0, 4, .white, .king),
                    ],
                    blackHand: 7,
                    whiteHand: 8
                ),
                allowed: [.move(from: Coord(r: 1, c: 4), to: Coord(r: 0, c: 4))],
                showGoals: true
            )
        default:
            return TutorialLesson(
                title: "목적지로 가 볼까요?",
                coach: "색이 다른 위쪽 가운데 세 칸이 목적지예요. 왕을 그중 한 칸으로 옮기면 이겨요. 파란 왕을 눌러 파란 목적지 칸으로 옮겨 보세요.",
                hintIdle: "파란 왕을 먼저 눌러 보세요",
                hintArmed: "파란 목적지 칸을 눌러 보세요",
                state: makeBoard(
                    config: config,
                    pieces: [
                        (1, 3, .black, .king),
                        (0, 4, .white, .king),
                    ],
                    blackHand: 8,
                    whiteHand: 8
                ),
                allowed: [.move(from: Coord(r: 1, c: 3), to: Coord(r: 0, c: 3))],
                showGoals: true
            )
        }
    }

    private static func makeBoard(
        config: RuleConfig,
        pieces: [(Int, Int, Player, PieceType)],
        blackHand: Int,
        whiteHand: Int
    ) -> GameState {
        let n = config.boardSize
        var board: [[Piece?]] = Array(repeating: Array(repeating: nil, count: n), count: n)
        for (r, c, player, type) in pieces {
            board[r][c] = Piece(player: player, type: type)
        }
        var state = GameState(
            board: board,
            turn: .black,
            guardsInHand: [.black: blackHand, .white: whiteHand],
            history: [],
            positionCounts: [:]
        )
        state.positionCounts[positionKey(state)] = 1
        return state
    }
}
