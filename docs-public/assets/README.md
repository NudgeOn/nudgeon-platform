# NudgeOn 브랜드 자산

- 파일
  - `nudgeon-logo.svg` — 가로형 로고 락업(N 마크 + NudgeOn 워드마크). 원본입니다.
  - `nudgeon-logo.png` — 락업의 1600px 래스터 내보내기. README·문서용.
  - `nudgeon-mark.svg` — N 마크 단독. 아바타·파비콘용 정사각(512×512).
- 방향: 하나로 이어진 N 형태. 오른쪽 기둥이 살짝 높고 앞으로 나와 있어 다른 상징을 더하지 않고 "작은 밀어주기(nudge)"를 표현합니다.
- 색상
  - 마크·워드마크: `#0B2438`
  - 배경: `#FFFFFF`
- 조직 프로필([`NudgeOn/.github`](https://github.com/NudgeOn/.github))의 `profile/assets/`와 동일한 원본을 씁니다. 한쪽만 바꾸지 말고 두 저장소를 함께 갱신하세요.
- 라이선스: NudgeOn 이름·워드마크·로고는 저장소의 Apache-2.0 허여 대상이 아닙니다. 사용 조건은 [`TRADEMARKS.md`](../../TRADEMARKS.md)와 [`docs-public/LICENSING.md`](../LICENSING.md)를 따릅니다. `architecture.svg` 등 별도 제외 표시가 없는 프로젝트 문서 자산은 Apache-2.0 범위에 포함됩니다.

## 다시 내보내는 방법

락업 SVG의 워드마크는 텍스트 요소입니다. 렌더러에 따라 대체 글꼴로 표시될 수 있으므로 **배포용은 PNG를 쓰고**, PNG는 아래로 다시 만듭니다.

```bash
rsvg-convert -w 1600 nudgeon-logo.svg -o nudgeon-logo.png   # 락업
rsvg-convert -w 1024 -h 1024 nudgeon-mark.svg -o avatar.png  # 조직 아바타
```
