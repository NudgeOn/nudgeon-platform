# 앱 실행 직후 전면 광고 — SDK 0.2.4

기존 `enable()`은 앱 활성화(`foreground`) 캠페인을 유지한다. 시작 광고를 쓰는
앱은 준비된 화면에서 **대신** `enableAfterLaunch`를 호출한다. OS의 정적 launch
screen 자체에 웹뷰를 넣지 않는다. 호스트는 메인 UI 위에 시작 화면을 유지하며 광고 준비 결과를 기다린다. 호스트 예제의 준비 기한은 3초이며, 광고가 없거나 실패하면 메인으로 바로 진입한다. 성공하면 전면 광고가 4초 표시된 뒤 자동으로 사라져 메인이 보인다.

## 동작 계약

- API 주소/SDK key 조합마다 프로세스에서 한 번만 시작 광고를 시도한다. Scene,
  Activity 또는 SDK 객체를 재생성하거나 disable 후 다시 enable해도 초기화하지 않는다.
  앱 프로세스 재시작은 새 기회이며 서버의 일일/누적 제한과 오늘 하루 숨김은 유지된다.
- 호스트가 동의·라우팅·화면 준비를 끝낸 시점에 호출한다. 첫 동의 화면, 딥링크,
  권한 요청, 결제 등 표시 불가 상황은 호스트가 건너뛴다. 화면 이동 뒤 늦게 호출하지 않는다.
- 준비 기한은 기본 3초, 설정 범위 1~10초다. 잘못된 비유한 숫자는 3초를 사용한다.
  단조 시계로 측정하며 로컬 시각 변경에 영향을 받지 않는다. 시간 초과 뒤 도착한
  응답은 화면에 표시하지 않는다. 네트워크 요청 자체는 전송 계층 timeout까지 남을 수 있다.
- 캠페인이 없거나 빈도/숨김 조건으로 선택되지 않으면 `noCampaign`/`NO_CAMPAIGN`.
  자동으로 foreground 캠페인을 대신 요청하지 않는다.
- `screen`, `contextChanged`, `disable` 또는 백그라운드 전환은 준비 중인 광고를
  취소한다. 준비 중 바로 `screen("home")`을 연달아 호출하지 않는다.
- 준비 시간과 광고 표시 시간은 별개다. `displaySeconds`는 기본 4초, 3~5초로 제한한다.
  SDK의 네이티브 타이머는 실제 표시부터 계산하고 `dismiss(auto_dismiss)`로 종료한다.
  시작 광고에는 네이티브 닫기·오늘 하루 숨김 버튼을 표시하지 않는다. 일반 인앱 팝업은 기존 동작을 유지한다.
- iOS는 실제 백그라운드 복귀를 관찰한다. Android 호스트는 실제 앱 복귀 경계에서
  `foreground()`를 호출한다. Activity/탭 전환마다 호출하지 않는다.

## 결과

| iOS / Android | 의미 |
|---|---|
| `shown` / `SHOWN` | 광고 표시 시작. 이후 클릭/닫힘은 기존 이벤트에 기록 |
| `noCampaign` / `NO_CAMPAIGN` | 현재 조건에서 선택된 광고 없음 |
| `timedOut` / `TIMED_OUT` | 준비 시간 초과, 이 시작 기회에서는 재시도하지 않음 |
| `blocked` / `BLOCKED` | 호출 시 표시 가능한 호스트/동의/화면 조건 불충족 |
| `cancelled` / `CANCELLED` | 준비 중 화면/동의/세션 상태 변경 |
| `failed` / `FAILED` | 통신·검증·웹뷰 준비 실패 |
| `alreadyHandled` / `ALREADY_HANDLED` | 이미 활성화됐거나 이 프로세스에서 시작 기회를 사용함 |

시도마다 완료 콜백은 한 번 전달된다. 중복 호출에는 별도의 alreadyHandled 결과를
준다. 반환 Bool은 새 시작 시도를 사용했는지이며 **광고 노출 성공 여부가 아니다**.
객체는 앱 소유자가 보관해야 한다. 새 시작 시도가 없는 호출도 클라이언트를 활성화해
이후 화면·이벤트 캠페인은 계속 사용할 수 있다.

## 콘솔과 배포

웹 소스 작업실에서 **시작 전면 광고 예제**를 선택하고 화면 전체를 채우는 콘텐츠를 확인한 뒤, 캠페인의 표시 조건을
**앱 실행 직후**로 설정한다. 권장 초기 설정은 하루 1회, `Asia/Seoul` 시간대다.
공개 콘텐츠만 사용하며 광고 네트워크 입찰/과금/개인화 기능은 포함하지 않는다.

`launch` 트리거와 `launch_timeout` 정상 중단 사유를 지원하는 서버/콘솔을 먼저
배포하고 SDK 및 호스트 연결을 반영한다. JSONB 설정을 사용하므로 이 변경만을 위한
새 DB migration은 없다. 기존 0010~0012 migration과 인앱 기능 설정은 필요하다.
SDK 0.2.2 이하의 기존 앱은 시작 광고를 요청하지 않는다.

## 호스트 연결

```swift
campaigns.enableAfterLaunch(timeoutSeconds: 3, displaySeconds: 4) { result in
    // 광고가 표시됐거나 시도가 끝나면 시작 화면 덮개를 제거한다.
    // 광고는 불투명하므로 자동 종료 전에는 메인이 보이지 않는다.
    revealMainBehindAd()
}
```

```kotlin
campaigns.enableAfterLaunch(timeoutSeconds = 3.0, displaySeconds = 4.0) { result ->
    revealMainBehindAd() // 호스트가 구현한 시작 화면 덮개 제거 함수
}
```

두 예제의 `campaigns`는 초기화 후 앱 소유자가 보관하는 운영 `InAppCampaignClient`다. `revealMainBehindAd`는 SDK API가 아니다. `shown`/`SHOWN`은 표시 **시작**이며 종료 알림이 아니다. 콜백에서 광고 뒤의 덮개를 제거하고 호스트 fallback을 취소한다. fallback이 먼저 실행되면 `contextChanged()`로 준비를 취소한 뒤 덮개를 제거한다.

작업실의 `InAppTestClient`는 콘텐츠 검수용이며 시작 타이머를 적용하지 않는다. 대상 OS별 테스트를 네이티브 닫기로 마치고 같은 버전을 검수·게시한 뒤, 통제된 테스트 앱 프로세스를 재시작해 실제 4초 자동 종료를 검증한다.

[유저가이드](https://nudgeon.io/ko/guide/#launch-ads) · [개발자센터](https://developer.nudgeon.io/#launch-ads)

시작 화면 덮개는 첫 프레임 전에 추가하고 자체 3초 fallback을 둔다. 동의·딥링크 제외,
백그라운드·Activity 재생성 때 해제해 앱 진입이 영구 차단되지 않도록 한다.
카드형 HTML을 그대로 사용하면 문서 안의 카드 스타일은 남으므로 전면 광고용 소스를 별도로 게시한다.
