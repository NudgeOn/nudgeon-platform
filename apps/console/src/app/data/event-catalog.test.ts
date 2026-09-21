import { describe, expect, it } from "vitest";
import { STANDARD_EVENTS } from "@nudgeon/api-client";
import { createJourneyTemplate } from "../journeys/journey-templates";
import ko from "../../messages/ko.json";
import en from "../../messages/en.json";

describe("standard event integration", () => {
  it("uses the exact names already used by welcome and returning-customer journeys", () => {
    const names = STANDARD_EVENTS.map((event) => event.name);
    const welcome = createJourneyTemplate("welcome", { title: "Welcome", body: "Hello" });
    const returning = createJourneyTemplate("return", { title: "Come back", body: "Hello" });
    expect(names).toContain(welcome.entry.trigger_event);
    expect(names).toContain(returning.entry.trigger_event);
    expect(names).toContain(returning.exit?.conversion_event);
  });

  it("has localized labels and property guidance for every preset", () => {
    for (const messages of [ko, en]) {
      for (const event of STANDARD_EVENTS) {
        expect(messages.eventCatalog.events[event.name].label).toBeTruthy();
        expect(messages.eventCatalog.events[event.name].description).toBeTruthy();
        for (const key of Object.keys(event.properties)) {
          expect(messages.eventCatalog.properties).toHaveProperty(key);
        }
      }
    }
  });
});
