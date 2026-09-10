// NestJS 컨트롤러 소스에서 (method, path) 목록을 뽑는다 — 격리 스위트가 "전 경로"를 대입할 때의 출처.
// OpenAPI 스펙은 아직 수기(ADR-5 부분)라 소스가 더 정확하다. 데코레이터 정규식 스캔이므로
// 동적으로 등록된 라우트는 잡지 못한다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".controller.ts")) out.push(p);
  }
  return out;
}

const join = (a, b) => ("/" + [a, b].filter(Boolean).join("/")).replace(/\/+/g, "/").replace(/\/$/, "") || "/";

export function extractRoutes(srcDir) {
  const routes = [];
  for (const file of walk(srcDir)) {
    const src = readFileSync(file, "utf8");
    const base = src.match(/@Controller\((?:"([^"]*)")?\)/)?.[1] ?? "";
    const re = /@(Get|Post|Put|Patch|Delete)\((?:"([^"]*)")?\)/g;
    let m;
    while ((m = re.exec(src))) {
      routes.push({ method: m[1].toUpperCase(), path: join(base, m[2] ?? ""), file: path.relative(srcDir, file) });
    }
  }
  return routes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const routes = extractRoutes(process.argv[2] ?? "apps/api/src");
  for (const r of routes) console.log(`${r.method.padEnd(6)} ${r.path}  (${r.file})`);
  console.error(`${routes.length} routes`);
}
