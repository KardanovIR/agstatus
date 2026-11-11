package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.unit.dp
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
 * The usage blocks lead the list where pinning them would crowd it, as on a
 * phone held sideways. They join it as its first item a frame after the
 * board is drawn, and on a short board they must start whole at its top, not
 * mostly scrolled off it. The real app on a phone held sideways, turned to
 * a board of one card (as turning the phone draws the board afresh).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w915dp-h360dp-land-xxhdpi")
class UsageJoinTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private val usage = listOf(
        UsageInfo(
            source = "claude",
            windows = listOf(
                UsageWindow(id = "five_hour", label = "Current session", usedPct = 64.0),
                UsageWindow(id = "seven_day", label = "Weekly", usedPct = 22.0),
            ),
        ),
    )

    private fun card(id: String, name: String, host: Boolean = false) = Session(
        id = id,
        name = name,
        status = AgentStatus.CODING,
        message = "Editing src/limits.ts",
        project = "acme-api",
        homeProject = "acme-api",
        createdAt = 1,
        updatedAt = 1,
        host = if (host) {
            SessionHost(
                machine = HostMachine(id = "3f9a1c7e5b2d4086a9c1e3f5b7d90246", name = "MacBook"),
                app = HostApp(slug = "agterm", name = "agterm", kind = "terminal"),
            )
        } else {
            null
        },
    )

    /** The board as [sessions], drawn afresh, as a phone turned sideways draws it. */
    private fun turnedTo(sessions: List<Session>): ActivityScenario<MainActivity> {
        val scenario = ActivityScenario.launch<MainActivity>(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(sessions, usage) }
        rule.waitForIdle()
        scenario.recreate()
        rule.waitForIdle()
        return scenario
    }

    /** The usage block's top edge, below the list's own, in dp. */
    private fun blockBelowListTop(): Float {
        val list = rule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.CollectionInfo))
            .fetchSemanticsNode().positionInRoot.y
        val block = rule.onNode(
            SemanticsMatcher("the Claude usage block") {
                it.config.getOrNull(SemanticsActions.OnClick)?.label == "Show Claude usage detail"
            },
        ).fetchSemanticsNode().positionInRoot.y
        return with(rule.density) { (block - list).toDp().value }
    }

    @Test
    fun `blocks that join one card sideways start whole at the top`() {
        turnedTo(listOf(card("c1", "Fix the login redirect", host = true))).use {
            // 10dp, the blocks' own top padding: nothing of them above the list.
            assertEquals(10f, blockBelowListTop(), 0.5f)
        }
    }

    @Test
    fun `blocks that join two cards sideways start whole at the top`() {
        turnedTo(listOf(card("c1", "Fix the login redirect"), card("c2", "Add rate limiting"))).use {
            assertEquals(10f, blockBelowListTop(), 0.5f)
        }
    }

    @Test
    fun `blocks that join a long board start whole at the top too`() {
        turnedTo((1..8).map { card("c$it", "Session $it") }).use {
            assertEquals(10f, blockBelowListTop(), 0.5f)
        }
    }
}
