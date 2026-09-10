import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, pickLocale } from "./locales";

/**
 * 콘솔 i18n (U-12) — next-intl "without i18n routing": URL 접두어 없이 쿠키(NEXT_LOCALE)로 로케일을 정하고,
 * 쿠키가 없으면 Accept-Language의 첫 언어로 고른다. 기본은 ko. 메시지는 src/messages/<locale>.json.
 * 번역이 없는 키는 next-intl이 키 이름을 그대로 보여주므로(개발 시 눈에 띈다) ko 카탈로그가 항상 완전해야 한다.
 */
export default getRequestConfig(async () => {
  const locale = pickLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get("accept-language"));
  return { locale, messages: (await import(`../messages/${locale}.json`)).default };
});
