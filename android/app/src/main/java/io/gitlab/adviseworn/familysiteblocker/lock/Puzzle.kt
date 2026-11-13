package io.gitlab.adviseworn.familysiteblocker.lock

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A time-lock puzzle (Rivest, Shamir and Wagner, 1996), the phone's counterpart of the add-on's locked-away
 * password (extension/lib/timelock.js): a secret encrypted with a key that can only be worked out by squaring
 * a number [Box.steps] times in a row, modulo n. Each squaring needs the one before it, so the work cannot be
 * split across processors, and the number of squarings is chosen so that it takes the chosen wait on this
 * phone. Whoever seals the box knows the two primes behind n, which turns the same work into a shortcut of a
 * few milliseconds; they are thrown away as soon as the box is made. So neither the stored box nor a change of
 * the phone's clock skips the wait.
 *
 * The wait can be lengthened without the secret: the box itself is sealed inside a fresh puzzle of as many
 * more squarings as the difference takes ([lengthen]), so opening means solving the outer puzzle, which gives
 * the inner box, and then that one. A box that holds a box says what the layers inside it take, so the Lock
 * page can describe the whole wait without opening any of it.
 */
object Puzzle {
    private const val MODULUS_BITS = 2048
    private val BASE: BigInteger = BigInteger.valueOf(2)
    private const val TAG_BITS = 128
    private val random = SecureRandom()

    /** What the box holds: the secret itself, or another box (JSON) when the wait was lengthened. */
    enum class Holds { SECRET, BOX }

    /** A sealed box. `n` is the modulus, `steps` the squarings its own layer takes, `rate` the squarings per second measured when it was sealed. */
    data class Box(
        val n: BigInteger,
        val steps: Long,
        val rate: Double,
        val iv: ByteArray,
        val ciphertext: ByteArray,
        val holds: Holds,
        /** The layers inside, outermost first, each as (steps, rate), when [holds] is [Holds.BOX]. */
        val inside: List<Layer>,
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("format", FORMAT)
            put("n", n.toString(16))
            put("steps", steps)
            put("rate", rate)
            put("iv", iv.toHex())
            put("ct", ciphertext.toHex())
            put("holds", if (holds == Holds.BOX) "box" else "secret")
            put("inside", JSONArray().apply { inside.forEach { put(JSONObject().put("steps", it.steps).put("rate", it.rate)) } })
        }

        companion object {
            fun fromJson(json: JSONObject): Box {
                require(json.optString("format") == FORMAT) { "Not a lock box" }
                val inside = json.optJSONArray("inside") ?: JSONArray()
                return Box(
                    n = BigInteger(json.getString("n"), 16),
                    steps = json.getLong("steps"),
                    rate = json.getDouble("rate"),
                    iv = json.getString("iv").hexToBytes(),
                    ciphertext = json.getString("ct").hexToBytes(),
                    holds = if (json.optString("holds") == "box") Holds.BOX else Holds.SECRET,
                    inside = (0 until inside.length()).map { inside.getJSONObject(it) }.map { Layer(it.getLong("steps"), it.getDouble("rate")) },
                )
            }
        }
    }

    data class Layer(val steps: Long, val rate: Double)

    /**
     * The unlocking under way: the number reached and the squarings done in the layer being worked on, the
     * layer itself once the stored box has been opened to one inside it, and [box], the modulus of the stored
     * box the work was done on. Progress counts only for that box (as on the computer, where it carries the
     * box's `n`): lengthening the wait stores a new box, and work saved for the old one must never be carried
     * on against it. Progress saved by the first build to reach a phone has no [box]; it cannot be told whose
     * it is, so it is not used ([LockState] drops it and says so in the record).
     */
    data class Progress(val x: BigInteger, val done: Long, val before: Long, val inner: Box?, val box: BigInteger? = null) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("x", x.toString(16))
            put("done", done)
            put("before", before)
            inner?.let { put("inner", it.toJson()) }
            box?.let { put("n", it.toString(16)) }
        }

        /** Whether this is work done on [stored], the box now kept. */
        fun isFor(stored: Box): Boolean = box != null && box == stored.n

        companion object {
            fun fromJson(json: JSONObject): Progress = Progress(
                x = BigInteger(json.getString("x"), 16),
                done = json.getLong("done"),
                before = json.optLong("before", 0),
                inner = json.optJSONObject("inner")?.let { Box.fromJson(it) },
                box = json.optString("n").takeIf { it.isNotEmpty() }?.let { BigInteger(it, 16) },
            )
        }
    }

    private const val FORMAT = "family-site-blocker-phone-lock"

    /** All the layers of a box, outermost first. */
    fun layersOf(box: Box): List<Layer> = listOf(Layer(box.steps, box.rate)) + box.inside

    /** How many squarings the whole box takes. */
    fun stepsOf(box: Box): Long = layersOf(box).sumOf { it.steps }

    /** How long the whole box takes, in seconds, at the rates measured when its layers were sealed. */
    fun secondsOf(box: Box): Double = layersOf(box).sumOf { it.steps / it.rate }

    /**
     * Seals [secret] so that opening it takes [delaySeconds] at [rate] squarings a second. The squarings are
     * rounded to the nearest whole one, as the computer's page does; cutting the fraction off left every box a
     * hair short of its wait, and 1 hour, measured back, came out as 3599 seconds.
     */
    fun seal(secret: ByteArray, delaySeconds: Long, rate: Double, holds: Holds = Holds.SECRET, inside: List<Layer> = emptyList()): Box {
        val steps = maxOf(1L, Math.round(delaySeconds * rate))
        val p = BigInteger.probablePrime(MODULUS_BITS / 2, random)
        val q = BigInteger.probablePrime(MODULUS_BITS / 2, random)
        val n = p * q
        val phi = (p - BigInteger.ONE) * (q - BigInteger.ONE)
        // The shortcut: 2^steps mod phi(n) gives the exponent that reaches the same number in one go.
        val exponent = BigInteger.valueOf(2).modPow(BigInteger.valueOf(steps), phi)
        val answer = BASE.modPow(exponent, n)
        val iv = ByteArray(12).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyFrom(answer), GCMParameterSpec(TAG_BITS, iv))
        return Box(n, steps, rate, iv, cipher.doFinal(secret), holds, inside)
    }

    /** A box whose wait is [extraSeconds] longer: [box] sealed inside a fresh puzzle. */
    fun lengthen(box: Box, extraSeconds: Long, rate: Double): Box =
        seal(box.toJson().toString().toByteArray(), extraSeconds, rate, Holds.BOX, layersOf(box))

    /** One squaring step of the puzzle, [count] times: the only slow part. */
    fun square(x: BigInteger, n: BigInteger, count: Long): BigInteger {
        var y = x
        var left = count
        while (left > 0) {
            y = y.multiply(y).mod(n)
            left--
        }
        return y
    }

    /** Squarings a second on this phone, measured over about [millis]. */
    fun measureRate(millis: Long = 1000): Double {
        val n = BigInteger.probablePrime(MODULUS_BITS / 2, random) * BigInteger.probablePrime(MODULUS_BITS / 2, random)
        var x = BASE
        var count = 0L
        val start = System.nanoTime()
        val until = start + millis * 1_000_000
        while (System.nanoTime() < until) {
            x = square(x, n, 256)
            count += 256
        }
        val seconds = (System.nanoTime() - start) / 1e9
        return maxOf(1.0, count / seconds)
    }

    /** Whether [answer] opens [box]: the decrypted contents, or null when it does not. */
    fun open(box: Box, answer: BigInteger): ByteArray? = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keyFrom(answer), GCMParameterSpec(TAG_BITS, box.iv))
        cipher.doFinal(box.ciphertext)
    } catch (_: Exception) {
        null
    }

    /** The start of the work on [box]: the base, no squarings done, and whose work it is. */
    fun start(box: Box): Progress = Progress(BASE, 0, 0, null, box.n)

    /**
     * Works on [box] from [progress] for up to [chunk] squarings and returns the progress reached, or null once
     * the whole box is open (the secret is then in [onOpened]). A layer that opens onto a box inside continues
     * on that box, counting its squarings under `before`. Progress made on another box is refused: its number
     * means nothing here.
     */
    fun work(box: Box, progress: Progress, chunk: Long, onOpened: (ByteArray) -> Unit): Progress? {
        check(progress.isFor(box)) { "The saved unlocking is for another box" }
        val layer = progress.inner ?: box
        check(progress.done in 0..layer.steps) { "The saved unlocking does not fit the box" }
        val todo = minOf(chunk, layer.steps - progress.done)
        val x = if (todo > 0) square(progress.x, layer.n, todo) else progress.x
        val done = progress.done + todo
        if (done < layer.steps) return progress.copy(x = x, done = done)
        val contents = open(layer, x) ?: throw IllegalStateException("The box did not open after ${layer.steps} squarings")
        return if (layer.holds == Holds.BOX) {
            Progress(BASE, 0, progress.before + layer.steps, Box.fromJson(JSONObject(String(contents))), progress.box)
        } else {
            onOpened(contents)
            null
        }
    }

    private fun keyFrom(answer: BigInteger): SecretKeySpec =
        SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(answer.toByteArray()), "AES")

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    private fun String.hexToBytes() = chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
