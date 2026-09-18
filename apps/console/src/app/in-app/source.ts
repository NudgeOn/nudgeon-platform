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
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body><main><span class="tag">NUDGEON · SPECIAL EVENT</span><div class="art">✦</div><h1>A little surprise,<br>just for you.</h1><p>Your next favorite moment starts here.</p><button id="join" disabled>Explore the event ↗</button><div class="dismiss-actions"><button id="hide-today" type="button" disabled>오늘 하루 안 보기</button><button id="close" type="button" disabled>닫기</button></div><p id="status" role="status" aria-live="polite"></p><small id="time-zone">캠페인 시간대의 다음 자정까지</small></main><script src="main.js"></script></body></html>',
      ),
    },
    {
      path: "styles.css",
      base64: encode(
        "*{box-sizing:border-box}html,body{margin:0;background:transparent;font-family:system-ui,sans-serif}body{height:100vh;height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;color:#17251e}main{width:100%;max-width:330px;max-height:100%;overflow-y:auto;overscroll-behavior:contain;text-align:center;background:#f1f7dd;border-radius:28px;padding:34px 24px;box-shadow:0 16px 70px #1233}.tag{font-size:10px;letter-spacing:2px;font-weight:700}.art{color:#466840;font-size:104px;line-height:1.3}h1{font-size:30px;line-height:1.15;letter-spacing:-1px;margin:8px 0 18px}p{font-size:14px;line-height:1.6;color:#53644f;margin:0 0 30px}button{width:100%;border:0;border-radius:14px;background:#273e2c;color:white;padding:17px 10px;font-size:14px;font-weight:700;cursor:pointer}.dismiss-actions{display:flex;gap:12px;margin-top:20px}.dismiss-actions button{width:auto;flex:1;background:transparent;color:#354b32;border:1px solid #879877;padding:12px 6px;font-size:12px;min-height:44px}button:focus-visible{outline:3px solid #64884b;outline-offset:3px}button:disabled{opacity:.6;cursor:wait}#status{font-size:12px;margin:12px 0 0;color:#714322}#status:empty{display:none}small{display:block;margin-top:16px;color:#738069;font-size:10px}@media(max-height:620px){body{padding:16px 24px}main{padding:22px 24px}.art{font-size:64px;line-height:1.1}h1{font-size:26px;margin:8px 0 12px}p{margin-bottom:18px}.dismiss-actions{margin-top:12px}small{margin-top:12px}}@media(max-height:440px){body{padding:12px 20px}main{padding:16px 20px}.art{display:none}h1{font-size:22px}p{font-size:12px;margin-bottom:12px}button{padding:12px 10px;min-height:44px}}",
      ),
    },
    {
      path: "main.js",
      base64: encode(
        `window.addEventListener('nudgeon:ready', () => {
  const status = document.querySelector('#status');
  document.querySelector('#time-zone').textContent = (window.nudgeonBridge.timeZone || 'UTC') + ' 기준 다음 자정까지';
  function bind(id, action) {
    const button = document.querySelector(id);
    button.disabled = false;
    button.addEventListener('click', async () => {
      button.disabled = true; status.textContent = '';
      try {
        const result = await action();
        if (result && result.preview) status.textContent = '미리보기에서는 실제로 닫거나 숨기지 않아요. 게시한 캠페인에서 확인하세요.';
      } catch (error) {
        status.textContent = error.message === 'LIVE_CAMPAIGN_REQUIRED'
          ? '테스트 연결에서는 숨김이 저장되지 않아요. 게시한 캠페인에서 확인하세요.'
          : '처리하지 못했어요. SDK 0.2.1 이상인지 확인하고 다시 시도해 주세요.';
      } finally { button.disabled = false; }
    });
  }
  bind('#join', () => window.nudgeonBridge.performAction('join_event'));
  bind('#hide-today', () => window.nudgeonBridge.hideToday());
  bind('#close', () => window.nudgeonBridge.dismiss('close_button'));
});`,
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

/** Startup ads are opaque documents; the SDK owns the 3–5 second display timer. */
export const launchManifest: InAppManifest = {
  ...defaultManifest,
  display: { type: "fullscreen", backdrop_opacity: 0 },
  actions: {},
};
export function launchExampleFiles(): InAppFile[] {
  return [
    { path: "index.html", base64: encode(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="styles.css"></head><body><main><header>WORSHIPLOG <span>SPONSORED</span></header><section><p class="eyebrow">A MOMENT OF INSPIRATION</p><h1>오늘의 찬양,<br>새로운 영감.</h1><p class="description">마음을 채우는 찬양을<br>지금 만나보세요.</p><div class="art" aria-hidden="true">✦</div></section><footer><strong>당신의 예배를 함께 기록합니다.</strong><small>잠시 후 메인 화면으로 이동합니다</small></footer></main></body></html>`) },
    { path: "styles.css", base64: encode(`*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:#142e25;color:#f1f7dc;font-family:system-ui,sans-serif}main{height:100vh;height:100dvh;min-height:320px;display:flex;flex-direction:column;overflow:hidden;padding:max(28px,env(safe-area-inset-top)) 30px max(28px,env(safe-area-inset-bottom));background:radial-gradient(ellipse at 90% 55%,#477a53 0,transparent 55%),#142e25}header{display:flex;justify-content:space-between;gap:20px;font-size:12px;font-weight:800;letter-spacing:2px}header span{font-size:9px;opacity:.65}section{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}.eyebrow{font-size:10px;letter-spacing:2px;color:#b3d289}h1{font-size:clamp(36px,11vw,68px);line-height:1.15;letter-spacing:-2px;margin:16px 0 24px}.description{font-size:16px;line-height:1.7;opacity:.85;margin:0}.art{align-self:flex-end;font-size:clamp(100px,43vw,240px);line-height:1;color:#d5ea94;margin-top:20px}footer{display:flex;flex-direction:column;gap:12px}footer strong{font-size:13px;font-weight:500}footer small{font-size:11px;opacity:.65}@media(max-height:540px){main{padding:24px}.art{position:absolute;right:20px;top:28%;font-size:130px;opacity:.35}h1{font-size:34px;margin:10px 0}.description{font-size:13px}footer{gap:5px}}`) },
  ];
}
