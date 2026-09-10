import { describe, expect, it } from "vitest";
import { isLoopback, resolveApiUrl, snippet } from "./snippets";

describe("resolveApiUrl", () => {
  it("Safe Boot의 상대 경로(/api)에 브라우저 origin을 붙인다", () => {
    expect(resolveApiUrl("/api", "http://localhost:18080")).toBe("http://localhost:18080/api");
    expect(resolveApiUrl("/api/", "http://localhost:18080/")).toBe("http://localhost:18080/api");
  });
  it("절대 주소는 그대로 둔다", () => {
    expect(resolveApiUrl("https://ingest.example.com", "http://localhost:3000")).toBe("https://ingest.example.com");
    expect(resolveApiUrl("http://localhost:8080/", undefined)).toBe("http://localhost:8080");
  });
});

describe("snippet", () => {
  it("curl은 절대 주소를 쓴다 (상대 경로면 'URL rejected: No host part')", () => {
    expect(snippet("curl", "pk_x", "http://localhost:18080/api")).toContain("curl -X POST http://localhost:18080/api/v1/track");
  });
  it("네 SDK 스니펫이 실제 공개 API 시그니처를 쓴다", () => {
    const host = "https://ingest.example.com";
    expect(snippet("ios", "pk_x", host)).toContain('NudgeOn.initialize(config: NudgeOnConfig(');
    expect(snippet("ios", "pk_x", host)).toContain('apiHost: URL(string: "https://ingest.example.com")!');
    expect(snippet("android", "pk_x", host)).toContain('NudgeOn.initialize(this, NudgeOnConfig(sdkKey = "pk_x", apiHost = "https://ingest.example.com"))');
    expect(snippet("rn", "pk_x", host)).toContain('import NudgeOn from "@nudgeon/react-native"');
    expect(snippet("rn", "pk_x", host)).toContain('NudgeOn.initialize({ sdkKey: "pk_x", apiHost: "https://ingest.example.com" })');
    expect(snippet("flutter", "pk_x", host)).toContain("import 'package:nudgeon_flutter/nudgeon_flutter.dart'");
    expect(snippet("flutter", "pk_x", host)).toContain("NudgeOn.initialize(NudgeOnConfig(sdkKey: 'pk_x', apiHost: 'https://ingest.example.com'))");
    for (const p of ["ios", "android", "rn", "flutter"] as const) {
      expect(snippet(p, "pk_x", host)).not.toMatch(/options:|apiUrl/);
    }
  });
  it("로컬 주소면 단말 SDK 스니펫에만 도달 불가 안내를 붙인다", () => {
    expect(isLoopback("http://localhost:18080/api")).toBe(true);
    expect(isLoopback("https://ingest.example.com")).toBe(false);
    const hint = "실기기는 localhost에 닿지 못합니다";
    expect(snippet("android", "pk_x", "http://localhost:18080/api", hint)).toMatch(/^\/\/ 실기기는 localhost에 닿지 못합니다\n/);
    expect(snippet("curl", "pk_x", "http://localhost:18080/api", hint)).not.toContain("실기기");
    expect(snippet("ios", "pk_x", "https://ingest.example.com", hint)).not.toContain("실기기");
    // 안내문이 없으면(호출 측이 번역을 못 넘긴 경우) 스니펫은 깨끗해야 한다
    expect(snippet("android", "pk_x", "http://localhost:18080/api")).not.toMatch(/^\/\//);
  });
});
