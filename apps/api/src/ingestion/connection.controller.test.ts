import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { ConnectionController } from "./connection.controller";
import { ApiKeyGuard, type AuthedRequest } from "../auth/api-key.guard";

describe("integration handshake", () => {
  it("requires the server key guard and scopes a read-only query to its app and tenant", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "app", name: "Supple", fcm: true, apns: false }] });
    const controller = new ConnectionController({ query } as unknown as Pool);
    const result = await controller.connection({ apiKey: { appId: "app", tenantId: "tenant" } } as AuthedRequest);
    expect(query.mock.calls[0]![1]).toEqual(["app", "tenant"]);
    expect(query.mock.calls[0]![0]).toContain("a.tenant_id=$2");
    expect(query.mock.calls[0]![0]).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(result).toEqual({ service: "nudgeon", contract_version: 1, tenant_id: "tenant",
      app: { id: "app", name: "Supple" }, capabilities: { track: true }, push: { fcm: true, apns: false } });
    expect(Reflect.getMetadata("__guards__", ConnectionController)).toContain(ApiKeyGuard);
    expect(Reflect.getMetadata("api_key_kinds", controller.connection)).toEqual(["server"]);
  });
  it("does not verify a missing app", async () => {
    const controller = new ConnectionController({ query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool);
    await expect(controller.connection({ apiKey: { appId: "other", tenantId: "tenant" } } as AuthedRequest)).rejects.toThrow("App not found");
  });
});
