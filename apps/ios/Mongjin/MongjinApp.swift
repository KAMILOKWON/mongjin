import GoogleMobileAds
import SwiftUI

@main
struct MongjinApp: App {
    @State private var model = AppModel()

    init() {
        MobileAds.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ZStack {
            Palette.canvas.ignoresSafeArea()
            switch model.route {
            case .home:
                HomeView()
            case .setupAI:
                SetupView()
            case .match:
                MatchView()
            case .game:
                if model.session != nil {
                    GameView()
                } else {
                    HomeView()
                }
            case .tutorial:
                TutorialView()
            case .profile:
                ProfileView()
            }
        }
        .tint(Palette.blue)
        .overlay(alignment: .top) {
            if let toast = model.toast {
                Text(toast)
                    .font(Typeface.body(14))
                    .foregroundStyle(Palette.panel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Palette.ink.opacity(0.92), in: Capsule())
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .onAppear {
                        Task {
                            try? await Task.sleep(for: .seconds(2.2))
                            if model.toast == toast { model.toast = nil }
                        }
                    }
            }
        }
        .animation(.spring(duration: 0.35), value: model.toast)
        .animation(.easeInOut(duration: 0.2), value: model.route)
    }
}
