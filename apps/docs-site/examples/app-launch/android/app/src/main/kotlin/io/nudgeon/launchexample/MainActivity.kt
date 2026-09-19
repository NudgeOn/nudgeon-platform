package io.nudgeon.launchexample

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
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
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        skipLaunch("Main · external route takes priority")
        // Route to your app's destination here; the sample has no destinations.
    }

    override fun onDestroy() {
        removeCover()
        campaigns?.destroy()
        campaigns = null
        super.onDestroy()
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
        column.addView(text("Allow startup ads, then force-stop and relaunch. Returning from Home does not retry."))
        column.addView(Switch(this).apply {
            text = "Allow startup ads"
            isChecked = preferences.getBoolean("consent", false)
            setOnCheckedChangeListener { _, enabled ->
                preferences.edit().putBoolean("consent", enabled).apply()
                skipLaunch("Main · consent saved; force-stop and relaunch to test")
            }
        })
        status = text("Main")
        column.addView(status)
        root.addView(column, ViewGroup.LayoutParams(-1, -1))
        setContentView(root)
    }
}
