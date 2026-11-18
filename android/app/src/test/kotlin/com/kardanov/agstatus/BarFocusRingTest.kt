package com.kardanov.agstatus

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PixelMap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.IntRect
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.kardanov.agstatus.ui.CornerCurve
import com.kardanov.agstatus.ui.ReportedCorners
import com.kardanov.agstatus.ui.RingCornerSource
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import kotlin.math.abs

/**
 * A keyboard's focus on the needs-you bar (the owner's decision of
 * 2026-11-17): a square ring of 2dp in the accent, inside the bar, as the
 * web draws its focus outline. It was Material's focus layer, which
 * lightened the blocked ground under the words and took the 12sp red word
 * under AA. Now the ground and every ink keep their values under focus; the
 * ring stands 2dp in from the bar's edges and from the system bars and
 * cutout beside or under it; neither a touch nor a pointer shows it; and in
 * a beat it holds at the bar's place while the bar's face rises under it.
 *
 * The bar's own pixels, as the real app draws them on a phone (3 px to the
 * dp), and a keyboard's real Tab. The window is drawn into a bitmap: the test
 * rule's own capture waits for a redraw Robolectric's paused looper never
 * runs.
 *
 * That capture draws the whole window again, in software, every time, so
 * these cases cannot tell whether the ring is drawn again on its own when
 * the focus comes or goes: a ring that read the focus without its draw
 * observing it would pass them all, and on a device keep showing what it
 * last drew until something else redrew the bar. That is the capture's
 * limit, accepted; only a device shows it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BarFocusRingTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var store: SessionStore

    /** The platform's own corners, which a case may stand in for. */
    private val platformCorners = RingCornerSource.read

    @After
    fun close() {
        scenario.close()
        RingCornerSource.read = platformCorners
    }

    private fun card(id: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = "Session $id",
        status = status,
        message = "Working on $id",
        project = "acme-api",
        homeProject = "acme-api",
        createdAt = 1,
        updatedAt = 1,
    )

    private var board = listOf(card("s1", AgentStatus.BLOCKED), card("w1"), card("w2"))

    /**
     * The board, out of touch mode as a keyboard leaves a screen, standing a
     * second, as a real board does before a block: one within half a second
     * of the board's first draw is part of its arrival, and no beat.
     */
    private fun launch() {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { store = ViewModelProvider(it)[SessionStore::class.java] }
        store.showForTest(board)
        rule.waitForIdle()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1_000))
        rule.waitForIdle()
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    private fun barFocused(): Boolean =
        rule.onNode(bar).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Focused) == true

    private fun tab() {
        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.waitForIdle()
    }

    /** Tab, as a reader would, until the bar has the keyboard's focus. */
    private fun tabToTheBar() {
        repeat(8) { if (!barFocused()) tab() }
        assertTrue("the bar has the keyboard's focus", barFocused())
    }

    /**
     * The system bars and a cutout, as the platform hands them to the window:
     * the bar runs under them, and its words keep inside them.
     */
    private fun insets(left: Int = 0, right: Int = 0, bottom: Int = 0) {
        scenario.onActivity { activity ->
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, right, bottom))
                .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(left, 0, 0, 0))
                .build()
            ViewCompat.dispatchApplyWindowInsets(activity.window.decorView, insets)
        }
        rule.waitForIdle()
    }

    /**
     * A finger arriving on the screen: the system takes the window into touch
     * mode as the touch arrives (ViewRootImpl.touchModeChanged, which a touch
     * Robolectric hands straight to the view goes round).
     */
    private fun intoTouchMode() {
        scenario.onActivity { activity ->
            val root = View::class.java.getMethod("getViewRootImpl").invoke(activity.window.decorView)
            root.javaClass.getMethod("touchModeChanged", Boolean::class.javaPrimitiveType).invoke(root, true)
        }
        rule.waitForIdle()
    }

    /** A touch on the board's title, which is no control: anywhere but the bar. */
    private fun touchElsewhere() {
        intoTouchMode()
        rule.onNodeWithText("AgStatus").performTouchInput {
            down(center)
            up()
        }
        rule.waitForIdle()
    }

    /**
     * A finger on the bar, held there for a shot of what the window draws
     * under it, then lifted, which presses the bar.
     */
    private fun holdTheBar(): Shot {
        intoTouchMode()
        rule.onNode(bar).performTouchInput { down(center) }
        rule.waitForIdle()
        val held = shot()
        rule.onNode(bar).performTouchInput { up() }
        rule.waitForIdle()
        return held
    }

    /** The bar's place in the window, which is where its press and its name are. */
    private fun place(): IntRect = rule.onNode(bar).fetchSemanticsNode().boundsInWindow
        .let { IntRect(it.left.toInt(), it.top.toInt(), it.right.toInt(), it.bottom.toInt()) }

    /** What the window draws at the bar's place, in the bar's own pixels. */
    private class Shot(private val pixels: PixelMap, private val place: IntRect) {
        val width = place.width
        val height = place.height

        operator fun get(x: Int, y: Int): Color = pixels[place.left + x, place.top + y]
    }

    private fun shot(at: IntRect = place()): Shot {
        lateinit var window: Bitmap
        scenario.onActivity { activity ->
            val view = activity.window.decorView
            window = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(window))
        }
        return Shot(window.asImageBitmap().toPixelMap(), at)
    }

    /** 2dp, at 3 px to the dp. */
    private val twoDp = 6

    /** Where the ring's outer edge stands, in the bar's pixels. */
    private data class Ring(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        /** Whether a pixel is in the ring's 2dp band. */
        fun holds(x: Int, y: Int, band: Int): Boolean =
            x in left until right && y in top until bottom &&
                (x < left + band || x >= right - band || y < top + band || y >= bottom - band)
    }

    /** The ring 2dp in from the bar's edges and from each inset beside or under it. */
    private fun ringIn(shot: Shot, left: Int = 0, right: Int = 0, bottom: Int = 0) =
        Ring(left + twoDp, twoDp, shot.width - right - twoDp, shot.height - bottom - twoDp)

    private fun hex(c: Color) = "#%02X%02X%02X".format((c.red * 255).toInt(), (c.green * 255).toInt(), (c.blue * 255).toInt())

    /**
     * The ring in the accent, its 2dp band whole along every side, and not
     * one pixel wider: across each side's middle, the band is the accent and
     * the pixel either side of it is not.
     */
    private fun assertRing(shot: Shot, ring: Ring, what: String) {
        val accent = hex(Theme.accent)
        val midX = (ring.left + ring.right) / 2
        val midY = (ring.top + ring.bottom) / 2
        val sides = mapOf(
            "top" to (ring.top - 1..ring.top + twoDp).map { midX to it },
            "bottom" to (ring.bottom - twoDp - 1..ring.bottom).map { midX to it },
            "left" to (ring.left - 1..ring.left + twoDp).map { it to midY },
            "right" to (ring.right - twoDp - 1..ring.right).map { it to midY },
        )
        for ((side, line) in sides) {
            val drawn = line.map { (x, y) -> hex(shot[x, y]) }
            val expected = line.map { (x, y) -> if (ring.holds(x, y, twoDp)) accent else "not $accent" }
            val matches = drawn.zip(expected).all { (d, e) -> if (e == accent) d == accent else d != accent }
            assertTrue("$what, the ring's $side side across its band: expected $expected, drawn $drawn", matches)
        }
        // Square: each corner is the accent to its very point.
        for ((x, y) in listOf(ring.left to ring.top, ring.right - 1 to ring.top, ring.left to ring.bottom - 1, ring.right - 1 to ring.bottom - 1)) {
            assertEquals("$what, the ring's corner at $x,$y", accent, hex(shot[x, y]))
        }
    }

    /** No pixel of the accent in [x0, x1) by [y0, y1) of the bar's place: by default, all of it. */
    private fun assertNoRing(shot: Shot, what: String, x0: Int = 0, y0: Int = 0, x1: Int = shot.width, y1: Int = shot.height) {
        val accent = hex(Theme.accent)
        var found: Pair<Int, Int>? = null
        for (y in y0 until y1) for (x in x0 until x1) {
            if (found == null && hex(shot[x, y]) == accent) found = x to y
        }
        assertEquals("$what, a pixel of the accent", null, found)
    }

    /** The brightest ink in the top line's last fifth, where the verb stands alone. */
    private fun verb(shot: Shot): Float {
        var brightest = 0f
        for (y in 4 until shot.height / 2) for (x in shot.width * 4 / 5 until shot.width - 2 * twoDp) {
            val c = shot[x, y]
            if (hex(c) != hex(Theme.accent)) brightest = maxOf(brightest, (c.red + c.green + c.blue) / 3)
        }
        return brightest
    }

    @Test
    fun `under a keyboard's focus the ground, the edge and every word stay as they were, and only the ring is new`() {
        launch()
        val rest = shot()
        tabToTheBar()
        val focused = shot()

        // The commonest colour at the bar's place is its ground.
        val counts = HashMap<String, Int>()
        for (y in 0 until focused.height) for (x in 0 until focused.width) counts.merge(hex(focused[x, y]), 1, Int::plus)
        assertEquals("the ground under focus", hex(Theme.cardSurface(DisplayStatus.BLOCKED)), counts.maxBy { it.value }.key)
        // Every pixel the ring does not cover is as it was before the focus came.
        val ring = ringIn(focused)
        val changed = ArrayList<String>()
        for (y in 0 until focused.height) for (x in 0 until focused.width) {
            if (!ring.holds(x, y, twoDp) && rest[x, y] != focused[x, y]) changed += "$x,$y ${hex(rest[x, y])} to ${hex(focused[x, y])}"
        }
        assertEquals("pixels outside the ring that the focus changed: ${changed.take(4)}", 0, changed.size)
    }

    @Test
    fun `the ring is the accent, 2dp wide and square, its outer edge 2dp inside the bar on every side`() {
        launch()
        tabToTheBar()
        val shot = shot()

        assertRing(shot, ringIn(shot), "on a phone")
        // Along the top, the blocked edge (the blocked ink at 42% over the
        // ground, #843C33), then 1dp of ground, then the ring.
        val top = (0 until twoDp).map { shot[shot.width / 2, it] }
        val edge = Color(0xFF843C33)
        val ground = Theme.cardSurface(DisplayStatus.BLOCKED)
        val near = { a: Color, b: Color -> listOf(a.red - b.red, a.green - b.green, a.blue - b.blue).all { abs(it) <= 2 / 255f } }
        assertTrue(
            "the 1dp edge, then 1dp of ground: ${top.map(::hex)}",
            top.take(3).all { near(it, edge) } && top.drop(3).all { near(it, ground) },
        )
    }

    @Test
    fun `beside a cutout and over a navigation bar or a gesture handle, the ring keeps 2dp inside them`() {
        launch()
        tabToTheBar()

        // Three buttons along the bottom.
        insets(bottom = 144)
        val buttons = shot()
        assertRing(buttons, ringIn(buttons, bottom = 144), "over three buttons")
        assertNoRing(buttons, "under the buttons", y0 = buttons.height - 144)
        // Sideways: the camera's cutout on the left, the buttons on the right.
        insets(left = 135, right = 144)
        val sideways = shot()
        assertRing(sideways, ringIn(sideways, left = 135, right = 144), "beside a cutout and the buttons")
        assertNoRing(sideways, "in the cutout", x1 = 135)
        assertNoRing(sideways, "under the buttons", x0 = sideways.width - 144)
        // Sideways with gestures: the cutout on the left, the handle along the bottom.
        insets(left = 135, bottom = 72)
        val gestures = shot()
        assertRing(gestures, ringIn(gestures, left = 135, bottom = 72), "beside a cutout, over a gesture handle")
        assertNoRing(gestures, "in the cutout", x1 = 135)
        assertNoRing(gestures, "under the gesture handle", y0 = gestures.height - 72)
        assertTrue("the bar still has the focus", barFocused())
    }

    @Test
    fun `no ring without a keyboard's focus, at rest, under a pointer, or once the focus has moved on`() {
        launch()
        val rest = shot()
        assertNoRing(rest, "at rest")

        rule.onNode(bar).performMouseInput { enter(center) }
        rule.waitForIdle()
        val hovered = shot()
        assertTrue("the pointer is on the bar: its verb lights, ${verb(rest)} to ${verb(hovered)}", verb(hovered) > verb(rest) + 0.1f)
        assertFalse("a pointer resting on the bar gives it no focus", barFocused())
        assertNoRing(hovered, "under a pointer")
        rule.onNode(bar).performMouseInput { exit() }
        rule.waitForIdle()

        tabToTheBar()
        assertRing(shot(), ringIn(shot()), "with the focus")

        tab()
        assertFalse("the focus has moved on to the cards", barFocused())
        assertNoRing(shot(), "once the focus has moved on")
    }

    @Test
    fun `a touch anywhere takes the ring away with the focus, and a finger on the bar draws none`() {
        launch()
        tabToTheBar()
        assertRing(shot(), ringIn(shot()), "with the focus")

        // Not on the bar, whose press would send the focus to the card it
        // brings: touch mode itself takes it.
        touchElsewhere()
        assertFalse("in touch mode the bar has no focus", barFocused())
        assertNoRing(shot(), "after a touch elsewhere")

        val rest = shot()
        val held = holdTheBar()
        assertTrue("the finger is down on the bar: its verb lights, ${verb(rest)} to ${verb(held)}", verb(held) > verb(rest) + 0.1f)
        assertNoRing(held, "under a finger held on the bar")
        assertEquals("the touch pressed the bar", "s1", store.brought.value)
        assertNoRing(shot(), "after the touch")
    }

    /**
     * Rounded corners reported in the platform's place, since Robolectric
     * reports none: the window's own bottom corners, curves of [window] px
     * where its own edges meet, as a split screen's window has them above
     * the divider; or, with an [inset], the window's corners at the edge of
     * an inset that many px tall under it, where Android reports them for a
     * navigation bar with three buttons; and the display's own corners,
     * curves of [display] px. Each for the window's size. The window stands
     * at the display's top left here, so its pixels and the display's are
     * the same, and a corner counted from the other's origin would pass: a
     * split screen on a device, its window lower on the display or right of
     * the divider, shows which is which.
     */
    private fun reporting(window: Float? = null, inset: Float = 0f, display: Float? = null, asked: () -> Unit = {}) {
        RingCornerSource.read = { view ->
            asked()
            val w = view.rootView.width.toFloat()
            val h = view.rootView.height.toFloat()
            ReportedCorners(
                displayLeft = display?.let { CornerCurve(it, h - it, it) },
                displayRight = display?.let { CornerCurve(w - it, h - it, it) },
                windowLeft = window?.let { CornerCurve(it, h - inset - it, it) },
                windowRight = window?.let { CornerCurve(w - it, h - inset - it, it) },
                windowWidth = w,
                windowHeight = h,
            )
        }
    }

    @Test
    fun `clear of the window's own rounded corners, asked of the platform once the bar is placed, not on every draw`() {
        var asked = 0
        reporting(window = 24f) { asked++ }
        launch()
        tabToTheBar()

        // Each side moves in until the ring's corner, at its foot 2dp above
        // the bar's bottom, is 2dp inside a 24 px curve: across from the
        // curve's centre, 24 px in from the bar's sides.
        val own = shot()
        assertRing(own, Ring(24, twoDp, own.width - 24, own.height - twoDp), "clear of the window's own corners")
        val once = asked
        assertTrue("the platform was asked", once > 0)
        repeat(3) { shot() }
        assertEquals("the platform asked again for draws with the bar where it was", once, asked)

        // Three buttons under the bar: the window's corners reported at their
        // edge, where nothing cuts the ring, which keeps 2dp inside them.
        reporting(window = 24f, inset = 144f) { asked++ }
        insets(bottom = 144)
        val buttons = shot()
        assertTrue("the platform asked again once the bar was placed anew", asked > once)
        assertRing(buttons, ringIn(buttons, bottom = 144), "over three buttons, the window's corners at their edge")
    }

    @Test
    fun `clear of the display's own rounded corners, as the bar stands on the display`() {
        reporting(display = 30f)
        launch()
        tabToTheBar()

        val shot = shot()
        assertRing(shot, Ring(30, twoDp, shot.width - 30, shot.height - twoDp), "clear of the display's corners")
    }

    @Test
    fun `in a beat the ring holds at the bar's place while the bar's face rises under it`() {
        launch()
        tabToTheBar()
        val place = place()
        val rest = shot(place)
        val ring = ringIn(rest)
        assertRing(rest, ring, "before the beat")
        val edge = hex(rest[rest.width / 2, 0])

        board = board.map { if (it.id == "w1") it.copy(status = AgentStatus.BLOCKED) else it }
        store.showForTest(board, live = true)
        rule.waitForIdle()
        rule.mainClock.autoAdvance = false
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
        val frames = List(20) {
            rule.mainClock.advanceTimeByFrame()
            shot(place)
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()

        // Where the face's top edge is drawn in each frame, down the bar a
        // third of the way across from its place: it leaves the place and
        // comes back up.
        val faceTops = frames.map { f -> (0 until f.height).firstOrNull { y -> hex(f[f.width / 3, y]) == edge } ?: f.height }
        assertTrue("the face rose from below its place: $faceTops", faceTops.any { it > rest.height / 3 } && faceTops.last() == 0)
        assertEquals("the bar's place never moved", place, place())
        frames.forEachIndexed { i, frame -> assertRing(frame, ring, "frame $i, the face ${faceTops[i]} px below its place") }
        assertTrue("the bar still has the focus", barFocused())
    }
}
