package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.math.abs

/**
 * Shift+Tab from the needs-you bar reaches the last usage block, whole in
 * view: Tab's order is the blocks, the bar, then the cards, both ways.
 *
 * Where the blocks lead the list they are its first item, which the list
 * composes only near its top. Tabbed on from the bar into the cards, the list
 * scrolls past them, and Shift+Tab back past the bar found none of them: the
 * focus went to the top bar's Settings, past every block, or, on a device, to
 * the last block laid out beyond the list's bounds and never brought into
 * view, where Enter opened a usage screen the reader could not see. With one
 * row of blocks the list sometimes still held them; edge.mjs's board, whose
 * agents without plan limits have blocks of their own (H2), has two.
 *
 * edge.mjs's board: Claude 9 sessions, one of them blocked, Codex 5, Gemini 2
 * and Claude-work 1, so the blocks are Claude, Claude-work, Codex and Gemini,
 * with limits for Claude and Codex. The real app, a keyboard's focus.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w914dp-h411dp-land-xxhdpi")
class ShiftTabFromBarTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun close() {
        scenario.close()
        RuntimeEnvironment.setFontScale(1f)
    }

    private fun card(id: String, home: String, source: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = "Card $id",
        status = status,
        message = "Working on $id",
        project = home,
        homeProject = home,
        source = source,
        createdAt = 1,
        updatedAt = 1,
    )

    private val board = (1..9).map { card("c$it", "acme-api", "claude", if (it == 1) AgentStatus.BLOCKED else AgentStatus.CODING) } +
        (1..5).map { card("x$it", "beta", "codex") } +
        (1..2).map { card("g$it", "zeta", "gemini") } +
        card("w1", "zeta", "claude-work")

    private fun limits(source: String) = UsageInfo(
        source = source,
        windows = listOf(
            UsageWindow(id = "five_hour", label = "Current session", usedPct = 42.0),
            UsageWindow(id = "seven_day", label = "Weekly", usedPct = 18.0),
        ),
    )

    /** Limits for Claude and Codex only, as board.mjs's `usage` posts them. */
    private val claudeAndCodex = listOf(limits("claude"), limits("codex"))

    private fun launch(usage: List<UsageInfo> = claudeAndCodex) {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(board, usage) }
        rule.waitForIdle()
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    private fun said(text: String) = SemanticsMatcher("says \"$text\"") {
        it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() == text
    }

    private fun focusedNodes(): List<SemanticsNode> = rule
        .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
        .fetchSemanticsNodes()

    /** What has the keyboard's focus says first. */
    private fun focused(): List<String> = focusedNodes()
        .map { node -> node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().firstOrNull().orEmpty() }

    private fun tab(back: Boolean = false) {
        rule.onRoot().performKeyInput {
            if (back) withKeyDown(Key.ShiftLeft) { pressKey(Key.Tab) } else pressKey(Key.Tab)
        }
        rule.waitForIdle()
    }

    private fun list(): Rect = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().boundsInRoot

    /** Whether any part of a block that says [text] shows in the list. */
    private fun inTheList(text: String): Boolean {
        val list = list()
        return rule.onAllNodes(said(text)).fetchSemanticsNodes()
            .any { it.boundsInRoot.bottom > list.top && it.boundsInRoot.top < list.bottom }
    }

    /** The focus on the block that says [text], which shows whole in the list. */
    private fun assertFocusedWholeInTheList(text: String) {
        assertEquals(listOf(text), focused())
        val block = focusedNodes().single().boundsInRoot
        val list = list()
        assertTrue("$text whole in the list's view: $block in $list", block.top >= list.top - 1f && block.bottom <= list.bottom + 1f)
    }

    /** How far below the list's top Claude's block, the first, stands, in dp. */
    private fun blocksBelowListTop(): Float {
        val block = rule.onNode(said("Claude, 9 sessions")).fetchSemanticsNode().boundsInRoot.top
        return with(rule.density) { (block - list().top).toDp().value }
    }

    /**
     * From the bar, Tab on to the third card, which scrolls the blocks out of
     * the list's view, then Shift+Tab back to the bar.
     */
    private fun backOnTheBarFromTheCards() {
        repeat(3) { tab() }
        assertTrue("on a card: ${focused()}", focused().single().startsWith("Claude, Card c"))
        assertTrue("the blocks out of view", !inTheList("Claude, 9 sessions") && !inTheList("Gemini, 2 sessions"))
        repeat(3) { tab(back = true) }
        rule.onNode(bar).assertIsFocused()
    }

    /** The blocks are the list's first item, Claude's at its top, rather than pinned over it. */
    private fun assertTheBlocksLeadTheList() {
        assertTrue("the blocks lead the list", inTheList("Claude, 9 sessions"))
        assertEquals(10f, blocksBelowListTop(), 0.5f)
    }

    private fun onTheBar() {
        // A first Tab puts the app in keyboard mode, where the controls take focus.
        tab()
        rule.onNode(bar).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.waitForIdle()
        rule.onNode(bar).assertIsFocused()
    }

    @Test
    fun `sideways, with the blocks in two rows, Shift+Tab from the bar reaches the last block in view`() {
        launch()
        assertTheBlocksLeadTheList()
        onTheBar()

        // From the list's top, where the blocks show.
        tab(back = true)
        assertFocusedWholeInTheList("Gemini, 2 sessions")
        tab()
        rule.onNode(bar).assertIsFocused()

        // From the cards, with the blocks scrolled away: the list goes back
        // to its top, as a fresh board has it, and Tab goes on to the bar.
        backOnTheBarFromTheCards()
        tab(back = true)
        assertFocusedWholeInTheList("Gemini, 2 sessions")
        assertEquals(10f, blocksBelowListTop(), 0.5f)
        tab()
        rule.onNode(bar).assertIsFocused()
    }

    @Test
    fun `sideways, with every agent reporting limits, Shift+Tab from the bar reaches the last block in view`() {
        launch(listOf("claude", "claude-work", "codex", "gemini").map { limits(it) })
        assertTheBlocksLeadTheList()
        onTheBar()
        backOnTheBarFromTheCards()

        tab(back = true)

        assertFocusedWholeInTheList("Gemini, 2 sessions")
        assertEquals(10f, blocksBelowListTop(), 0.5f)
    }

    @Test
    @Config(qualifiers = "w411dp-h731dp-xxhdpi")
    fun `upright at twice the text size, the blocks leading the list, Shift+Tab from the bar reaches the last block in view`() {
        // A phone a little shorter than the emulator's, which has system
        // bars where Robolectric has none: at 200% the four blocks, one to a
        // row, leave the list too little room under them and lead it.
        RuntimeEnvironment.setFontScale(2f)
        launch()
        assertTheBlocksLeadTheList()
        onTheBar()
        backOnTheBarFromTheCards()

        tab(back = true)

        assertFocusedWholeInTheList("Gemini, 2 sessions")
    }

    @Test
    @Config(qualifiers = "w914dp-h300dp-land-xxhdpi")
    fun `sideways at twice the text size, Shift+Tab from the bar to a last block already in view moves no list`() {
        // At 200% the blocks lead the list and stand taller than it: a Tab
        // onto Gemini's, the last, scrolls the list until it shows, and Tab on
        // to the bar leaves the list there. A phone held sideways, less the
        // status and navigation bars a device draws and Robolectric does not:
        // 411dp tall here, Gemini's block fits at the list's top.
        RuntimeEnvironment.setFontScale(2f)
        launch()
        assertTheBlocksLeadTheList()
        tab()
        rule.onNode(hasContentDescription("Settings")).performSemanticsAction(SemanticsActions.RequestFocus)
        repeat(4) { tab() }
        assertFocusedWholeInTheList("Gemini, 2 sessions")
        val standing = blocksBelowListTop()
        assertTrue("the Tab onto Gemini's block scrolled the list: Claude's $standing dp below its top", standing < 9f)
        tab()
        rule.onNode(bar).assertIsFocused()
        assertEquals(standing, blocksBelowListTop(), 0.5f)

        // Back, frame by frame: the list holds still, and Claude's block never
        // stands at its top. Sent there first, the list jumped up a frame,
        // then glided back to where it stood.
        rule.mainClock.autoAdvance = false
        rule.onRoot().performKeyInput { withKeyDown(Key.ShiftLeft) { pressKey(Key.Tab) } }
        val frames = List(30) {
            rule.mainClock.advanceTimeByFrame()
            blocksBelowListTop()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()

        assertTrue("the list held still, Claude's block at $standing dp: $frames", frames.all { abs(it - standing) < 0.5f })
        assertFocusedWholeInTheList("Gemini, 2 sessions")
        assertEquals(standing, blocksBelowListTop(), 0.5f)
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp-xxhdpi")
    fun `upright, the blocks pinned over the list, Shift+Tab from the bar reaches the last block`() {
        launch()
        onTheBar()
        // Pinned, the blocks stand over the list, not in it.
        val blocks = rule.onNode(said("Gemini, 2 sessions")).fetchSemanticsNode().boundsInRoot
        assertTrue("pinned over the list: $blocks above ${list()}", blocks.bottom <= list().top + 1f)

        tab(back = true)

        assertEquals(listOf("Gemini, 2 sessions"), focused())
        rule.onNode(said("Gemini, 2 sessions")).assertIsDisplayed()
    }
}
