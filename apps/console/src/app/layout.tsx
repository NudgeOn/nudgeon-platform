import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Onda 콘솔",
  description: "Onda — 고객 인게이지먼트 플랫폼 어드민 콘솔",
};

// TODO(S8): next-intl en/ko 스위칭 (U-12). S1은 ko 고정.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
