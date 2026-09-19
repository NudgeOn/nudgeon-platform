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
    }

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        skipLaunch("Main · external route takes priority")
        return false // The sample has no deep-link destination. Route in your app here.
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        skipLaunch("Main · external route takes priority")
        return false
    }

    @objc private func consentChanged() {
        UserDefaults.standard.set(main.consent.isOn, forKey: consentKey)
        skipLaunch("Main · consent saved; terminate and relaunch to test")
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
        let stack = UIStackView(arrangedSubviews: [title, instructions, consent, status])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32)
        ])
    }
}
