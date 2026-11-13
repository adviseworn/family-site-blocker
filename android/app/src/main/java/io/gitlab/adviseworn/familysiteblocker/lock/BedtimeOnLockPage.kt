package io.gitlab.adviseworn.familysiteblocker.lock

import android.content.Context
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import io.gitlab.adviseworn.familysiteblocker.R
import org.json.JSONObject
import java.time.ZoneId
import kotlin.concurrent.thread

/**
 * The Lock page's lines about the bedtime: what the add-on's bedtime is (set on its own settings page), and
 * whether the lock turns the other apps away while it lasts, with the one button that switches that. Anyone
 * can switch it on. Once the lock is on it holds the switch like everything else: other apps are left open
 * again only while the lock is off, which takes the lock's wait.
 */
class BedtimeOnLockPage(
    private val context: Context,
    private val state: LockState,
    private val status: TextView,
    private val button: Button,
    private val changed: () -> Unit,
) {
    private val setting = BedtimeSetting(context)
    @Volatile private var leftOpen: List<String>? = null

    init {
        // Which apps stay open is asked of the phone once, off the main thread; until it answers the line names none.
        val app = context.applicationContext
        thread { leftOpen = BedtimeApps.leftOpenNames(app) }
        button.setOnClickListener { pressed() }
    }

    fun render() {
        val now = System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        val bedtime = setting.bedtime.inForce(now)
        val held = setting.apps && state.isOn
        val lines = mutableListOf<String>()
        if (bedtime.on) {
            bedtime.endOf(now, zone)?.let { lines += context.getString(R.string.bedtime_now, BedtimeWatch.timeOf(context, it)) }
            lines += context.getString(R.string.bedtime_sites, BedtimeWatch.timeOfDay(context, bedtime.from), BedtimeWatch.timeOfDay(context, bedtime.to))
        } else {
            lines += context.getString(R.string.bedtime_none)
        }
        val names = leftOpen
        lines += when {
            !setting.apps -> context.getString(R.string.bedtime_apps_off)
            names.isNullOrEmpty() -> context.getString(R.string.bedtime_apps_on_none_named)
            else -> context.getString(R.string.bedtime_apps_on, names.joinToString(", "))
        }
        if (held) lines += context.getString(R.string.bedtime_apps_held)
        status.text = lines.joinToString(" ")
        button.visibility = if (held) View.GONE else View.VISIBLE
        button.setText(if (setting.apps) R.string.bedtime_turn_apps_off else R.string.bedtime_turn_apps_on)
    }

    private fun pressed() {
        if (!setting.apps) {
            AlertDialog.Builder(context)
                .setMessage(R.string.bedtime_turn_apps_on_confirm)
                .setPositiveButton(R.string.bedtime_turn_apps_on_short) { _, _ ->
                    setting.turnAppsAway()
                    state.record("bedtime-apps-on", JSONObject())
                    changed()
                }
                .setNegativeButton(R.string.lock_go_back, null)
                .show()
        } else if (setting.leaveAppsOpen(lockOn = state.isOn)) {
            state.record("bedtime-apps-off", JSONObject())
            changed()
        } else {
            changed() // the lock went on while the page was open: the button goes
        }
    }
}
