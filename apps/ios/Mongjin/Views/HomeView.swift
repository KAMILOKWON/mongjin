import GoogleMobileAds
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var tab: HomeTab = .quick

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 0) {
                HStack(alignment: .center) {
                    Text("몽진")
                        .font(Typeface.display(34))
                        .foregroundStyle(Palette.ink)
                    Spacer()
                    Button {
                        model.route = .profile
                    } label: {
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(model.profile.name)
                                .font(Typeface.title(15))
                            Text("Elo \(model.profile.rating) · \(model.profile.wins)승")
                                .font(Typeface.body(11))
                                .foregroundStyle(Palette.inkSoft)
                        }
                        .foregroundStyle(Palette.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(Palette.line, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)

                PreviewBoard()
                    .padding(.horizontal, 26)
                    .padding(.top, 18)
                    .padding(.bottom, 16)

                VStack(spacing: 12) {
                    HStack(spacing: 6) {
                        ForEach(HomeTab.allCases) { item in
                            Button {
                                tab = item
                            } label: {
                                Text(item.label)
                                    .font(Typeface.body(14))
                                    .foregroundStyle(tab == item ? Palette.panel : Palette.inkSoft)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(
                                        tab == item ? Palette.blue : Color.clear,
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(4)
                    .background(Palette.surface, in: Capsule())
                    .overlay(Capsule().stroke(Palette.line, lineWidth: 1))

                    Text(tab.blurb)
                        .font(Typeface.body(13))
                        .foregroundStyle(Palette.inkSoft)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)

                    Button(tab.cta) {
                        switch tab {
                        case .quick:
                            model.route = .match
                        case .ai:
                            model.route = .setupAI
                        case .local:
                            model.openLocal()
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())

                    Button("튜토리얼") {
                        model.openTutorial()
                    }
                    .font(Typeface.body(15))
                    .foregroundStyle(Palette.blue)
                    .padding(.top, 2)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 24)
            .padding(.bottom, 28)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Palette.panel.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AdBannerSlot()
                .frame(maxWidth: .infinity)
                .background(Palette.panel)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(Palette.line.opacity(0.7))
                        .frame(height: 1)
                }
        }
    }
}

/// 메인 화면 하단의 표준 배너 광고 영역.
struct AdBannerSlot: View {
    var body: some View {
        BannerViewContainer(adSize: AdSizeBanner)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .padding(.vertical, 8)
            .accessibilityHidden(true)
    }
}

private struct BannerViewContainer: UIViewRepresentable {
    typealias UIViewType = BannerView

    let adSize: AdSize

    func makeUIView(context: Context) -> BannerView {
        let banner = BannerView(adSize: adSize)
#if DEBUG
        banner.adUnitID = "ca-app-pub-3940256099942544/2435281174"
#else
        banner.adUnitID = "ca-app-pub-5461761225918027/1766330588"
#endif
        banner.rootViewController = Self.topViewController()
        banner.delegate = context.coordinator
        banner.load(Request())
        return banner
    }

    func updateUIView(_ uiView: BannerView, context: Context) {}

    func makeCoordinator() -> BannerCoordinator {
        BannerCoordinator()
    }

    final class BannerCoordinator: NSObject, BannerViewDelegate {
        func bannerViewDidReceiveAd(_ bannerView: BannerView) {
            print("Mongjin AdMob banner loaded")
        }

        func bannerView(_ bannerView: BannerView, didFailToReceiveAdWithError error: Error) {
            print("Mongjin AdMob banner failed: \(error.localizedDescription)")
        }
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              let root = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
            return nil
        }

        var current = root
        while let presented = current.presentedViewController {
            current = presented
        }
        return current
    }
}

enum HomeTab: String, CaseIterable, Identifiable {
    case quick
    case ai
    case local

    var id: String { rawValue }

    var label: String {
        switch self {
        case .quick: return "빠른 대전"
        case .ai: return "컴퓨터"
        case .local: return "같이 두기"
        }
    }

    var blurb: String {
        switch self {
        case .quick: return "접속 중인 상대와 자동 매칭"
        case .ai: return "난이도와 진영을 골라 연습합니다"
        case .local: return "한 기기에서 흑·백을 번갈아 둡니다"
        }
    }

    var cta: String {
        switch self {
        case .quick: return "대국 시작"
        case .ai: return "대국 준비"
        case .local: return "대국 시작"
        }
    }
}

struct PreviewBoard: View {
    var body: some View {
        GeometryReader { geo in
            let cell = min(geo.size.width, geo.size.height) / 9
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Palette.wood)
                VStack(spacing: 0) {
                    ForEach(0..<9, id: \.self) { r in
                        HStack(spacing: 0) {
                            ForEach(0..<9, id: \.self) { c in
                                let goal = (r == 0 || r == 8) && (3...5).contains(c)
                                ZStack {
                                    Rectangle()
                                        .fill(goal ? Palette.blue.opacity(0.10) : Palette.panel.opacity(0.35))
                                        .overlay(Rectangle().stroke(Palette.woodEdge.opacity(0.55), lineWidth: 0.6))
                                    if r == 8 && c == 4 {
                                        PieceImage(player: .black, type: .king)
                                            .padding(cell * 0.08)
                                    }
                                    if r == 0 && c == 4 {
                                        PieceImage(player: .white, type: .king)
                                            .padding(cell * 0.08)
                                    }
                                }
                                .frame(width: cell, height: cell)
                            }
                        }
                    }
                }
                .padding(8)
            }
            .frame(width: cell * 9 + 16, height: cell * 9 + 16)
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var fill: Color = Palette.blue

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.title(17))
            .foregroundStyle(Palette.panel)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(fill.opacity(configuration.isPressed ? 0.82 : 1), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.title(16))
            .foregroundStyle(Palette.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                Palette.surface.opacity(configuration.isPressed ? 0.7 : 1),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Palette.line, lineWidth: 1)
            )
    }
}
