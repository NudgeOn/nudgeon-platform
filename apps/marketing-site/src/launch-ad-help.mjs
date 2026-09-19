export const launchAdHelp = {
  "ko": {
    "title": "광고가 안 보이나요? 순서대로 확인하세요",
    "items": [
      [
        "1. 게시·기간·대상 OS",
        "같은 앱의 캠페인이 게시 중인지, 현재 시각이 게시 기간 안인지, 기기의 OS가 대상인지 확인하세요. 수정 후에는 같은 소스 버전의 OS별 검수와 재게시가 필요합니다."
      ],
      [
        "2. 실제 앱 시작 조건",
        "작업실 연결을 종료하고 앱 프로세스를 완전히 종료한 뒤 아이콘으로 다시 실행하세요. 홈 화면에서 복귀하거나 Activity를 다시 만드는 것만으로는 새 시도가 생기지 않습니다. 첫 동의·딥링크·권한 요청으로 건너뛴 광고는 그 실행 중 나중에 표시하지 않습니다."
      ],
      [
        "3. 하루 빈도·KST·우선순위",
        "한국 날짜 기준 하루 1회는 Asia/Seoul과 일일 제한 1로 설정합니다. 제한은 계정이 아닌 설치 기기 기준입니다. 재실행해도 일일 한도·숨김은 초기화되지 않습니다. 우선순위가 높은 다른 캠페인이 선택됐는지도 확인하세요."
      ],
      [
        "4. SDK 결과와 다음 행동",
        "noCampaign/NO_CAMPAIGN: 앞의 게시·빈도 조건부터 확인. timedOut/TIMED_OUT: 네트워크와 콘텐츠 준비 시간 확인. blocked/BLOCKED: 동의와 표시 가능한 화면 확인. cancelled/CANCELLED: 화면 변경·백그라운드 전환 확인. failed/FAILED: 통신·콘텐츠 검증 로그 확인. alreadyHandled/ALREADY_HANDLED: 프로세스를 완전히 종료하고 재실행."
      ],
      [
        "5. 확인한 결과를 개발 담당자에게 전달",
        "KST 시각, 앱·캠페인 ID, 소스 버전, OS·SDK 버전, 실행 방법, SDK 결과와 표시·자동 종료 기록을 함께 전달하세요. 비밀 키·테스트 연결 코드·기기 토큰은 첨부하지 않습니다."
      ]
    ],
    "contentTitle": "짧게 알리고, 메인에서 다시 읽게 하세요",
    "contentItems": [
      "작성 초안은 제목 1개·핵심 문장 1개로 시작하세요. 예: “오늘의 새 소식” / “새 콘텐츠가 도착했어요.” 짧은 카피도 4초 안에 모두가 읽는다고 보장하지 않습니다.",
      "동일한 소식과 참여 방법은 메인 화면의 이벤트·공지에서도 시간 제한 없이 제공하세요. 해당 경로는 호스트 앱에 직접 구현해야 합니다. 필수 동의·긴 약관·즉시 입력을 시작 광고에 넣지 마세요.",
      "일반 텍스트 대비는 4.5:1 이상을 기준으로 검수하고, 글자 200% 확대·작은 화면·폴드 가로 화면에서 잘림을 확인하세요. 제목·문단을 실제 HTML 텍스트로 작성하고 장식 이미지는 읽기 순서에서 제외합니다.",
      "VoiceOver·TalkBack으로 제목 읽기, 광고 종료 후 메인 포커스, 시간 제한 없는 동일 콘텐츠 접근을 확인하세요. 실제 이용자·보조 기술 사용자 검증은 별도로 필요합니다. 3~5초 자동 종료만으로 접근성 적합성을 주장하지 않습니다."
    ],
    "reviewTitle": "검수 연결을 끝내기 전에",
    "reviewBody": "네이티브 닫기 후 예제 앱에서 전송 대기 → 전송 중 → 서버 확인(대기 0)을 확인하고 End test session으로 종료하세요. 종료 시 남은 기록을 먼저 전송하며 실패하면 암호화 보관합니다. Retry transfer로 다시 보내거나 앱 재실행 후 전송을 복구할 수 있습니다. Discard pending records는 기록을 포기할 때만 선택하세요. 서버 확인은 기록 수신이며 검수 통과가 아닙니다. 콘솔의 동일 버전·OS 검수는 별도로 진행합니다. 테스트 자격(30분)·실행 유효기간(5분)이 지나 거절되면 새 검수가 필요합니다."
  },
  "en": {
    "title": "No ad? Check these in order",
    "items": [
      [
        "1. Publication, dates and target OS",
        "Check that the campaign belongs to this app, is published, is within its schedule and includes this device’s OS. Changes require review of the same revision on each target OS and republishing."
      ],
      [
        "2. A real process launch",
        "End workbench pairing, terminate the app process, then launch from its icon. Returning from Home or recreating an Activity does not create another attempt. An opportunity skipped for initial consent, deep links or permission prompts is not inserted later in that process."
      ],
      [
        "3. Daily limits, KST and priority",
        "For once per Korean calendar day, select Asia/Seoul and a daily limit of 1. Limits apply per installation, not account. Restarting does not reset limits or suppression. Check whether a higher-priority campaign was selected."
      ],
      [
        "4. SDK result and next action",
        "noCampaign/NO_CAMPAIGN: recheck publication and frequency. timedOut/TIMED_OUT: check network and content preparation. blocked/BLOCKED: check consent and presentation host. cancelled/CANCELLED: check background or screen changes. failed/FAILED: check communication and artifact validation logs. alreadyHandled/ALREADY_HANDLED: terminate the process and relaunch."
      ],
      [
        "5. Give your developer a reproducible report",
        "Include KST time, app/campaign IDs, source revision, OS/SDK versions, launch method, SDK result and presentation/automatic-dismissal records. Exclude secret keys, pairing codes and device tokens."
      ]
    ],
    "contentTitle": "Keep it brief, and available from main",
    "contentItems": [
      "Start with one heading and one core sentence: “Something new today” / “Fresh content is here.” Brief copy does not guarantee that everyone can read it in four seconds.",
      "Provide the same information and participation options without a time limit in the main app’s events or announcements. The host app must implement that route. Keep required consent, long terms and immediate data entry out of startup ads.",
      "Review normal text against a contrast ratio of at least 4.5:1. Check 200% text resizing, small screens and foldable landscape layouts for clipping. Use real HTML headings and paragraphs; keep decorative images out of the reading order.",
      "Use VoiceOver and TalkBack to check heading reading, focus after dismissal and access to the same untimed content. Validation with real users and assistive-technology users remains necessary. A 3–5 second auto-dismiss timer alone does not establish accessibility conformance."
    ],
    "reviewTitle": "Before ending content review",
    "reviewBody": "After native Close, check Waiting → Sending → Server confirmed (pending 0) in the example app, then End test session. Ending uploads remaining records first and retains failures in encrypted storage. Use Retry transfer or relaunch the app to recover delivery. Choose Discard pending records only to abandon the records. Server confirmed means receipt, not review approval; approve the matching revision and OS in the console separately. Expired test credentials (30 minutes) or active runs (five minutes) can reject recovery and require a new review."
  }
};
