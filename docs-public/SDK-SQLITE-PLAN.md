# Client SDK SQLite 이벤트 큐 전환 계획 및 구현 결과

작성: 2026-09-29. 범위: iOS·Android 네이티브 코어의 이벤트 영속 큐.

## 목적과 범위

기존 JSON 파일 전체를 재작성하는 이벤트 큐를 SQLite로 전환한다. 앱이 다시 시작해도 커밋된 이벤트를 복원하고 기존 `track()`·`flush()` 배치 전송을 사용한다. SQL을 앱 개발자에게 노출하는 API나 별도 Bulk API를 추가하는 작업은 아니다. 인앱 캠페인/테스트 전달 저널, identify 및 속성 저장 구조는 이번 범위에 포함하지 않는다.

## 구현 순서와 완료 기준

1. **네이티브 큐 교체 — 완료**
   - iOS: 시스템 SQLite3, SPM 및 CocoaPods의 sqlite3 링크 설정.
   - Android: 플랫폼 SQLiteDatabase, 런타임 외부 DB 라이브러리 추가 없음.
   - 최초 큐 접근 시 DB를 열어 SDK 초기화 시 메인 스레드의 DB 작업을 피한다.
2. **JSON 이전 — 완료**
   - 기존 위치의 `nudgeon_events.json`을 `nudgeon_events.sqlite`로 이전한다.
   - 이벤트와 `legacy_json_imported` 마커를 단일 트랜잭션으로 커밋한 뒤 JSON을 삭제한다.
   - 커밋 후 삭제 전에 종료돼도 마커로 중복 이전을 막는다. 이전 실패 시 롤백하고 원본을 보존한다.
3. **큐 계약 보존 — 완료**
   - sequence 순서의 FIFO, insert_id 고유성, 최대 1,000건·초과 시 oldest drop을 유지한다.
   - peek는 삭제하지 않는다. 네트워크 성공 후 ack한 ID만 트랜잭션으로 삭제한다.
   - 전송 실패 시 다음 flush에서 같은 insert_id로 재시도한다. 서버 접수 후 ack 전 종료 시 중복 전송은 가능하며 서버의 insert_id 중복 제거 계약을 사용한다.
   - iOS에서는 ack 저장이 실패했을 때 즉시 재전송 루프에 들어가지 않도록 한다.
   - iOS 재귀 JSON 코덱을 보완해 중첩 객체·배열·불리언·null·정수 및 NSNumber를 보존한다.
4. **검증 — 완료**
   - iOS 전체 `swift test`: 66개 통과(신규 SQLite 테스트 9개 포함).
   - iOS `xcodebuild`, generic iOS Simulator, NudgeOnSDK scheme: 성공.
   - Android `:nudgeon:testDebugUnitTest`: 34개 통과(신규 SQLite 테스트 9개 포함). Robolectric API 35 native SQLite 사용.
   - Android `:nudgeon:assembleRelease`: 성공.
   - 검증 항목: 재시작 복원, 순서·식별자 보존, 선택 ack, 배치 재조회, 중첩 JSON, 일회 이전, 실패 시 롤백·재시도, 저장 상한, 동시 연결, DB 손상 시 파일 보존.

## 저장 실패와 호환성

DB 손상이나 디스크 쓰기 실패 시 고객 페이로드 없는 경고를 남기고 기존 저장소를 자동 삭제하지 않는다. 원인이 해소되면 다음 접근에서 재시도한다. 디스크 부족·손상·잘못된 이전 JSON 상태에서 새 이벤트 저장은 보장되지 않는다. 공개 track 호출은 비동기이므로 호출 반환이 디스크 커밋 완료를 뜻하지 않는다.

1,000건을 초과한 이벤트의 oldest drop 정책은 유지한다. SQLite만 읽는 새 큐의 미전송 이벤트를 구버전 JSON 큐가 읽을 수 없으므로 다운그레이드 전 큐를 비워야 한다.

## 적용 및 출시 경계

소스 변경 대상은 형제 저장소 `nudgeon-ios-sdk`와 `nudgeon-android-sdk`이며 README와 Unreleased 변경 기록을 포함한다. 기존 배포 버전은 변경하거나 게시하지 않는다.

RN·Flutter는 네이티브 큐를 호출하지만 의존성 버전이 고정되어 있다. 조사 시 Android 코어는 `0.2.8`, iOS CocoaPods 코어는 `0.2.2`를 참조한다. 네이티브 코어 출시 후 브리지 의존성 갱신·소비 앱 빌드 검증이 필요하며, 현재 배포된 RN·Flutter에 자동 적용되지는 않는다. 실기기 강제 종료/네트워크 단절 검증과 패키지 게시는 이번 로컬 검증에 포함하지 않는다.

## 참고

- [SQLite 트랜잭션](https://www.sqlite.org/lang_transaction.html)
- [SQLite 원자적 커밋](https://www.sqlite.org/atomiccommit.html)
- [Android SQLiteDatabase](https://developer.android.com/reference/android/database/sqlite/SQLiteDatabase)
