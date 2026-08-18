import Foundation

struct OnlinePlayerProfile: Sendable {
    var playerId: String
    var name: String
    var wins: Int
    var losses: Int
    var winRate: Int
    var rating: Int
    var rank: Int
    var totalPlayers: Int
}

struct OnlineOpponent: Sendable {
    var name: String
    var rating: Int
    var isBot: Bool
}

struct StoredOnlineIdentity: Codable, Sendable {
    var playerId: String
    var token: String
}

@MainActor
protocol OnlineClientDelegate: AnyObject {
    func onlineDidReceiveState(_ state: GameState)
    func onlineDidJoin(roomId: String, side: Player)
    func onlineDidFindMatch(roomId: String, side: Player, opponent: OnlineOpponent)
    func onlineDidFinish(winner: Player, reason: WinReason)
    func onlineDidReceiveProfile(_ profile: OnlinePlayerProfile)
    func onlineOpponentLeft()
    func onlineDidFail(_ message: String)
    func onlineStatus(_ message: String)
    func onlineDidLogOut(_ message: String)
}

@MainActor
final class OnlineClient: NSObject {
    static let identityKey = "mongjin.online.identity.v1"
    private static let connectTimeout: TimeInterval = 45
    private static let connectRetries = 3

    weak var delegate: OnlineClientDelegate?

    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var connectionVersion = 0
    private(set) var connected = false
    private(set) var roomId: String?
    private(set) var mySide: Player?
    private(set) var queued = false
    private var receiveLoopActive = false

    #if DEBUG
    private let url = URL(string: "ws://localhost:3001")!
    #else
    private let url = URL(string: "wss://mongjin-api.onrender.com")!
    #endif

    func loadIdentity() -> StoredOnlineIdentity? {
        guard let data = UserDefaults.standard.data(forKey: Self.identityKey) else { return nil }
        return try? JSONDecoder().decode(StoredOnlineIdentity.self, from: data)
    }

    func saveIdentity(_ identity: StoredOnlineIdentity) {
        if let data = try? JSONEncoder().encode(identity) {
            UserDefaults.standard.set(data, forKey: Self.identityKey)
        }
    }

    func clearIdentity() {
        UserDefaults.standard.removeObject(forKey: Self.identityKey)
    }

    func connect() async throws {
        if connected { return }
        connectionVersion += 1
        let version = connectionVersion
        var lastError: Error = URLError(.cannotConnectToHost)
        for attempt in 1...Self.connectRetries {
            guard version == connectionVersion else { throw CancellationError() }
            delegate?.onlineStatus(attempt > 1 ? "서버 연결 재시도 (\(attempt)/\(Self.connectRetries))…" : "서버 연결 중…")
            do {
                try await openOnce()
                return
            } catch {
                lastError = error
                task?.cancel(with: .goingAway, reason: nil)
                task = nil
                connected = false
                if attempt < Self.connectRetries {
                    try await Task.sleep(for: .milliseconds(Int(1500 * attempt)))
                }
            }
        }
        delegate?.onlineDidFail("온라인 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.")
        throw lastError
    }

    func disconnect() {
        connectionVersion += 1
        receiveLoopActive = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
        roomId = nil
        mySide = nil
        queued = false
    }

    func startMatchmaking() {
        queued = true
        delegate?.onlineStatus("랜덤 상대를 찾는 중…")
        send(["type": "MATCHMAKE"])
    }

    func cancelMatchmaking() {
        if connected { send(["type": "CANCEL_MATCHMAKING"]) }
        queued = false
    }

    func updateProfile(name: String) {
        send(["type": "UPDATE_PROFILE", "name": name])
    }

    func sendMove(_ move: Move) {
        guard let data = try? JSONEncoder().encode(move),
              let object = try? JSONSerialization.jsonObject(with: data) else { return }
        send(["type": "MOVE", "move": object])
    }

    private func openOnce() async throws {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = Self.connectTimeout
        let session = URLSession(configuration: config)
        self.session = session
        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()
        connected = true
        var hello: [String: Any] = ["type": "HELLO"]
        if let identity = loadIdentity() {
            hello["playerId"] = identity.playerId
            hello["token"] = identity.token
        }
        send(hello)
        delegate?.onlineStatus("서버에 연결됨")
        receiveLoopActive = true
        startReceiveLoop()
    }

    private func startReceiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.receiveLoopActive else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.startReceiveLoop()
                case .failure:
                    self.connected = false
                    self.roomId = nil
                    self.mySide = nil
                    self.queued = false
                    self.delegate?.onlineStatus("연결 끊김")
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            data = Data(text.utf8)
        case .data(let value):
            data = value
        @unknown default:
            return
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            delegate?.onlineDidFail("서버 응답을 읽을 수 없습니다")
            return
        }
        switch type {
        case "IDENTITY":
            if let playerId = object["playerId"] as? String, let token = object["token"] as? String {
                saveIdentity(StoredOnlineIdentity(playerId: playerId, token: token))
            }
            if let profile = parseProfile(object["profile"]) {
                delegate?.onlineDidReceiveProfile(profile)
            }
        case "PROFILE":
            if let profile = parseProfile(object["profile"]) {
                delegate?.onlineDidReceiveProfile(profile)
            }
        case "CREATED", "JOINED":
            queued = false
            roomId = object["roomId"] as? String
            mySide = parsePlayer(object["side"])
            if let roomId, let mySide {
                delegate?.onlineDidJoin(roomId: roomId, side: mySide)
            }
            if let state = parseState(object["state"]) {
                delegate?.onlineDidReceiveState(state)
            }
        case "MATCH_FOUND":
            queued = false
            roomId = object["roomId"] as? String
            mySide = parsePlayer(object["side"])
            let opp = object["opponent"] as? [String: Any]
            let opponent = OnlineOpponent(
                name: opp?["name"] as? String ?? "상대",
                rating: opp?["rating"] as? Int ?? 1200,
                isBot: opp?["isBot"] as? Bool ?? false
            )
            if let roomId, let mySide {
                delegate?.onlineDidFindMatch(roomId: roomId, side: mySide, opponent: opponent)
            }
            if let state = parseState(object["state"]) {
                delegate?.onlineDidReceiveState(state)
            }
        case "MATCH_RESULT":
            if let profile = parseProfile(object["profile"]) {
                delegate?.onlineDidReceiveProfile(profile)
            }
            if let winner = parsePlayer(object["winner"]) {
                let reason = parseReason(object["reason"] as? String)
                delegate?.onlineDidFinish(winner: winner, reason: reason)
            }
        case "QUEUE_LEFT":
            queued = false
            delegate?.onlineStatus("랜덤 매칭을 취소했어요")
        case "STATE":
            if let state = parseState(object["state"]) {
                delegate?.onlineDidReceiveState(state)
            }
        case "OPPONENT_LEFT":
            delegate?.onlineOpponentLeft()
        case "LOGGED_OUT", "UNLINKED":
            clearIdentity()
            roomId = nil
            mySide = nil
            queued = false
            let message = object["message"] as? String ?? (type == "UNLINKED"
                ? "토스 연결이 해제되어 다시 로그인해야 해요"
                : "로그아웃되었어요")
            delegate?.onlineDidLogOut(message)
        case "ERROR":
            queued = false
            delegate?.onlineDidFail(object["message"] as? String ?? "오류가 발생했어요")
        default:
            break
        }
    }

    private func send(_ payload: [String: Any]) {
        guard connected, let task else {
            delegate?.onlineDidFail("서버에 연결되어 있지 않습니다")
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func parsePlayer(_ raw: Any?) -> Player? {
        guard let value = raw as? String else { return nil }
        return Player(rawValue: value)
    }

    private func parseReason(_ raw: String?) -> WinReason {
        WinReason(rawValue: raw ?? "forfeit") ?? .forfeit
    }

    private func parseState(_ raw: Any?) -> GameState? {
        guard let raw,
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(GameState.self, from: data)
    }

    private func parseProfile(_ raw: Any?) -> OnlinePlayerProfile? {
        guard let obj = raw as? [String: Any] else { return nil }
        return OnlinePlayerProfile(
            playerId: obj["playerId"] as? String ?? "",
            name: obj["name"] as? String ?? "나그네",
            wins: obj["wins"] as? Int ?? 0,
            losses: obj["losses"] as? Int ?? 0,
            winRate: obj["winRate"] as? Int ?? 0,
            rating: obj["rating"] as? Int ?? 1200,
            rank: obj["rank"] as? Int ?? 0,
            totalPlayers: obj["totalPlayers"] as? Int ?? 0
        )
    }
}
