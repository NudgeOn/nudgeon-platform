# NudgeOn Beta 남은 작업 — 2026-09-18 KST

> 이 문서는 2026-09-18 당시의 검증 기록입니다. 이후 공개 네이티브 SDK는 0.2.4로 업데이트되었습니다. [현재 SDK·APP-AD 연결 안내](APP-LAUNCH-ADS.md)를 사용하세요. 아래 과거 검증 버전은 변경하지 않습니다.

현재 상태는 **파트너 베타 후보**다. 아래 표는 완료한 코드·검증과 실제 외부
환경에서 남은 출시 조건을 구분한다. 이번 작업에서 실제 단말 푸시 시험은
사용자 요청으로 제외했다. 패키지 레지스트리 로그인도 나중에 진행하기로 했다.

| 항목 | 완료한 준비·증거 | 남은 조건 |
|---|---|---|
| B-1 SDK 배포 | iOS SPM 0.2.2, Android core/in-app Maven 0.2.2 공개 배포. RN·Flutter 0.1.3 브리지 수정·새 iOS/Android 앱 CI·문서·main 머지 완료 | 메인테이너 로그인 후 npm·pub.dev 첫 게시, CocoaPods trunk core/NSE 등록. 현재 RN·Flutter는 공개 게시 완료 상태가 아님 |
| B-2 실단말 푸시 | 기존 인앱 팝업/KST 숨김 검증과 네이티브 SDK 릴리스 기록 보유 | 이번 작업에서 제외. 최신 공개 SDK로 푸시 전경/배경/종료·탭·중복 억제·리포트 대사 별도 |
| B-3 외부 온보딩 | 설치 문서·native consumer fixture·CI 개선 | 외부 개발자 3명의 문서만 보고 30분 내 설치 기록. 내부 자동 시험으로 대체하지 않음 |
| B-4 관리형 저장소 | 실제 pg pool의 idle disconnect 복구, 풀 대기 timeout, TLS CA/hostname/인증 거부 회귀. 로컬 격리 PG16 및 Redis 7 TLS·인증 거부·재연결 fixture 통과 | 실제 관리형 PG/Redis/CH 대상에서 TLS·인증·migration·백업/복원·연결 복구 검증. 대상 환경 정보 필요 |
| B-5 부하·장시간 | 자원 사전 점검, 결정적 seed/M0/M1/M4 생성기, 요청/이벤트·고객사별 집계, loopback 대사 회귀 | 격리된 목표 규모 환경, 실측 G0, 실제 PG/CH의 다중 tenant/key 대사·M3 장애 시험·5,000 events/s·100만 토큰·24시간 원본 결과 |
| B-6 4 SDK 계약 | RN/Flutter 각 8개 JS/Dart 테스트와 4개 Swift 테스트, 공개 네이티브 0.2.2 소비 앱 빌드. Flutter 시뮬레이터 런타임 6항목 통과 | RN/Flutter 공개 게시 후 registry-only 신규 앱 설치·계약 검증. 단말 푸시는 B-2로 별도 |
| B-7 Godspell 파일럿 | Godspell main에 SPM/Maven 0.2.2 반영, iOS 빌드·Android 빌드 및 20개 단위 테스트 통과 | 실제 스테이징 사용자 흐름과 공급자 발송·수신·열기 리허설. 이번 단말 푸시 제외 범위 |

## 공개 배포 직전 상태

- [iOS SDK 0.2.2](https://github.com/NudgeOn/nudgeon-ios-sdk/releases/tag/0.2.2)
- [Android core Maven](https://repo.maven.apache.org/maven2/io/nudgeon/nudgeon-sdk/0.2.2/nudgeon-sdk-0.2.2.pom), [in-app Maven](https://repo.maven.apache.org/maven2/io/nudgeon/nudgeon-inapp/0.2.2/nudgeon-inapp-0.2.2.pom)
- [iOS CocoaPods 준비 PR #10](https://github.com/NudgeOn/nudgeon-ios-sdk/pull/10): 공개 태그 기반 core lint, NSE lint 통과. trunk 게시 전에는 README의 고정 podspec URL 사용.
- [RN 준비 PR #4](https://github.com/NudgeOn/nudgeon-rn-sdk/pull/4): RN 0.81.5 새 앱 iOS·Android, TS/Jest·Swift·pack CI 통과. 최소 RN 0.81, Kotlin 2.1.20, Android 26. Xcode 27의 RN fmt 컴파일 문제는 별도 제한이며 macOS 15 CI 성공으로 Xcode 27 지원을 주장하지 않는다.
- [Flutter 준비 PR #4](https://github.com/NudgeOn/nudgeon-flutter-sdk/pull/4): 새 iOS·Android 앱, Dart 분석/테스트·Swift·pub dry-run CI 통과. Flutter 3.38.4 로컬/3.38.5 CI, Android 26/iOS 15 검증. iOS 27 UIScene 설정 문서 포함.
- [Godspell 반영 PR #3](https://github.com/marvinkim-photo/godspell/pull/3): main `4152715`. 기존 사용자 변경 파일은 유지.

로그인 전에는 RN/Flutter 배포 태그나 publish workflow를 실행하지 않는다.
로그인 후 CocoaPods core → NSE 게시, RN npm·Flutter pub.dev 게시를 진행하고
고정 Git/path/tarball override를 제거한 새 앱에서 설치를 재검증한다.

## 운영 시험 범위

[관리형 저장소 검증 순서와 기록 양식](MANAGED-STORAGE-VALIDATION.md)에
필요한 환경 정보와 실제 클라이언트별 TLS·복구·백업 대사 조건을 정리했다.
현재 대상 환경이 없어 결과는 `NOT_RUN`이다.

[PG 복구 증거](capacity/postgres-recovery-qa.json)는 로컬 격리 fixture다.
관리형 서비스 인증서/네트워크/장애조치의 합격 증거는 아니다.
[자원 사전 점검](capacity/preflight-local-2026-09-18.json)은 당시 디스크 여유와
실측 입력 부재로 `NO_GO_PREFLIGHT`다. 완료한 임시 빌드 파일 정리로 디스크가
늘어나도 대상 환경과 실측 데이터가 없으면 운영 시험을 시작할 수 없다.

[부하 프로필](../apps/worker/cmd/loadgen/WORKLOADS.md)의 loopback 검증은
생성기의 요청/ID/집계 계약만 확인한다. 운영 저장/분석·100만 토큰·24시간
soak는 미완료다. 24시간을 실제로 수행하지 않은 기록을 통과 처리하지 않는다.

## 발견한 실패와 처리

| 실패 | 처리·현재 상태 |
|---|---|
| idle PG 연결 오류로 Node 프로세스 종료 | pool error handler, 연결/획득 timeout 추가. 동일 프로세스 재연결 회귀 통과 |
| IP 주소 TLS 검증에서 localhost 인증서를 잘못 허용 | 설정된 실제 host를 명시 검증. 잘못된 hostname/CA 거부 통과 |
| RN 문자열 ID/권한 결과 JSON 파싱 실패 | 네이티브 scalar JSON 직렬화 수정, Swift/JS 계약 테스트 추가 |
| iOS 숫자 0/1 속성을 Bool로 변환 | CFBoolean 유형 구분, 숫자·불리언 회귀 통과 |
| Flutter 두 이벤트 스트림이 서로 취소·버퍼 소진 | 단일 EventChannel과 이벤트별 구독 적용, 재구독/독립 취소·실행 회귀 통과 |
| Flutter iOS 27 시작 시 종료 | 테스트 앱 UIScene 전환, 플러그인 초기화 위치 수정. 시뮬레이터 런타임 통과 |
| RN 0.76 Kotlin metadata/Gradle API 충돌 | 지원 기준 RN 0.81/Kotlin 2.1.20로 정리. 새 Android 앱 빌드 통과 |
| RN 0.81 Xcode 27 fmt consteval 오류 | 로컬 Xcode 27 미지원 상태를 문서화. macOS 15 CI iOS 빌드는 통과 |
| Flutter Linux CI에서 iOS Podfile 없음 | Linux에서는 Android 준비만 수행하도록 수정. 후속 CI 전체 통과 |
| 운영 부하 실측/자원 부족 | 사전 점검에서 NO_GO. 운영 부하·24시간 시험 미실행으로 유지 |

출처: [PG 복구 PR #31](https://github.com/NudgeOn/nudgeon-platform/pull/31),
[사전 점검 PR #32](https://github.com/NudgeOn/nudgeon-platform/pull/32),
[부하 프로필 PR #33](https://github.com/NudgeOn/nudgeon-platform/pull/33),
[출시 체크리스트](RELEASE-CHECKLIST.md).

## 생성기 자체 시험

[격리 loopback runner](../tests/ops/generator-validation/README.md)로 최초
7,500 요청/초 × 60초에서 45만 건 중 transport 오류 1건을 기록했다.
이후 1,000 요청/초 × 60초 및 진단을 추가한 7,500 요청/초 × 60초는 통과했다.
[원본 결과](capacity/generator-2026-09-18/)에 실패와 성공을 함께 보존했다.
원인 미확정인 최초 실패는 후속 성공으로 지우지 않는다. 이 수치는 로컬
모의 HTTP 응답 대상이며 운영 API/PG/CH 처리량이나 24시간 합격 수치가 아니다.


후속 7,500 요청/초 × 10분 생성기 시험은 디스크 안전 여유가 20 GiB 아래로
내려가 약 5분 40초에 자동 중단됐다. 약 252만 건을 수신했으며 결과는
`ABORTED_RESOURCE`다. 10분 통과나 운영 24시간 시험으로 처리하지 않는다.
[실패 요청 내보내기](../tests/ops/loadgen-failures/README.md)는 원래 insert ID와
payload 필드를 복원하는 오프라인 검토 도구다. 자동 재전송은 하지 않으며
M3 실제 재시도·중복 방지·PG/CH 대사는 여전히 남아 있다.
