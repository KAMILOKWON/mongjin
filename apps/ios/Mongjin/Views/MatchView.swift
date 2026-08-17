import SwiftUI

struct MatchView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            ScreenNav(title: "빠른 대전", onBack: { model.cancelMatch() })

            VStack(spacing: 10) {
                MatchPulse()
                    .padding(.bottom, 8)

                Text(model.matchFoundName == nil ? "상대를 찾는 중" : "매칭됐어요")
                    .font(.system(size: 27, weight: .heavy))
                    .tracking(-1.2)
                    .foregroundStyle(Palette.ink)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 20)
            .padding(.bottom, 24)
        }
        .background(Palette.panel.ignoresSafeArea())
        .onAppear { model.startQuickMatch() }
    }
}

struct MatchPulse: View {
    @State private var phase = 0

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { index in
                    let cycle = (t - Double(index) * 0.15).truncatingRemainder(dividingBy: 1.1)
                    let active = cycle >= 0 && cycle < 0.44
                    Circle()
                        .fill(Palette.blue)
                        .frame(width: 9, height: 9)
                        .scaleEffect(active ? 1 : 0.85)
                        .opacity(active ? 1 : 0.25)
                }
            }
        }
        .accessibilityHidden(true)
    }
}
