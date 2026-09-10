"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/i18n/locales";

const LABELS: Record<Locale, string> = { ko: "한국어", en: "English" };

/** 로케일 전환 — 쿠키를 바꾸고 서버 컴포넌트를 다시 렌더한다(URL은 그대로). */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <select
      aria-label="Language"
      className={className ?? "h-8 rounded-md border bg-background px-2 text-xs"}
      value={locale}
      disabled={pending}
      onChange={(e) => {
        document.cookie = `${LOCALE_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
        start(() => router.refresh());
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>{LABELS[l]}</option>
      ))}
    </select>
  );
}
