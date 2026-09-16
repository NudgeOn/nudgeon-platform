import { describe, expect, it } from "vitest";
import { validateJourney } from "@nudgeon/journey-model";
import { createJourneyTemplate, isJourneyTemplate, JOURNEY_TEMPLATES } from "./journey-templates";

describe("journey starters", () => {
  it.each(JOURNEY_TEMPLATES)("%s produces a valid graph with no dangling steps", template => {
    const def = createJourneyTemplate(template, { title: "Hello", body: "Welcome" });
    expect(validateJourney(def).filter(issue => issue.level === "error")).toEqual([]);
  });
  it("keeps a service update transactional and removes the wait", () => {
    const def = createJourneyTemplate("update", { title: "Updated", body: "New playlist" });
    expect(def.entry.trigger_event).toBe("playlist_updated");
    expect(def.settings).toEqual({ category: "transactional", reentry: "always" });
    expect(def.nodes.map(node => node.type)).toEqual(["message"]);
  });
  it("exits the reminder on purchase and keeps marketing consent rules", () => {
    const def = createJourneyTemplate("return", { title: "Hello", body: "Again" });
    expect(def.exit.conversion_event).toBe("purchase_completed");
    expect(def.settings.category).toBe("marketing");
    expect(def.nodes[0]).toMatchObject({ type: "delay", duration_seconds: 86400 });
  });
  it("does not share mutable draft content and rejects unknown URL values", () => {
    const push = { title: "Hello", body: "Welcome" };
    const def = createJourneyTemplate("welcome", push);
    push.title = "Changed";
    expect(def.nodes[1]).toMatchObject({ push: { title: "Hello" } });
    expect(isJourneyTemplate("__proto__")).toBe(false);
    expect(isJourneyTemplate(null)).toBe(false);
  });
});
