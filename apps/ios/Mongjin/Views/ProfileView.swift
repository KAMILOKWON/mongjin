import SwiftUI

struct ProfileView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            ScreenNav(title: "내 프로필", onBack: { model.route = .home })
            VStack(spacing: 18) {
                VStack(spacing: 6) {
                    Text("로컬 순위")
                        .font(Typeface.body(13))
                        .foregroundStyle(Palette.inkSoft)
                    Text("Elo \(model.profile.rating)")
                        .font(Typeface.display(36))
                    Text("\(model.profile.wins)승 \(model.profile.losses)패 · 승률 \(model.profile.winRate)%")
                        .font(Typeface.body(14))
                        .foregroundStyle(Palette.inkSoft)
                }
                .frame(maxWidth: .infinity)
                .padding(22)
                .background(Palette.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    Text("닉네임")
                        .font(Typeface.title(13))
                        .foregroundStyle(Palette.inkSoft)
                    TextField("2~12자", text: Bindable(model).profileName)
                        .textInputAutocapitalization(.never)
                        .padding(12)
                        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(Palette.line, lineWidth: 1)
                        )
                    Button("닉네임 저장") { model.saveName() }
                        .buttonStyle(SecondaryButtonStyle())
                }

                Spacer()
            }
            .padding(20)
        }
        .background(Palette.panel.ignoresSafeArea())
        .onAppear { model.refresh() }
    }
}
