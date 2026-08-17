import Foundation
import Observation
import SwiftUI

enum AppRoute: Hashable {
    case home
    case setupAI
    case match
    case game
    case tutorial
    case profile
}

@MainActor
@Observable
final class AppModel {
    var route: AppRoute = .home
    var session: GameSession?
    var profileName: String
    var toast: String?
    var lastImported: GhostTape?
    var matchStatus = ""
    var matchFoundName: String?

    let store: GhostStore
    var catalog: GhostCatalog
    private var matchTask: Task<Void, Never>?

    init(store: GhostStore = GhostStore()) {
        self.store = store
        self.catalog = store.snapshot()
        self.profileName = store.profile().name
    }

    var profile: PlayerCard { catalog.profile }

    func refresh() {
        catalog = store.snapshot()
        profileName = catalog.profile.name
    }

    func openTutorial() {
        session = GameSession(mode: .tutorial)
        route = .tutorial
    }

    func leaveTutorial() {
        session = nil
        route = .home
    }

    func openLocal() {
        session = GameSession(mode: .local)
        session?.start()
        route = .game
    }

    func openAI(difficulty: AiDifficulty, color: HumanColorChoice) {
        session = GameSession(mode: .ai(difficulty), humanColor: color)
        session?.start()
        route = .game
    }

    func openGhost(_ tape: GhostTape) {
        session = GameSession(mode: .ghost(tape))
        session?.start()
        route = .game
    }

    func startQuickMatch() {
        matchTask?.cancel()
        matchFoundName = nil
        matchStatus = ""
        matchTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            guard let tape = store.pickChallenge() else {
                toast = "대국할 상대를 찾지 못했어요"
                route = .home
                return
            }
            matchFoundName = tape.ownerName
            matchStatus = "\(tape.ownerName) 님과 대국해요 · \(tape.challengerSide.korean)"
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            openGhost(tape)
        }
    }

    func cancelMatch() {
        matchTask?.cancel()
        matchTask = nil
        matchFoundName = nil
        matchStatus = ""
        route = .home
    }

    func leaveGame() {
        if let session, let result = session.result, case .ghost(let tape) = session.mode {
            let recorded = session.makeGhostFromResult(
                ownerName: profile.name,
                ownerRating: profile.rating
            )
            store.recordMatch(
                won: result.winner == session.humanSide,
                opponentRating: tape.ownerRating,
                tape: recorded
            )
            refresh()
        }
        session = nil
        route = .home
    }

    func saveName() {
        let trimmed = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...12).contains(trimmed.count) else {
            toast = "닉네임은 2~12자로 적어 주세요"
            return
        }
        store.updateProfile { $0.name = trimmed }
        refresh()
        toast = "닉네임을 저장했어요"
    }

    func importGhost(from url: URL) {
        do {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            let tape = try store.importData(data)
            lastImported = tape
            refresh()
            toast = "\(tape.ownerName)의 고스트를 가져왔어요"
        } catch {
            toast = "고스트 파일을 읽을 수 없어요"
        }
    }

    func importGhost(from data: Data) {
        do {
            let tape = try store.importData(data)
            lastImported = tape
            refresh()
            toast = "\(tape.ownerName)의 고스트를 가져왔어요"
        } catch {
            toast = "고스트 데이터를 읽을 수 없어요"
        }
    }
}
