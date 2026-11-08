package io.gitlab.adviseworn.familysiteblocker.lock

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlin.concurrent.thread
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import io.gitlab.adviseworn.familysiteblocker.BrowserFragment
import io.gitlab.adviseworn.familysiteblocker.R
import io.gitlab.adviseworn.familysiteblocker.databinding.FragmentLockBinding
import mozilla.components.support.base.feature.UserInteractionHandler
import java.text.DateFormat
import java.util.Date

/**
 * The Lock page: what the phone has let the lock do (the setup, with a button for each missing piece), where
 * the lock stands (on with its wait, unlocking with its progress, off until a time), the things to do with
 * it (turn on, start or stop unlocking, lengthen the wait, lock again now, turn off while off), and the
 * record. Everything here is plain words; the add-on's pages show the same record in Every try.
 */
class LockFragment : Fragment(), UserInteractionHandler {
    private var _binding: FragmentLockBinding? = null
    private val binding get() = _binding!!
    private lateinit var state: LockState
    private val onChange = SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> if (_binding != null) render() }
    private var pendingWhy: String? = null
    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        pendingWhy?.let { why -> pendingWhy = null; begin(why) }
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

        binding.waitChooser.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, state.waits.map { LockState.duration(it) })
        binding.waitChooser.setSelection(state.waits.indexOf(state.delaySeconds).coerceAtLeast(0))

        binding.accessibilityButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        binding.adminButton.setOnClickListener {
            startActivity(
                Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
                    .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(requireContext(), LockAdminReceiver::class.java))
                    .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, getString(R.string.lock_admin_explanation)),
            )
        }
        binding.turnOn.setOnClickListener {
            val delay = state.waits[binding.waitChooser.selectedItemPosition]
            inBackground { state.turnOn(delay) }
        }
        binding.startUnlocking.setOnClickListener { askWhy() }
        binding.stopUnlocking.setOnClickListener {
            UnlockService.stop(requireContext())
            render()
        }
        binding.lengthen.setOnClickListener { askLonger() }
        binding.lockAgain.setOnClickListener { inBackground { state.lockAgain(byHand = true) } }
        binding.turnOff.setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setMessage(R.string.lock_turn_off_confirm)
                .setPositiveButton(R.string.lock_turn_off) { _, _ -> state.turnOff(); render() }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
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
        val accessibility = Permissions.accessibilityOn(context)
        val admin = Permissions.adminOn(context)
        binding.accessibilityStatus.text = getString(if (accessibility) R.string.lock_permission_done else R.string.lock_permission_missing)
        binding.adminStatus.text = getString(if (admin) R.string.lock_permission_done else R.string.lock_permission_missing)
        binding.accessibilityButton.visibility = if (accessibility) View.GONE else View.VISIBLE
        binding.adminButton.visibility = if (admin) View.GONE else View.VISIBLE
        binding.setupNote.visibility = if (accessibility && admin) View.GONE else View.VISIBLE

        val box = state.box
        val progress = state.progress
        val browsers = Browsers.packages(context).map { Browsers.label(context, it) }.sorted()
        binding.browsers.text = if (browsers.isEmpty()) getString(R.string.lock_no_other_browsers) else getString(R.string.lock_other_browsers, browsers.joinToString(", "))

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
                binding.status.text = getString(R.string.lock_status_unlocking, LockState.percent(done, Puzzle.stepsOf(box)), LockState.duration(UnlockService.remainingSeconds(box, progress)))
                binding.progress.progress = if (Puzzle.stepsOf(box) > 0) (1000 * done / Puzzle.stepsOf(box)).toInt() else 0
                show(binding.stopUnlocking, binding.lengthen, binding.progress)
                hide(binding.waitRow, binding.turnOn, binding.startUnlocking, binding.lockAgain, binding.turnOff)
            }
            else -> {
                val wait = LockState.duration(Puzzle.secondsOf(box).toLong())
                binding.status.text = if (progress != null) {
                    getString(R.string.lock_status_on_paused, wait, LockState.percent(progress.before + progress.done, Puzzle.stepsOf(box)))
                } else {
                    getString(R.string.lock_status_on, wait)
                }
                show(binding.startUnlocking, binding.lengthen)
                hide(binding.waitRow, binding.turnOn, binding.stopUnlocking, binding.lockAgain, binding.turnOff, binding.progress)
            }
        }
        if (binding.startUnlocking.visibility == View.VISIBLE && progress != null) binding.startUnlocking.setText(R.string.lock_resume_unlocking) else binding.startUnlocking.setText(R.string.lock_start_unlocking)

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
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun askOtherReason() {
        val input = EditText(requireContext())
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.lock_why)
            .setView(input)
            .setPositiveButton(R.string.lock_start_unlocking) { _, _ -> begin(input.text.toString().trim()) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun begin(why: String) {
        // The unlocking shows its progress in a notification, which Android 13 and later ask leave for.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            pendingWhy == null
        ) {
            pendingWhy = why
            notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        state.startUnlocking(why)
        UnlockService.start(requireContext())
        render()
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

    private fun askLonger() {
        val box = state.box ?: return
        val current = Puzzle.secondsOf(box).toLong()
        val longer = state.waits.filter { it > current }
        if (longer.isEmpty()) {
            AlertDialog.Builder(requireContext()).setMessage(R.string.lock_already_longest).setPositiveButton(android.R.string.ok, null).show()
            return
        }
        AlertDialog.Builder(requireContext())
            .setTitle(R.string.lock_lengthen_to)
            .setItems(longer.map { LockState.duration(it) }.toTypedArray()) { _, which ->
                if (state.unlocking) UnlockService.stop(requireContext())
                inBackground { state.lengthen(longer[which]) }
            }
            .setNegativeButton(android.R.string.cancel, null)
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
