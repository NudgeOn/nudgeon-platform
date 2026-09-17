import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bridgeBootstrap } from "./bridge";

describe("HTML hide-today bridge", () => {
  function connect() {
    const messages: any[] = [];
    const window: any = {
      addEventListener() {}, dispatchEvent() {},
      webkit: { messageHandlers: { nudgeon: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) } } },
    };
    runInNewContext(bridgeBootstrap, {
      window, parent: window, Event: class {}, setTimeout, clearTimeout,
      document: { readyState: "loading", addEventListener() {} },
    });
    window.__nudgeonConnect("delivery", "nonce");
    return { window, messages };
  }
  it("sends a distinct authenticated request and resolves host acknowledgement", async () => {
    const { window, messages } = connect();
    const result = window.nudgeonBridge.hideToday();
    expect(messages).toEqual([{ protocol: 1, request_id: "1", execution_id: "delivery", nonce: "nonce", method: "hideToday", payload: {} }]);
    window.__nudgeonReply({ request_id: "1", ok: true });
    await expect(result).resolves.toBeUndefined();
  });
  it("propagates test-mode rejection without pretending suppression succeeded", async () => {
    const { window } = connect();
    const result = window.nudgeonBridge.hideToday();
    window.__nudgeonReply({ request_id: "1", ok: false, error: { code: "LIVE_CAMPAIGN_REQUIRED" } });
    await expect(result).rejects.toThrow("LIVE_CAMPAIGN_REQUIRED");
  });
});
