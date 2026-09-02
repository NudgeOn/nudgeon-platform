import { describe, expect, it } from "vitest";
import { EMAIL_PROVIDERS } from "@nudgeon/api-client";
import { RESEND_LINKS, RESEND_WEBHOOK_EVENTS, isEmailProvider, resendWebhookUrl } from "./email-provider-links";

describe("resendWebhookUrl", () => {
  const appId = "22222222-2222-4222-8222-222222222222";

  it("API 주소 뒤에 /v1/webhooks/resend/{appId}를 붙인다", () => {
    expect(resendWebhookUrl("https://api.example.com", appId)).toBe(
      `https://api.example.com/v1/webhooks/resend/${appId}`,
    );
  });

  it("끝의 슬래시가 중복되지 않는다", () => {
    expect(resendWebhookUrl("https://api.example.com///", appId)).toBe(
      `https://api.example.com/v1/webhooks/resend/${appId}`,
    );
  });
});

describe("RESEND_LINKS", () => {
  it("모두 resend.com https 절대 URL이다 (새 탭 이동 대상)", () => {
    for (const [key, href] of Object.entries(RESEND_LINKS)) {
      const u = new URL(href);
      expect(u.protocol, key).toBe("https:");
      expect(u.hostname, key).toBe("resend.com");
    }
  });

  it("설정에 필요한 네 곳을 모두 안내한다", () => {
    expect(Object.keys(RESEND_LINKS).sort()).toEqual(["apiKeys", "domains", "emails", "webhooks"]);
  });
});

describe("RESEND_WEBHOOK_EVENTS", () => {
  it("서버가 매핑하는 이벤트를 빠짐없이 안내한다", () => {
    expect([...RESEND_WEBHOOK_EVENTS]).toEqual([
      "email.sent",
      "email.delivered",
      "email.opened",
      "email.clicked",
      "email.bounced",
      "email.complained",
      "email.failed",
    ]);
  });
});

describe("isEmailProvider", () => {
  it("이메일 발송기만 통과시킨다", () => {
    for (const p of EMAIL_PROVIDERS) expect(isEmailProvider(p), p).toBe(true);
    expect(isEmailProvider("push_fcm")).toBe(false);
    expect(isEmailProvider("push_apns")).toBe(false);
  });

  it("email_resend를 발송기로 인식한다", () => {
    expect(isEmailProvider("email_resend")).toBe(true);
  });
});
