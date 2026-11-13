package io.gitlab.adviseworn.familysiteblocker.lock

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.core.text.bold
import androidx.core.text.buildSpannedString
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.doOnAttach
import androidx.core.view.updatePadding
import androidx.fragment.app.Fragment
import io.gitlab.adviseworn.familysiteblocker.BrowserFragment
import io.gitlab.adviseworn.familysiteblocker.BuildConfig
import io.gitlab.adviseworn.familysiteblocker.R
import io.gitlab.adviseworn.familysiteblocker.databinding.FragmentLockBinding
import mozilla.components.support.base.feature.UserInteractionHandler
import java.text.DateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * The Lock page: what the phone has let the lock do (the setup, with a button for each missing piece), where
 * the lock stands (the wait on a line of its own, then on, unlocking with its progress, or off until a time),
 * the things to do with it, and the record.
 *
 * The page uses the words of the add-on's locked-away password page on a computer for the same things: the
 * same waits to choose from, "Wait: 1 hour" first, Start unlocking (with a reason), Carry on unlocking for
 * work that was paused, Stop unlocking (which asks, then throws the work away) and Lengthen the wait. Its
 * buttons are of two kinds only: filled for turning the lock on, outlined for everything else.
 */
class LockFragment : Fragment(), UserInteractionHandler {
    private var _binding: FragmentLockBinding? = null
    private val binding get() = _binding!!
    private lateinit var state: LockState
    private lateinit var bedtime: BedtimeOnLockPage
    private val onChange = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> if (_binding != null) render() }
    private var pendingWhy: String? = null
    // Whatever the answer, the unlocking goes ahead: without the leave the work still runs, only unseen.
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        pendingWhy?.let { why -> pendingWhy = null; begin(why, asked = true) }
    }
    private var busy = false
    private val ticker = object : Runnable {
        override fun run() {
            if (_binding == null) return
            render()
            binding.root.postDelayed(this, 2000)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentLockBinding.inflate(inflater, container, false)
        state = LockState(requireContext())
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        binding.toolbar.setNavigationOnClickListener { close() }
        bedtime = BedtimeOnLockPage(requireContext(), state, binding.bedtimeStatus, binding.bedtimeApps) { if (_binding != null) render() }

        // The waits as the computer's menu names them, in the same order as LockState.waits.
        binding.waitChooser.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, resources.getStringArray(R.array.lock_waits))
        binding.waitChooser.setSelection(state.waits.indexOf(state.delaySeconds).coerceAtLeast(0))

        // The Settings screens open on top of this app, not in Settings' own list of screens: left there, the
        // app's own Settings screen is where Settings would open the next time, and the lock holds that screen.
        binding.accessibilityButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.appInfoButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", requireContext().packageName, null)))
        }
        // Android's screen lists the operations an administrator may perform, and this one's list is empty. The
        // explanation sent along is the only word of the app's that Android shows on that screen: the
        // description in the manifest shows in Android's list of device admin apps, and nowhere else.
        binding.adminButton.setOnClickListener {
            startActivity(
                Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(requireContext(), LockAdminReceiver::class.java))
                    .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, getString(R.string.lock_admin_description)),
            )
        }
        // Usage access under the name this phone's Settings give it.
        val usageAccess = Words.usageAccessName(Build.VERSION.SDK_INT)
        binding.usageText.text = getString(R.string.lock_permission_usage, usageAccess)
        binding.usageButton.text = getString(R.string.lock_permission_usage_button, usageAccess.lowercase(Locale.ROOT))
        // The app's own line in Settings' list, where there is one; the whole list otherwise.
        binding.usageButton.setOnClickListener {
            val own = Uri.fromParts("package", requireContext().packageName, null)
            runCatching { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, own)) }
                .onFailure { runCatching { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) } }
        }
        binding.turnOn.setOnClickListener {
            val delay = state.waits[binding.waitChooser.selectedItemPosition]
            inBackground { state.turnOn(delay) }
        }
        // Start unlocking asks why; Carry on unlocking was given its reason when the work began.
        binding.startUnlocking.setOnClickListener { if (state.progress != null) begin(null) else askWhy() }
        binding.stopUnlocking.setOnClickListener { askToStop() }
        binding.lengthen.setOnClickListener { askLonger() }
        binding.lockAgain.setOnClickListener { inBackground { state.lockAgain(byHand = true) } }
        binding.turnOff.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setMessage(R.string.lock_turn_off_confirm)
                .setPositiveButton(R.string.lock_turn_off) { _, _ -> state.turnOff(); render() }
                .setNegativeButton(R.string.lock_go_back, null)
                .show()
        }
        binding.version.text = getString(R.string.lock_version, BuildConfig.VERSION_NAME, BuildConfig.APP_BUILD)
        // The app draws under the phone's navigation bar; the foot of the page, the version, has to clear it.
        val below = binding.content.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(binding.content) { content, insets ->
            content.updatePadding(bottom = below + insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom)
            insets
        }
        binding.content.doOnAttach { ViewCompat.requestApplyInsets(it) }
        render()
    }

    override fun onStart() {
        super.onStart()
        state.registerOnChange(onChange)
        binding.root.post(ticker)
    }

    override fun onStop() {
        state.unregisterOnChange(onChange)
        binding.root.removeCallbacks(ticker)
        super.onStop()
    }

    override fun onDestroyView() {
        _binding = null
        super.onDestroyView()
    }

    private fun render() {
        val context = requireContext()
        state.relockIfDue()
        // The state says unlocking but nothing is doing the work: the phone restarted, or Android stopped the
        // app. That is a pause, dated when the work was last saved, and Carry on unlocking picks it up.
        if (state.unlocking && !UnlockService.alive) state.pauseUnlocking(state.workedAt)

        val accessibility = Permissions.accessibilityOn(context)
        // The accessibility shortcut, set to this app, switches the service off at one press: not done until it is off.
        val shortcut = accessibility && Permissions.shortcutOn(context)
        val admin = Permissions.adminOn(context)
        val usage = Permissions.usageOn(context)
        state.noteUsageAccess(usage)
        binding.accessibilityStatus.text = getString(if (accessibility && !shortcut) R.string.lock_permission_done else R.string.lock_permission_missing)
        binding.adminStatus.text = getString(if (admin) R.string.lock_permission_done else R.string.lock_permission_missing)
        binding.usageStatus.text = getString(if (usage) R.string.lock_permission_done else R.string.lock_permission_missing)
        binding.accessibilityButton.visibility = if (accessibility && !shortcut) View.GONE else View.VISIBLE
        binding.shortcutHint.visibility = if (shortcut) View.VISIBLE else View.GONE
        // Things the phone may already allow that lead round the lock; each is said only while it is so.
        binding.debuggingHint.visibility = if (Permissions.debuggingOn(context)) View.VISIBLE else View.GONE
        binding.usersHint.visibility = if (Permissions.userSwitchOn(context)) View.VISIBLE else View.GONE
        // And a third: another browser that may display over other apps, by name.
        val others = Browsers.packages(context)
        val displayOver = others.filter { Permissions.displaysOver(context, it) }.map { Browsers.label(context, it) }.sorted()
        // From Android 12 the watch has Android keep floating windows off while one of them may ([LockAccessibilityService]).
        val displayOverWords = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) R.string.lock_display_over_hint else R.string.lock_display_over_hint_before_12
        binding.displayOverHint.text = getString(displayOverWords, displayOver.joinToString(", "))
        binding.displayOverHint.visibility = if (displayOver.isEmpty()) View.GONE else View.VISIBLE
        // Usage access is asked for where Android keeps Security & privacy from the watch, from Android 14 on.
        val usageRow = if (Permissions.usageNeeded) View.VISIBLE else View.GONE
        binding.usageText.visibility = usageRow
        binding.usageStatus.visibility = usageRow
        binding.usageButton.visibility = if (Permissions.usageNeeded && !usage) View.VISIBLE else View.GONE
        // Android 13 and later refuse the accessibility switch to an app installed from a file until the
        // person allows it on the app's own Settings page, and Android 15 does the same with the other two;
        // Android's link to the instructions needs a browser.
        val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && (!accessibility || Permissions.mayNeedAllowing(context))
        binding.restrictedHint.visibility = if (restricted) View.VISIBLE else View.GONE
        binding.appInfoButton.visibility = if (restricted) View.VISIBLE else View.GONE
        binding.adminButton.visibility = if (admin) View.GONE else View.VISIBLE
        binding.setupNote.visibility = if (Permissions.allGranted(context)) View.GONE else View.VISIBLE

        val box = state.box
        val progress = state.progress
        val browsers = others.map { Browsers.label(context, it) }.sorted()
        binding.browsers.text = if (browsers.isEmpty()) getString(R.string.lock_no_other_browsers) else getString(R.string.lock_other_browsers, browsers.joinToString(", "))

        // The wait first, on a line of its own, so its length is found at a glance, as on the computer.
        if (state.enabled && box != null) {
            binding.waitLine.text = buildSpannedString {
                append(getString(R.string.lock_wait_line))
                append(" ")
                bold { append(Words.duration(state.waitSeconds)) }
            }
            show(binding.waitLine)
        } else {
            hide(binding.waitLine)
        }

        when {
            !state.enabled || box == null -> {
                binding.status.text = getString(R.string.lock_status_never_on)
                show(binding.waitRow, binding.turnOn)
                hide(binding.startUnlocking, binding.stopUnlocking, binding.lengthen, binding.lockAgain, binding.turnOff, binding.progress)
            }
            state.isOff -> {
                binding.status.text = getString(R.string.lock_status_off_until, time(state.offUntil))
                show(binding.lockAgain, binding.turnOff)
                hide(binding.waitRow, binding.turnOn, binding.startUnlocking, binding.stopUnlocking, binding.lengthen, binding.progress)
            }
            state.unlocking -> {
                val done = (progress?.before ?: 0) + (progress?.done ?: 0)
                binding.status.text = getString(R.string.lock_status_unlocking, Words.percent(done, Puzzle.stepsOf(box)), Words.duration(UnlockService.remainingSeconds(box, progress)))
                binding.progress.progress = if (Puzzle.stepsOf(box) > 0) (1000 * done / Puzzle.stepsOf(box)).toInt() else 0
                show(binding.stopUnlocking, binding.lengthen, binding.progress)
                hide(binding.waitRow, binding.turnOn, binding.startUnlocking, binding.lockAgain, binding.turnOff)
            }
            else -> {
                val standing = state.standing() ?: getString(R.string.lock_status_on)
                if (progress != null) {
                    // Paused: the work is kept. Carry on picks it up, Stop unlocking throws it away.
                    binding.status.text = getString(R.string.lock_status_on_paused, standing, Words.percent(progress.before + progress.done, Puzzle.stepsOf(box)))
                    show(binding.startUnlocking, binding.stopUnlocking, binding.lengthen)
                } else {
                    binding.status.text = standing
                    show(binding.startUnlocking, binding.lengthen)
                    hide(binding.stopUnlocking)
                }
                hide(binding.waitRow, binding.turnOn, binding.lockAgain, binding.turnOff, binding.progress)
            }
        }
        binding.startUnlocking.setText(if (progress != null) R.string.lock_carry_on_unlocking else R.string.lock_start_unlocking)

        bedtime.render()

        val events = state.events().takeLast(12).reversed()
        binding.record.text = if (events.isEmpty()) getString(R.string.lock_record_empty) else events.joinToString("\n") { state.describe(it) }
    }

    private fun askWhy() {
        val reasons = resources.getStringArray(R.array.lock_reasons)
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.lock_why)
            .setItems(reasons) { _, which ->
                if (which == reasons.lastIndex) askOtherReason() else begin(reasons[which])
            }
            .setNegativeButton(R.string.lock_go_back, null)
            .show()
    }

    private fun askOtherReason() {
        val input = EditText(requireContext())
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.lock_why)
            .setView(input)
            .setPositiveButton(R.string.lock_start_unlocking) { _, _ -> begin(input.text.toString().trim()) }
            .setNegativeButton(R.string.lock_go_back, null)
            .show()
    }

    /** Starts the unlocking for the reason [why], or carries on the paused work (which has its reason already). */
    private fun begin(why: String?, asked: Boolean = false) {
        // The unlocking shows its progress in a notification, which Android 13 and later ask leave for, once.
        if (!asked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            pendingWhy = why ?: ""
            notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        // Work that was just paused or stopped takes a moment to end (its thread looks at the state before
        // every batch of squarings). The new start waits for it, so that nothing of the old work is carried on.
        if (UnlockService.alive && !state.unlocking) {
            binding.root.postDelayed({ if (_binding != null) begin(why, asked = true) }, 250)
            return
        }
        UnlockService.begin(requireContext(), state, why)
        render()
    }

    /** Stop unlocking throws the work away, on the phone as on the computer, so it asks first. */
    private fun askToStop() {
        AlertDialog.Builder(requireContext())
            .setMessage(R.string.lock_stop_confirm)
            .setPositiveButton(R.string.lock_stop_unlocking) { _, _ -> state.cancelUnlocking(); render() }
            .setNegativeButton(R.string.lock_go_back, null)
            .show()
    }

    /** Sealing a box takes a moment (two large primes); it runs off the main thread with the buttons held. */
    private fun inBackground(work: () -> Unit) {
        if (busy) return
        busy = true
        setButtonsEnabled(false)
        thread {
            try { work() } finally {
                activity?.runOnUiThread {
                    busy = false
                    if (_binding != null) { setButtonsEnabled(true); render() }
                }
            }
        }
    }

    private fun setButtonsEnabled(enabled: Boolean) {
        listOf(binding.turnOn, binding.lockAgain, binding.lengthen, binding.startUnlocking, binding.stopUnlocking, binding.turnOff).forEach { it.isEnabled = enabled }
    }

    /** Offers the waits that are longer than the present one, and only those. */
    private fun askLonger() {
        if (state.box == null) return
        val longer = Words.longerThan(state.waitSeconds)
        if (longer.isEmpty()) {
            AlertDialog.Builder(requireContext()).setMessage(R.string.lock_already_longest).setPositiveButton(android.R.string.ok, null).show()
            return
        }
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.lock_lengthen_to)
            .setItems(longer.map { Words.duration(it) }.toTypedArray()) { _, which ->
                // Unlocking under way or paused was done on the box as it is; a longer wait throws it away.
                if (state.unlocking || state.progress != null) confirmLonger(longer[which]) else inBackground { state.lengthen(longer[which]) }
            }
            .setNegativeButton(R.string.lock_go_back, null)
            .show()
    }

    private fun confirmLonger(seconds: Long) {
        AlertDialog.Builder(requireContext())
            .setMessage(R.string.lock_lengthen_confirm)
            .setPositiveButton(R.string.lock_lengthen) { _, _ -> inBackground { state.lengthen(seconds) } }
            .setNegativeButton(R.string.lock_go_back, null)
            .show()
    }

    private fun time(millis: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(millis))

    private fun show(vararg views: View) = views.forEach { it.visibility = View.VISIBLE }
    private fun hide(vararg views: View) = views.forEach { it.visibility = View.GONE }

    private fun close() {
        parentFragmentManager.beginTransaction()
            .replace(R.id.container, BrowserFragment.create())
            .commit()
    }

    override fun onBackPressed(): Boolean {
        close()
        return true
    }
}
