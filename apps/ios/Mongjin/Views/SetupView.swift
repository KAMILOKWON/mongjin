import SwiftUI

struct SetupView: View {
    @Environment(AppModel.self) private var model
    @State private var difficulty: AiDifficulty = .normal
    @State private var color: HumanColorChoice = .black

    var body: some View {
        VStack(spacing: 0) {
            ScreenNav(title: "컴퓨터 대전", onBack: { model.route = .home })
            VStack(alignment: .leading, spacing: 22) {
                Text("대국을 준비하세요")
                    .font(Typeface.display(24))

                field("봇 난이도") {
                    HStack(spacing: 8) {
                        ForEach(AiDifficulty.allCases, id: \.self) { item in
                            choice(item.label, active: difficulty == item) {
                                difficulty = item
                            }
                        }
                    }
                    Text(difficulty.description)
                        .font(Typeface.body(13))
                        .foregroundStyle(Palette.inkSoft)
                }

                field("내 색") {
                    HStack(spacing: 8) {
                        ForEach(HumanColorChoice.allCases) { item in
                            choice(item.label, active: color == item) {
                                color = item
                            }
                        }
                    }
                }

                Spacer()
                Button("대국 시작") {
                    model.openAI(difficulty: difficulty, color: color)
                }
                .buttonStyle(PrimaryButtonStyle())
            }
            .padding(20)
        }
        .background(Palette.panel.ignoresSafeArea())
    }

    private func field(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(Typeface.title(13))
                .foregroundStyle(Palette.inkSoft)
            content()
        }
    }

    private func choice(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Typeface.body(13))
                .foregroundStyle(active ? Palette.panel : Palette.ink)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(active ? Palette.blue : Palette.surface, in: Capsule())
                .overlay(Capsule().stroke(active ? Palette.blue : Palette.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
