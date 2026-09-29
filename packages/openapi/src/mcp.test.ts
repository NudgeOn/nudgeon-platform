import { afterEach, describe, expect, it, vi } from "vitest";
import { NudgeOnClient } from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("MCP console API contracts", () => {
  function setup(response: unknown = { ok: true }) {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    return { api: new NudgeOnClient("https://api.example"), fetch };
  }

  it("sends OAuth consent scopes to the session-authenticated endpoint", async () => {
    const { api, fetch } = setup({ redirect_uri: "https://client.example/callback?code=123" });
    await api.mcp.authorize("request", { app_id: "app", scopes: ["mcp:read"], approve: true });
    expect(fetch).toHaveBeenCalledWith("https://api.example/v1/mcp/authorization/request", expect.objectContaining({
      method: "POST", credentials: "include", body: JSON.stringify({ app_id: "app", scopes: ["mcp:read"], approve: true }),
    }));
  });

  it("passes the exact journey revision in If-Match while keeping older callers compatible", async () => {
    const { api, fetch } = setup();
    const body = { name: "Draft", definition: {} };
    await api.journeys.update("app", "journey", body, "revision-a");
    expect(fetch.mock.calls[0]?.[1].headers["If-Match"]).toBe('"revision-a"');
    await api.journeys.update("app", "journey", body);
    expect(fetch.mock.calls[1]?.[1].headers["If-Match"]).toBeUndefined();
  });

  it("can decline OAuth without an app or requested scopes", async () => {
    const { api, fetch } = setup();
    await api.mcp.authorize("request", { approve: false });
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"approve":false}');
  });

  it("promotes only a saved revision and isolates path components", async () => {
    const { api, fetch } = setup();
    await api.segmentDrafts.promote("app/id", "draft/id", 3);
    expect(fetch).toHaveBeenCalledWith("https://api.example/v1/apps/app%2Fid/segment-drafts/draft%2Fid/promote", expect.objectContaining({ method: "POST", body: '{"expected_revision":3}' }));
  });
});
