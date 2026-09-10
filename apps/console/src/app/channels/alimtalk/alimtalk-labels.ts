/**
 * 알림톡 설정 화면의 순수 헬퍼 — 리포트 지원 범위·템플릿 유형·웹훅 URL.
 * 컴포넌트와 분리해 단위 테스트가 React·API 클라이언트 없이 돌게 한다(email-provider-links.ts와 동일).
 */

/**
 * 번역 함수 — next-intl `useTranslations("alimtalk")`의 t와 호환. 이 모듈은 React·next-intl을 import하지
 * 않고(단위 테스트 격리), 사용자 문구는 "alimtalk" 네임스페이스의 메시지 키로만 가리킨다.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** 라벨 참조 — 카탈로그 키이거나(알려진 상태), 번역 없이 그대로 보여 줄 원문(모르는 상태). */
export type LabelRef = { key: string } | { text: string };

export function renderLabel(ref: LabelRef, t: Translate): string {
  return "key" in ref ? t(ref.key) : ref.text;
}

/** 커넥터가 보고할 수 있는 상태의 전체 집합. manifest.lifecycle.reports가 이 중 일부를 선언한다. */
export const LIFECYCLE_REPORTS = ["accepted", "sent", "delivered", "read", "failed"] as const;
export type LifecycleReport = (typeof LIFECYCLE_REPORTS)[number];

export const REPORT_LABEL_KEYS: Record<LifecycleReport, string> = {
  accepted: "report.accepted",
  sent: "report.sent",
  delivered: "report.delivered",
  read: "report.read",
  failed: "report.failed",
};

export interface ReportSupport {
  supported: LabelRef[];
  unsupported: LabelRef[];
}

/**
 * 벤더가 무엇을 보고하고 무엇을 보고하지 않는지.
 *
 * "미지원"과 "0건"은 다르다 — 알림톡은 대부분 열람을 보고하지 않으므로, 열람 0을 성과로 읽으면 안 된다.
 * 매니페스트에 없는 상태도 그대로 지원 목록에 남긴다(모르는 상태를 숨기면 표시가 거짓이 된다).
 */
export function reportSupport(reports: readonly string[]): ReportSupport {
  const declared = new Set(reports);
  const supported: LabelRef[] = reports.map((r) =>
    r in REPORT_LABEL_KEYS ? { key: REPORT_LABEL_KEYS[r as LifecycleReport] } : { text: r },
  );
  const unsupported: LabelRef[] = LIFECYCLE_REPORTS.filter((r) => !declared.has(r)).map((r) => ({
    key: REPORT_LABEL_KEYS[r],
  }));
  return { supported, unsupported };
}

/** "접수 · 발송 · 도달 보고 · 열람 미지원" 같은 한 줄 요약. */
export function reportSummary(reports: readonly string[], t: Translate): string {
  const { supported, unsupported } = reportSupport(reports);
  if (supported.length === 0) return t("report.none");
  const join = (refs: LabelRef[]) => refs.map((r) => renderLabel(r, t)).join(" · ");
  return unsupported.length === 0
    ? t("report.summary", { supported: join(supported) })
    : t("report.summaryUnsupported", { supported: join(supported), unsupported: join(unsupported) });
}

/** 콘솔이 안내하는 커넥터 웹훅 URL — 벤더 콘솔에 등록할 주소. */
export function connectorWebhookUrl(apiUrl: string, appId: string, connectorId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/webhooks/connectors/${appId}/${connectorId}`;
}

/** 카카오 알림톡 템플릿 유형. AD·MI는 광고성이라 발송 규제가 다르다. */
export const MESSAGE_TYPE_KEYS: Record<string, string> = {
  BA: "messageType.BA",
  EX: "messageType.EX",
  AD: "messageType.AD",
  MI: "messageType.MI",
};

export function messageTypeLabel(messageType: string, t: Translate): string {
  const code = messageType.trim().toUpperCase();
  if (!code) return t("messageType.unknown");
  return MESSAGE_TYPE_KEYS[code] ? `${code} ${t(MESSAGE_TYPE_KEYS[code])}` : code;
}

/**
 * 광고성 템플릿인가 — AD(광고추가형)·MI(복합형).
 * 법적 구분이다: 야간(21시~익일 08시) 발송이 제한되고 수신거부가 적용된다. 표시용 장식이 아니다.
 */
export function isAdMessageType(messageType: string): boolean {
  const code = messageType.trim().toUpperCase();
  return code === "AD" || code === "MI";
}

/** 광고성 템플릿 안내 — "alimtalk" 네임스페이스 키. */
export const AD_TEMPLATE_NOTICE_KEY = "adTemplateNotice";

/** 워커가 정규화하는 템플릿 상태(vendor.go: approved · pending · rejected). */
export const TEMPLATE_STATUS_KEYS: Record<string, string> = {
  approved: "templateStatus.approved",
  pending: "templateStatus.pending",
  rejected: "templateStatus.rejected",
  unknown: "templateStatus.unknown",
};

export function templateStatusLabel(status: string, t: Translate): string {
  const key = TEMPLATE_STATUS_KEYS[status];
  return key ? t(key) : status;
}

export function isTemplateApproved(status: string): boolean {
  return status === "approved";
}

/**
 * 벤더 목록에서 사라진 템플릿에 워커가 찍는 표식 (templatesync/store.go: VendorStatusMissing).
 * 행을 지우지 않는 이유: 미동기화 템플릿은 발송 전 검증을 건너뛰므로, 삭제가 곧 가드를
 * 조용히 끄는 일이 된다. 저니가 아직 참조하고 있을 수도 있어 눈에 보여야 한다.
 */
export const VENDOR_STATUS_MISSING = "NUDGEON_MISSING_IN_VENDOR";

export function isMissingInVendor(vendorStatus: string | undefined): boolean {
  return vendorStatus === VENDOR_STATUS_MISSING;
}

/**
 * 템플릿의 사용 가능 상태를 한 마디로. 벤더에서 사라진 것은 반려와 구분한다 —
 * 반려는 심사 결과이고, 소실은 벤더 쪽에서 없어진 것이라 대응이 다르다.
 */
export function templateStateLabel(status: string, vendorStatus: string | undefined, t: Translate): string {
  if (isMissingInVendor(vendorStatus)) return t("templateStatus.missingInVendor");
  return templateStatusLabel(status, t);
}

/** 승인되지 않은 템플릿을 저니에서 고를 수 없는 이유 — 노드 select의 disabled 사유로 쓴다. */
export function templateBlockReason(status: string, vendorStatus: string | undefined, t: Translate): string | null {
  if (isTemplateApproved(status)) return null;
  if (isMissingInVendor(vendorStatus)) return t("templateStatus.missingInVendor");
  const label = templateStatusLabel(status, t);
  return vendorStatus ? t("templateStatus.blockedWithVendor", { label, vendorStatus }) : label;
}

/** 벤더 소실 안내 — "alimtalk" 네임스페이스 키. */
export const MISSING_IN_VENDOR_NOTICE_KEY = "missingInVendorNotice";

/**
 * 서버가 보낸 한국어 메시지를 그대로 꺼낸다.
 *
 * ApiError.message는 "API 501"이라 사용자에게 쓸모가 없다. 실제 사유는 body.message에 있고,
 * Nest의 검증 실패는 그것이 문자열 배열로 온다. 벤더 미지원·미구현 안내를 우리가 다시 쓰지 않고
 * 서버 문구를 그대로 보여 주기 위한 헬퍼다.
 */
export function serverMessage(error: unknown, fallback: string): string {
  const body = (error as { body?: unknown } | null)?.body;
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message.trim()) return message;
  if (Array.isArray(message)) {
    const joined = message.filter((m): m is string => typeof m === "string").join(" · ");
    if (joined) return joined;
  }
  return fallback;
}
