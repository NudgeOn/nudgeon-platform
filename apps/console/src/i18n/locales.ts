/** 로케일 상수와 선택 규칙 — 클라이언트(전환 UI)와 서버(request config)가 함께 쓴다. next/headers를 여기서 import하지 않는다. */
export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "NEXT_LOCALE";

export function pickLocale(cookie: string | undefined, acceptLanguage: string | null): Locale {
  if (cookie && (LOCALES as readonly string[]).includes(cookie)) return cookie as Locale;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("en") ? "en" : "ko";
}
