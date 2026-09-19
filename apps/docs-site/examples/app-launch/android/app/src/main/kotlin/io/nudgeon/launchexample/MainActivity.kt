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
    private var reviewConnected = false
    private var endReviewPrompt: AlertDialog? = null
    private var reviewGeneration = 0
    private lateinit var pairingCode: EditText
    private lateinit var confirmation: TextView
    private lateinit var reviewStatus: TextView
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
        val token = pairingCode.text.toString().trim()
        if (token.isEmpty()) { reviewStatus.text = "Paste the workbench pairing code first."; return }
        if (API_URL.contains("YOUR_") || SDK_KEY.contains("YOUR_") || SDK_KEY.isBlank()) {
            reviewStatus.text = "Configure API_URL and the public SDK key in this example first."
            return
        }
        // Test opt-in is separate from campaign consent. Never enable both clients together.
        skipLaunch("Main · content review mode; relaunch later for the published launch ad")
        try {
            val client = review ?: InAppTestClient(application,
                InAppTestClient.Configuration(apiUrl = API_URL, sdkKey = SDK_KEY),
                host = { this }, isAllowed = { reviewing && resumed && !isFinishing && !isDestroyed },
                onAction = { reviewStatus.text = "Test action received; check its result in the console." },
                onDiagnostic = { message ->
                    if (reviewing && !message.startsWith("CONFIRM_DEVICE:")) {
                        reviewStatus.text = "Local event: $message\nServer receipt is not confirmed here. Check the console completion record."
                    }
                }).also { review = it }
            reviewing = true
            reviewConnected = false
            val generation = ++reviewGeneration
            connectReview.isEnabled = false
            endReview.isEnabled = true
            reviewStatus.text = "Connecting…"
            reviewJob = reviewScope.launch {
                try {
                    val pairing = client.pair(token, "Android launch example")
                    if (!isActive || generation != reviewGeneration) return@launch
                    reviewConnected = true
                    pairingCode.text.clear() // Never persist a test credential or pairing code.
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

    private fun requestEndContentReview() {
        if (!reviewConnected) { endContentReview(); return } // Cancel pending pairing directly.
        if (endReviewPrompt != null) return
        val generation = reviewGeneration
        endReviewPrompt = AlertDialog.Builder(this)
            .setCustomTitle(TextView(this).apply {
                text = "After native Close, check this run’s completed state and impression/close records in the console. Ending may discard unsent events."
                textSize = 18f
                val padding = (24 * resources.displayMetrics.density).toInt()
                setPadding(padding, padding, padding, padding / 2)
            })
            .setItems(arrayOf("Keep waiting", "Console record checked · end", "Discard and end")) { _, choice ->
                if (generation == reviewGeneration && choice != 0) {
                    endContentReview()
                    if (choice == 2) reviewStatus.text = "Review abandoned. Unsent records may be lost; run a new test before approval."
                }
            }.create().also { dialog ->
                dialog.setOnDismissListener { if (endReviewPrompt === dialog) endReviewPrompt = null }
                dialog.show()
            }
    }

    private fun endContentReview() {
        if (!reviewing && reviewJob == null) return
        endReviewPrompt?.dismiss()
        endReviewPrompt = null
        reviewConnected = false
        reviewing = false
        reviewGeneration++
        reviewJob?.cancel()
        reviewJob = null
        review?.end() // Invalidates in-flight pairing and ends the remote session asynchronously.
        pairingCode.text.clear()
        confirmation.text = ""
        reviewStatus.text = "Test session ended. Unsent records may be lost. Check the console before approval."
        connectReview.isEnabled = true
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
        column.addView(text("Paste a workbench code, connect, and compare the confirmation number. Finish with the ad's native Close button, then wait for completion in the console before ending this session."))
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
        reviewStatus = text("Not connected. Test mode starts only when you tap Connect.")
        column.addView(reviewStatus)
        endReview = Button(this).apply {
            text = "End test session"
            isEnabled = false
            setOnClickListener { requestEndContentReview() }
        }
        column.addView(endReview)
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
