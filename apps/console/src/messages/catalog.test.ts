import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import ko from "./ko.json";
import en from "./en.json";

const flatten = (o: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v !== null ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));

// en 카탈로그에 빠진 키가 있으면 next-intl이 키 이름을 화면에 그대로 보여준다 — ko(권위)와 키 집합이 같아야 한다.
describe("message catalogs", () => {
  it("renders email HTML placeholders as literal code in both languages", () => {
    for (const [locale, messages] of [["ko", ko], ["en", en]] as const) {
      const t = createTranslator({ locale, messages });
      expect(t("journeyEditor.inspector.email.htmlPlaceholder")).toMatch(/^<h1>.*\{\{first_name\}\}.*<\/h1>$/);
    }
  });
  it("en has exactly the same keys as ko", () => {
    const k = flatten(ko).sort(), e = flatten(en).sort();
    expect(e).toEqual(k);
  });
  it("every message is a non-empty string", () => {
    for (const cat of [ko, en]) for (const key of flatten(cat)) {
      const v = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], cat);
      expect(typeof v === "string" && v.trim().length > 0, key).toBe(true);
    }
  });
});
