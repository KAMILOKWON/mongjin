import Foundation

public enum Player: String, Codable, CaseIterable, Sendable {
    case black = "BLACK"
    case white = "WHITE"

    public var opponent: Player { self == .black ? .white : .black }

    public var korean: String { self == .black ? "흑" : "백" }
}

public enum PieceType: String, Codable, Sendable {
    case king = "KING"
    case escort = "GUARD"
}

public struct Piece: Hashable, Codable, Sendable {
    public var player: Player
    public var type: PieceType

    public init(player: Player, type: PieceType) {
        self.player = player
        self.type = type
    }
}

public struct Coord: Hashable, Codable, Sendable {
    public var r: Int
    public var c: Int

    public init(r: Int, c: Int) {
        self.r = r
        self.c = c
    }

    public func manhattan(to other: Coord) -> Int {
        abs(r - other.r) + abs(c - other.c)
    }

    public func chebyshev(to other: Coord) -> Int {
        max(abs(r - other.r), abs(c - other.c))
    }
}

public enum Move: Hashable, Sendable {
    case place(to: Coord)
    case move(from: Coord, to: Coord)

    public var to: Coord {
        switch self {
        case .place(let to), .move(_, let to):
            return to
        }
    }

    public var from: Coord? {
        if case .move(let from, _) = self { return from }
        return nil
    }

    public var isPlace: Bool {
        if case .place = self { return true }
        return false
    }

    public var signature: String {
        switch self {
        case .place(let to):
            return "P:\(to.r),\(to.c)"
        case .move(let from, let to):
            return "M:\(from.r),\(from.c)>\(to.r),\(to.c)"
        }
    }
}

extension Move: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, from, to
    }

    private enum Kind: String, Codable {
        case place = "PLACE"
        case move = "MOVE"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .kind)
        switch kind {
        case .place:
            self = .place(to: try container.decode(Coord.self, forKey: .to))
        case .move:
            self = .move(
                from: try container.decode(Coord.self, forKey: .from),
                to: try container.decode(Coord.self, forKey: .to)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .place(let to):
            try container.encode(Kind.place, forKey: .kind)
            try container.encode(to, forKey: .to)
        case .move(let from, let to):
            try container.encode(Kind.move, forKey: .kind)
            try container.encode(from, forKey: .from)
            try container.encode(to, forKey: .to)
        }
    }
}

public struct GameState: Sendable {
    public var board: [[Piece?]]
    public var turn: Player
    public var guardsInHand: [Player: Int]
    public var history: [Move]
    public var positionCounts: [String: Int]

    public init(
        board: [[Piece?]],
        turn: Player,
        guardsInHand: [Player: Int],
        history: [Move] = [],
        positionCounts: [String: Int] = [:]
    ) {
        self.board = board
        self.turn = turn
        self.guardsInHand = guardsInHand
        self.history = history
        self.positionCounts = positionCounts
    }

    public var size: Int { board.count }

    public func piece(at coord: Coord) -> Piece? {
        guard coord.r >= 0, coord.r < size, coord.c >= 0, coord.c < size else { return nil }
        return board[coord.r][coord.c]
    }
}

extension GameState: Codable {
    private enum CodingKeys: String, CodingKey {
        case board, turn, guardsInHand, history, positionCounts
    }

    private struct HandDTO: Codable {
        var BLACK: Int
        var WHITE: Int
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        board = try container.decode([[Piece?]].self, forKey: .board)
        turn = try container.decode(Player.self, forKey: .turn)
        let hand = try container.decode(HandDTO.self, forKey: .guardsInHand)
        guardsInHand = [.black: hand.BLACK, .white: hand.WHITE]
        history = try container.decodeIfPresent([Move].self, forKey: .history) ?? []
        positionCounts = try container.decodeIfPresent([String: Int].self, forKey: .positionCounts) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(board, forKey: .board)
        try container.encode(turn, forKey: .turn)
        try container.encode(
            HandDTO(BLACK: guardsInHand[.black] ?? 0, WHITE: guardsInHand[.white] ?? 0),
            forKey: .guardsInHand
        )
        try container.encode(history, forKey: .history)
        try container.encode(positionCounts, forKey: .positionCounts)
    }
}
