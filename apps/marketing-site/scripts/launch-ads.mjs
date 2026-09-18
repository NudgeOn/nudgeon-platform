const copy = {
  ko: {
    title: '앱을 여는 순간,\n새로운 소식을 전하세요.',
    intro: '런치 화면 다음에 나타나는 전면 광고. 이벤트와 프로모션을 3~5초 동안 보여주고, 누를 필요 없이 메인 화면으로 자연스럽게 이어집니다.',
    steps: ['런치 화면', '전면 광고 · 기본 4초', '메인 화면'],
    points: [
      ['웹 소스로 자유롭게', 'HTML·CSS·JS를 올리거나 시작 전면 광고 예제로 만드세요. 웹 소스는 NudgeOn에서 관리합니다.'],
      ['미리 보고, 단말에서 확인하고', '콘솔 미리보기와 연결한 iOS·Android 테스트 기기로 화면을 확인한 뒤 캠페인을 게시하세요.'],
      ['언제 보여줄지도 직접', '앱 실행 직후 조건과 노출 빈도, 캠페인 시간대를 설정하세요. 광고가 없거나 준비 기한을 넘기면 메인으로 진입합니다.'],
    ],
    replay: '4초 광고 흐름 체험', note: '예시 화면 · 실제 광고가 전송되지 않습니다',
    adTitle: '새로운 계절,\n새로운 발견.', adBody: '오늘의 특별한 이벤트를 만나보세요.',
    adFooter: '잠시 후 메인 화면으로 이동합니다', mainTitle: '다시 만나 반가워요', mainBody: '오늘의 발견을 이어가세요.',
    card: '당신을 위한 새로운 이야기', label: '시작 광고 미리보기',
    integration: 'iOS·Android SDK 0.2.4와 앱 시작 화면 연결이 필요합니다. 기본 표시 시간은 4초이며 SDK에서 3~5초로 설정합니다.',
    docs: '시작 광고 연결 가이드',
  },
  en: {
    title: 'A new story,\nright as your app opens.',
    intro: 'Show a full-screen event or promotion after the launch screen. After 3–5 seconds, it disappears automatically and your main screen takes over. No tap needed.',
    steps: ['Launch screen', 'Full-screen ad · 4s default', 'Main screen'],
    points: [
      ['Create with web assets', 'Upload HTML, CSS and JavaScript, or start from the full-screen ad example. NudgeOn manages your web assets.'],
      ['Preview, then test on a device', 'Check the console preview and a connected iOS or Android test device before publishing your campaign.'],
      ['Choose the moment', 'Set the app-launch trigger, frequency and campaign time zone. If no ad is available or preparation times out, users proceed to the main screen.'],
    ],
    replay: 'Try the 4-second ad flow', note: 'Illustrative preview · No ads are sent',
    adTitle: 'A new season.\nA fresh discovery.', adBody: 'Discover something special today.',
    adFooter: 'Your main screen is coming next', mainTitle: 'Good to see you again', mainBody: 'Keep discovering something new.',
    card: 'A new story, picked for you', label: 'Startup ad preview',
    integration: 'Requires iOS or Android SDK 0.2.4 and a host-app startup integration. Display time defaults to 4 seconds and is configurable from 3 to 5 seconds in the SDK.',
    docs: 'Read the startup ad guide',
  },
};
export function renderLaunchAds(lang) {
  const t = copy[lang];
  return `<section class="launch-ads shell" id="launch-ads" aria-labelledby="launch-ads-title" data-launch-demo data-labels='${JSON.stringify(t.steps)}'>
    <div class="launch-copy"><p class="install-eyebrow">APP LAUNCH ADS · iOS &amp; ANDROID</p>
      <h2 id="launch-ads-title">${t.title.replace('\n', '<br>')}</h2><p class="launch-intro">${t.intro}</p>
      <ol class="launch-points">${t.points.map(([title, body], i) => `<li><span>0${i + 1}</span><div><h3>${title}</h3><p>${body}</p></div></li>`).join('')}</ol>
      <a class="text-link" href="https://developer.nudgeon.io/#launch-ads">${t.docs} <span aria-hidden="true">↗</span></a>
      <p class="launch-integration">${t.integration}</p>
    </div>
    <div class="launch-showcase"><ol class="launch-flow">${t.steps.map((step, i) => `<li data-launch-step="${i}" ${i === 1 ? 'aria-current="step"' : ''}><span>0${i + 1}</span>${step}</li>`).join('')}</ol>
      <div class="launch-device" role="img" aria-label="${t.label}">
        <div class="launch-screen launch-splash" data-launch-screen="0" hidden><strong>NudgeOn</strong></div>
        <div class="launch-screen launch-ad" data-launch-screen="1"><div class="launch-ad-brand">NUDGEON <span>SPONSORED</span></div><div><p>MAKE ROOM FOR SOMETHING NEW</p><h3>${t.adTitle.replace('\n', '<br>')}</h3><p>${t.adBody}</p><div class="launch-star" aria-hidden="true">✦</div></div><small>${t.adFooter}</small></div>
        <div class="launch-screen launch-home" data-launch-screen="2" hidden><strong>NudgeOn</strong><h3>${t.mainTitle}</h3><p>${t.mainBody}</p><div class="launch-home-art" aria-hidden="true">✦</div><h4>${t.card}</h4><div class="launch-home-lines" aria-hidden="true"></div></div>
      </div>
      <p class="launch-status" role="status" aria-live="polite" data-launch-status>${t.steps[1]}</p>
      <button class="button primary" type="button" data-launch-replay>${t.replay} <span aria-hidden="true">↻</span></button><p class="launch-note">${t.note}</p>
    </div>
  </section>`;
}
