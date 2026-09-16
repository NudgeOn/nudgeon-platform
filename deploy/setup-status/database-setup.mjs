import { readFile, writeFile, link, unlink } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest();
export function validPassword(value) {
  return typeof value === "string" && [...value].length >= 12 && [...value].length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}
export function databaseSetup(env = process.env) {
  const required = env.NUDGEON_DATABASE_SETUP_REQUIRED === "true";
  const file = env.NUDGEON_DATABASE_CONFIG_FILE ?? "/tmp/nudgeon-database-config.json";
  const read = async () => JSON.parse(await readFile(file, "utf8"));
  return {
    async status() {
      if (!required) return { required: false, submitted: false };
      try { const saved = await read(); return { required: true, submitted: validPassword(saved.password) }; }
      catch { return { required: true, submitted: false }; }
    },
    async submit(request, body) {
      if (!required) return { status: 409, error: "setup_closed" };
      if (!env.NUDGEON_PUBLIC_ORIGIN || request.headers.origin !== env.NUDGEON_PUBLIC_ORIGIN) return { status: 403, error: "invalid_origin" };
      let token;
      try { token = (await readFile(env.NUDGEON_SETUP_TOKEN_FILE, "utf8")).trim(); }
      catch { return { status: 503, error: "setup_unavailable" }; }
      if (!token || typeof body.token !== "string" || body.token.length > 256 || !timingSafeEqual(digest(body.token), digest(token))) {
        return { status: 403, error: "invalid_token" };
      }
      if (!validPassword(body.password) || typeof body.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) {
        return { status: 400, error: "invalid_password" };
      }
      // Publish one complete file atomically. Concurrent submissions cannot overwrite it.
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ request_id: body.request_id, password: body.password }), { mode: 0o600, flag: "wx" });
        try { await link(temp, file); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const saved = await read();
          if (saved.request_id !== body.request_id || !timingSafeEqual(digest(saved.password), digest(body.password))) return { status: 409, error: "already_submitted" };
        }
        return { status: 200, submitted: true };
      } catch { return { status: 503, error: "save_failed" }; }
      finally { await unlink(temp).catch(() => {}); }
    },
    // Docker exec only: the host installer consumes stdout into a shell variable, never a web response.
    async readForInstaller() {
      if (!required) throw new Error("setup_closed");
      const saved = await read();
      if (!validPassword(saved.password)) throw new Error("invalid_password");
      return saved.password;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "read") {
  try { process.stdout.write(await databaseSetup().readForInstaller()); }
  catch { process.exitCode = 1; }
}
