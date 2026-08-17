import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "몽진 개인정보 처리방침 및 앱 지원",
  description: "몽진의 개인정보 처리방침과 앱 지원 안내입니다.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
