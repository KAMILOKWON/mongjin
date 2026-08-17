import SwiftUI

struct TutorialView: View {
    @Environment(AppModel.self) private var model

    private let blockGap: CGFloat = 16

    var body: some View {
        if let session = model.session, session.isTutorial {
            VStack(spacing: 0) {
                ScreenNav(title: "튜토리얼", onBack: { model.leaveTutorial() })

                coachCard(session)
                    .padding(.horizontal, 16)

                Spacer(minLength: blockGap)

                BoardView(session: session, ghostSide: nil, showsCoordinates: false)
                    .padding(.horizontal, 16)
                    .layoutPriority(1)
                    .allowsHitTesting(!session.tutorialFinished)

                progressDots(session)
                    .padding(.top, 10)

                Spacer(minLength: blockGap)

                TutorialFooter(
                    session: session,
                    onPractice: { model.openAI(difficulty: .easy, color: .black) },
                    onHome: { model.leaveTutorial() }
                )
            }
            .background(Palette.panel.ignoresSafeArea())
        } else {
            Color.clear.onAppear { model.openTutorial() }
        }
    }

    private func coachCard(_ session: GameSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.tutorialTitle)
                    .font(.system(size: 18, weight: .heavy))
                    .tracking(-0.3)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: 8)
                Text("\(min(session.tutorialStep + 1, TutorialGuide.lastIndex + 1)) / \(TutorialGuide.lastIndex + 1)")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.inkSoft)
            }
            Text(session.tutorialCoach)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Palette.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Palette.line, lineWidth: 1)
        )
    }

    private func progressDots(_ session: GameSession) -> some View {
        HStack(spacing: 6) {
            ForEach(0...TutorialGuide.lastIndex, id: \.self) { index in
                Capsule()
                    .fill(index <= session.tutorialStep ? Palette.blue : Palette.line)
                    .frame(width: index == session.tutorialStep ? 18 : 7, height: 7)
            }
        }
    }
}

private struct TutorialFooter: View {
    let session: GameSession
    let onPractice: () -> Void
    let onHome: () -> Void

    var body: some View {
        Group {
            if session.tutorialFinished {
                VStack(spacing: 10) {
                    Label("규칙을 모두 익혔어요", systemImage: "checkmark.circle.fill")
                        .font(Typeface.title(17))
                        .foregroundStyle(Palette.ink)

                    Text(session.tutorialCoach)
                        .font(Typeface.body(14))
                        .foregroundStyle(Palette.inkSoft)
                        .multilineTextAlignment(.center)

                    Button("컴퓨터로 연습하기", action: onPractice)
                        .buttonStyle(PrimaryButtonStyle())
                    Button("홈으로", action: onHome)
                        .buttonStyle(SecondaryButtonStyle())
                }
                .frame(maxWidth: .infinity)
            } else {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "hand.tap.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Palette.blue)
                        .frame(width: 38, height: 38)
                        .background(Palette.blue.opacity(0.12), in: Circle())

                    VStack(alignment: .leading, spacing: 4) {
                        Text("지금 할 일")
                            .font(Typeface.body(12))
                            .foregroundStyle(Palette.inkSoft)
                        Text(session.tutorialHint)
                            .font(Typeface.title(17))
                            .foregroundStyle(Palette.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(Palette.line, lineWidth: 1)
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 22)
    }
}
