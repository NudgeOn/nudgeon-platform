import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { can } from "../authz/permissions";
import type { SessionMember } from "../auth/session.service";

export const MCP_SCOPES = [
  "mcp:read",
  "mcp:drafts:write",
  "mcp:customers:read",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export interface McpActor extends SessionMember {
  connectionId: string;
  appId: string;
  scopes: string[];
  customerAccessApproved: boolean;
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const uuid = z.string().uuid();
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      code: "INVALID_INPUT",
      issues: result.error.issues.map((i) => ({
        path: i.path,
        message: i.message,
      })),
    });
  return result.data;
}
export function scopesFor(
  member: Pick<SessionMember, "role">,
  scopes: readonly string[],
  approved: boolean,
): string[] {
  return scopes.filter((scope) =>
    scope === "mcp:read"
      ? can(member.role, "analytics:read")
      : scope === "mcp:drafts:write"
        ? can(member.role, "journeys:write") &&
          can(member.role, "segments:write")
        : scope === "mcp:customers:read"
          ? approved && can(member.role, "users:read")
          : false,
  );
}
export function requireScope(actor: McpActor, scope: McpScope): void {
  if (
    !scopesFor(actor, actor.scopes, actor.customerAccessApproved).includes(
      scope,
    )
  )
    throw new ForbiddenException({
      code: "INSUFFICIENT_SCOPE",
      required_scope: scope,
    });
}
export function assertEnabled(enabled?: boolean): void {
  if (!enabled) throw new NotFoundException("MCP is disabled");
}
export function redirectAllowed(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function isAdmin(role: string): boolean {
  return role === "owner" || role === "admin";
}
export const authorizeSchema = z.object({
  response_type: z.literal("code"),
  client_id: uuid,
  redirect_uri: z.string().max(2048),
  state: z.string().min(1).max(2048),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
  resource: z.string().url(),
  scope: z.string().max(256).default("mcp:read"),
});
export function parseScopes(value: string): McpScope[] {
  return parse(z.array(z.enum(MCP_SCOPES)).min(1).max(3), [
    ...new Set(value.trim().split(/\s+/)),
  ]);
}
export function authorizeUrl(
  redirect: string,
  state: string,
  values: Record<string, string>,
): string {
  const url = new URL(redirect);
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(values))
    url.searchParams.set(key, value);
  return url.toString();
}
