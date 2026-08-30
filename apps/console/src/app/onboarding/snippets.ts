/** 위저드 3단계 — 플랫폼별 SDK 연동 스니펫 (PRD-01A 인터페이스 기준, SDK 구현은 S1~) */

export const PLATFORMS = ["ios", "android", "rn", "flutter", "curl"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  ios: "iOS (Swift)",
  android: "Android (Kotlin)",
  rn: "React Native",
  flutter: "Flutter",
  curl: "curl (지금 바로 테스트)",
};

export function snippet(platform: Platform, sdkKeyHint: string, apiUrl: string): string {
  switch (platform) {
    case "ios":
      return `import OndaSDK

// AppDelegate 또는 App init
Onda.initialize("${sdkKeyHint}", options: .init(apiUrl: "${apiUrl}"))
Onda.track("app_open")`;
    case "android":
      return `import io.onda.sdk.Onda

// Application.onCreate()
Onda.initialize(this, "${sdkKeyHint}", OndaOptions(apiUrl = "${apiUrl}"))
Onda.track("app_open")`;
    case "rn":
      return `import { Onda } from "@onda/react-native";

await Onda.initialize("${sdkKeyHint}", { apiUrl: "${apiUrl}" });
await Onda.track("app_open");`;
    case "flutter":
      return `import 'package:onda_sdk/onda_sdk.dart';

await Onda.initialize('${sdkKeyHint}', OndaOptions(apiUrl: '${apiUrl}'));
await Onda.track('app_open');`;
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
