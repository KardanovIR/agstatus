package com.kardanov.agstatus

import android.content.Intent
import android.os.Looper
import androidx.compose.runtime.Composer
import androidx.compose.runtime.CompositionTracer
import androidx.compose.runtime.InternalComposeTracingApi
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * What a hook event costs the board: which of the app's composables run
 * again for it, counted through Compose's composition tracer in the real
 * app on a phone-sized screen.
 *
 * A message changing on one card is that card's news alone, as it was before
 * the board was grouped by project: no label, no usage block and not the
 * needs-you bar runs again for it (the spec's Risks, "PERF-3 can regress
 * quietly"). Each still runs, and says the new thing, when what it draws
 * changes: a label's count, the bar's words.
 */
@OptIn(InternalComposeTracingApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class EventCostTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var store: SessionStore

    /** How many times each of the app's composables ran, by name, since [count] began. */
    private val runs = HashMap<String, Int>()

    private val tracer = object : CompositionTracer {
        override fun traceEventStart(key: Int, dirty1: Int, dirty2: Int, info: String) {
            val name = info.substringBefore(" (")
            if (name.startsWith(APP)) runs.merge(name.removePrefix(APP), 1, Int::plus)
        }

        override fun traceEventEnd() {}

        override fun isTraceInProgress(): Boolean = true
    }

    private val idle = object : CompositionTracer {
        override fun traceEventStart(key: Int, dirty1: Int, dirty2: Int, info: String) {}

        override fun traceEventEnd() {}

        override fun isTraceInProgress(): Boolean = false
    }

    private fun session(id: String, home: String, source: String = "claude", status: AgentStatus = AgentStatus.CODING) =
        Session(
            id = id,
            name = "Session $id",
            status = status,
            message = "Working on $id",
            project = home,
            homeProject = home,
            source = source,
            createdAt = 1,
            updatedAt = 1,
        )

    private val usage = listOf("claude", "codex").map { source ->
        UsageInfo(source = source, windows = listOf(UsageWindow(id = "five_hour", label = "5-hour", usedPct = 40.0)))
    }

    /** Eight sessions in three projects, one of them blocked: the bar names s3. */
    private var board = listOf(
        session("s1", "acme-api"), session("s2", "acme-api", "codex"), session("s3", "acme-api", status = AgentStatus.BLOCKED),
        session("s4", "omega"), session("s5", "omega", "codex"),
        session("s6", "zeta"), session("s7", "zeta"), session("s8", "zeta", "codex"),
    )

    @Before
    fun launch() {
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { store = ViewModelProvider(it)[SessionStore::class.java] }
        store.showForTest(board, usage)
        rule.waitForIdle()
    }

    @After
    fun close() {
        Composer.setTracer(idle)
        scenario.close()
    }

    /** The board after a hook event changes it by [change], as a session frame does, and what ran again for it. */
    private fun count(change: (List<Session>) -> List<Session>): Map<String, Int> {
        board = change(board)
        runs.clear()
        Composer.setTracer(tracer)
        try {
            store.showForTest(board, live = true)
            rule.waitForIdle()
        } finally {
            Composer.setTracer(idle)
        }
        return HashMap(runs)
    }

    private fun Map<String, Int>.of(vararg names: String) = names.associateWith { this[it] ?: 0 }

    private fun message(id: String, text: String): (List<Session>) -> List<Session> = { sessions ->
        sessions.map { if (it.id == id) it.copy(message = text, updatedAt = it.updatedAt + 1) else it }
    }

    private fun said(text: String) = SemanticsMatcher("says \"$text\"") {
        it.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() == text
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    private fun barSays(): String = rule.onNode(bar).fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().joinToString()

    @Test
    fun `a message on one card runs that card again, and no label, usage block or the bar`() {
        // The first event can still settle what the first frames left; the
        // second is a plain one.
        count(message("s1", "Reading the brief"))
        val ran = count(message("s1", "Editing src/limits.ts"))

        assertEquals(
            mapOf(
                "ui.SessionCard" to 1,
                "ui.ProjectLabel" to 0,
                "ui.NeedsYouBar" to 0,
                "ui.BarContent" to 0,
                "ui.UsageBars" to 0,
                "ui.UsageSourceBlock" to 0,
            ),
            ran.of("ui.SessionCard", "ui.ProjectLabel", "ui.NeedsYouBar", "ui.BarContent", "ui.UsageBars", "ui.UsageSourceBlock"),
        )
    }

    @Test
    fun `a label runs again, and says so, when its count changes`() {
        rule.onNode(said("acme-api, 3 sessions")).assertExists()

        val ran = count { it + session("s9", "acme-api") }

        assertEquals(1, ran["ui.ProjectLabel"])
        rule.onNode(said("acme-api, 4 sessions")).assertExists()
    }

    @Test
    fun `the bar runs again, and says so, when its words change`() {
        assertEquals("1 blocked: Session s3, in acme-api, Show", barSays())

        val renamed = count { sessions -> sessions.map { if (it.id == "s3") it.copy(name = "Fix the login redirect") else it } }
        assertTrue("the bar ran again: $renamed", (renamed["ui.NeedsYouBar"] ?: 0) >= 1)
        assertEquals("1 blocked: Fix the login redirect, in acme-api, Show", barSays())

        val second = count { sessions -> sessions.map { if (it.id == "s6") it.copy(status = AgentStatus.BLOCKED) else it } }
        assertTrue("the bar ran again: $second", (second["ui.NeedsYouBar"] ?: 0) >= 1)
        assertEquals("2 blocked: Fix the login redirect, in acme-api, Show", barSays())
    }

    @Test
    fun `the bar's beat runs nothing again, the bar included`() {
        // The board stands, then the count rises, which the bar says at once
        // (counted here, not asserted); half a second on, it beats, and the
        // voice says the block.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        count { sessions -> sessions.map { if (it.id == "s6") it.copy(status = AgentStatus.BLOCKED) else it } }
        assertEquals("2 blocked: Session s3, in acme-api, Show", barSays())
        var beats = 0
        val listening = CoroutineScope(Dispatchers.Main.immediate).launch { store.beats.collect { beats++ } }

        runs.clear()
        Composer.setTracer(tracer)
        try {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
            rule.waitForIdle()
        } finally {
            Composer.setTracer(idle)
            listening.cancel()
        }

        assertEquals("a beat was called", 1, beats)
        // Nothing on the board runs, not even a lambda inside the bar: only
        // the voice's line, above the board, which says the block.
        assertEquals(mapOf("ui.SpokenLine" to 1), HashMap(runs))
    }

    private companion object {
        const val APP = "com.kardanov.agstatus."
    }
}
