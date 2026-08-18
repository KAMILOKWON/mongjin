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
final class AppModel: OnlineClientDelegate {
    var route: AppRoute = .home
    var session: GameSession?
    var profileName: String
    var toast: String?
    var lastImported: GhostTape?
    var matchStatus = ""
    var matchFoundName: String?
    var onlineProfile: OnlinePlayerProfile?

    let store: GhostStore
    var catalog: GhostCatalog
    let online = OnlineClient()
    private var matchTask: Task<Void, Never>?
    private var matchGeneration = 0
    private var awaitingOnlineMatch = false

    init(store: GhostStore = GhostStore()) {
        self.store = store
        self.catalog = store.snapshot()
        self.profileName = store.profile().name
        online.delegate = self
    }

    var profile: PlayerCard {
        if let remote = onlineProfile {
            var card = catalog.profile
            card.name = remote.name
            card.rating = remote.rating
            card.wins = remote.wins
            card.losses = remote.losses
            return card
        }
        return catalog.profile
    }

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
        awaitingOnlineMatch = true
        matchGeneration += 1
        let generation = matchGeneration
        matchTask = Task { @MainActor in
            do {
                try await online.connect()
                guard generation == matchGeneration, awaitingOnlineMatch else { return }
                let name = store.profile().name
                if (2...12).contains(name.count) {
                    online.updateProfile(name: name)
                }
                online.startMatchmaking()
            } catch {
                if generation == matchGeneration, awaitingOnlineMatch {
                    fallbackToGhost()
                    return
                }
            }
            try? await Task.sleep(for: .seconds(15))
            guard generation == matchGeneration, awaitingOnlineMatch else { return }
            fallbackToGhost()
        }
    }

    private func fallbackToGhost() {
        awaitingOnlineMatch = false
        online.cancelMatchmaking()
        online.disconnect()
        guard let tape = store.pickChallenge() else {
            toast = "대국할 상대를 찾지 못했어요"
            route = .home
            return
        }
        matchFoundName = tape.ownerName
        matchStatus = "\(tape.ownerName) 님과 대국해요 · \(tape.challengerSide.korean)"
        matchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            openGhost(tape)
        }
    }

    func cancelMatch() {
        matchGeneration += 1
        matchTask?.cancel()
        matchTask = nil
        awaitingOnlineMatch = false
        online.cancelMatchmaking()
        online.disconnect()
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
        if let session, case .online = session.mode {
            online.disconnect()
        }
        session = nil
        route = .home
    }

    func openOnline(opponent: OnlineOpponent, side: Player) {
        let game = GameSession(
            mode: .online(
                opponentName: opponent.name,
                opponentRating: opponent.rating,
                isBot: opponent.isBot
            )
        )
        game.bindOnlineSide(side)
        game.onOnlineMove = { [weak self] move in
            self?.online.sendMove(move)
        }
        session = game
        route = .game
    }

    func onlineDidReceiveState(_ state: GameState) {
        session?.applyServerState(state)
    }

    func onlineDidJoin(roomId: String, side: Player) {
        session?.bindOnlineSide(side)
    }

    func onlineDidFindMatch(roomId: String, side: Player, opponent: OnlineOpponent) {
        guard awaitingOnlineMatch else { return }
        awaitingOnlineMatch = false
        matchTask?.cancel()
        matchFoundName = opponent.name
        matchStatus = opponent.isBot
            ? "\(opponent.name)와 대국해요 · \(side.korean)"
            : "\(opponent.name) 님과 매칭됐어요 · \(side.korean)"
        matchTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(800))
            guard !Task.isCancelled else { return }
            openOnline(opponent: opponent, side: side)
        }
    }

    func onlineDidFinish(winner: Player, reason: WinReason) {
        session?.applyServerResult(winner: winner, reason: reason)
    }

    func onlineDidReceiveProfile(_ profile: OnlinePlayerProfile) {
        onlineProfile = profile
    }

    func onlineOpponentLeft() {
        toast = "상대가 연결을 끊었습니다"
        leaveGame()
    }

    func onlineDidFail(_ message: String) {
        if awaitingOnlineMatch {
            toast = message
        }
    }

    func onlineStatus(_ message: String) {
        if route == .match, matchFoundName == nil {
            matchStatus = message
        }
    }

    func onlineDidLogOut(_ message: String) {
        onlineProfile = nil
        toast = message
    }

    func saveName() {
        let trimmed = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2...12).contains(trimmed.count) else {
            toast = "닉네임은 2~12자로 적어 주세요"
            return
        }
        store.updateProfile { $0.name = trimmed }
        refresh()
        if online.connected {
            online.updateProfile(name: trimmed)
        }
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
