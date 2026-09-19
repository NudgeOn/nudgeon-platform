import UIKit
import NudgeOnInApp

// Use the API base URL and a PUBLIC SDK key for a controlled test app.
// Do not use an admin API key. Keep credentials out of committed edits.
private let apiURL = "https://YOUR_API_HOST"
private let sdkKey = "YOUR_PUBLIC_SDK_KEY"

private func reviewText(_ ko: String, _ en: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("ko") == true ? ko : en
}
private let permanentReviewErrors: Set<String> = ["HTTP_400", "HTTP_401", "HTTP_403", "HTTP_404", "HTTP_409", "HTTP_410", "HTTP_422", "QUEUE_FULL"]

// All review timestamps are explicitly KST. Local acknowledgement time is not a server timestamp.
private func reviewTime(_ date: Date?) -> String {
    guard let date else { return reviewText("아직 확인되지 않음", "Not recorded") }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "Asia/Seoul"); formatter.dateFormat = "yyyy-MM-dd HH:mm:ss 'KST'"
    return formatter.string(from: date)
}
private func reviewExpiry(_ value: String?) -> String {
    guard let value else { return reviewTime(nil) }
    let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let parsed = parser.date(from: value); parser.formatOptions = [.withInternetDateTime]
    return reviewTime(parsed ?? parser.date(from: value))
}
private func reviewContext(_ detail: InAppTestReviewDetails?) -> String {
    guard let detail else { return reviewText("검수 상세 정보가 없습니다. 이전 SDK에서 저장한 기록에는 시각·버전 정보가 없을 수 있습니다.", "Review details unavailable. Older SDK records may lack timestamps and revision context.") }
    let unknown = reviewText("아직 확인되지 않음", "Not recorded")
    return [reviewText("최근 실행 ID: ", "Latest run ID: ") + (detail.runID ?? unknown),
        reviewText("소스 버전: ", "Revision: ") + (detail.revisionID ?? unknown), "OS: iOS",
        reviewText("마지막 전송 시도: ", "Last delivery attempt: ") + reviewTime(detail.lastAttemptAt),
        reviewText("마지막 수신 확인(기기 시각): ", "Last receipt observed (device clock): ") + reviewTime(detail.lastReceivedAt),
        reviewText("연결 유효기간: ", "Session expiry: ") + reviewExpiry(detail.sessionExpiresAt),
        reviewText("실행 유효기간: ", "Run expiry: ") + reviewExpiry(detail.runExpiresAt),
        reviewText("유효기간은 서버가 판정합니다. 위 시각은 KST입니다.", "Expiry is enforced by the server. All times above are KST.")].joined(separator: "\n")
}

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private let main = MainViewController()
    private var campaigns: InAppCampaignClient?
    private var review: InAppTestClient?
    private var reviewTask: Task<Void, Never>?
    private var reviewGeneration = 0
    private var reviewing = false
    private var cover: UIView?
    private var fallback: DispatchWorkItem?
    private var attempted = false
    private var eligible = false
    private let consentKey = "launchAdConsent"

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        self.window = window
        window.rootViewController = main
        main.loadViewIfNeeded()
        main.consent.isOn = UserDefaults.standard.bool(forKey: consentKey)
        main.consent.addTarget(self, action: #selector(consentChanged), for: .valueChanged)
        main.connectReview.addTarget(self, action: #selector(connectReview), for: .touchUpInside)
        main.endReview.addTarget(self, action: #selector(endReview), for: .touchUpInside)
        main.copyRun.addTarget(self, action: #selector(copyReviewRun), for: .touchUpInside)
        main.retryReview.addTarget(self, action: #selector(retryReview), for: .touchUpInside)
        main.discardReview.addTarget(self, action: #selector(discardReview), for: .touchUpInside)
        if !apiURL.contains("YOUR_"), !sdkKey.contains("YOUR_") {
            do { try prepareReviewClient() } catch { main.transfer.text = reviewText("검수 기록 저장소를 열지 못했습니다. 기기 저장소 접근을 확인한 뒤 앱을 다시 실행하세요.", "Review storage is unavailable. Check device storage access and restart the app."); main.connectReview.isEnabled = false }
        }
        // This sample is a single-window, startup-only app. Consume a skipped opportunity too.
        eligible = main.consent.isOn && options?[.url] == nil && options?[.userActivityDictionary] == nil
        guard eligible, let url = URL(string: apiURL), !apiURL.contains("YOUR_"),
              !sdkKey.contains("YOUR_"), !sdkKey.isEmpty else {
            attempted = true
            main.status.text = "Main · configure API/key, allow ads, then terminate and relaunch."
            window.makeKeyAndVisible()
            return true
        }
        do {
            campaigns = try InAppCampaignClient(
                configuration: .init(apiURL: url, sdkKey: sdkKey),
                host: { [weak self] in self?.main },
                isAllowed: { [weak self] in self?.eligible == true },
                // Empty URL allowlists: actions are not opened by this sample.
                onAction: { [weak self] _ in self?.main.status.text = "Main · campaign action received" },
                onDiagnostic: { message in NSLog("NudgeOn: %@", message) }
            )
            addCover() // Before the first main frame; below the SDK's presented controller.
            let deadline = DispatchWorkItem { [weak self] in
                guard let self, self.cover != nil else { return }
                self.skipLaunch("Main · host preparation deadline reached")
            }
            fallback = deadline
            DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: deadline)
        } catch {
            attempted = true
            eligible = false
            main.status.text = "Main · invalid SDK configuration"
        }
        window.makeKeyAndVisible()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        guard !attempted, eligible, cover != nil else { return }
        attempted = true
        campaigns?.enableAfterLaunch(timeoutSeconds: 3, displaySeconds: 4) { [weak self] result in
            guard let self, self.cover != nil else { return }
            // .shown reports presentation START. The opaque ad is now above main.
            // Do not disable the client here: that would dismiss the ad immediately.
            self.main.status.text = "Main · launch result: \(result)"
            self.removeCover()
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Consume the opportunity during backgrounding/permission UI; never insert it later.
        skipLaunch("Main · inactive; relaunch for another startup attempt")
        endReview()
    }

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        skipLaunch("Main · external route takes priority")
        endReview()
        return false // The sample has no deep-link destination. Route in your app here.
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        skipLaunch("Main · external route takes priority")
        endReview()
        return false
    }

    @objc private func consentChanged() {
        UserDefaults.standard.set(main.consent.isOn, forKey: consentKey)
        skipLaunch("Main · consent saved; terminate and relaunch to test")
        endReview()
    }

    @objc private func connectReview() {
        let token = (main.pairingCode.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            main.reviewStatus.text = "Paste the workbench pairing code first."
            return
        }
        guard URL(string: apiURL) != nil, !apiURL.contains("YOUR_"),
              !sdkKey.contains("YOUR_"), !sdkKey.isEmpty else {
            main.reviewStatus.text = "Configure API_URL and the public SDK key in this example first."
            return
        }
        // Explicit test opt-in is separate from campaign consent. Never run both clients together.
        skipLaunch("Main · content review mode; relaunch later for the published launch ad")
        main.view.endEditing(true)
        do {
            try prepareReviewClient()
            guard let review else { return }
            reviewing = true
            reviewGeneration += 1
            let generation = reviewGeneration
            main.connectReview.isEnabled = false
            main.endReview.isEnabled = true
            main.reviewStatus.text = "Connecting…"
            reviewTask = Task { [weak self] in
                do {
                    let pairing = try await review.pair(token: token, deviceName: "iOS launch example")
                    guard let self, !Task.isCancelled, self.reviewGeneration == generation else { return }
                    self.main.pairingCode.text = "" // Do not persist the pairing code; the SDK protects delivery credentials.
                    self.main.confirmation.text = "Confirmation number: \(pairing.confirmation_code)"
                    self.main.reviewStatus.text = "Compare this number in the console, confirm the same device, then run the saved source."
                } catch {
                    guard let self, !Task.isCancelled, self.reviewGeneration == generation else { return }
                    self.reviewing = false
                    self.main.connectReview.isEnabled = true
                    self.main.endReview.isEnabled = false
                    self.main.reviewStatus.text = "Connection failed. Generate a new pairing code and retry."
                }
            }
        } catch {
            main.reviewStatus.text = "Invalid SDK configuration. Check the API address."
        }
    }

    private func prepareReviewClient() throws {
        guard review == nil, let url = URL(string: apiURL) else { return }
        review = try InAppTestClient(configuration: .init(apiURL: url, sdkKey: sdkKey),
            host: { [weak self] in self?.main }, isAllowed: { [weak self] in self?.reviewing == true },
            onAction: { [weak self] _ in self?.main.reviewStatus.text = "Test action received." },
            onDiagnostic: { message in
                guard !message.hasPrefix("CONFIRM_DEVICE:") else { return }
                print("NudgeOn review: \(message)")
            }, onTransferStatus: { [weak self] state in
                guard let self else { return }
                self.showTransfer(state)
            })
    }
    private func showTransfer(_ state: InAppTestTransferStatus) {
        let permanent = permanentReviewErrors.contains(state.reason ?? "")
        let count = reviewText("대기 \(state.pendingCount)건 · 연결 누적 수신 \(state.acknowledgedCount)건", "Pending \(state.pendingCount) · session received \(state.acknowledgedCount)")
        let message: String
        if permanent {
            let cause: String
            switch state.reason {
            case "HTTP_401", "HTTP_403": cause = reviewText("연결 만료 또는 권한 문제로 서버가 수신을 거절했습니다. API 주소와 SDK 키, 테스트 연결을 확인하세요.", "The server rejected the test credentials. Check the API address, SDK key and test connection; the session may have expired or lost permission.")
            case "HTTP_404", "HTTP_409", "HTTP_410": cause = reviewText("실행 만료·취소 또는 기록 충돌로 서버가 수신을 거절했습니다.", "The run is unavailable, expired or cancelled, or the record conflicts with one already received.")
            case "QUEUE_FULL": cause = reviewText("보관 가능한 기록 수를 넘었습니다.", "The pending-record limit was reached.")
            default: cause = reviewText("서버가 기록 형식을 거절했습니다. 개발 담당자에게 SDK와 서버 설정 확인을 요청하세요.", "The server rejected the record format. Ask your developer to check SDK and server configuration.")
            }
            message = reviewText("새 검수가 필요합니다. ", "A new review is required. ") + cause + reviewText(" 이 기록은 재전송할 수 없습니다. 아래 ‘새 검수 준비’에서 폐기를 확인한 뒤 새 연결 코드를 입력하세요.", " These records cannot be retried. Use Prepare new review below, confirm discard, then enter a new pairing code.")
        } else if state.reason == "STORAGE_ERROR" {
            message = reviewText("기록 저장을 확인하지 못했습니다. 앱을 종료하면 미저장 기록이 유실될 수 있습니다. 기기 저장소 문제를 해결한 뒤 다시 시도하세요. 자동 재시도는 중단되었습니다.", "Storage could not be confirmed. Closing the app can lose unsaved records. Resolve device storage access, then retry. Automatic retries are paused.")
        } else {
            switch state.phase {
            case .idle: message = reviewText("보낼 기록이 없습니다. 새 검수는 기기 연결 후 시작합니다.", "No pending records. Connect a device to start a new review.")
            case .pending, .failed:
                message = state.pendingCount > 0
                    ? reviewText("기록 \(state.pendingCount)건 보관 중 · 자동 재시도 예정. 앱이 실행 가능한 동안 다시 전송합니다. 연결이 복구되면 ‘다시 전송’을 눌러도 됩니다. 테스트 유효기간 안에 전송을 마치세요.", "\(state.pendingCount) record(s) retained · automatic retry scheduled while the app can run. Retry transfer when the connection recovers. Complete delivery before the test expires.")
                    : reviewText("기록 전송은 끝났고 연결 종료를 확인 중입니다. 앱이 실행 가능한 동안 자동 재시도합니다.", "Records have been sent; session closure is pending. Automatic retry continues while the app can run.")
            case .sending: message = reviewText("서버 수신을 확인 중입니다. 확인이 끝날 때까지 보관 기록을 유지합니다.", "Confirming server receipt. Records remain retained until acknowledgement.")
            case .acknowledged:
                message = state.canEndSafely
                    ? reviewText("기록 전송 완료. 다음: 콘솔에서 검수 승인. 같은 소스 버전·OS의 실행 결과와 네이티브 닫기 완료를 확인하세요. 중단된 검수는 다시 진행해야 합니다. 수신 완료는 검수 통과가 아닙니다.", "Delivery complete. Next: approve the review in the console. Check the same revision, OS and native-close completion. Interrupted reviews must be repeated. Receipt is not approval.")
                    : reviewText("현재 기록은 서버가 받았습니다. 콘텐츠 확인 후 네이티브 닫기로 검수를 마치세요.", "Current records were received. Finish content review with the native Close button.")
            }
        }
        main.transfer.text = message + "\n" + count
        main.reviewContext.text = reviewContext(state.review)
        main.copyRun.isEnabled = state.review?.runID != nil
        main.transferDetails.text = state.reason.map { reviewText("진단 코드: ", "Diagnostic code: ") + $0 }
        main.retryReview.isEnabled = !permanent && (state.phase == .failed || state.phase == .pending)
        main.discardReview.setTitle(permanent ? reviewText("새 검수 준비", "Prepare new review") : reviewText("보관 기록 폐기", "Discard pending records"), for: .normal)
        main.discardReview.isEnabled = permanent || (!reviewing && (state.phase == .failed || state.pendingCount > 0))
        if !reviewing { main.connectReview.isEnabled = state.canEndSafely }
    }
    @objc private func copyReviewRun() {
        guard let id = review?.transferStatus.review?.runID else { return }
        UIPasteboard.general.string = id // Non-secret ID can also be pasted into the desktop console.
        main.lookupHint.text = reviewText("실행 ID를 복사했습니다. 콘솔 → 인앱 캠페인 → 검수 → 실행 ID로 찾기에 붙여 넣으세요. 같은 소스 버전·OS인지 확인한 후 승인하세요.", "Run ID copied. In the console, open In-app campaigns → Review → Find by run ID. Check the matching revision and OS before approving.")
    }
    @objc private func retryReview() {
        guard let review, !permanentReviewErrors.contains(review.transferStatus.reason ?? "") else { return }
        review.retryPendingEvents()
    }
    @objc private func discardReview() {
        let prompt = UIAlertController(title: reviewText("보관 기록을 폐기할까요?", "Discard pending records?"), message: reviewText("미전송 기록은 삭제되며 서버 수신이나 검수 통과로 처리되지 않습니다. 새 코드를 발급받아 같은 소스를 다시 검수해야 합니다.", "Unsent records will be deleted, never marked received or approved. Generate a new pairing code and review the source again."), preferredStyle: .alert)
        prompt.addAction(UIAlertAction(title: reviewText("기록 유지", "Keep records"), style: .cancel))
        prompt.addAction(UIAlertAction(title: reviewText("기록 폐기 후 새 검수", "Discard and start new review"), style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.reviewing = false; self.reviewGeneration += 1
            let generation = self.reviewGeneration
            self.reviewTask?.cancel(); self.reviewTask = nil
            self.main.pairingCode.text = ""; self.main.confirmation.text = ""; self.main.endReview.isEnabled = false
            Task { [weak self] in
                guard let self else { return }
                await self.review?.discardPendingEvents()
                if self.reviewGeneration == generation, self.review?.transferStatus.phase == .idle {
                    self.main.reviewStatus.text = reviewText("콘솔에서 새 연결 코드를 발급받아 입력하세요. 소스 검수도 다시 진행하세요.", "Generate and enter a new console pairing code, then review the source again.")
                }
            }
        })
        main.present(prompt, animated: true)
    }

    @objc private func endReview() {
        guard reviewing || reviewTask != nil else { return }
        reviewing = false
        reviewGeneration += 1
        let generation = reviewGeneration
        reviewTask?.cancel()
        reviewTask = nil
        review?.contextChanged() // Invalidates a pairing request already in flight.
        main.pairingCode.text = ""
        main.confirmation.text = ""
        main.reviewStatus.text = reviewText("테스트 화면을 종료했습니다. 기록 전송 상태는 아래에서 확인하세요.", "Test presentation stopped. Check record delivery below.")
        main.connectReview.isEnabled = false
        main.endReview.isEnabled = false
        let client = review
        Task { [weak self] in
            await client?.end()
            guard let self, self.reviewGeneration == generation else { return }
            self.main.connectReview.isEnabled = client?.transferStatus.canEndSafely == true
        }
    }

    private func skipLaunch(_ reason: String) {
        attempted = true
        eligible = false
        campaigns?.disable() // Cancels preparation/presentation and stops polling.
        main.status.text = reason
        removeCover()
    }

    private func addCover() {
        let view = UIView(frame: main.view.bounds)
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.backgroundColor = UIColor(red: 0.04, green: 0.14, blue: 0.22, alpha: 1)
        view.accessibilityViewIsModal = true
        view.isAccessibilityElement = true
        view.accessibilityLabel = "Preparing startup ad"
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        spinner.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
        spinner.startAnimating()
        view.addSubview(spinner)
        main.view.addSubview(view)
        cover = view
    }

    private func removeCover() {
        fallback?.cancel()
        fallback = nil
        cover?.removeFromSuperview()
        cover = nil
    }
}

@MainActor
final class MainViewController: UIViewController {
    let status = UILabel()
    let consent = UISwitch()
    let pairingCode = UITextField()
    let confirmation = UILabel()
    let reviewStatus = UILabel()
    let transfer = UILabel()
    let transferDetails = UILabel()
    let reviewContext = UILabel()
    let copyRun = UIButton(type: .system)
    let lookupHint = UILabel()
    let retryReview = UIButton(type: .system)
    let discardReview = UIButton(type: .system)
    let connectReview = UIButton(type: .system)
    let endReview = UIButton(type: .system)
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.text = "Main"
        status.numberOfLines = 0
        let title = UILabel()
        title.text = "NudgeOn · App launch example"
        title.font = .preferredFont(forTextStyle: .title2)
        title.numberOfLines = 0
        let instructions = UILabel()
        instructions.numberOfLines = 0
        instructions.text = "Allow startup ads in this test app. After changing consent, terminate the process and relaunch. Returning from Home does not retry."
        consent.accessibilityLabel = "Allow startup ads"
        let reviewTitle = UILabel()
        reviewTitle.text = "1. Content review · manual close"
        reviewTitle.font = .preferredFont(forTextStyle: .headline)
        let reviewHelp = UILabel()
        reviewHelp.numberOfLines = 0
        reviewHelp.text = "Paste a workbench code, connect, and compare the confirmation number. Finish the test using the ad's native Close button. End stops presentation and sends pending records. Server confirmed means receipt, not review approval. Retry temporary failures without reconnecting; rejected sessions require a new review."
        pairingCode.placeholder = "Workbench pairing code"
        pairingCode.accessibilityIdentifier = "review-pairing-code"
        pairingCode.borderStyle = .roundedRect
        pairingCode.autocapitalizationType = .none
        pairingCode.autocorrectionType = .no
        confirmation.numberOfLines = 0
        confirmation.font = .preferredFont(forTextStyle: .headline)
        confirmation.accessibilityIdentifier = "review-confirmation"
        reviewStatus.numberOfLines = 0
        reviewStatus.text = reviewText("테스트 연결과 기록 전송은 별개입니다. 새 검수는 연결 버튼으로 시작하세요.", "Test pairing and record delivery are separate. Use Connect to start a new review.")
        connectReview.setTitle("Connect for content review", for: .normal)
        endReview.setTitle("End test session", for: .normal)
        endReview.isEnabled = false
        transfer.numberOfLines = 0
        transfer.text = reviewText("보낼 기록이 없습니다.", "No pending records")
        transfer.accessibilityIdentifier = "review-transfer"
        retryReview.setTitle(reviewText("다시 전송", "Retry transfer"), for: .normal)
        retryReview.accessibilityIdentifier = "review-retry"
        discardReview.accessibilityIdentifier = "review-discard"
        transferDetails.accessibilityIdentifier = "review-transfer-details"
        reviewContext.numberOfLines = 0
        reviewContext.font = .preferredFont(forTextStyle: .footnote)
        reviewContext.accessibilityIdentifier = "review-context"
        copyRun.setTitle(reviewText("실행 ID 복사", "Copy run ID"), for: .normal)
        copyRun.accessibilityIdentifier = "review-copy-run"; copyRun.isEnabled = false
        lookupHint.numberOfLines = 0; lookupHint.font = .preferredFont(forTextStyle: .footnote)
        lookupHint.accessibilityIdentifier = "review-lookup-hint"
        lookupHint.text = reviewText("콘솔의 인앱 캠페인 → 검수에서 실행 ID로 찾을 수 있습니다. 자격증명은 복사하지 않습니다.", "Find this run in console → In-app campaigns → Review. Credentials are never copied.")
        transferDetails.numberOfLines = 0
        transferDetails.font = .preferredFont(forTextStyle: .caption1)
        transferDetails.textColor = .secondaryLabel
        discardReview.setTitle("Discard pending records", for: .normal)
        retryReview.isEnabled = false
        discardReview.isEnabled = false
        let launchTitle = UILabel()
        launchTitle.text = "2. Published launch ad · auto-dismiss"
        launchTitle.font = .preferredFont(forTextStyle: .headline)
        let stack = UIStackView(arrangedSubviews: [title, reviewTitle, reviewHelp, pairingCode,
            connectReview, confirmation, reviewStatus, transfer, transferDetails, reviewContext, copyRun, lookupHint, endReview, retryReview, discardReview, launchTitle, instructions, consent, status])
        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        ])
    }
}
