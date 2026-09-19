import UIKit
import NudgeOnInApp

// Use the API base URL and a PUBLIC SDK key for a controlled test app.
// Do not use an admin API key. Keep credentials out of committed edits.
private let apiURL = "https://YOUR_API_HOST"
private let sdkKey = "YOUR_PUBLIC_SDK_KEY"

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
    private var reviewConnected = false
    private var endReviewPrompt: UIAlertController?
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
        main.endReview.addTarget(self, action: #selector(requestEndReview), for: .touchUpInside)
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
        guard let url = URL(string: apiURL), !apiURL.contains("YOUR_"),
              !sdkKey.contains("YOUR_"), !sdkKey.isEmpty else {
            main.reviewStatus.text = "Configure API_URL and the public SDK key in this example first."
            return
        }
        // Explicit test opt-in is separate from campaign consent. Never run both clients together.
        skipLaunch("Main · content review mode; relaunch later for the published launch ad")
        main.view.endEditing(true)
        do {
            if review == nil {
                review = try InAppTestClient(
                    configuration: .init(apiURL: url, sdkKey: sdkKey),
                    host: { [weak self] in self?.main },
                    isAllowed: { [weak self] in self?.reviewing == true },
                    onAction: { [weak self] _ in self?.main.reviewStatus.text = "Test action received; check its result in the console." },
                    onDiagnostic: { [weak self] message in
                        guard let self, self.reviewing, !message.hasPrefix("CONFIRM_DEVICE:") else { return }
                        self.main.reviewStatus.text = "Local event: \(message)\nServer receipt is not confirmed here. Check the console completion record."
                    }
                )
            }
            guard let review else { return }
            reviewing = true
            reviewConnected = false
            reviewGeneration += 1
            let generation = reviewGeneration
            main.connectReview.isEnabled = false
            main.endReview.isEnabled = true
            main.reviewStatus.text = "Connecting…"
            reviewTask = Task { [weak self] in
                do {
                    let pairing = try await review.pair(token: token, deviceName: "iOS launch example")
                    guard let self, !Task.isCancelled, self.reviewGeneration == generation else { return }
                    self.reviewConnected = true
                    self.main.pairingCode.text = "" // Keep pairing credentials out of persistent storage.
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

    @objc private func requestEndReview() {
        guard reviewConnected else { endReview(); return } // Pending pairing is safe to cancel.
        guard endReviewPrompt == nil, main.presentedViewController == nil else { return }
        let generation = reviewGeneration
        let prompt = UIAlertController(title: "Check the console before ending",
            message: "After native Close, wait for this run’s completed state and impression/close records. Local events do not confirm server receipt. Ending now can discard unsent records.", preferredStyle: .alert)
        prompt.addAction(UIAlertAction(title: "Keep waiting", style: .cancel) { [weak self] _ in
            self?.endReviewPrompt = nil
        })
        prompt.addAction(UIAlertAction(title: "Console record checked · end", style: .default) { [weak self] _ in
            guard let self, self.reviewGeneration == generation else { return }
            self.endReviewPrompt = nil
            self.endReview()
        })
        prompt.addAction(UIAlertAction(title: "Discard and end", style: .destructive) { [weak self] _ in
            guard let self, self.reviewGeneration == generation else { return }
            self.endReviewPrompt = nil
            self.endReview()
            self.main.reviewStatus.text = "Review abandoned. Unsent records may be lost; run a new test before approval."
        })
        endReviewPrompt = prompt
        main.present(prompt, animated: true)
    }

    private func endReview() {
        guard reviewing || reviewTask != nil else { return }
        endReviewPrompt?.dismiss(animated: false)
        endReviewPrompt = nil
        reviewConnected = false
        reviewing = false
        reviewGeneration += 1
        let generation = reviewGeneration
        reviewTask?.cancel()
        reviewTask = nil
        review?.contextChanged() // Invalidates a pairing request already in flight.
        main.pairingCode.text = ""
        main.confirmation.text = ""
        main.reviewStatus.text = "Test session ended. Unsent records may be lost. Check the console before approval."
        main.connectReview.isEnabled = false
        main.endReview.isEnabled = false
        let client = review
        Task { [weak self] in
            await client?.end()
            guard let self, self.reviewGeneration == generation else { return }
            self.main.connectReview.isEnabled = true
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
        reviewHelp.text = "Paste a workbench code, connect, and compare the confirmation number. Finish the test using the ad's native Close button. Wait for the console to record completion before ending this session."
        pairingCode.placeholder = "Workbench pairing code"
        pairingCode.accessibilityIdentifier = "review-pairing-code"
        pairingCode.borderStyle = .roundedRect
        pairingCode.autocapitalizationType = .none
        pairingCode.autocorrectionType = .no
        confirmation.numberOfLines = 0
        confirmation.font = .preferredFont(forTextStyle: .headline)
        confirmation.accessibilityIdentifier = "review-confirmation"
        reviewStatus.numberOfLines = 0
        reviewStatus.text = "Not connected. Test mode starts only when you tap Connect."
        connectReview.setTitle("Connect for content review", for: .normal)
        endReview.setTitle("End test session", for: .normal)
        endReview.isEnabled = false
        let launchTitle = UILabel()
        launchTitle.text = "2. Published launch ad · auto-dismiss"
        launchTitle.font = .preferredFont(forTextStyle: .headline)
        let stack = UIStackView(arrangedSubviews: [title, reviewTitle, reviewHelp, pairingCode,
            connectReview, confirmation, reviewStatus, endReview, launchTitle, instructions, consent, status])
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
