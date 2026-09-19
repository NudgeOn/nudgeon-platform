const root = 'https://github.com/NudgeOn/nudgeon-platform/tree/main/apps/docs-site/examples/app-launch';
const clone = 'git clone https://github.com/NudgeOn/nudgeon-platform.git\ncd nudgeon-platform/apps/docs-site/examples/app-launch';
const iosBuild = 'cd ios\nxcodegen generate\nxcodebuild -project LaunchAdExample.xcodeproj -scheme LaunchAdExample \\\n  -destination \'generic/platform=iOS Simulator\' CODE_SIGNING_ALLOWED=YES build\nopen LaunchAdExample.xcodeproj';
const androidBuild = 'cd android\n./gradlew :app:assembleDebug\nadb -s YOUR_TEST_DEVICE install -r app/build/outputs/apk/debug/app-debug.apk\nadb -s YOUR_TEST_DEVICE shell am start -a android.intent.action.MAIN \\\n  -c android.intent.category.LAUNCHER -n io.nudgeon.launchexample/.MainActivity';
export const launchAdQuickstart = {
  ko: {
    title: '완성 예제로 바로 시작하세요', intro: '플랫폼을 선택하면 설정할 두 값과 빌드·테스트 순서를 바로 볼 수 있습니다.',
    prerequisite: '먼저 인앱 기능이 켜진 NudgeOn 테스트 앱을 준비하세요. 공개 SDK 0.2.5를 사용하며, 이 예제에는 푸시 인증서가 필요하지 않습니다.',
    download: '예제 내려받기', configure: 'API 주소와 공개 SDK 키 설정', build: '빌드하고 실행', test: '작업실에 기기 연결', clone,
    keyNote: '테스트 앱의 HTTPS API 기본 주소와 공개 SDK 키를 사용하세요. 콘텐츠 호스트 주소나 Admin 키를 넣지 마세요. 자리표시자를 바꾸지 않으면 광고 없이 메인 화면이 열립니다.',
    testBody: '앱의 Connect for content review에 작업실 연결 코드를 입력하고 확인 숫자를 대조하세요. 콘솔에서 같은 기기 확인 → 내 기기에서 실행 후 네이티브 닫기로 마칩니다. 서버 수신 완료를 확인한 뒤 콘솔에서 같은 버전·OS를 검수 승인하세요. 게시 후 실제 4초 자동 종료 테스트는 아래 두 번째 절차로 진행합니다.',
    project: '프로젝트 소스', readmeLabel: '전체 설정·테스트 안내', readme: root + '#한국어',
    platforms: [
      {id:'ios', label:'iOS 예제 실행', requirements:'iOS 15+ · Xcode · XcodeGen', configure:'ios/LaunchAdExample.swift 상단의 apiURL과 sdkKey를 바꾸세요.', build:iosBuild, run:'Xcode에서 시뮬레이터를 선택하고 Run합니다. Keychain 저장을 위해 서명을 켜 두세요. 실제 iPhone은 본인 Team과 고유 Bundle ID를 설정합니다.', project:root+'/ios'},
      {id:'android', label:'Android 예제 실행', requirements:'Android 8+ · JDK 17 · SDK 34', configure:'android/app/src/main/kotlin/io/nudgeon/launchexample/MainActivity.kt 상단의 API_URL과 SDK_KEY를 바꾸세요.', build:androidBuild, run:'JAVA_HOME은 JDK 17, ANDROID_HOME은 Android SDK 경로로 설정합니다. YOUR_TEST_DEVICE는 adb devices에서 확인한 단말·에뮬레이터 ID로 바꾸세요.', project:root+'/android'},
    ],
  },
  en: {
    title: 'Start with a complete example', intro: 'Choose a platform for the two configuration values and the build-and-test steps.',
    prerequisite: 'Prepare a NudgeOn test app with in-app features enabled first. These examples use public SDK 0.2.5; no push certificates are required.',
    download:'Get the example', configure:'Set the API URL and public SDK key', build:'Build and run', test:'Connect to the workbench', clone,
    keyNote:'Use your test app’s HTTPS API base URL and public SDK key, not the content host or an admin key. Unchanged placeholders open main without ads.',
    testBody:'Enter a workbench pairing code through Connect for content review and compare the confirmation number. Confirm the device in the console, run the saved source and finish with native Close. After server receipt, approve the matching revision and OS in the console. Use the second procedure below for the published four-second auto-dismiss test.',
    project:'Project source', readmeLabel:'Full setup and test guide', readme:root+'#english',
    platforms:[
      {id:'ios',label:'Run the iOS example',requirements:'iOS 15+ · Xcode · XcodeGen',configure:'Edit apiURL and sdkKey at the top of ios/LaunchAdExample.swift.',build:iosBuild,run:'Choose a simulator in Xcode and Run. Keep signing enabled for Keychain storage. Physical iPhones require your signing Team and a unique Bundle ID.',project:root+'/ios'},
      {id:'android',label:'Run the Android example',requirements:'Android 8+ · JDK 17 · SDK 34',configure:'Edit API_URL and SDK_KEY at the top of android/app/src/main/kotlin/io/nudgeon/launchexample/MainActivity.kt.',build:androidBuild,run:'Set JAVA_HOME to JDK 17 and ANDROID_HOME to your Android SDK path. Replace YOUR_TEST_DEVICE with the device/emulator ID from adb devices.',project:root+'/android'},
    ],
  },
};
