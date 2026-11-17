package com.kardanov.agstatus

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs

/**
 * The needs-you bar's ground (the owner's decision of 2026-11-16, O6): a
 * blocked card's own surface under a blocked card's edge, as on iOS and the
 * web, where it was a card's neutral ground under the neutral hairline. A
 * press leaves the ground as it is and lights the verb: Material's press
 * lightens the ground, and took the 12sp red word to 3.66:1. The bar's own
 * pixels, as the real app draws them on a phone, where it has two lines: the
 * alarm and the verb over the session.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class BarGroundTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun close() {
        scenario.close()
    }

    private val board = listOf(
        Session(
            id = "s1",
            name = "Fix the login redirect",
            status = AgentStatus.BLOCKED,
            message = "Approve: Edit src/auth.ts",
            project = "acme-api",
            homeProject = "acme-api",
            createdAt = 1,
            updatedAt = 1,
        ),
    )

    private fun launch() {
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(board) }
        rule.waitForIdle()
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    /**
     * The bar as the window draws it. Drawn into a bitmap: the test rule's
     * own capture waits for a redraw that Robolectric's paused looper never
     * runs.
     */
    private fun barImage(): ImageBitmap {
        val bounds = rule.onNode(bar).fetchSemanticsNode().boundsInWindow
        lateinit var window: Bitmap
        scenario.onActivity { activity ->
            val view = activity.window.decorView
            window = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(window))
        }
        val top = bounds.top.toInt()
        return Bitmap.createBitmap(window, bounds.left.toInt(), top, bounds.width.toInt(), bounds.bottom.toInt() - top)
            .asImageBitmap()
    }

    /** The colour most of the bar is: its ground. */
    private fun ImageBitmap.ground(): Color {
        val pixels = toPixelMap()
        val counts = HashMap<Color, Int>()
        for (y in 0 until height) for (x in 0 until width) counts.merge(pixels[x, y], 1, Int::plus)
        return counts.maxBy { it.value }.key
    }

    /** The bar's top edge: its first row, halfway across. */
    private fun ImageBitmap.edge(): Color = toPixelMap()[width / 2, 1]

    /** The brightest ink in the top line's last fifth, where the verb stands alone. */
    private fun ImageBitmap.verb(): Float {
        val pixels = toPixelMap()
        var brightest = 0f
        for (y in 4 until height / 2) for (x in width * 4 / 5 until width) {
            val c = pixels[x, y]
            brightest = maxOf(brightest, (c.red + c.green + c.blue) / 3)
        }
        return brightest
    }

    private fun assertColor(expected: Color, actual: Color, what: String) {
        val close = abs(expected.red - actual.red) <= 2 / 255f &&
            abs(expected.green - actual.green) <= 2 / 255f &&
            abs(expected.blue - actual.blue) <= 2 / 255f
        assertTrue("$what: expected ${hex(expected)}, was ${hex(actual)}", close)
    }

    private fun hex(c: Color) = "#%02X%02X%02X".format((c.red * 255).toInt(), (c.green * 255).toInt(), (c.blue * 255).toInt())

    @Test
    fun `the bar stands on a blocked card's surface under a blocked card's edge`() {
        launch()
        val image = barImage()

        assertColor(Theme.cardSurface(DisplayStatus.BLOCKED), image.ground(), "the ground")
        // The edge is the blocked ink at 42% over that surface: #843C33.
        assertColor(Color(0xFF843C33), image.edge(), "the top edge")
    }

    /**
     * Material's press is the platform's ripple, which Robolectric does not
     * draw, so only a ground drawn by Compose would show here; the ripple's
     * is checked on a device. The verb is drawn by Compose.
     */
    @Test
    fun `a press leaves the ground as it is and lights the verb`() {
        launch()
        val rest = barImage()

        rule.onNode(bar).performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(300)
        val pressed = barImage()
        rule.onNode(bar).performTouchInput { cancel() }

        assertEquals("the ground under the finger", hex(rest.ground()), hex(pressed.ground()))
        assertTrue(
            "the verb lights from the secondary ink toward the primary: ${rest.verb()} to ${pressed.verb()}",
            pressed.verb() > rest.verb() + 0.1f,
        )
    }
}
