import { NudgeOnClient } from "@nudgeon/api-client";

/** 콘솔 = API 클라이언트 (PRD-05 1장). 수기 fetch 금지 — 이 인스턴스만 사용. */
export const api = new NudgeOnClient(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080",
);
