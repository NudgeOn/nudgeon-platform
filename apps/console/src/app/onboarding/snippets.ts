/**
 * 위저드 3단계 — 플랫폼별 SDK 연동 스니펫.
 * 시그니처는 실제 SDK 공개 API(각 SDK README)와 같아야 한다 — 2026-09-10 M-2 드라이런에서 네 스니펫 모두
 * 존재하지 않는 `initialize(key, options)` 형태라 복사해도 컴파일되지 않던 결함을 고쳤다.
 *  - iOS:     NudgeOn.initialize(config: NudgeOnConfig(sdkKey:, apiHost: URL))
 *  - Android: NudgeOn.initialize(context, NudgeOnConfig(sdkKey =, apiHost =))
 *  - RN:      NudgeOn.initialize({ sdkKey, apiHost })            (@nudgeon/react-native)
 *  - Flutter: NudgeOn.initialize(NudgeOnConfig(sdkKey:, apiHost:)) (package:nudgeon_flutter)
 */

export const PLATFORMS = ["ios", "android", "rn", "flutter", "curl"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  ios: "iOS (Swift)",
  android: "Android (Kotlin)",
  rn: "React Native",
  flutter: "Flutter",
  curl: "curl",
};

/**
 * 콘솔이 쓰는 API 주소를 SDK·curl이 쓸 절대 주소로 바꾼다.
 * Safe Boot(`./nudgeon up`)는 `NEXT_PUBLIC_API_URL=/api`(게이트웨이 상대경로)라 그대로 내보내면
 * curl은 "URL rejected: No host part"로 실패하고 단말 SDK는 접속할 곳이 없다.
 */
export function resolveApiUrl(apiUrl: string, origin: string | undefined): string {
  const trimmed = apiUrl.replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  if (!origin) return trimmed;
  return origin.replace(/\/+$/, "") + (trimmed.startsWith("/") ? trimmed : "/" + trimmed);
}

/** 단말은 개발 PC의 localhost에 닿지 못한다 — 주소가 로컬이면 스니펫 첫 줄에 안내(주석)를 붙인다. */
export function isLoopback(apiUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(apiUrl);
}

/**
 * @param deviceHint 로컬 주소일 때 단말 SDK 스니펫 첫 줄에 붙일 안내문(주석 접두 `// `는 여기서 붙인다).
 *   번역은 호출 측(onboarding.snippetHints.device.*)이 하고, 이 모듈은 next-intl에 의존하지 않는다.
 */
export function snippet(platform: Platform, sdkKeyHint: string, apiUrl: string, deviceHint?: string): string {
  const hint = platform !== "curl" && isLoopback(apiUrl) && deviceHint ? `// ${deviceHint}\n` : "";
  switch (platform) {
    case "ios":
      return `${hint}import NudgeOnSDK

// AppDelegate / App init
NudgeOn.initialize(config: NudgeOnConfig(
    sdkKey: "${sdkKeyHint}",
    apiHost: URL(string: "${apiUrl}")!
))
NudgeOn.track("app_open")`;
    case "android":
      return `${hint}import io.nudgeon.sdk.NudgeOn
import io.nudgeon.sdk.NudgeOnConfig

// Application.onCreate()
NudgeOn.initialize(this, NudgeOnConfig(sdkKey = "${sdkKeyHint}", apiHost = "${apiUrl}"))
NudgeOn.track("app_open")`;
    case "rn":
      return `${hint}import NudgeOn from "@nudgeon/react-native";

await NudgeOn.initialize({ sdkKey: "${sdkKeyHint}", apiHost: "${apiUrl}" });
NudgeOn.track("app_open");`;
    case "flutter":
      return `${hint}import 'package:nudgeon_flutter/nudgeon_flutter.dart';

await NudgeOn.initialize(NudgeOnConfig(sdkKey: '${sdkKeyHint}', apiHost: '${apiUrl}'));
NudgeOn.track('app_open');`;
    case "curl":
      return `curl -X POST ${apiUrl}/v1/track \\
  -H "Authorization: Bearer ${sdkKeyHint}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "batch": [{
      "insert_id": "'$(uuidgen | tr A-Z a-z)'",
      "anon_id": "'$(uuidgen | tr A-Z a-z)'",
      "event": "app_open",
      "client_ts": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }]
  }'`;
  }
}
