package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
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
 * H1: each agent's usage block carries the agent's session count, every card
 * of it on the board, done included, and TalkBack hears it first, "Claude, 7
 * sessions", whether or not there is room to draw it. The shared board's
 * agents: seven Claude sessions, one of them done, and four Codex ones.
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

    /** What TalkBack hears for [name]'s usage block, in order. */
    private fun block(name: String): List<String> = rule
        .onNode(SemanticsMatcher("$name's usage block") { it.config.getOrNull(SemanticsActions.OnClick)?.label == "Show $name usage detail" })
        .fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.ContentDescription).orEmpty()

    @Test
    fun `each usage block leads with its agent's session count, done included`() {
        val board = (1..6).map { session("c$it", "claude") } + session("c7", "claude", AgentStatus.DONE) +
            (1..4).map { session("x$it", "codex") }
        val scenario = ActivityScenario.launch<MainActivity>(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.use {
            it.onActivity { activity -> ViewModelProvider(activity)[SessionStore::class.java].showForTest(board, usage) }
            rule.waitForIdle()

            assertEquals("Claude, 7 sessions", block("Claude").first())
            assertEquals("Codex, 4 sessions", block("Codex").first())
            assertEquals("Claude Current session: 40% used", block("Claude")[1])
        }
    }
}
