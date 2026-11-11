package com.kardanov.agstatus

import android.content.Intent
import android.provider.Settings
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * A keyboard's focus when the needs-you bar leaves under it: the last
 * blocked card is approved on the Mac while the reader has Tabbed to the bar
 * and not pressed it. The focus goes on to the card the bar named, else the
 * first card in view, and never to the top app bar, where a stray Enter
 * would end the demo or open Settings. The real app, on a phone-sized
 * screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class BarFocusTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var store: SessionStore

    @After
    fun close() {
        scenario.close()
        Settings.Global.putFloat(
            ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
        RuntimeEnvironment.setFontScale(1f)
    }

    private fun card(id: String, name: String, home: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = name,
        status = status,
        message = "Working",
        project = home,
        homeProject = home,
        createdAt = 1,
        updatedAt = 1,
    )

    private fun launch(board: List<Session>, animationsOff: Boolean = false, usage: List<UsageInfo> = emptyList()) {
        if (animationsOff) {
            Settings.Global.putFloat(
                ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                0f,
            )
        }
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity {
            store = ViewModelProvider(it)[SessionStore::class.java]
            store.showForTest(board, usage = usage)
        }
        rule.waitForIdle()
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    /** A keyboard's Tab, then the focus put on the bar, as Tabbing to it would. */
    private fun focusTheBar() {
        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.onNode(bar).performSemanticsAction(SemanticsActions.RequestFocus)
        rule.onNode(bar).assertIsFocused()
    }

    /** What the focused element says. */
    private fun focused(): List<String> = rule
        .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
        .fetchSemanticsNodes()
        .map { node ->
            (node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty() +
                node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }).joinToString(" ")
        }

    private fun approve(board: List<Session>, id: String) {
        store.showForTest(board.map { if (it.id == id) it.copy(status = AgentStatus.CODING) else it }, live = true)
        rule.waitForIdle()
    }

    private val board = listOf(
        card("s1", "Add rate limiting", "acme-api"),
        card("s2", "Fix the login redirect", "acme-api", AgentStatus.BLOCKED),
        card("s3", "Tune the cache", "zeta"),
    )

    @Test
    fun `the focus goes to the card the bar named`() {
        launch(board)
        focusTheBar()

        approve(board, "s2")

        assertEquals(listOf("Claude, Fix the login redirect"), focused().map { it.substringBefore(" Coding") })
    }

    @Test
    fun `with animations off it goes there too`() {
        launch(board, animationsOff = true)
        focusTheBar()

        approve(board, "s2")

        assertEquals(listOf("Claude, Fix the login redirect"), focused().map { it.substringBefore(" Coding") })
    }

    @Test
    fun `where the card the bar named is out of view, it goes to the first card in view`() {
        // Ten cards in "aaa", then the blocked one alone in "zzz", far below.
        val long = (1..10).map { card("a$it", "Session $it", "aaa") } +
            card("z1", "Fix the login redirect", "zzz", AgentStatus.BLOCKED)
        launch(long)
        focusTheBar()

        approve(long, "z1")

        assertEquals(listOf("Claude, Session 1"), focused().map { it.substringBefore(" Coding") })
    }

    @Test
    @Config(qualifiers = "w915dp-h330dp-land-xxhdpi")
    fun `with no card in view, it goes to the first usage block, still on the board`() {
        // A phone held sideways at 200% text: the usage blocks lead the list
        // and fill it, and the one card is below them, out of view.
        RuntimeEnvironment.setFontScale(2f)
        val usage = listOf(
            UsageInfo(
                source = "claude",
                windows = listOf(
                    UsageWindow(id = "five_hour", label = "Current session", usedPct = 64.0),
                    UsageWindow(id = "seven_day", label = "Weekly", usedPct = 22.0),
                    UsageWindow(id = "seven_day_opus", label = "Weekly (Opus)", usedPct = 41.0),
                ),
            ),
        )
        val alone = listOf(card("c1", "Fix the login redirect", "acme-api", AgentStatus.BLOCKED))
        launch(alone, usage = usage)
        val list = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().boundsInRoot
        val cardsInView = rule.onAllNodes(
            SemanticsMatcher("the card") {
                it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()?.startsWith("Claude, Fix") == true
            },
        ).fetchSemanticsNodes().filter { it.boundsInRoot.bottom > list.top && it.boundsInRoot.top < list.bottom }
        assertTrue("no card in view: $cardsInView", cardsInView.isEmpty())
        focusTheBar()

        approve(alone, "c1")

        assertEquals(listOf("Claude, 1 session"), focused().map { it.substringBefore(" Claude ") })
    }
}
