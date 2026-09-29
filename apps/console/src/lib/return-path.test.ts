import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("login return path", () => {
  it("preserves the local OAuth request through sign-in and enrollment", () => {
    expect(safeReturnPath("/mcp/authorize?request_id=123")).toBe("/mcp/authorize?request_id=123");
  });
  it.each([null, "", "https://evil.example", "//evil.example", "/\\evil.example", "/\nevil", "javascript:alert(1)"])("rejects external or ambiguous destinations: %s", (path) => {
    expect(safeReturnPath(path)).toBeNull();
  });
});
