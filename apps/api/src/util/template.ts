/**
 * {{ key }} 개인화 치환 — 워커 render.go와 동일 규약(영숫자/언더스코어 키, 공백 허용).
 * 값 없으면 빈 문자열. 발송·미리보기 공통으로 사용해 결과가 일치하도록 한다.
 */
const VAR = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(tpl: string, vars: Record<string, unknown> = {}): string {
  return tpl.replace(VAR, (_m, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}
