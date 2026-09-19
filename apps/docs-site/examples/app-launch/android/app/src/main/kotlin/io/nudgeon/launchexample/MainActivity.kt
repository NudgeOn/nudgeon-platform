package io.nudgeon.launchexample

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.text.InputType
import kotlinx.coroutines.*
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Switch
import android.widget.TextView
import io.nudgeon.inapp.InAppCampaignClient
import io.nudgeon.inapp.InAppTestClient
import io.nudgeon.inapp.InAppTestTransferStatus

// Use a controlled test app's API base URL and PUBLIC SDK key, never an admin key.
// Keep credentials out of committed edits.
private const val API_URL = "https://YOUR_API_HOST"
private const val SDK_KEY = "YOUR_PUBLIC_SDK_KEY"

class MainActivity : Activity() {
    companion object {
        // Process lifetime, including skipped launches and Activity recreation.
        private var opportunityConsumed = false
    }
    private val handler = Handler(Looper.getMainLooper())
    private val preferences by lazy { getSharedPreferences("launch-example", MODE_PRIVATE) }
    private lateinit var root: FrameLayout
    private lateinit var status: TextView
    private var campaigns: InAppCampaignClient? = null
    private var review: InAppTestClient? = null
    private val reviewScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var reviewJob: Job? = null
    private var reviewing = false
    private var reviewGeneration = 0
    private lateinit var pairingCode: EditText
    private lateinit var confirmation: TextView
    private lateinit var reviewStatus: TextView
    private lateinit var transfer: TextView
    private lateinit var transferDetails: TextView
    private lateinit var reviewContext: TextView
    private lateinit var copyRun: Button
    private lateinit var lookupHint: TextView
    private lateinit var retryReview: Button
    private lateinit var discardReview: Button
    private lateinit var connectReview: Button
    private lateinit var endReview: Button
    private var cover: View? = null
    private var pending = false
    private var eligible = false
    private var resumed = false
    private val fallback = Runnable { skipLaunch("Main · host preparation deadline reached") }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildMain()
        if (!API_URL.contains("YOUR_") && !SDK_KEY.contains("YOUR_")) {
            try { prepareReviewClient() } catch (_: Exception) { transfer.text = reviewText("검수 기록 저장소를 열지 못했습니다. 기기 저장소 접근을 확인한 뒤 앱을 다시 실행하세요.", "Review storage is unavailable. Check device storage access and restart the app."); connectReview.isEnabled = false }
        }
        val firstOwner = !opportunityConsumed && savedInstanceState == null
        opportunityConsumed = true // Consent changes must not create a late launch.
        val launcherEntry = intent.action == Intent.ACTION_MAIN &&
            intent.hasCategory(Intent.CATEGORY_LAUNCHER) && intent.data == null
        eligible = firstOwner && launcherEntry && preferences.getBoolean("consent", false)
        if (!eligible || API_URL.contains("YOUR_") || SDK_KEY.contains("YOUR_") || SDK_KEY.isBlank()) {
            status.text = "Main · configure API/key, allow ads, then force-stop and relaunch."
            return
        }
        try {
            campaigns = InAppCampaignClient(
                application = application,
                configuration = InAppTestClient.Configuration(apiUrl = API_URL, sdkKey = SDK_KEY),
                host = { this },
                isAllowed = { eligible && resumed && !isFinishing && !isDestroyed },
                // Empty URL allowlists: this sample does not open external actions.
                onAction = { status.text = "Main · campaign action received" },
                onDiagnostic = { android.util.Log.d("NudgeOnLaunch", it) }
            )
            addCover() // Before the first frame. SDK presentation goes above this view.
            pending = true
            handler.postDelayed(fallback, 3_000)
        } catch (_: Exception) {
            eligible = false
            status.text = "Main · invalid SDK configuration"
        }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        startIfReady()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) startIfReady()
        // Dialog focus loss is NOT app backgrounding. Do not call foreground() here.
    }

    private fun startIfReady() {
        if (!pending || !eligible || !resumed || !hasWindowFocus()) return
        pending = false
        campaigns?.enableAfterLaunch(timeoutSeconds = 3.0, displaySeconds = 4.0) { result ->
            if (cover != null) {
                // SHOWN means presentation START, with the opaque ad above main.
                // Keep the client enabled so its native timer can finish the ad.
                status.text = "Main · launch result: $result"
                removeCover()
            }
        }
    }

    override fun onPause() {
        resumed = false
        // Startup-only example: stop for permission UI, backgrounding or host changes.
        skipLaunch("Main · inactive; force-stop and relaunch for another attempt")
        endContentReview()
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        skipLaunch("Main · external route takes priority")
        endContentReview()
        // Route to your app's destination here; the sample has no destinations.
    }

    override fun onDestroy() {
        removeCover()
        endContentReview()
        review?.destroy()
        reviewScope.cancel()
        campaigns?.destroy()
        campaigns = null
        super.onDestroy()
    }

    private fun connectContentReview() {
        pairingCode.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
            .hideSoftInputFromWindow(pairingCode.windowToken, 0)
        val token = pairingCode.text.toString().trim()
        if (token.isEmpty()) { reviewStatus.text = "Paste the workbench pairing code first."; return }
        if (API_URL.contains("YOUR_") || SDK_KEY.contains("YOUR_") || SDK_KEY.isBlank()) {
            reviewStatus.text = "Configure API_URL and the public SDK key in this example first."
            return
        }
        // Test opt-in is separate from campaign consent. Never enable both clients together.
        skipLaunch("Main · content review mode; relaunch later for the published launch ad")
        try {
            val client = prepareReviewClient()
            reviewing = true
            val generation = ++reviewGeneration
            connectReview.isEnabled = false
            endReview.isEnabled = true
            reviewStatus.text = "Connecting…"
            reviewJob = reviewScope.launch {
                try {
                    val pairing = client.pair(token, "Android launch example")
                    if (!isActive || generation != reviewGeneration) return@launch
                    pairingCode.text.clear() // Do not persist the pairing code; the SDK protects delivery credentials.
                    confirmation.text = "Confirmation number: ${pairing.confirmationCode}"
                    reviewStatus.text = "Compare this number in the console, confirm the same device, then run the saved source."
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) {
                    if (generation != reviewGeneration) return@launch
                    reviewing = false
                    connectReview.isEnabled = true
                    endReview.isEnabled = false
                    reviewStatus.text = "Connection failed. Generate a new pairing code and retry."
                }
            }
        } catch (_: Exception) { reviewStatus.text = "Invalid SDK configuration. Check the API address." }
    }

    private fun prepareReviewClient(): InAppTestClient = review ?: InAppTestClient(application,
        InAppTestClient.Configuration(apiUrl=API_URL,sdkKey=SDK_KEY),
        host={this},isAllowed={reviewing && resumed && !isFinishing && !isDestroyed},
        onAction={reviewStatus.text="Test action received."},
        onDiagnostic={android.util.Log.d("NudgeOnReview",it)},
        onTransferStatus={state -> showTransfer(state)}).also { review=it }

    private fun reviewText(ko: String, en: String) = if (resources.configuration.locales[0].language == "ko") ko else en
    private fun reviewTime(value: Long?): String = value?.let {
        java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'KST'", java.util.Locale.ROOT).apply {
            timeZone = java.util.TimeZone.getTimeZone("Asia/Seoul")
        }.format(java.util.Date(it))
    } ?: reviewText("아직 확인되지 않음", "Not recorded")
    private fun reviewExpiry(value: String?) = reviewTime(value?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() })
    private fun reviewContext(detail: io.nudgeon.inapp.InAppTestReviewDetails?): String {
        if(detail == null) return reviewText("검수 상세 정보가 없습니다. 이전 SDK에서 저장한 기록에는 시각·버전 정보가 없을 수 있습니다.", "Review details unavailable. Older SDK records may lack timestamps and revision context.")
        val unknown = reviewText("아직 확인되지 않음", "Not recorded")
        return listOf(reviewText("최근 실행 ID: ", "Latest run ID: ") + (detail.runId ?: unknown),
            reviewText("소스 버전: ", "Revision: ") + (detail.revisionId ?: unknown), "OS: Android",
            reviewText("마지막 전송 시도: ", "Last delivery attempt: ") + reviewTime(detail.lastAttemptAt),
            reviewText("마지막 수신 확인(기기 시각): ", "Last receipt observed (device clock): ") + reviewTime(detail.lastReceivedAt),
            reviewText("연결 유효기간: ", "Session expiry: ") + reviewExpiry(detail.sessionExpiresAt),
            reviewText("실행 유효기간: ", "Run expiry: ") + reviewExpiry(detail.runExpiresAt),
            reviewText("유효기간은 서버가 판정합니다. 위 시각은 KST입니다.", "Expiry is enforced by the server. All times above are KST.")).joinToString("\n")
    }
    private fun isPermanent(reason: String?) = reason in setOf("HTTP_400", "HTTP_401", "HTTP_403", "HTTP_404", "HTTP_409", "HTTP_410", "HTTP_422", "QUEUE_FULL")
    private fun showTransfer(state: InAppTestTransferStatus) {
        val permanent = isPermanent(state.reason)
        val count = reviewText("대기 ${state.pendingCount}건 · 연결 누적 수신 ${state.acknowledgedCount}건", "Pending ${state.pendingCount} · session received ${state.acknowledgedCount}")
        val message = when {
            permanent -> {
                val cause = when(state.reason) {
                    "HTTP_401", "HTTP_403" -> reviewText("연결 만료 또는 권한 문제로 서버가 수신을 거절했습니다. API 주소와 SDK 키, 테스트 연결을 확인하세요.", "The server rejected the test credentials. Check the API address, SDK key and test connection; the session may have expired or lost permission.")
                    "HTTP_404", "HTTP_409", "HTTP_410" -> reviewText("실행 만료·취소 또는 기록 충돌로 서버가 수신을 거절했습니다.", "The run is unavailable, expired or cancelled, or the record conflicts with one already received.")
                    "QUEUE_FULL" -> reviewText("보관 가능한 기록 수를 넘었습니다.", "The pending-record limit was reached.")
                    else -> reviewText("서버가 기록 형식을 거절했습니다. 개발 담당자에게 SDK와 서버 설정 확인을 요청하세요.", "The server rejected the record format. Ask your developer to check SDK and server configuration.")
                }
                reviewText("새 검수가 필요합니다. ", "A new review is required. ") + cause + reviewText(" 이 기록은 재전송할 수 없습니다. 아래 ‘새 검수 준비’에서 폐기를 확인한 뒤 새 연결 코드를 입력하세요.", " These records cannot be retried. Use Prepare new review below, confirm discard, then enter a new pairing code.")
            }
            state.reason == "STORAGE_ERROR" -> reviewText("기록 저장을 확인하지 못했습니다. 앱을 종료하면 미저장 기록이 유실될 수 있습니다. 기기 저장소 문제를 해결한 뒤 다시 시도하세요. 자동 재시도는 중단되었습니다.", "Storage could not be confirmed. Closing the app can lose unsaved records. Resolve device storage access, then retry. Automatic retries are paused.")
            else -> when(state.phase) {
                InAppTestTransferStatus.Phase.IDLE -> reviewText("보낼 기록이 없습니다. 새 검수는 기기 연결 후 시작합니다.", "No pending records. Connect a device to start a new review.")
                InAppTestTransferStatus.Phase.PENDING, InAppTestTransferStatus.Phase.FAILED -> if(state.pendingCount > 0)
                    reviewText("기록 ${state.pendingCount}건 보관 중 · 자동 재시도 예정. 앱이 실행 가능한 동안 다시 전송합니다. 연결이 복구되면 ‘다시 전송’을 눌러도 됩니다. 테스트 유효기간 안에 전송을 마치세요.", "${state.pendingCount} record(s) retained · automatic retry scheduled while the app can run. Retry transfer when the connection recovers. Complete delivery before the test expires.")
                    else reviewText("기록 전송은 끝났고 연결 종료를 확인 중입니다. 앱이 실행 가능한 동안 자동 재시도합니다.", "Records have been sent; session closure is pending. Automatic retry continues while the app can run.")
                InAppTestTransferStatus.Phase.SENDING -> reviewText("서버 수신을 확인 중입니다. 확인이 끝날 때까지 보관 기록을 유지합니다.", "Confirming server receipt. Records remain retained until acknowledgement.")
                InAppTestTransferStatus.Phase.ACKNOWLEDGED -> if(state.canEndSafely)
                    reviewText("기록 전송 완료. 다음: 콘솔에서 검수 승인. 같은 소스 버전·OS의 실행 결과와 네이티브 닫기 완료를 확인하세요. 중단된 검수는 다시 진행해야 합니다. 수신 완료는 검수 통과가 아닙니다.", "Delivery complete. Next: approve the review in the console. Check the same revision, OS and native-close completion. Interrupted reviews must be repeated. Receipt is not approval.")
                    else reviewText("현재 기록은 서버가 받았습니다. 콘텐츠 확인 후 네이티브 닫기로 검수를 마치세요.", "Current records were received. Finish content review with the native Close button.")
            }
        }
        transfer.text = "$message\n$count"
        reviewContext.text = reviewContext(state.review)
        copyRun.isEnabled = state.review?.runId != null
        transferDetails.text = state.reason?.let { reviewText("진단 코드: ","Diagnostic code: ") + it } ?: ""
        retryReview.isEnabled = !permanent && state.phase in setOf(InAppTestTransferStatus.Phase.PENDING,InAppTestTransferStatus.Phase.FAILED)
        discardReview.text = if(permanent) reviewText("새 검수 준비", "Prepare new review") else reviewText("보관 기록 폐기", "Discard pending records")
        discardReview.isEnabled = permanent || (!reviewing && (state.phase == InAppTestTransferStatus.Phase.FAILED || state.pendingCount > 0))
        if(!reviewing) connectReview.isEnabled = state.canEndSafely
    }

    private fun confirmDiscard() {
        AlertDialog.Builder(this).setTitle(reviewText("보관 기록을 폐기할까요?", "Discard pending records?"))
            .setMessage(reviewText("미전송 기록은 삭제되며 서버 수신이나 검수 통과로 처리되지 않습니다. 새 코드를 발급받아 같은 소스를 다시 검수해야 합니다.", "Unsent records will be deleted, never marked received or approved. Generate a new pairing code and review the source again."))
            .setNegativeButton(reviewText("기록 유지", "Keep records"),null)
            .setPositiveButton(reviewText("기록 폐기 후 새 검수", "Discard and start new review")) { _,_ ->
                reviewing = false; reviewGeneration++
                reviewJob?.cancel(); reviewJob = null
                pairingCode.text.clear(); confirmation.text = ""; endReview.isEnabled = false
                review?.discardPendingEvents()
                if(review?.transferStatus?.phase == InAppTestTransferStatus.Phase.IDLE) {
                    reviewStatus.text = reviewText("콘솔에서 새 연결 코드를 발급받아 입력하세요. 소스 검수도 다시 진행하세요.", "Generate and enter a new console pairing code, then review the source again.")
                }
            }.show()
    }

    private fun endContentReview() {
        if (!reviewing && reviewJob == null) return
        reviewing = false
        reviewGeneration++
        reviewJob?.cancel()
        reviewJob = null
        review?.end() // Invalidates in-flight pairing and ends the remote session asynchronously.
        pairingCode.text.clear()
        confirmation.text = ""
        reviewStatus.text = reviewText("테스트 화면을 종료했습니다. 기록 전송 상태는 아래에서 확인하세요.", "Test presentation stopped. Check record delivery below.")
        connectReview.isEnabled = review?.transferStatus?.canEndSafely == true
        endReview.isEnabled = false
    }

    private fun skipLaunch(reason: String) {
        pending = false
        eligible = false
        campaigns?.disable()
        status.text = reason
        removeCover()
    }

    private fun addCover() {
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(11, 36, 56))
            isClickable = true
            isFocusable = true
            contentDescription = "Preparing startup ad"
            addView(ProgressBar(context), FrameLayout.LayoutParams(96, 96, Gravity.CENTER))
        }
        root.getChildAt(0).importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        cover = overlay
    }

    private fun removeCover() {
        handler.removeCallbacks(fallback)
        cover?.let { root.removeView(it) }
        cover = null
        root.getChildAt(0).importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    private fun buildMain() {
        root = FrameLayout(this)
        val padding = (24 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        fun text(value: String) = TextView(this).apply {
            text = value
            textSize = 18f
            setPadding(0, 0, 0, padding)
        }
        column.addView(text("NudgeOn · App launch example"))
        column.addView(text("1. Content review · manual close"))
        column.addView(text("Paste a workbench code, connect, and compare the confirmation number. Finish with the ad's native Close button, then End to upload pending records. Server confirmed means receipt, not review approval. Retry temporary failures without reconnecting; rejected sessions require a new review."))
        pairingCode = EditText(this).apply {
            hint = "Workbench pairing code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
            isSaveEnabled = false
        }
        column.addView(pairingCode)
        connectReview = Button(this).apply {
            text = "Connect for content review"
            setOnClickListener { connectContentReview() }
        }
        column.addView(connectReview)
        confirmation = text("")
        column.addView(confirmation)
        reviewStatus = text(reviewText("테스트 연결과 기록 전송은 별개입니다. 새 검수는 연결 버튼으로 시작하세요.", "Test pairing and record delivery are separate. Use Connect to start a new review."))
        column.addView(reviewStatus)
        endReview = Button(this).apply {
            text = "End test session"
            isEnabled = false
            setOnClickListener { endContentReview() }
        }
        column.addView(endReview)
        transfer = text(reviewText("보낼 기록이 없습니다.", "No pending records"))
        transfer.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        transferDetails = text("").apply { textSize = 13f }
        column.addView(transfer)
        column.addView(transferDetails)
        reviewContext = text("").apply { textSize = 14f; setTextIsSelectable(true) }
        column.addView(reviewContext)
        lookupHint = text(reviewText("콘솔의 인앱 캠페인 → 검수에서 실행 ID로 찾을 수 있습니다. 자격증명은 복사하지 않습니다.", "Find this run in console → In-app campaigns → Review. Credentials are never copied."))
        copyRun = Button(this).apply {
            text = reviewText("실행 ID 복사", "Copy run ID"); isEnabled = false
            setOnClickListener {
                review?.transferStatus?.review?.runId?.let { id ->
                    (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                        .setPrimaryClip(android.content.ClipData.newPlainText("NudgeOn run ID", id))
                    lookupHint.text = reviewText("실행 ID를 복사했습니다. 콘솔 → 인앱 캠페인 → 검수 → 실행 ID로 찾기에 붙여 넣으세요. 같은 소스 버전·OS인지 확인한 후 승인하세요.", "Run ID copied. In the console, open In-app campaigns → Review → Find by run ID. Check the matching revision and OS before approving.")
                }
            }
        }
        column.addView(copyRun); column.addView(lookupHint)
        retryReview = Button(this).apply {
            text=reviewText("다시 전송", "Retry transfer"); isEnabled=false
            setOnClickListener { if(!isPermanent(review?.transferStatus?.reason)) review?.retryPendingEvents() }
        }
        discardReview = Button(this).apply {
            text=reviewText("보관 기록 폐기", "Discard pending records"); isEnabled=false
            setOnClickListener { confirmDiscard() }
        }
        column.addView(retryReview); column.addView(discardReview)
        column.addView(text("2. Published launch ad · auto-dismiss"))
        column.addView(text("Allow startup ads, then force-stop and relaunch. Returning from Home does not retry."))
        column.addView(Switch(this).apply {
            text = "Allow startup ads"
            isChecked = preferences.getBoolean("consent", false)
            setOnCheckedChangeListener { _, enabled ->
                preferences.edit().putBoolean("consent", enabled).apply()
                skipLaunch("Main · consent saved; force-stop and relaunch to test")
                endContentReview()
            }
        })
        status = text("Main")
        column.addView(status)
        val scroll = ScrollView(this).apply { addView(column) }
        root.addView(scroll, ViewGroup.LayoutParams(-1, -1))
        setContentView(root)
    }
}
