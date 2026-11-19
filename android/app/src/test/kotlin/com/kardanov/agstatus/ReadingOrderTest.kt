package com.kardanov.agstatus

import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasContentDescription
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
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The order TalkBack and a keyboard's Tab reach the board in: the usage
 * blocks, then the needs-you bar, then the labels and cards, as the web
 * board's page has it. The bar is drawn along the bottom edge, and TalkBack,
 * left to where things are drawn, heard it after every card. Where the usage
 * blocks lead the list they are its first item, inside it, and TalkBack hears
 * the bar just before them, as VoiceOver does on iOS; Tab still reaches it
 * after them.
 *
 * TalkBack's order is read as TalkBack reads it. Compose tells each node which
 * one TalkBack goes to next (AccessibilityNodeInfo's traversalBefore), worked
 * out from where the nodes are drawn and the traversal groups and indexes
 * they carry, and puts the same link in each node's extras under a key kept
 * for tests. The real app, walked link by link from its first node.
 * Robolectric's own graphics leave Compose with no accessibility nodes under
 * the root (the region it measures what is covered with is empty there), so
 * those run on the native ones, under which, in turn, nothing takes a
 * keyboard's focus; Tab's run on Robolectric's own.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class ReadingOrderTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>

    @After
    fun close() {
        scenario.close()
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

    private val board = listOf(
        card("a1", "Add rate limiting", "acme-api"),
        card("a2", "Fix the login redirect", "acme-api", AgentStatus.BLOCKED),
        card("z1", "Tune the cache", "zeta"),
    )

    // Two windows: tall enough that, held sideways, the block leads the list.
    private val usage = listOf(
        UsageInfo(
            source = "claude",
            windows = listOf(
                UsageWindow(id = "five_hour", label = "Current session", usedPct = 40.0),
                UsageWindow(id = "seven_day", label = "Weekly", usedPct = 22.0),
            ),
        ),
    )

    private fun launch() {
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { ViewModelProvider(it)[SessionStore::class.java].showForTest(board, usage) }
        rule.waitForIdle()
    }

    private fun composeRoot(view: View): ViewRootForTest? {
        if (view is ViewRootForTest) return view
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) composeRoot(view.getChildAt(i))?.let { return it }
        }
        return null
    }

    private fun SemanticsMatcher.words(): Map<Int, String> = rule.onAllNodes(this)
        .fetchSemanticsNodes()
        .associate { node ->
            node.id to (
                node.config.getOrNull(SemanticsProperties.ContentDescription).orEmpty() +
                    node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text }
                ).joinToString(" ")
        }

    /** What TalkBack hears, one node at a time, in the order it goes. */
    private fun heard(): List<String> {
        lateinit var root: ViewRootForTest
        scenario.onActivity {
            root = composeRoot(it.window.decorView)!!
            // Compose speaks to the platform only while the platform listens.
            shadowOf(it.getSystemService(AccessibilityManager::class.java)).setEnabled(true)
        }
        root.forceAccessibilityForTesting(true)
        rule.waitForIdle()

        val provider = root.view.accessibilityNodeProvider
        val words = SemanticsMatcher("any node") { true }.words()
        val next = HashMap<Int, Int>()
        for (node in rule.onAllNodes(SemanticsMatcher("any node") { true }, useUnmergedTree = true).fetchSemanticsNodes()) {
            val info = provider.createAccessibilityNodeInfo(node.id) ?: continue
            val to = info.extras.getInt(TRAVERSAL_BEFORE, NONE)
            if (to != NONE) next[node.id] = to
        }
        assertTrue("Compose linked no nodes for TalkBack", next.isNotEmpty())
        val first = next.keys.single { it !in next.values }
        return generateSequence(first) { next[it] }.map { words[it].orEmpty() }.toList()
    }

    /** Where a keyboard's Tab goes from Settings, the top bar's last control, [steps] times over. */
    private fun tabbedFromSettings(steps: Int): List<String> {
        // A first Tab puts the app in keyboard mode, where the controls take focus.
        rule.onRoot().performKeyInput { pressKey(Key.Tab) }
        rule.onNode(hasContentDescription("Settings")).performSemanticsAction(SemanticsActions.RequestFocus)
        return List(steps) {
            rule.onRoot().performKeyInput { pressKey(Key.Tab) }
            rule.waitForIdle()
            SemanticsMatcher.expectValue(SemanticsProperties.Focused, true).words().values.single()
        }
    }

    private fun List<String>.at(what: String, starts: String): Int =
        indexOfFirst { it.startsWith(starts) }.also { assertTrue("never reaches $what in $this", it >= 0) }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `upright, TalkBack hears the bar right after the usage blocks and before every label and card`() {
        launch()
        val order = heard()

        val blocks = order.at("the Claude usage block", BLOCK)
        val bar = order.at("the bar", BAR)
        assertEquals("the bar right after the usage block: $order", blocks + 1, bar)
        assertTrue("the bar before the first label: $order", bar < order.at("acme-api's label", "acme-api, 2 sessions"))
        for (session in board) {
            assertTrue("the bar before ${session.name}: $order", bar < order.at(session.name, "Claude, ${session.name}"))
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers = "w915dp-h360dp-land-xxhdpi")
    fun `sideways, where the blocks lead the list, TalkBack hears the bar just before them and the cards`() {
        launch()
        val order = heard()

        val bar = order.at("the bar", BAR)
        assertEquals("the bar right after the top bar's Settings: $order", "Settings", order[bar - 1])
        assertEquals("the bar right before the usage block, the list's first item: $order", bar + 1, order.at("the Claude usage block", BLOCK))
        assertTrue("the bar before the first label: $order", bar < order.at("acme-api's label", "acme-api, 2 sessions"))
        assertTrue("the bar before the first card: $order", bar < order.at("the first card", "Claude, Add rate limiting"))
    }

    @Test
    fun `upright, Tab goes from Settings to the usage block, the bar, then the first card`() {
        launch()
        val tabbed = tabbedFromSettings(3)

        assertTrue("first the usage block: $tabbed", tabbed[0].startsWith(BLOCK))
        assertTrue("then the bar: $tabbed", tabbed[1].startsWith(BAR))
        assertTrue("then the first card: $tabbed", tabbed[2].startsWith("Claude, Add rate limiting"))
    }

    @Test
    @Config(qualifiers = "w915dp-h360dp-land-xxhdpi")
    fun `sideways, where the blocks lead the list, Tab still goes to the usage block, the bar, then the first card`() {
        launch()
        val tabbed = tabbedFromSettings(3)

        assertTrue("first the usage block: $tabbed", tabbed[0].startsWith(BLOCK))
        assertTrue("then the bar: $tabbed", tabbed[1].startsWith(BAR))
        assertTrue("then the first card: $tabbed", tabbed[2].startsWith("Claude, Add rate limiting"))
    }

    private companion object {
        const val BLOCK = "Claude, 3 sessions"
        const val BAR = "1 blocked: Fix the login redirect, in acme-api"

        /** Compose's test key for the node TalkBack goes to next (AndroidComposeViewAccessibilityDelegateCompat). */
        const val TRAVERSAL_BEFORE = "android.view.accessibility.extra.EXTRA_DATA_TEST_TRAVERSALBEFORE_VAL"
        const val NONE = Int.MIN_VALUE
    }
}
