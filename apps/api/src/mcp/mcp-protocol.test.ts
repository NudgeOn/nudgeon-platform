import "reflect-metadata";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { HttpException, UnauthorizedException } from "@nestjs/common";
import express from "express";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Redis from "ioredis";
import { McpController } from "./mcp.controller";
import type { McpOAuth } from "./mcp-oauth.service";
import type { McpRead } from "./mcp-read.service";
import type { McpActor } from "./mcp-policy";
import type { AnalysisService } from "../analytics/analysis.service";
import type { SegmentDrafts } from "../segments/segment-drafts.service";
import type { JourneyDrafts } from "../journeys/journey-drafts.service";
import type { RateLimitService } from "../rate-limit/rate-limit.service";
import type { AuditService } from "../audit/audit.service";

const aid = "10000000-0000-4000-8000-000000000001",
  id = "10000000-0000-4000-8000-000000000002";
const baseActor: McpActor = {
  tenantId: id,
  memberId: id,
  appId: aid,
  connectionId: id,
  email: "test@example.invalid",
  name: "Test",
  role: "editor",
  totpEnabled: false,
  requires2fa: false,
  scopes: ["mcp:read", "mcp:drafts:write"],
  customerAccessApproved: false,
};
let actor: McpActor, url: string, server: Server;
const resolve = vi.fn(async (_token: string) => actor);
const analytics = {
  catalog: () => ({ metrics: ["event_count"] }),
  appCatalog: vi.fn(async () => ({ metrics: ["event_count"] })),
  events: vi.fn(async () => ({ rows: [], denominator: 0 })),
};
const segments = { create: vi.fn(async () => ({ id, revision: 1 })) };
const journeys = {
  create: vi.fn(async () => ({ id, revision: "a".repeat(64) })),
  validate: vi.fn(async () => ({ issues: [], estimated_count: null })),
};
const read = {
  app: vi.fn(async (a: McpActor) => ({ app_id: a.appId, role: a.role })),
};
const rate = {
  check: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
};
const redis = {
  set: vi.fn(async () => "OK" as string | null),
  eval: vi.fn(async () => 1),
};
const audit = { record: vi.fn(async () => {}) };

async function rpc(
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer synthetic",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await response.text();
  const json = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? JSON.parse(
        raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      )
    : JSON.parse(raw);
  return { response, json };
}

describe("remote MCP over actual HTTP transport", () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    let controller: McpController;
    app.all("/mcp", (req, res) => {
      void controller
        .handle(req, res)
        .catch((error) =>
          res
            .status(error instanceof HttpException ? error.getStatus() : 500)
            .json({ error: "request_failed" }),
        );
    });
    server = await new Promise<Server>((done) => {
      const listener = app.listen(0, "127.0.0.1", () => done(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oauth = {
      issuer: url,
      consoleUrl: "http://localhost:13100",
      enabled: () => {},
      resolve,
    };
    controller = new McpController(
      oauth as unknown as McpOAuth,
      analytics as unknown as AnalysisService,
      segments as unknown as SegmentDrafts,
      journeys as unknown as JourneyDrafts,
      read as unknown as McpRead,
      rate as unknown as RateLimitService,
      audit as unknown as AuditService,
      redis as unknown as Redis,
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    actor = { ...baseActor, scopes: [...baseActor.scopes] };
    resolve.mockImplementation(async () => actor);
    redis.set.mockResolvedValue("OK");
  });
  afterAll(async () => {
    await new Promise<void>((done, fail) =>
      server.close((error) => (error ? fail(error) : done())),
    );
  });

  it("advertises OAuth discovery and rejects wrong origins/hosts", async () => {
    const response = await fetch(`${url}/mcp`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `${url}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(
      (await rpc("tools/list", {}, { origin: "https://evil.example" })).response
        .status,
    ).toBe(403);
    const hostStatus = await new Promise<number | undefined>((done, fail) => {
      request(
        `${url}/mcp`,
        { headers: { host: "evil.example" } },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      )
        .on("error", fail)
        .end();
    });
    expect(hostStatus).toBe(403);
    resolve.mockRejectedValueOnce(new Error("private database detail"));
    expect((await rpc("tools/list")).response.status).toBe(500);
  });
  it("initializes with the official SDK and exposes resources/prompts", async () => {
    const { json } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "synthetic integration", version: "1" },
    });
    expect(json.result.serverInfo.name).toBe("nudgeon");
    expect(json.result.capabilities.tools).toBeDefined();
    const resources = (await rpc("resources/list")).json.result.resources;
    expect(resources.map((r: { uri: string }) => r.uri)).toEqual(
      expect.arrayContaining([
        "nudgeon://catalog",
        "nudgeon://metrics",
        "nudgeon://segment-schema",
        "nudgeon://journey-schema",
      ]),
    );
    const content = (
      await rpc("resources/read", { uri: "nudgeon://journey-schema" })
    ).json.result.contents[0];
    expect(JSON.parse(content.text).properties.nodes).toBeDefined();
    expect((await rpc("prompts/list")).json.result.prompts).toHaveLength(3);
  });
  it("filters tools by role/consent and never exposes publishing or arbitrary SQL", async () => {
    actor = { ...actor, role: "viewer", scopes: ["mcp:read"] };
    const viewer = (await rpc("tools/list")).json.result.tools;
    expect(
      viewer.some((t: { name: string }) => t.name === "get_customer_context"),
    ).toBe(true);
    expect(
      viewer.some((t: { name: string }) =>
        /^(create|update|search_customers|get_customer_profile)/.test(t.name),
      ),
    ).toBe(false);
    actor = { ...baseActor, scopes: [...baseActor.scopes] };
    const editor = (await rpc("tools/list")).json.result.tools;
    expect(
      editor.some((t: { name: string }) => t.name === "create_journey_draft"),
    ).toBe(true);
    expect(
      editor.some((t: { name: string }) =>
        /activate|publish|promote|delete|sql|credential/.test(t.name),
      ),
    ).toBe(false);
    expect(
      editor.find((t: { name: string }) => t.name === "query_message_metrics")
        .inputSchema.properties.time_basis,
    ).toBeUndefined();
  });
  it("binds calls to the connected app and returns structured draft review links", async () => {
    const result = (
      await rpc("tools/call", { name: "get_app_context", arguments: {} })
    ).json.result;
    expect(result.structuredContent.app_id).toBe(aid);
    await rpc("tools/call", {
      name: "get_app_context",
      arguments: { app_id: id },
    });
    expect(read.app).toHaveBeenCalledTimes(1);
    const draft = (
      await rpc("tools/call", {
        name: "create_journey_draft",
        arguments: { name: "Welcome", definition: {}, request_id: id },
      })
    ).json.result;
    expect(draft.structuredContent.console_url).toBe(
      `http://localhost:13100/journeys/${id}?app_id=${aid}`,
    );
    expect(draft.structuredContent.issues).toEqual([]);
    expect(journeys.validate).toHaveBeenCalledWith(expect.anything(), aid, id, {
      estimateAudience: false,
    });
  });
  it("rechecks current permission before a call from an already discovered tool list", async () => {
    resolve
      .mockResolvedValueOnce(actor)
      .mockResolvedValueOnce({
        ...actor,
        role: "viewer",
        scopes: ["mcp:read"],
      });
    const result = (
      await rpc("tools/call", {
        name: "create_segment_draft",
        arguments: { name: "Target", definition: {}, request_id: id },
      })
    ).json.result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("INSUFFICIENT_SCOPE");
    expect(segments.create).not.toHaveBeenCalled();
    resolve
      .mockResolvedValueOnce(actor)
      .mockRejectedValueOnce(new UnauthorizedException());
    expect(
      (await rpc("tools/call", { name: "get_app_context", arguments: {} })).json
        .result.structuredContent.error.code,
    ).toBe("CONNECTION_EXPIRED");
  });
  it("bounds concurrent analytics, releases the lock and sanitizes failures", async () => {
    redis.set.mockResolvedValueOnce(null);
    const params = { name: "query_event_metrics", arguments: {} };
    expect(
      (await rpc("tools/call", params)).json.result.structuredContent.error
        .code,
    ).toBe("QUERY_LIMIT");
    expect(analytics.events).not.toHaveBeenCalled();
    analytics.events.mockRejectedValueOnce(
      new Error("SELECT sensitive profile payload"),
    );
    const result = (await rpc("tools/call", params)).json.result;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(redis.eval).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          app_id: aid,
          result: "INTERNAL_ERROR",
        }),
      }),
    );
  });
});
