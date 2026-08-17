import Foundation

public struct PlayerCard: Codable, Sendable, Hashable {
    public var name: String
    public var rating: Int
    public var wins: Int
    public var losses: Int
    public var defenseGhostID: UUID?

    public init(
        name: String = "나그네",
        rating: Int = 1_200,
        wins: Int = 0,
        losses: Int = 0,
        defenseGhostID: UUID? = nil
    ) {
        self.name = name
        self.rating = rating
        self.wins = wins
        self.losses = losses
        self.defenseGhostID = defenseGhostID
    }

    public var winRate: Int {
        let total = wins + losses
        guard total > 0 else { return 0 }
        return Int((Double(wins) / Double(total) * 100).rounded())
    }
}

public struct GhostCatalog: Codable, Sendable {
    public var profile: PlayerCard
    public var tapes: [GhostTape]

    public init(profile: PlayerCard = PlayerCard(), tapes: [GhostTape] = []) {
        self.profile = profile
        self.tapes = tapes
    }

    public var defenseGhost: GhostTape? {
        guard let id = profile.defenseGhostID else { return tapes.last }
        return tapes.first { $0.id == id } ?? tapes.last
    }
}

public final class GhostStore: @unchecked Sendable {
    public static let defaultFileName = "mongjin-ghosts.json"

    private let url: URL
    private let lock = NSLock()
    private var catalog: GhostCatalog

    public init(url: URL? = nil) {
        let file = url ?? GhostStore.documentsURL()
        self.url = file
        if let data = try? Data(contentsOf: file),
           let decoded = try? GhostStore.decoder.decode(GhostCatalog.self, from: data) {
            self.catalog = decoded
        } else {
            self.catalog = GhostCatalog()
        }
        if catalog.tapes.isEmpty {
            catalog.tapes = SeedGhosts.builtIn
        }
        persist()
    }

    public func snapshot() -> GhostCatalog {
        lock.lock()
        defer { lock.unlock() }
        return catalog
    }

    public func profile() -> PlayerCard {
        snapshot().profile
    }

    public func allTapes() -> [GhostTape] {
        snapshot().tapes.sorted { $0.createdAt > $1.createdAt }
    }

    public func updateProfile(_ mutate: (inout PlayerCard) -> Void) {
        lock.lock()
        mutate(&catalog.profile)
        lock.unlock()
        persist()
    }

    @discardableResult
    public func add(_ tape: GhostTape, makeDefense: Bool = false) -> GhostTape {
        lock.lock()
        catalog.tapes.removeAll { $0.id == tape.id }
        catalog.tapes.append(tape)
        if makeDefense {
            catalog.profile.defenseGhostID = tape.id
        }
        lock.unlock()
        persist()
        return tape
    }

    public func importData(_ data: Data) throws -> GhostTape {
        var tape = try GhostCodec.decode(data)
        tape.source = .imported
        tape.id = UUID()
        return add(tape)
    }

    public func recordMatch(won: Bool, opponentRating: Int, tape: GhostTape?) {
        lock.lock()
        if won {
            catalog.profile.wins += 1
        } else {
            catalog.profile.losses += 1
        }
        catalog.profile.rating = Elo.next(
            rating: catalog.profile.rating,
            opponent: opponentRating,
            score: won ? 1 : 0
        )
        if let tape {
            catalog.tapes.removeAll { $0.id == tape.id }
            catalog.tapes.append(tape)
            catalog.profile.defenseGhostID = tape.id
        }
        lock.unlock()
        persist()
    }

    public func pickChallenge(excludingID: UUID? = nil) -> GhostTape? {
        let tapes = allTapes().filter { $0.id != excludingID }
        guard !tapes.isEmpty else { return nil }
        let rating = profile().rating
        return tapes.min { a, b in
            abs(a.ownerRating - rating) < abs(b.ownerRating - rating)
        }
    }

    private func persist() {
        lock.lock()
        let value = catalog
        lock.unlock()
        guard let data = try? GhostStore.encoder.encode(value) else { return }
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url, options: .atomic)
    }

    private static func documentsURL() -> URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent(defaultFileName)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
