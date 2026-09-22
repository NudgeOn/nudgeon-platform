import { describe, expect, it } from "vitest";
import { STANDARD_ATTRIBUTES } from "@nudgeon/api-client";
import { compile } from "@nudgeon/segment-dsl";
import ko from "../../messages/ko.json";
import en from "../../messages/en.json";

describe("standard attribute integration", () => {
  it("provides localized guidance and compilable segment conditions for every preset", () => {
    for (const attr of STANDARD_ATTRIBUTES) {
      for (const messages of [ko, en]) {
        expect(messages.attributeCatalog.attributes[attr.key].label).toBeTruthy();
        expect(messages.attributeCatalog.attributes[attr.key].format).toBeTruthy();
      }
      const query = compile({version: 1, operator: "AND", groups: [{operator: "AND", conditions: [
        {type: "attribute", key: attr.key, op: "eq", value: attr.example},
      ]}]}, "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "marketing");
      expect(query.args).toContain(attr.key);
      expect(query.sql).toContain("std_attrs");
    }
  });
});
