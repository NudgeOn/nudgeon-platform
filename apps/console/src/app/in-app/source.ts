import { zip } from "fflate";
import type { InAppFile, InAppManifest } from "@nudgeon/api-client";
export const encode = (text: string) =>
  bytesToBase64(new TextEncoder().encode(text));
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export const decode = (base64: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
  );
export const defaultManifest: InAppManifest = {
  format_version: 1,
  entrypoint: "index.html",
  bridge_version: 1,
  display: { type: "transparent", backdrop_opacity: 0.4 },
  actions: { join_event: { type: "open_url", url: "https://nudgeon.io" } },
};
export function exampleFiles(): InAppFile[] {
  return [
    {
      path: "index.html",
      base64: encode(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body><main><span class="tag">NUDGEON · SPECIAL EVENT</span><div class="art">✦</div><h1>A little surprise,<br>just for you.</h1><p>Your next favorite moment starts here.</p><button id="join">Explore the event ↗</button><small>Made with NudgeOn</small></main><script src="main.js"></script></body></html>',
      ),
    },
    {
      path: "styles.css",
      base64: encode(
        "*{box-sizing:border-box}html,body{margin:0;background:transparent;font-family:system-ui,sans-serif}body{min-height:100vh;display:grid;place-items:center;padding:30px 24px;color:#17251e}main{width:100%;max-width:330px;text-align:center;background:#f1f7dd;border-radius:28px;padding:34px 24px;box-shadow:0 16px 70px #1233}.tag{font-size:10px;letter-spacing:2px;font-weight:700}.art{color:#466840;font-size:104px;line-height:1.3}h1{font-size:30px;line-height:1.15;letter-spacing:-1px;margin:8px 0 18px}p{font-size:14px;line-height:1.6;color:#53644f;margin:0 0 30px}button{width:100%;border:0;border-radius:14px;background:#273e2c;color:white;padding:17px 10px;font-size:14px;font-weight:700;cursor:pointer}small{display:block;margin-top:20px;color:#738069;font-size:10px}",
      ),
    },
    {
      path: "main.js",
      base64: encode(
        "window.addEventListener('nudgeon:ready', () => { document.querySelector('#join').addEventListener('click', () => { window.nudgeonBridge.performAction('join_event').catch(() => {}); }); });",
      ),
    },
  ];
}

export async function packageFiles(files: InAppFile[]): Promise<string> {
  const contents: Record<string, Uint8Array> = Object.create(null);
  for (const file of files)
    contents[file.path] = Uint8Array.from(atob(file.base64), (c) =>
      c.charCodeAt(0),
    );
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    zip(contents, { level: 6 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  if (bytes.length > 10 * 1024 * 1024) throw new Error("ZIP exceeds 10 MiB");
  return bytesToBase64(bytes);
}
