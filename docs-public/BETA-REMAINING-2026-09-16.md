# NudgeOn 남은 작업 — 2026-09-16

기준: `main`의 `7306a20`과 [출시 체크리스트](RELEASE-CHECKLIST.md). 해당 커밋의 CI는 통과했으며 확인 시점의 열린 PR·이슈는 0건이었다. 이슈가 없는 것과 베타 게이트 완료는 다르다. 현재 상태는 **파트너 베타 후보**다.

## 우선순위

| 순서 | 항목 | 현재 확인한 상태 | 완료 증거 |
|---|---|---|---|
| 1 | B-2: SDK 0.1.2 실단말 재검증 | iOS·Android 0.1.2 공개 배포 완료. 이전 M-1 실기기 성공 기록만으로 새 버전 검증을 대신할 수 없음 | iPhone·Android에서 전경/배경/종료 상태 수신, 탭·딥링크, 같은 `message_id`의 중복 표시 억제, 도달·열기 리포트 대사 |
| 2 | B-7: godspell 스테이징 파일럿 | SDK 통합 완료. 9월 12일 로컬 리허설의 receipt 4건·저니 상태 3건은 실제 푸시 수신 증거가 아님 | 앱의 HTTPS API 주소·앱 키와 공급자 자격증명 확인 후 실제 기기에서 콘티 변경 이벤트→거래성 알림→탭·열기 검증. 재발송 간격·중복도 확인 |
| 3 | B-1: RN·Flutter 공개 배포 | `@nudgeon/react-native`, `nudgeon_flutter` 공개 레지스트리 조회 모두 404 | RN: `NPM_TOKEN` 설정 후 publish 워크플로 실행. Flutter: 첫 `flutter pub publish` 후 자동 게시 연결 |
| 4 | B-6: 네 SDK 설치·계약 검증 | 공개 배포가 끝난 패키지 기준의 전체 결과 필요 | 새 앱에서 공개 좌표로 설치하고 시작·토큰·이벤트·수신·열기 및 푸시 계약 확인 |
| 5 | B-3: 외부 개발자 온보딩 | 내부 드라이런 성공, 외부 3명 기록은 미완료 | 문서만 보고 30분 안에 첫 푸시 성공, 막힌 단계와 소요 시간 기록 |
| 6 | B-4: 관리형 저장소 검증 | RDS·ElastiCache·ClickHouse 실환경 기록 필요 | TLS·인증·재연결·마이그레이션을 실제 대상에서 검증 |
| 7 | B-5: 운영 규모 부하·장시간 시험 | 로컬 VM 결과는 운영 규모 합격 근거가 아님 | 목표 5,000 events/s·100만 토큰·24시간 시험과 지연·실패율·복구 결과 |

godspell의 마지막 확인 기록은 `66f02c9`다. 9월 12일 빌드 기록의 API 주소·키 누락은 **당시 상태**이며, 새 빌드에서는 다시 확인해야 한다. 실제 푸시·실단말·외부 사용자 검증은 홈페이지 개편으로 완료 처리하지 않는다.

## 이번 화면 개선

- Vercel에서 운영하던 소개 사이트 원본을 `apps/marketing-site`로 복구해 버전 관리에 포함했다. 기존 한·영 가이드 URL을 유지한다.
- 환영·재방문·업데이트 알림 세 예제로 저니 단계 선택, 메시지 편집, 알림 미리보기, 흐름 재생을 제공한다. 홈페이지 데모는 브라우저 안에서만 동작하며 실제 메시지를 보내지 않는다.
- 콘솔 저니 목록에 시작 예제를 추가했다. Graph V2 지원 앱에서 편집 가능한 초안으로 열리며, 자동 활성화하지 않는다.
- 오픈소스 셀프호스팅과 현재 베타 상태를 분명히 표시한다. 미제공 관리형 SaaS·가상의 고객 수·성과 수치는 넣지 않는다.

## 베타 이후 별도 범위

설치 마법사 후속 단계(C–F), 테스트 수신함, 버전 고정 이미지, 관리형 SaaS·과금, 알림톡 실제 공급자 연동, 세그먼트 주기 실행과 고객 병합·삭제 후속 작업은 기존 체크리스트의 범위를 따른다. 이를 이번 UI 변경의 완료 항목으로 묶지 않는다.

## 확인 출처

- [main CI](https://github.com/NudgeOn/nudgeon-platform/actions/runs/34471371269)
- [iOS SDK 0.1.2](https://github.com/NudgeOn/nudgeon-ios-sdk/releases/tag/0.1.2)
- [Android Maven 0.1.2](https://repo.maven.apache.org/maven2/io/nudgeon/nudgeon-sdk/0.1.2/nudgeon-sdk-0.1.2.pom)
- [RN 공개 레지스트리](https://registry.npmjs.org/@nudgeon%2freact-native), [Flutter 공개 레지스트리](https://pub.dev/api/packages/nudgeon_flutter): 2026-09-16 조회 404
- [출시 체크리스트](RELEASE-CHECKLIST.md), [푸시 계약](PUSH-CONTRACT.md), 인접 `godspell` 저장소의 통합·리허설 기록
