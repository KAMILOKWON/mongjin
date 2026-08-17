import Foundation

public enum SeedGhosts {
    /// 앱 첫 실행용 기본 고스트. 실제 자기대국 기보다.
    public static let builtIn: [GhostTape] = makeBuiltIn()

    public static func generate(
        name: String,
        rating: Int,
        side: Player,
        black: AiOptions,
        white: AiOptions,
        note: String
    ) -> GhostTape? {
        let played = playSelfGame(black: black, white: white)
        guard let result = played.result else { return nil }
        return GhostTape.make(
            from: played.state,
            result: result,
            ownerName: name,
            ownerRating: rating,
            side: side,
            source: .seed,
            note: note
        )
    }

    private static func makeBuiltIn() -> [GhostTape] {
        if let baked = bakedSeeds(), !baked.isEmpty { return baked }
        return liveSeeds()
    }

    /// 빌드에 심어 둔 확정 기보. 없으면 얕은 AI로 즉석 생성한다.
    private static func bakedSeeds() -> [GhostTape]? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let data = bakedJSON.data(using: .utf8),
              let tapes = try? decoder.decode([GhostTape].self, from: data),
              !tapes.isEmpty else { return nil }
        return tapes
    }

    private static func liveSeeds() -> [GhostTape] {
        let easy = AiOptions(maxDepth: 2, maxNodes: 400, choiceWindow: 40, planStrength: 0.8, strategyLevel: 1)
        let normal = AiOptions(maxDepth: 2, maxNodes: 700, choiceWindow: 16, planStrength: 1.0, strategyLevel: 2)
        var tapes: [GhostTape] = []
        if let a = generate(
            name: "새벽",
            rating: 1_180,
            side: .black,
            black: normal,
            white: easy,
            note: "선공으로 왕을 밀어 올린 기본 기보"
        ) { tapes.append(a) }
        if let b = generate(
            name: "이슬",
            rating: 1_260,
            side: .white,
            black: easy,
            white: normal,
            note: "후공으로 호위를 붙여 막아 낸 기보"
        ) { tapes.append(b) }
        if let c = generate(
            name: "단풍",
            rating: 1_340,
            side: .black,
            black: normal,
            white: normal,
            note: "서로 왕을 겨룬 균형 기보"
        ) { tapes.append(c) }
        return tapes
    }

    /// `swift run mongjin-seed`로 채운다. 비어 있으면 liveSeeds가 대신 돈다.
    static let bakedJSON = #"""
[
  {
    "createdAt" : "2026-08-17T04:25:26Z",
    "id" : "469EF43E-B23A-4724-B6CD-65747D1749D1",
    "moves" : [
      {
        "from" : {
          "c" : 4,
          "r" : 8
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 4,
          "r" : 7
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 4,
          "r" : 6
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 6
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 6
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 5
        }
      },
      {
        "from" : {
          "c" : 2,
          "r" : 5
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 4
        }
      },
      {
        "from" : {
          "c" : 2,
          "r" : 4
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 3
        }
      },
      {
        "from" : {
          "c" : 2,
          "r" : 3
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 1,
          "r" : 2
        }
      },
      {
        "from" : {
          "c" : 1,
          "r" : 2
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 1
        }
      },
      {
        "from" : {
          "c" : 2,
          "r" : 1
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 0
        }
      }
    ],
    "note" : "선공으로 왕을 밀어 올린 기본 기보",
    "ownerName" : "새벽",
    "ownerRating" : 1180,
    "plyCount" : 17,
    "result" : {
      "reason" : "goal",
      "winner" : "BLACK"
    },
    "side" : "BLACK",
    "source" : "seed"
  },
  {
    "createdAt" : "2026-08-17T04:25:31Z",
    "id" : "294A3433-277D-4187-A14C-F6A82406132A",
    "moves" : [
      {
        "from" : {
          "c" : 4,
          "r" : 0
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 1
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 1
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 2
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 2
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 4,
          "r" : 3
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 3
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 5,
          "r" : 4
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 6,
          "r" : 4
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 6,
          "r" : 3
        }
      },
      {
        "from" : {
          "c" : 5,
          "r" : 4
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 4,
          "r" : 5
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 5
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 4,
          "r" : 6
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 6
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 5,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 5,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 5,
          "r" : 8
        }
      }
    ],
    "note" : "후공으로 호위를 붙여 막아 낸 기보",
    "ownerName" : "이슬",
    "ownerRating" : 1260,
    "plyCount" : 20,
    "result" : {
      "reason" : "goal",
      "winner" : "WHITE"
    },
    "side" : "WHITE",
    "source" : "seed"
  },
  {
    "createdAt" : "2026-08-17T04:25:44Z",
    "id" : "3FA39A5C-3C9F-46FC-933F-85452F559397",
    "moves" : [
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 4,
          "r" : 7
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 5,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 5,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 6,
          "r" : 7
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 5,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 8
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 4,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 4,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 6
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 6
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 5
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 5
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 3,
          "r" : 4
        }
      },
      {
        "from" : {
          "c" : 3,
          "r" : 4
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 2,
          "r" : 3
        }
      },
      {
        "kind" : "PLACE",
        "to" : {
          "c" : 1,
          "r" : 7
        }
      },
      {
        "from" : {
          "c" : 1,
          "r" : 7
        },
        "kind" : "MOVE",
        "to" : {
          "c" : 1,
          "r" : 8
        }
      }
    ],
    "note" : "서로 왕을 겨룬 균형 기보",
    "ownerName" : "단풍",
    "ownerRating" : 1340,
    "plyCount" : 25,
    "result" : {
      "reason" : "capture",
      "winner" : "BLACK"
    },
    "side" : "BLACK",
    "source" : "seed"
  }
]
"""#
}
