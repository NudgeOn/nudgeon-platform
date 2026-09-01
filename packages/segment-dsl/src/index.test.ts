import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, CompileError, type Category, type SegmentDSL } from "./index";

const TENANT = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";

interface GoldenCase {
  name: string;
  category: Category;
  dsl: SegmentDSL;
  expect: { compiles: boolean; contains?: string[]; not_contains?: string[] };
}

const golden = JSON.parse(
  readFileSync(join(__dirname, "..", "golden", "cases.json"), "utf8"),
) as { cases: GoldenCase[] };

// G-1(TS): 언어 중립 골든이 TS 컴파일러에서도 동일하게 동작 (Go와 정합)
describe("골든 스위트 (TS 컴파일러)", () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      if (!c.expect.compiles) {
        expect(() => compile(c.dsl, TENANT, APP, c.category)).toThrow();
        return;
      }
      const { sql } = compile(c.dsl, TENANT, APP, c.category);
      for (const want of c.expect.contains ?? []) {
        expect(sql).toContain(want);
      }
      for (const notWant of c.expect.not_contains ?? []) {
        expect(sql).not.toContain(notWant);
      }
    });
  }
});

describe("tenant 주입 불변식 (G-2)", () => {
  it("복수 이벤트의 기간과 횟수 인자가 SQL 순서로 바인딩된다", () => {
    const dsl: SegmentDSL = {
      version: 1, operator: "AND", groups: [{ operator: "AND", conditions: [
        { type: "event", event: "purchase", op: "count_gte", value: 2, window_days: 30 },
        { type: "event", event: "cancel", op: "not_performed", window_days: 7 },
      ] }],
    };
    const { args } = compile(dsl, TENANT, APP, "marketing");
    expect(args).toEqual([TENANT, APP, TENANT, APP, "purchase", 30, 2, TENANT, APP, "cancel", 7]);
  });

  it("모든 SQL에 tenant/app/status 필터가 주입되고 첫 두 인자가 tenant/app", () => {
    const dsl: SegmentDSL = {
      version: 1,
      operator: "AND",
      groups: [
        { operator: "OR", conditions: [{ type: "attribute", key: "country", op: "eq", value: "KR" }] },
      ],
    };
    const { sql, args } = compile(dsl, TENANT, APP, "marketing");
    expect(sql).toContain("tenant_id = toUUID(?)");
    expect(sql).toContain("app_id = toUUID(?)");
    expect(sql).toContain("status = 'active'");
    expect(args[0]).toBe(TENANT);
    expect(args[1]).toBe(APP);
  });

  it("악성 값은 SQL에 삽입되지 않고 인자로만 바인딩", () => {
    const dsl: SegmentDSL = {
      version: 1,
      operator: "AND",
      groups: [
        {
          operator: "AND",
          conditions: [{ type: "attribute", key: "name", op: "eq", value: "'; DROP TABLE users; --" }],
        },
      ],
    };
    const { sql, args } = compile(dsl, TENANT, APP, "marketing");
    expect(sql).not.toContain("DROP TABLE");
    expect(args).toContain("'; DROP TABLE users; --");
  });

  it("잘못된 연산자는 CompileError", () => {
    const dsl = {
      version: 1,
      operator: "AND",
      groups: [{ operator: "AND", conditions: [{ type: "attribute", key: "x", op: "evil" }] }],
    } as unknown as SegmentDSL;
    expect(() => compile(dsl, TENANT, APP, "marketing")).toThrow(CompileError);
  });
});
