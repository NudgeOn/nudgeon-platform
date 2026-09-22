/** Profile conventions for setUserAttributes and /v1/identify. No values are automatically collected. */
export const STANDARD_ATTRIBUTES = [
  { key: "first_name", type: "string", example: "Minji" },
  { key: "last_name", type: "string", example: "Kim" },
  { key: "email", type: "string", example: "minji@example.com" },
  { key: "phone", type: "string", example: "+821012345678" },
  { key: "dob", type: "string", example: "1995-03-15" },
  { key: "gender", type: "string", example: "F" },
  { key: "home_city", type: "string", example: "Seoul" },
  { key: "country", type: "string", example: "KR" },
  { key: "language", type: "string", example: "ko" },
  { key: "timezone", type: "string", example: "Asia/Seoul" },
  { key: "created_at", type: "datetime", example: "2026-09-22T00:00:00Z" },
] as const;

export type StandardAttributeKey = (typeof STANDARD_ATTRIBUTES)[number]["key"];
