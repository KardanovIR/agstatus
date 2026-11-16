package com.kardanov.agstatus

import android.content.Intent
import android.provider.Settings
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Focus brought into view never asks the list to go back past its top. What
 * it cannot take goes on up as if a finger had pulled, and the
 * pull-to-refresh took it as a pull no finger ever let go: its spinner stayed
 * in view, and TalkBack was handed a stray progress bar, until a finger
 * dragged the list.
 *
 * With animations off, which a device's "Remove animations" gives Compose as a
 * motion scale of 0, the whole distance is asked for in one frame. The real
 * app, a keyboard's focus.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w915dp-h360dp-land-xxhdpi")
class FocusPullTest {

    @get:Rule
    val rule = createEmptyComposeRule(
        effectContext = object : MotionDurationScale {
            override val scaleFactor: Float get() = 0f
        },
    )

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun close() {
        scenario.close()
        Settings.Global.putFloat(
            ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
    }

    private val usage = listOf(
        UsageInfo(
            source = "claude",
            windows = listOf(
                UsageWindow(id = "five_hour", label = "Current session", usedPct = 64.0),
                UsageWindow(id = "seven_day", label = "Weekly", usedPct = 22.0),
                UsageWindow(id = "seven_day_opus", label = "Weekly (Opus)", usedPct = 41.0),
            ),
        ),
        UsageInfo(
            source = "codex",
            windows = listOf(
                UsageWindow(id = "five_hour", label = "5-hour", usedPct = 12.0),
                UsageWindow(id = "week", label = "Weekly", usedPct = 40.0),
            ),
        ),
    )

    private fun card(i: Int, home: String, source: String = "claude", status: AgentStatus = AgentStatus.CODING) = Session(
        id = "c$i",
        name = "Card $i",
        status = status,
        message = "Working on $i",
        project = home,
        homeProject = home,
        source = source,
        createdAt = 1,
        updatedAt = 1,
    )

    /** Eight Claude cards in "aaa", two Codex ones in "bbb"; nothing blocked, so no bar. */
    private val board = (1..8).map { card(it, "aaa") } + (9..10).map { card(it, "bbb", "codex") }

    private fun launch(sessions: List<Session> = board) {
        Settings.Global.putFloat(
            ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            0f,
        )
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(sessions, usage) }
        rule.waitForIdle()
    }

    /** Every node with a progress bar's semantics: the pull-to-refresh's spinner, pulled. */
    private fun pulled(): List<String> = rule
        .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo), useUnmergedTree = true)
        .fetchSemanticsNodes()
        .map { "${it.config.getOrNull(SemanticsProperties.ProgressBarRangeInfo)}" }

    /** What has the keyboard's focus says first. */
    private fun focused(): List<String> = rule
        .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
        .fetchSemanticsNodes()
        .map { node -> node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().firstOrNull().orEmpty() }

    private fun said(text: String) = SemanticsMatcher("says \"$text\"") {
        it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() == text
    }

    /** How far below the list's top what says [text] stands, in dp. */
    private fun belowListTop(text: String): Float {
        val list = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().boundsInRoot.top
        val node = rule.onNode(said(text)).fetchSemanticsNode().boundsInRoot.top
        return with(rule.density) { (node - list).toDp().value }
    }

    /** How far below the list's top the usage blocks stand, in dp. */
    private fun blocksBelowListTop(): Float = belowListTop("Claude, 8 sessions")

    /**
     * A phone held sideways, where the usage blocks lead the list, Claude's
     * and Codex's side by side; the list scrolled until the first label
     * sticks, with the first card under it, and the keyboard's focus on that
     * card.
     */
    private fun onTheFirstCardPastTheBlocks() {
        launch()
        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.waitForIdle()
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(1)
        rule.waitForIdle()
        rule.onNode(said("Claude, Card 1")).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        assertEquals(listOf("Claude, Card 1"), focused())
        assertEquals(emptyList<String>(), pulled())
        // Just under the stuck label, the blocks above it out of view.
        val under = belowListTop("Claude, Card 1")
        assertTrue("the first card under its label: $under", under in 30f..50f)
    }

    @Test
    fun `Shift+Tab back into the blocks puts the list at its top and pulls nothing`() {
        onTheFirstCardPastTheBlocks()

        rule.onRoot().performKeyInput { withKeyDown(Key.ShiftLeft) { pressKey(Key.Tab) } }
        rule.waitForIdle()

        assertEquals(listOf("Codex, 2 sessions"), focused())
        assertEquals(emptyList<String>(), pulled())
        assertEquals(10f, blocksBelowListTop(), 0.5f)
        rule.mainClock.advanceTimeBy(3_000)
        rule.waitForIdle()
        assertEquals(emptyList<String>(), pulled())
    }

    @Test
    fun `the Up arrow back into the blocks puts the list at its top and pulls nothing`() {
        onTheFirstCardPastTheBlocks()

        rule.onRoot().performKeyInput { pressKey(Key.DirectionUp) }
        rule.waitForIdle()

        // The block straight above the card's start: Claude's, beside Codex's.
        assertEquals(listOf("Claude, 8 sessions"), focused())
        assertEquals(emptyList<String>(), pulled())
        assertEquals(10f, blocksBelowListTop(), 0.5f)
        rule.mainClock.advanceTimeBy(3_000)
        rule.waitForIdle()
        assertEquals(emptyList<String>(), pulled())
    }

    @Test
    fun `focus moving on from the blocks to the first card pulls nothing`() {
        // Back into the blocks, then on again: Tab from the last block to the
        // first card, which the room under the label takes again.
        onTheFirstCardPastTheBlocks()
        rule.onRoot().performKeyInput { withKeyDown(Key.ShiftLeft) { pressKey(Key.Tab) } }
        rule.waitForIdle()

        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.waitForIdle()

        assertEquals(listOf("Claude, Card 1"), focused())
        assertEquals(emptyList<String>(), pulled())
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp-xxhdpi")
    fun `focus on the first card with the list at its top pulls nothing (fc1a4cd)`() {
        // Upright, the blocks pinned over the list, the list at its top: Tab
        // from the last block to the first card, which sits under its label.
        launch()
        rule.onNode(said("Codex, 2 sessions")).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()

        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.waitForIdle()

        assertEquals(listOf("Claude, Card 1"), focused())
        assertEquals(emptyList<String>(), pulled())
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp-xxhdpi")
    fun `the bar bringing the first card with the list at its top pulls nothing (fc1a4cd)`() {
        launch(listOf(card(1, "aaa", status = AgentStatus.BLOCKED)) + board.drop(1))
        val bar = SemanticsMatcher("the needs-you bar") {
            it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
        }

        rule.onNode(bar).performSemanticsAction(SemanticsActions.OnClick)
        rule.waitForIdle()

        assertEquals(listOf("Claude, Card 1"), focused())
        assertEquals(emptyList<String>(), pulled())
    }
}
