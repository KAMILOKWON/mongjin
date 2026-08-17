import Foundation

@MainActor
final class ProfileStore {
    let ghosts: GhostStore

    init(ghosts: GhostStore) {
        self.ghosts = ghosts
    }

    var card: PlayerCard { ghosts.profile() }

    func rename(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...12).contains(trimmed.count) else { return }
        ghosts.updateProfile { $0.name = trimmed }
    }
}
