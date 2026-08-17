import Foundation

public enum GhostSource: String, Codable, Sendable {
    case seed
    case local
    case imported
}

public struct GhostTape: Identifiable, Codable, Sendable, Hashable {
    public var id: UUID
    public var ownerName: String
    public var ownerRating: Int
    /// 원래 플레이어가 둔 진영. 도전자는 반대 색을 잡는다.
    public var side: Player
    /// 그 진영의 수만 시간순으로 기록한다.
    public var moves: [Move]
    public var result: GameResult
    public var plyCount: Int
    public var createdAt: Date
    public var source: GhostSource
    public var note: String

    public init(
        id: UUID = UUID(),
        ownerName: String,
        ownerRating: Int,
        side: Player,
        moves: [Move],
        result: GameResult,
        plyCount: Int,
        createdAt: Date = Date(),
        source: GhostSource,
        note: String = ""
    ) {
        self.id = id
        self.ownerName = ownerName
        self.ownerRating = ownerRating
        self.side = side
        self.moves = moves
        self.result = result
        self.plyCount = plyCount
        self.createdAt = createdAt
        self.source = source
        self.note = note
    }

    public var challengerSide: Player { side.opponent }

    public var subtitle: String {
        let outcome = result.winner == side ? "승리 기보" : "패배 기보"
        return "\(side.korean) · \(outcome) · \(moves.count)수"
    }

    public static func make(
        from state: GameState,
        result: GameResult,
        ownerName: String,
        ownerRating: Int,
        side: Player,
        source: GhostSource,
        note: String = ""
    ) -> GhostTape {
        GhostTape(
            ownerName: ownerName,
            ownerRating: ownerRating,
            side: side,
            moves: sideMoves(from: state.history, side: side),
            result: result,
            plyCount: state.history.count,
            source: source,
            note: note
        )
    }
}

public struct GhostSharePayload: Codable, Sendable {
    public var version: Int
    public var tape: GhostTape

    public init(tape: GhostTape) {
        self.version = 1
        self.tape = tape
    }
}

public enum GhostCodec {
    public static func encode(_ tape: GhostTape) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(GhostSharePayload(tape: tape))
    }

    public static func decode(_ data: Data) throws -> GhostTape {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let payload = try? decoder.decode(GhostSharePayload.self, from: data) {
            var tape = payload.tape
            tape.source = .imported
            tape.id = UUID()
            return tape
        }
        var tape = try decoder.decode(GhostTape.self, from: data)
        tape.source = .imported
        tape.id = UUID()
        return tape
    }
}

public enum Elo {
    public static func expected(rating: Int, opponent: Int) -> Double {
        1.0 / (1.0 + pow(10.0, Double(opponent - rating) / 400.0))
    }

    public static func next(rating: Int, opponent: Int, score: Double, k: Double = 24) -> Int {
        let change = k * (score - expected(rating: rating, opponent: opponent))
        return max(100, rating + Int(change.rounded()))
    }
}
