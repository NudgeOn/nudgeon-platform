import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { createServer, type Server } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Pool } from "pg";
import { CONFIG, PG } from "../infra/infra.module";
import type { AppConfig } from "../config";
import { loadMasterKey } from "../crypto/envelope";
import { type SourceFile, type Manifest, hash } from "./bundle";

export interface Artifact {
  html: string;
  manifest: Manifest;
  artifact_sha256: string;
  source_bytes: number;
  files: SourceFile[];
}
@Injectable()
export class InAppAssets implements OnModuleInit, OnApplicationShutdown {
  private server?: Server;
  readonly root = resolve(process.env.IN_APP_ASSET_DIR ?? ".nudgeon-assets");
  readonly origin = process.env.CONTENT_PUBLIC_ORIGIN ?? "";
  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}
  status() {
    return {
      enabled: process.env.IN_APP_ENABLED === "true",
      campaigns_enabled: process.env.IN_APP_CAMPAIGNS_ENABLED === "true",
      content_origin: this.origin,
      format_version: 1,
    };
  }
  requireEnabled() {
    if (!this.status().enabled || !this.origin)
      throw new ServiceUnavailableException({
        code: "IN_APP_DISABLED",
        message:
          "Configure IN_APP_ENABLED, CONTENT_PUBLIC_ORIGIN and the NudgeOn asset volume.",
      });
  }
  private key() {
    return createHmac("sha256", loadMasterKey())
      .update("nudgeon-in-app-preview-v1")
      .digest();
  }
  private dir(tenant: string, app: string, id: string) {
    for (const v of [tenant, app, id])
      if (!/^[\da-f-]{36}$/i.test(v)) throw new NotFoundException();
    return join(this.root, tenant, app, id);
  }
  async store(tenant: string, app: string, id: string, artifact: Artifact) {
    this.requireEnabled();
    const target = this.dir(tenant, app, id),
      temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(temp, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(temp, "artifact.json"), JSON.stringify(artifact), {
        mode: 0o600,
      });
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { recursive: true, force: true });
      throw e;
    }
  }
  async remove(tenant: string, app: string, id: string) {
    await rm(this.dir(tenant, app, id), { recursive: true, force: true });
  }
  async read(tenant: string, app: string, id: string): Promise<Artifact> {
    const result = await this.pg.query(
      "SELECT artifact_sha256 FROM in_app_revisions WHERE tenant_id=$1 AND app_id=$2 AND id=$3",
      [tenant, app, id],
    );
    if (!result.rowCount) throw new NotFoundException();
    const artifact = JSON.parse(
      await readFile(join(this.dir(tenant, app, id), "artifact.json"), "utf8"),
    ) as Artifact;
    if (hash(artifact.html) !== result.rows[0].artifact_sha256)
      throw new ServiceUnavailableException("ASSET_HASH_MISMATCH");
    return artifact;
  }
  preview(tenant: string, app: string, id: string) {
    this.requireEnabled();
    const expires_at = new Date(Date.now() + 600_000).toISOString();
    const payload = Buffer.from(
      JSON.stringify({ tenant, app, id, exp: Date.parse(expires_at) }),
    ).toString("base64url");
    const sig = createHmac("sha256", this.key())
      .update(payload)
      .digest("base64url");
    return { url: `${this.origin}/preview/${payload}.${sig}`, expires_at };
  }
  async onModuleInit() {
    if (!this.status().enabled) return;
    this.requireEnabled();
    const origin = new URL(this.origin),
      consoleOrigin = new URL(this.cfg.corsOrigin);
    if (
      origin.hostname === consoleOrigin.hostname ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    )
      throw new Error(
        "CONTENT_PUBLIC_ORIGIN requires a separate content hostname and no path/credentials",
      );
    if (
      origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
      )
    )
      throw new Error(
        "Content origin requires HTTPS (loopback development excepted)",
      );
    this.key();
    await mkdir(this.root, { recursive: true });
    this.server = createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      );
      // An HTTP sandbox survives opening the untrusted document outside the console iframe.
      res.setHeader(
        "Content-Security-Policy",
        `sandbox allow-scripts; frame-ancestors ${consoleOrigin.origin}; form-action 'none'; base-uri 'none'`,
      );
      if (req.method === "GET" && req.url === "/healthz") {
        res.end("ok");
        return;
      }
      try {
        if (
          req.method !== "GET" ||
          !req.url?.startsWith("/preview/") ||
          req.url.length > 2048
        )
          throw Error();
        const parts = req.url.slice(9).split(".");
        if (parts.length !== 2) throw Error();
        const [payload, sig] = parts as [string, string],
          expected = createHmac("sha256", this.key()).update(payload).digest();
        const supplied = Buffer.from(sig, "base64url");
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw Error();
        const data = JSON.parse(Buffer.from(payload, "base64url").toString());
        if (typeof data.exp !== "number" || data.exp < Date.now())
          throw Error();
        const artifact = await this.read(data.tenant, data.app, data.id);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(artifact.html);
      } catch {
        res.statusCode = 404;
        res.end("Preview unavailable or expired");
      }
    });
    await new Promise<void>((ok, no) => {
      this.server!.once("error", no);
      this.server!.listen(
        Number(process.env.CONTENT_PORT ?? 8082),
        "0.0.0.0",
        ok,
      );
    });
  }
  async onApplicationShutdown() {
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
