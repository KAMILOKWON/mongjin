import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "몽진 개인정보 처리방침 및 앱 지원",
  description: "몽진의 개인정보 처리방침과 앱 지원 안내입니다.",
};

const googlePrivacyUrl = "https://policies.google.com/privacy";
const googleHowDataIsUsedUrl =
  "https://policies.google.com/technologies/partner-sites";

export default function Home() {
  return (
    <main className="policy-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="몽진 처음으로">
          <span className="brand-mark" aria-hidden="true">王</span>
          <span>몽진</span>
        </a>
        <a className="header-link" href="#support">앱 지원</a>
      </header>

      <div className="page-grid" id="top">
        <aside className="side-note" aria-label="문서 안내">
          <p className="eyebrow">MONGJIN</p>
          <p className="side-copy">한 수씩 읽고, 차분하게 두는 장기</p>
          <div className="side-rule" />
          <p className="side-meta">최종 수정일<br />2026년 8월 17일</p>
        </aside>

        <article className="policy-card">
          <section className="hero">
            <p className="eyebrow">개인정보 보호</p>
            <h1>개인정보 처리방침</h1>
            <p className="lead">
              몽진은 사용자가 안심하고 장기를 즐길 수 있도록 필요한 범위에서만
              정보를 처리합니다.
            </p>
            <p className="effective-date">시행일: 2026년 8월 17일</p>
          </section>

          <section className="quick-facts" aria-label="핵심 안내">
            <div>
              <span className="fact-number">01</span>
              <strong>계정 없이 플레이</strong>
              <p>기본 게임은 계정이나 이름·이메일 입력 없이 사용할 수 있습니다.</p>
            </div>
            <div>
              <span className="fact-number">02</span>
              <strong>게임 기록은 기기에 저장</strong>
              <p>닉네임과 전적 등 게임 기록은 앱을 사용하는 기기에 보관됩니다.</p>
            </div>
            <div>
              <span className="fact-number">03</span>
              <strong>광고 SDK 사용</strong>
              <p>하단 배너 광고 제공을 위해 Google Mobile Ads SDK를 사용합니다.</p>
            </div>
          </section>

          <div className="policy-body">
            <section>
              <p className="section-label">01</p>
              <h2>수집하거나 처리하는 정보</h2>
              <h3>앱 안에 저장되는 게임 정보</h3>
              <p>
                몽진은 닉네임, Elo 점수, 승·패 기록, 게임 기록(고스트) 등 게임
                진행에 필요한 정보를 사용자의 기기에 저장합니다. 이 정보는 앱의
                프로필과 게임 기능을 제공하기 위한 것이며, 기본 네이티브 앱에서는
                개발자 서버로 전송하지 않습니다.
              </p>
              <h3>광고 및 진단 정보</h3>
              <p>
                광고를 제공하기 위해 Google Mobile Ads SDK가 사용됩니다. 이 SDK는
                IP 주소, 기기 또는 광고 식별자, 광고 노출·상호작용 정보, 충돌 및
                성능 진단 정보 등을 Google 또는 광고 파트너가 처리할 수 있습니다.
                실제 처리 범위와 보관 기간은 Google의 정책과 광고 설정에 따릅니다.
              </p>
            </section>

            <section>
              <p className="section-label">02</p>
              <h2>이용 목적</h2>
              <ul>
                <li>게임 보드, 프로필, 전적 및 게임 기록 제공</li>
                <li>배너 광고 표시와 광고 성과 측정</li>
                <li>앱 안정성, 오류 및 성능 진단</li>
              </ul>
            </section>

            <section>
              <p className="section-label">03</p>
              <h2>제3자 서비스</h2>
              <p>
                몽진은 광고 제공을 위해 Google Mobile Ads를 사용합니다. Google의
                정보 처리 방식은 아래 문서에서 확인할 수 있습니다.
              </p>
              <div className="link-row">
                <a href={googlePrivacyUrl} target="_blank" rel="noreferrer">
                  Google 개인정보처리방침 <span aria-hidden="true">↗</span>
                </a>
                <a href={googleHowDataIsUsedUrl} target="_blank" rel="noreferrer">
                  Google 파트너 사이트의 데이터 사용 <span aria-hidden="true">↗</span>
                </a>
              </div>
            </section>

            <section>
              <p className="section-label">04</p>
              <h2>보관 및 삭제</h2>
              <p>
                기기에 저장된 게임 정보는 앱을 삭제하거나 기기 설정에서 앱 데이터를
                삭제할 때까지 보관됩니다. 광고·진단 정보는 해당 정보를 처리하는
                제3자 서비스의 정책과 보관 기준에 따라 관리됩니다.
              </p>
            </section>

            <section>
              <p className="section-label">05</p>
              <h2>사용자의 선택</h2>
              <p>
                iOS 설정에서 앱의 추적 권한과 광고 관련 설정을 관리할 수 있습니다.
                몽진은 계정 로그인을 요구하지 않으므로, 기본 게임 이용을 위해
                이름·이메일·전화번호를 제공할 필요가 없습니다.
              </p>
            </section>

            <section>
              <p className="section-label">06</p>
              <h2>방침 변경</h2>
              <p>
                서비스 또는 관련 법령의 변경에 따라 이 방침을 수정할 수 있습니다.
                변경 사항은 이 페이지에 새로운 시행일과 함께 게시합니다.
              </p>
            </section>

            <section className="support-section" id="support">
              <p className="section-label">APP SUPPORT</p>
              <h2>몽진 앱 지원</h2>
              <p>
                게임 이용 중 문제가 발생하면 앱 버전, iOS 버전, 문제 상황과 재현
                방법을 함께 알려 주세요. 지원 문의는 App Store Connect에 등록된
                개발자 연락처를 통해 접수합니다.
              </p>
              <p className="support-note">
                이 페이지는 몽진의 개인정보 처리방침과 앱 지원 안내를 함께 제공합니다.
              </p>
            </section>
          </div>

          <footer className="policy-footer">
            <span>몽진</span>
            <span>© 2026 Studio ZZG</span>
          </footer>
        </article>
      </div>
    </main>
  );
}
