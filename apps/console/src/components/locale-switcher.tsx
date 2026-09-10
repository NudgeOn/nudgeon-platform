"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/i18n/locales";

// 언어 이름은 해당 언어로 고정 표기한다(endonym) — 현재 로케일과 무관하게 자기 언어를 찾을 수 있어야 한다.
const LABELS: Record<Locale, string> = { ko: "한국어", en: "English" };

/** 로케일 전환 — 쿠키를 바꾸고 서버 컴포넌트를 다시 렌더한다(URL은 그대로). */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("app");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <select
      aria-label={t("localeSwitcherLabel")}
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
