#!/usr/bin/env bash
# CLAUDE.md 절대 규칙의 기계 강제 (DEV-sub-08 §1).
# CI와 로컬 양쪽에서 실행 가능. 위반 발견 시 exit 1.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 검사 대상 소스 파일 (생성 코드·의존성 제외)
src_files() {
  find apps packages -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.go' \) \
    ! -path '*/node_modules/*' ! -path '*/dist/*' ! -path '*/.next/*' \
    ! -path '*/generated/*' ! -name '*_gen.go' ! -name '*.gen.ts' \
    ! -name '*.d.ts' 2>/dev/null || true
}

# 규칙 1: 파일 1,000라인 제한 (생성 코드 제외)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  lines=$(wc -l <"$f")
  if [ "$lines" -gt 1000 ]; then
    echo "RULE-1 위반: $f — ${lines}라인 (제한 1,000)"
    fail=1
  fi
done < <(src_files)

# 규칙 2: libqueue 외부에서 Redis Streams 직접 호출 금지
# (xadd/xreadgroup/xack/xautoclaim/xgroup 호출을 libqueue 패키지 밖에서 금지)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    packages/libqueue-ts/*|packages/libqueue-go/*) continue ;;
  esac
  if grep -nEi '\.\s*x(add|readgroup|ack|autoclaim|group)' "$f" >/dev/null; then
    echo "RULE-2 위반: $f — Redis Streams 직접 호출 (libqueue 경유 필수)"
    grep -nEi '\.\s*x(add|readgroup|ack|autoclaim|group)' "$f" | head -3
    fail=1
  fi
done < <(src_files)

# 규칙 3: Go에서 time.Now() 직접 호출 금지 (주입 Clock 강제)
# 예외: clock 패키지 자신, *_test.go, 조립 지점(cmd/worker),
#       시간가속 불필요한 일회성 CLI 운영 도구(cmd/seed·cmd/loadgen)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *ated/*|*/clock/*|*_test.go) continue ;;
    */cmd/worker/*|*/cmd/seed/*|*/cmd/loadgen/*) continue ;;
  esac
  if [[ "$f" == *.go ]] && grep -n 'time\.Now()' "$f" >/dev/null; then
    echo "RULE-3 위반: $f — time.Now() 직접 호출 (clock.Clock 주입 사용)"
    grep -n 'time\.Now()' "$f" | head -3
    fail=1
  fi
done < <(src_files)

# 규칙 4: 콘솔에서 수기 fetch 금지 (openapi 생성 클라이언트만)
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    apps/console/*) ;;
    *) continue ;;
  esac
  if grep -nE '(^|[^.a-zA-Z])fetch\(' "$f" >/dev/null; then
    echo "RULE-4 위반: $f — 콘솔 수기 fetch (openapi 생성 클라이언트 사용)"
    grep -nE '(^|[^.a-zA-Z])fetch\(' "$f" | head -3
    fail=1
  fi
done < <(src_files)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "절대 규칙 위반이 발견되었습니다. CLAUDE.md를 참조하세요."
  exit 1
fi
echo "절대 규칙 검사 통과 ✓"
