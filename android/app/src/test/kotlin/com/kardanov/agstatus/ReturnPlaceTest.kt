package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Where the list stands when the board is drawn afresh while the usage blocks
 * lead it, as on a phone held sideways: back from a card's history, and with
 * the activity made again, as a change of text size makes it. The list saves
 * its place by item, counting the blocks as its first; drawn without them
 * for its first frame, it started one item on, and the card the reader had
 * opened went half under the label above it. The real app, in touch mode,
 * as a phone in the hand is: in a keyboard's, the first card in view takes
 * the focus as the board is drawn afresh, and moves into the room under its
 * label, as focus brings it.
 *
 * A change of text size can move the blocks as well: on a phone 360dp wide,
 * upright and 500dp to 620dp tall, they are pinned at 100% text and lead the
 * list at 200%. Made again at the new size, the list starts at the card it
 * was at, wherever the blocks then go.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w915dp-h360dp-land-xxhdpi")
class ReturnPlaceTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun close() {
        scenario.close()
        InstrumentationRegistry.getInstrumentation().setInTouchMode(false)
        RuntimeEnvironment.setFontScale(1f)
    }

    private val usage = listOf(
        UsageInfo(
            source = "claude",
            windows = listOf(
                UsageWindow(id = "five_hour", label = "Current session", usedPct = 64.0),
                UsageWindow(id = "seven_day", label = "Weekly", usedPct = 22.0),
            ),
        ),
    )

    private fun card(i: Int, home: String) = Session(
        id = "c$i",
        name = "Card $i",
        status = AgentStatus.CODING,
        message = "Working on $i",
        project = home,
        homeProject = home,
        createdAt = 1,
        updatedAt = 1,
    )

    private val board = (1..4).map { card(it, "alpha") } + (5..8).map { card(it, "beta") } + (9..12).map { card(it, "gamma") }

    /** Claude's three windows beside Codex's two, which a Codex card on the board brings. */
    private val bothAgents = listOf(
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

    private val withCodex = listOf(card(0, "alpha").copy(id = "x0", name = "Codex card", source = "codex")) + board

    private fun launch(sessions: List<Session> = board, limits: List<UsageInfo> = usage) {
        InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(sessions, limits) }
        rule.waitForIdle()
    }

    /** The labels and cards in view, top to bottom, each with its top edge in dp below the list's. */
    private fun inView(): List<String> {
        val list = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode()
        val top = list.positionInRoot.y
        val bottom = top + list.size.height
        return rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription))
            .fetchSemanticsNodes()
            .mapNotNull { node ->
                val said = node.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() ?: return@mapNotNull null
                val y = node.positionInRoot.y
                if (y + node.size.height <= top || y >= bottom) return@mapNotNull null
                if (!said.startsWith("Claude, Card") && !said.endsWith(" sessions")) return@mapNotNull null
                y to "${said.take(14)} @${with(rule.density) { (y - top).toDp().value.toInt() }}"
            }
            .sortedBy { it.first }
            .map { it.second }
    }

    /** The first card in view, top to bottom, by its name: "Card 6". */
    private fun firstCardInView(): String {
        val list = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode()
        val top = list.positionInRoot.y
        val bottom = top + list.size.height
        return rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription))
            .fetchSemanticsNodes()
            .filter { it.positionInRoot.y + it.size.height > top && it.positionInRoot.y < bottom }
            .sortedBy { it.positionInRoot.y }
            .firstNotNullOf { node ->
                val said = node.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull().orEmpty()
                Regex("^Claude, (Card \\d+)").find(said)?.groupValues?.get(1)
            }
    }

    /** Whether the usage blocks stand pinned over the list: Claude's head is above the list's top edge. */
    private fun blocksPinned(): Boolean {
        val listTop = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().positionInRoot.y
        return rule.onAllNodes(
            SemanticsMatcher("Claude's usage head") {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()?.startsWith("Claude, 12 sessions") == true
            },
        ).fetchSemanticsNodes().any { it.positionInRoot.y < listTop }
    }

    /** Scrolled down the list, the blocks out of view, the card it names sitting under beta's stuck label. */
    private fun scrolledDown(): List<String> {
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(7)
        rule.waitForIdle()
        return inView().also { assertTrue("Card 5 at the top: $it", it.first().startsWith("Claude, Card 5")) }
    }

    @Test
    fun `back from a card's history, the list stands where it stood`() {
        launch()
        val before = scrolledDown()

        rule.onNode(
            SemanticsMatcher("Card 6") {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()?.startsWith("Claude, Card 6") == true
            },
        ).performClick()
        rule.waitForIdle()
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()

        assertEquals(before, inView())
    }

    @Test
    fun `drawn afresh with the activity made again, the list stands where it stood`() {
        launch()
        val before = scrolledDown()

        scenario.recreate()
        rule.waitForIdle()

        assertEquals(before, inView())
    }

    @Test
    @Config(qualifiers = "w360dp-h500dp-port-xxhdpi")
    fun `made again at a larger text size, where the blocks move into the list, the list starts at the card it was at`() {
        launch(withCodex, bothAgents)
        assertTrue("pinned at 100%", blocksPinned())
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(8)
        rule.waitForIdle()
        assertEquals("Card 6", firstCardInView())

        RuntimeEnvironment.setFontScale(2f)
        scenario.recreate()
        rule.waitForIdle()

        assertFalse("in the list at 200%", blocksPinned())
        assertEquals("Card 6", firstCardInView())
    }

    @Test
    @Config(qualifiers = "w360dp-h620dp-port-xxhdpi")
    fun `made again at a smaller text size, where the blocks would leave the list, the list starts at the card it was at`() {
        RuntimeEnvironment.setFontScale(2f)
        launch(withCodex, bothAgents)
        assertFalse("in the list at 200%", blocksPinned())
        rule.onNode(hasScrollToIndexAction()).performScrollToIndex(9)
        rule.waitForIdle()
        assertEquals("Card 6", firstCardInView())

        RuntimeEnvironment.setFontScale(1f)
        scenario.recreate()
        rule.waitForIdle()

        assertEquals("Card 6", firstCardInView())
    }
}
