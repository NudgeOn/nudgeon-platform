export const launchAdTests = {
  "ko": {
    "title": "두 번의 테스트 · 목적과 완료 조건이 다릅니다",
    "done": "완료 조건",
    "phases": [
      {
        "title": "1. 콘텐츠 검수",
        "mode": "작업실 · InAppTestClient · 수동 닫기",
        "steps": [
          "테스트 앱의 기기 연결 화면에서 작업실 연결 코드를 입력하고 확인 숫자를 대조합니다.",
          "저장·검증한 같은 소스 버전을 각 대상 OS에서 실행합니다.",
          "레이아웃과 허용한 동작을 확인한 뒤 네이티브 닫기 버튼으로 종료합니다."
        ],
        "success": "OS별 마지막 테스트를 네이티브 닫기로 마치고, 캠페인 관리에서 같은 버전의 검수를 통과합니다. 여기서는 4초 자동 종료를 검사하지 않습니다."
      },
      {
        "title": "2. 실제 시작 광고 테스트",
        "mode": "게시 캠페인 · InAppCampaignClient · 자동 종료",
        "steps": [
          "통제된 테스트 앱에 검수한 버전을 게시합니다. 조건은 앱 실행 직후, 시간대는 한국 날짜 기준이면 Asia/Seoul로 설정합니다.",
          "시작 광고 연결과 사전 동의를 마친 앱의 프로세스를 종료하고 다시 실행합니다.",
          "런치 → 전면 광고 → 기본 4초 뒤 메인을 확인하고 표시·노출·dismiss(auto_dismiss) 기록을 대조합니다."
        ],
        "success": "자동 종료와 메인 복귀, 운영 이벤트가 일치합니다. 재실행해도 빈도·숨김 제한은 유지되며, 홈 화면에서 돌아오기만 하면 새 시작 테스트가 아닙니다."
      }
    ]
  },
  "en": {
    "title": "Two tests · different purposes and completion criteria",
    "done": "Complete when",
    "phases": [
      {
        "title": "1. Content review",
        "mode": "Workbench · InAppTestClient · manual close",
        "steps": [
          "Enter the workbench pairing code in the test app and compare confirmation numbers.",
          "Run the same saved and validated source revision on each target OS.",
          "Check layout and allowed actions, then finish with the native close button."
        ],
        "success": "The last test on each OS ends with native close, and the same revision passes review in campaign management. This does not test four-second auto-dismissal."
      },
      {
        "title": "2. Actual startup-ad test",
        "mode": "Published campaign · InAppCampaignClient · auto-dismiss",
        "steps": [
          "Publish the reviewed revision to a controlled test app with the app-launch trigger. Choose Asia/Seoul for Korean calendar-day limits.",
          "Integrate the startup host, grant prior consent, terminate the app process and relaunch.",
          "Verify launch → full-screen ad → main after the default four seconds, then compare presented, impression and dismiss(auto_dismiss) records."
        ],
        "success": "Auto-dismissal, return to main and production events match. Relaunching retains frequency/suppression limits; simply returning from Home is not a new startup test."
      }
    ]
  }
};
