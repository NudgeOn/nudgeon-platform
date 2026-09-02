import { EMAIL_PROVIDERS, type EmailProvider } from "@onda/api-client";

/**
 * 이메일 발송기 설정의 순수 헬퍼 — 외부 콘솔 딥링크·웹훅 URL·발송기 판별.
 * 컴포넌트(email-provider-card.tsx)와 분리해 단위 테스트가 React·API 클라이언트 없이 돌게 한다.
 */

/** Resend 대시보드 딥링크 — 설정 화면에서 바로 이동(새 탭). 경로는 Resend 공식 문서 기준. */
export const RESEND_LINKS = {
  apiKeys: "https://resend.com/api-keys",
  domains: "https://resend.com/domains",
  webhooks: "https://resend.com/webhooks",
  emails: "https://resend.com/emails",
} as const;

/** Resend 웹훅에서 켜야 하는 이벤트 — 서버 매핑(resend-webhook.service.ts)과 동일 목록 */
export const RESEND_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
] as const;

/** 콘솔이 안내하는 Resend 웹훅 URL — API의 POST /v1/webhooks/resend/:appId */
export function resendWebhookUrl(apiUrl: string, appId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/webhooks/resend/${appId}`;
}

export function isEmailProvider(kind: string): kind is EmailProvider {
  return (EMAIL_PROVIDERS as readonly string[]).includes(kind);
}
