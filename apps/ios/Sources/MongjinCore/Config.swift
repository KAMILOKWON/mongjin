import Foundation

public enum GoalCells: String, Codable, Sendable {
    case fullRow = "full-row"
    case center3 = "center-3"
    case center1 = "center-1"
}

public enum PlacementRule: String, Codable, Sendable {
    case adjacent
    case ownHalf = "own-half"
}

public enum GuardMove: String, Codable, Sendable {
    case step
    case slide
}

public struct RuleConfig: Hashable, Codable, Sendable {
    public var boardSize: Int
    public var guardCount: Int
    public var goalCells: GoalCells
    public var placement: PlacementRule
    public var guardMove: GuardMove
    public var kingSurroundLoss: Bool
    /// 호위는 양쪽 목적지 칸에 착수/진입 불가
    public var noGuardOnGoal: Bool
    /// 호위가 상대 왕을 잡으면 즉시 승리
    public var kingCapture: Bool

    public init(
        boardSize: Int = 9,
        guardCount: Int = 8,
        goalCells: GoalCells = .center3,
        placement: PlacementRule = .adjacent,
        guardMove: GuardMove = .step,
        kingSurroundLoss: Bool = true,
        noGuardOnGoal: Bool = true,
        kingCapture: Bool = true
    ) {
        self.boardSize = boardSize
        self.guardCount = guardCount
        self.goalCells = goalCells
        self.placement = placement
        self.guardMove = guardMove
        self.kingSurroundLoss = kingSurroundLoss
        self.noGuardOnGoal = noGuardOnGoal
        self.kingCapture = kingCapture
    }

    public static let `default` = RuleConfig()
}

public enum AiDifficulty: String, Codable, CaseIterable, Sendable {
    case easy
    case normal
    case hard

    public var label: String {
        switch self {
        case .easy: return "쉬움"
        case .normal: return "보통"
        case .hard: return "어려움"
        }
    }

    public var description: String {
        switch self {
        case .easy: return "규칙에 맞는 기본 수를 차분히 둔다"
        case .normal: return "초보 전술과 기본 수비를 읽는다"
        case .hard: return "최선 수를 깊게 읽어 빈틈을 놓치지 않는다"
        }
    }

    public var options: AiOptions {
        switch self {
        case .easy:
            return AiOptions(maxDepth: 2, maxNodes: 700, choiceWindow: 80, planStrength: 0.85, strategyLevel: 1)
        case .normal:
            return AiOptions(maxDepth: 3, maxNodes: 2_800, choiceWindow: 28, planStrength: 1.1, strategyLevel: 2)
        case .hard:
            return AiOptions(maxDepth: 5, maxNodes: 18_000, choiceWindow: 2, planStrength: 1.7, strategyLevel: 3)
        }
    }
}

public struct AiOptions: Sendable {
    public var maxDepth: Int
    public var maxNodes: Int
    public var choiceWindow: Int
    public var planStrength: Double
    public var strategyLevel: Int

    public init(
        maxDepth: Int = 3,
        maxNodes: Int = 2_800,
        choiceWindow: Int = 28,
        planStrength: Double = 1.1,
        strategyLevel: Int = 2
    ) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.choiceWindow = choiceWindow
        self.planStrength = planStrength
        self.strategyLevel = strategyLevel
    }

    /// 고스트가 기보에서 벗어났을 때 쓰는 가벼운 응수
    public static let ghostFallback = AiOptions(
        maxDepth: 3,
        maxNodes: 1_800,
        choiceWindow: 12,
        planStrength: 1.2,
        strategyLevel: 2
    )
}
