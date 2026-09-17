# NudgeOn 브랜드 자산

- `nudgeon-logo.svg` — 세 타일 심볼 + NudgeOn 워드마크를 조합한 가로형 원본.
- `nudgeon-logo.png` — 1600px 래스터 내보내기. README·문서용.
- `nudgeon-mark.svg` — 심볼 단독. 아바타·파비콘용 정사각(512×512).

방향: **행동의 연쇄**. 같은 크기의 둥근 타일 세 개가 0°, 14°, 28°로 차례로 기울어집니다. 작은 행동이 다음 행동으로 이어지는 넛지와 자동화의 흐름을 표현합니다.

- 마크·워드마크: `#0B2438`
- 배경: `#FFFFFF`
- 원본은 이 폴더에 있으며 마케팅 사이트, 문서 사이트, 콘솔에서 같은 심볼을 사용합니다.
- 조직 프로필([`NudgeOn/.github`](https://github.com/NudgeOn/.github))의 `profile/assets/`도 함께 갱신합니다. `nudgeon-logo.svg/png`는 조직 저장소에서 `nudgeon-lockup.svg/png`로 사용합니다.
- 라이선스: NudgeOn 이름·워드마크·로고는 저장소의 Apache-2.0 허여 대상이 아닙니다. [TRADEMARKS.md](../../TRADEMARKS.md)와 [LICENSING.md](../LICENSING.md)를 따릅니다.

## 다시 내보내기

프로젝트 루트에서 `bash scripts/export-brand-assets.sh`를 실행합니다. `rsvg-convert`가 필요합니다.
워드마크는 텍스트 요소이므로 렌더러와 설치 글꼴에 따라 차이가 있을 수 있습니다. 고정된 표시가 필요한 README와 조직 프로필에는 PNG를 사용합니다.

조직 저장소에도 원본 두 개, 1600px 락업 PNG, 1024px 아바타 PNG를 함께 복사하세요. 조직 아바타 PNG는 GitHub 조직 설정에서 별도로 적용해야 합니다.
