const copy = {
  ko: {
    eyebrow: 'SELF-HOSTED. GUIDED SETUP.', title: '설치도 아주 쉽게…',
    intro: 'DB 설정부터 관리자 로그인까지, 위자드가 순서대로 안내합니다. 복잡한 설정 파일 대신 익숙한 입력 화면으로 시작하세요.',
    prepare: '시작 전 준비', prerequisites: 'Docker Engine · Compose v2 · Git · OpenSSL · cURL',
    command: '저장소를 내려받고 ./nudgeon up을 실행하세요.', copy: '설치 명령 복사', copied: '복사했어요', failed: '명령어를 직접 선택해 복사해 주세요.',
    hint: '터미널에 표시되는 설치 링크를 여세요. 첫 실행은 소스 빌드가 필요하며, 터미널을 열어 둔 채 위자드를 진행합니다.',
    dockerTitle: 'Docker 설치 방식',
    dockerCurrent: '현재 · 소스 빌드', dockerCurrentBody: 'DB 등 기반 서비스는 배포된 이미지를 내려받고, NudgeOn은 서버에서 소스를 빌드해 실행합니다. 위 명령으로 설치할 수 있습니다.',
    dockerPlanned: '준비 중 · 이미지 다운로드', dockerPlannedBody: 'NudgeOn도 미리 빌드된 이미지를 내려받아 설치하는 방식을 준비하고 있습니다. 이미지 배포와 새 환경 검증이 끝나면, 소스 빌드 없이 같은 위자드로 설정할 수 있도록 제공할 예정입니다.',
    preview: '실제 화면으로 미리 보는 설치 과정', sample: '실제 제품 화면 · 예시 계정과 데이터',
    steps: [
      ['DB 비밀번호', '추천 비밀번호로 바로 시작.', '자동 생성된 비밀번호를 쓰거나 직접 입력하세요. 파일로 다운로드해 보관한 뒤 설치를 시작하면, 필요한 서비스가 자동으로 준비됩니다.', 'database'],
      ['관리자 계정', '앞으로 로그인할 계정을 만드세요.', '설치 링크로 소유권을 확인하고 워크스페이스 이름, 관리자 이메일과 로그인 비밀번호를 입력합니다. DB 비밀번호와는 따로 관리해요.', 'account'],
      ['첫 로그인', '방금 만든 계정으로 로그인.', '설치 완료 화면에서 로그인으로 이어집니다. 관리자 이메일과 비밀번호로 접속하면 마지막 보안 설정을 안내해요.', 'login'],
      ['OTP · 선택', '계정 보호는 한 단계 더. 선택은 자유롭게.', '인증 앱으로 OTP를 설정하고 복구 코드를 보관하세요. 지금은 건너뛰어도 됩니다. 나중에 앱 설정에서 다시 켤 수 있어요.', 'otp'],
      ['메인 대시보드', '설치 끝. 이제 내 서비스의 차례.', '로그인한 대시보드에서 시작하세요. 앱 연결 안내를 이어가거나 먼저 둘러볼 수 있습니다. SDK와 발송 채널을 연결한 뒤 첫 테스트 알림을 보내세요.', 'dashboard'],
    ],
    footnote: '현재 로컬 셀프호스팅 미리보기입니다. 푸시 발송에는 별도의 SDK 연결과 FCM 또는 APNs 설정이 필요합니다.',
    guide: '전체 설치 가이드 보기',
  },
  en: {
    eyebrow: 'SELF-HOSTED. GUIDED SETUP.', title: 'Your infrastructure.\nA setup you can follow.',
    intro: 'From database settings to your first admin sign-in, the wizard walks you through each step. Start with familiar forms instead of editing configuration files.',
    prepare: 'Before you start', prerequisites: 'Docker Engine · Compose v2 · Git · OpenSSL · cURL',
    command: 'Clone the repository, then run ./nudgeon up.', copy: 'Copy install commands', copied: 'Copied', failed: 'Select the commands and copy them manually.',
    hint: 'Open the setup link printed in your terminal. The first run builds from source; keep the terminal open while you follow the wizard.',
    dockerTitle: 'Installing with Docker',
    dockerCurrent: 'Available now · Build from source', dockerCurrentBody: 'Infrastructure services such as the database use published images. NudgeOn is built from source on your server. Use the commands above to install it.',
    dockerPlanned: 'Planned · Download prebuilt images', dockerPlannedBody: 'We plan to provide prebuilt NudgeOn images too. Once image publishing and installation checks on a fresh host are complete, you will be able to use the same setup wizard without building from source.',
    preview: 'Explore the actual setup screens', sample: 'Real product screens · Example account and data',
    steps: [
      ['Database password', 'Start with a recommended password.', 'Use the generated password or enter your own. Download a copy, then start installation. The required services are prepared automatically.', 'database'],
      ['Admin account', 'Create the account you’ll sign in with.', 'Confirm ownership using the setup link, then choose your workspace name, admin email, and sign-in password. This is separate from the database password.', 'account'],
      ['First sign-in', 'Sign in with your new account.', 'The completed installer takes you to sign-in. Enter the admin email and password you just created, then review the final security step.', 'login'],
      ['OTP · Optional', 'An extra layer of protection. Your choice.', 'Connect an authenticator app and save your recovery codes, or skip for now. You can enable OTP later in App settings.', 'otp'],
      ['Main dashboard', 'Installed. Ready for your app.', 'Arrive at your signed-in dashboard. Continue the app connection guide or explore first. Connect your SDK and sending channel before sending a test notification.', 'dashboard'],
    ],
    footnote: 'Local self-hosting preview. Push delivery requires a separate SDK integration and FCM or APNs credentials. Installer previews are shown in Korean.',
    guide: 'Read the full installation guide',
  },
};
export function renderInstallation(lang) {
  const t = copy[lang];
  return `<section class="installation shell" id="installation" aria-labelledby="installation-title">
    <div class="install-heading"><p class="install-eyebrow">${t.eyebrow}</p><h2 id="installation-title">${t.title.replace('\n','<br>')}</h2><p>${t.intro}</p></div>
    <div class="install-start"><div><span class="install-kicker">00 / ${t.prepare}</span><h3>${t.command}</h3><p>${t.prerequisites}</p><p class="install-hint">${t.hint}</p></div>
      <div class="install-command"><pre tabindex="0"><code data-install-command>git clone https://github.com/NudgeOn/nudgeon-platform.git
cd nudgeon-platform
./nudgeon up</code></pre><button type="button" data-copy-install data-copied="${t.copied}" data-failed="${t.failed}">${t.copy}</button><span data-copy-install-status role="status"></span></div></div>
    <aside class="install-method" aria-labelledby="install-method-title"><h3 id="install-method-title">${t.dockerTitle}</h3><p><strong>${t.dockerCurrent}</strong>${t.dockerCurrentBody}</p><p><strong>${t.dockerPlanned}</strong>${t.dockerPlannedBody}</p></aside>
    <div class="install-tour" data-install-tour aria-label="${t.preview}">
      <div class="install-steps">${t.steps.map(([name], i) => `<button type="button" data-install-step="${i}" aria-pressed="${i===0}" aria-controls="install-panel-${i}"><span>0${i+1}</span>${name}</button>`).join('')}</div>
      ${t.steps.map(([name,title,body,image], i) => `<div class="install-panel" id="install-panel-${i}" ${i ? 'hidden' : ''}><div class="install-caption"><span class="install-kicker">0${i+1} / ${name}</span><h3>${title}</h3><p>${body}</p></div><figure><img src="/assets/install-${image}${i>1?'-'+lang:''}.png" alt="${name}" width="1120" height="840" loading="lazy"><figcaption>${t.sample}</figcaption></figure></div>`).join('')}
    </div><div class="install-footer"><p>${t.footnote}</p><a class="text-link" href="https://github.com/NudgeOn/nudgeon-platform/blob/main/docs-public/DEPLOY.md">${t.guide} →</a></div>
  </section>`;
}
