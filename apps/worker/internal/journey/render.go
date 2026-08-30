package journey

import (
	"regexp"
	"strings"
)

var varPattern = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`)

// Render는 {{key}} 변수를 프로필 속성으로 치환한다 (PRD-04 2.3 간이 구현).
// 값 없으면 빈 문자열로 대체 (MVP — 기본값 fallback 문법은 S5).
func Render(template string, attrs map[string]string) string {
	return varPattern.ReplaceAllStringFunc(template, func(m string) string {
		key := strings.TrimSpace(varPattern.FindStringSubmatch(m)[1])
		if v, ok := attrs[key]; ok {
			return v
		}
		return ""
	})
}
