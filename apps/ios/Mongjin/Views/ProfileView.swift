import SwiftUI
import UniformTypeIdentifiers

struct ProfileView: View {
    @Environment(AppModel.self) private var model
    @State private var importing = false

    var body: some View {
        VStack(spacing: 0) {
            ScreenNav(title: "내 프로필", onBack: { model.route = .home })
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 6) {
                        Text(model.onlineProfile == nil ? "로컬 순위" : "온라인 순위")
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

                    VStack(alignment: .leading, spacing: 8) {
                        Text("고스트")
                            .font(Typeface.title(13))
                            .foregroundStyle(Palette.inkSoft)
                        HStack(spacing: 10) {
                            Button("가져오기") { importing = true }
                                .buttonStyle(SecondaryButtonStyle())
                            if let tape = model.catalog.defenseGhost ?? model.catalog.tapes.first {
                                ShareLink(
                                    item: GhostFile(tape: tape),
                                    preview: SharePreview("mongjin-ghost.json")
                                ) {
                                    Text("보내기")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(SecondaryButtonStyle())
                            }
                        }
                        ForEach(Array(model.catalog.tapes.sorted { $0.createdAt > $1.createdAt }.prefix(8))) { tape in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(tape.ownerName)
                                    .font(Typeface.title(15))
                                Text(tape.subtitle)
                                    .font(Typeface.body(12))
                                    .foregroundStyle(Palette.inkSoft)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(Palette.line, lineWidth: 1)
                            )
                        }
                    }
                }
                .padding(20)
            }
        }
        .background(Palette.panel.ignoresSafeArea())
        .onAppear { model.refresh() }
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.json, .data],
            allowsMultipleSelection: false
        ) { result in
            if case .success(let urls) = result, let url = urls.first {
                model.importGhost(from: url)
            } else {
                model.toast = "고스트 파일을 읽을 수 없어요"
            }
        }
    }
}
