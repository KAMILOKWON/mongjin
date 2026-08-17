import Foundation
import MongjinCore

let easy = AiOptions(maxDepth: 2, maxNodes: 500, choiceWindow: 24, planStrength: 0.85, strategyLevel: 1)
let normal = AiOptions(maxDepth: 3, maxNodes: 1_600, choiceWindow: 8, planStrength: 1.1, strategyLevel: 2)

struct Spec {
    var name: String
    var rating: Int
    var side: Player
    var black: AiOptions
    var white: AiOptions
    var note: String
}

let specs = [
    Spec(name: "새벽", rating: 1180, side: .black, black: normal, white: easy, note: "선공으로 왕을 밀어 올린 기본 기보"),
    Spec(name: "이슬", rating: 1260, side: .white, black: easy, white: normal, note: "후공으로 호위를 붙여 막아 낸 기보"),
    Spec(name: "단풍", rating: 1340, side: .black, black: normal, white: normal, note: "서로 왕을 겨룬 균형 기보"),
]

var tapes: [GhostTape] = []
for spec in specs {
    var produced: GhostTape?
    for attempt in 1...4 {
        if let tape = SeedGhosts.generate(
            name: spec.name,
            rating: spec.rating,
            side: spec.side,
            black: spec.black,
            white: spec.white,
            note: spec.note
        ) {
            produced = tape
            FileHandle.standardError.write(
                Data("ok \(spec.name) attempt \(attempt) plies=\(tape.plyCount) moves=\(tape.moves.count) \(tape.result.label)\n".utf8)
            )
            break
        }
        FileHandle.standardError.write(Data("retry \(spec.name) attempt \(attempt)\n".utf8))
    }
    if let produced { tapes.append(produced) }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
encoder.dateEncodingStrategy = .iso8601
let data = try encoder.encode(tapes)
if let json = String(data: data, encoding: .utf8) {
    print(json)
}
