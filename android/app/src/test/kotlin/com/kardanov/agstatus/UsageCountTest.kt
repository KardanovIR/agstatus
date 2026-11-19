package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Each agent's usage block, its head on the board, in the real app on a
 * phone-sized screen.
 *
 * H1: a block carries the agent's session count, every card of it on the
 * board, done included, and TalkBack hears it first, "Claude, 7 sessions",
 * whether or not there is room to draw it.
 *
 * H2: on a board with sessions every agent with sessions has a block, whether
 * or not it reports plan limits, in iOS's order of heads; one that reports
 * none says "No plan limits reported" where its meters would be. On an empty
 * board every agent that reports limits has one, as before.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class UsageCountTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private fun session(id: String, source: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = id,
        status = status,
        project = "acme-api",
        homeProject = "acme-api",
        source = source,
        createdAt = 1,
        updatedAt = 1,
    )

    private val usage = listOf("claude", "codex").map { source ->
        UsageInfo(source = source, windows = listOf(UsageWindow(id = "five_hour", label = "Current session", usedPct = 40.0)))
    }

    private fun show(board: List<Session>, usage: List<UsageInfo>, check: () -> Unit) {
        val scenario = ActivityScenario.launch<MainActivity>(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.use {
            it.onActivity { activity -> ViewModelProvider(activity)[SessionStore::class.java].showForTest(board, usage) }
            rule.waitForIdle()
            check()
        }
    }

    /** What TalkBack hears for [name]'s usage block, in order. */
    private fun block(name: String): List<String> = rule
        .onNode(SemanticsMatcher("$name's usage block") { it.config.getOrNull(SemanticsActions.OnClick)?.label == "Show $name usage detail" })
        .fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()

    /** One usage block as a reader meets it: what it is named, and the words it shows as text. */
    private data class Block(val said: String, val text: List<String>)

    /** Every usage block on the board, in reading order: by row, then left to right. */
    private fun blocks(): List<Block> = rule
        .onAllNodes(
            SemanticsMatcher("a usage block") {
                it.config.getOrNull(SemanticsActions.OnClick)?.label?.let { label ->
                    label.startsWith("Show ") && label.endsWith(" usage detail")
                } == true
            },
        )
        .fetchSemanticsNodes()
        .sortedWith(compareBy<SemanticsNode>({ it.boundsInRoot.top }, { it.boundsInRoot.left }))
        .map { node ->
            Block(
                said = node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().first(),
                text = node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text },
            )
        }

    @Test
    fun `each usage block leads with its agent's session count, done included`() {
        val board = (1..6).map { session("c$it", "claude") } + session("c7", "claude", AgentStatus.DONE) +
            (1..4).map { session("x$it", "codex") }
        show(board, usage) {
            assertEquals("Claude, 7 sessions", block("Claude").first())
            assertEquals("Codex, 4 sessions", block("Codex").first())
            assertEquals("Claude Current session: 40% used", block("Claude")[1])
        }
    }

    @Test
    fun `every agent with sessions has a block, in iOS's order, saying where it reports no limits`() {
        // edge.mjs's board on top of board.mjs's, with limits posted for
        // claude and codex only: Claude 9, Codex 5, Gemini 2, Claude-work 1.
        val board = (1..9).map { session("c$it", "claude") } + (1..5).map { session("x$it", "codex") } +
            (1..2).map { session("g$it", "gemini", if (it == 1) AgentStatus.BLOCKED else AgentStatus.CODING) } +
            session("w1", "claude-work", AgentStatus.IDLE)
        show(board, usage) {
            assertEquals(
                listOf(
                    Block("Claude, 9 sessions", emptyList()),
                    Block("Claude-work, 1 session", listOf(NO_PLAN_LIMITS)),
                    Block("Codex, 5 sessions", emptyList()),
                    Block("Gemini, 2 sessions", listOf(NO_PLAN_LIMITS)),
                ),
                blocks(),
            )
            // The same button as any block, heard as any block is: its name and count.
            assertEquals(listOf("Gemini, 2 sessions"), block("Gemini"))
        }
    }

    @Test
    fun `a board with no limits at all has a block for each agent with sessions`() {
        // The shell hook, or the Node hook with AGSTATUS_USAGE=off: no reports.
        val board = (1..2).map { session("c$it", "claude") } + session("g1", "gemini")
        show(board, emptyList()) {
            assertEquals(
                listOf(
                    Block("Claude, 2 sessions", listOf(NO_PLAN_LIMITS)),
                    Block("Gemini, 1 session", listOf(NO_PLAN_LIMITS)),
                ),
                blocks(),
            )
        }
    }

    @Test
    fun `the idle board keeps a block for every agent that reports limits, named alone, with its meters`() {
        show(emptyList(), usage) {
            assertEquals(
                listOf(Block("Claude", emptyList()), Block("Codex", emptyList())),
                blocks(),
            )
            assertEquals(listOf("Codex", "Codex Current session: 40% used"), block("Codex"))
            rule.onNode(hasText("No agents yet")).assertExists()
        }
    }

    @Test
    fun `on the idle board a report with no windows is no report, as on iOS`() {
        // The server takes one window at least; tolerant decoding still lets
        // an empty list through. It drew a block with a name and nothing else.
        show(emptyList(), usage + UsageInfo(source = "gemini")) {
            assertEquals(
                listOf(Block("Claude", emptyList()), Block("Codex", emptyList())),
                blocks(),
            )
        }
    }
}
