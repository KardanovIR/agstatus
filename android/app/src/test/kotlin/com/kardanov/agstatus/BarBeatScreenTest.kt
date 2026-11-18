package com.kardanov.agstatus

import android.content.Intent
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onChildAt
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.toSize
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * The needs-you bar's beat in the real app (the owner's decision of
 * 2026-11-16, O5): when the blocked count rises while the bar shows, the
 * store calls one beat half a second after the block ([BarBeat],
 * SessionStore.beats), and the bar comes in from the bottom edge again,
 * once, with the new count already in it. Drawn only: the bar's place, the
 * list and what TalkBack is told stay where they are, and a press lands on
 * the bar throughout. The rule's every case is BarBeatTest's; these are the
 * ones that turn on the app itself: the store's clock and its frames, the
 * board's screen and the app's lifecycle, animations off, and the drawing.
 *
 * The board stands for a second before each block, as a real one does: a
 * block within half a second of the board's first draw is part of its
 * arrival.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class BarBeatScreenTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var store: SessionStore
    private var listening: Job? = null

    /** Every beat the store called, by the store's clock. */
    private val called = mutableListOf<Long>()

    @After
    fun close() {
        listening?.cancel()
        scenario.close()
        // A board a case adopted is saved in BoardStorage, whose preferences
        // live in a static for as long as the sandbox does, which is every
        // class after this one too: each case after it would start paired,
        // with the board's Pair button in the toolbar and a stream started.
        BoardStorage.clear(ApplicationProvider.getApplicationContext())
        Settings.Global.putFloat(
            ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        )
    }

    private fun card(id: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = "Session $id",
        status = status,
        message = "Working on $id",
        project = "acme-api",
        homeProject = "acme-api",
        createdAt = 1,
        updatedAt = 1,
    )

    private var board = listOf(card("s1", AgentStatus.BLOCKED), card("w1"), card("w2"), card("w3"))

    private fun launch(sessions: List<Session> = board, animationsOff: Boolean = false) {
        if (animationsOff) {
            Settings.Global.putFloat(
                ApplicationProvider.getApplicationContext<android.app.Application>().contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                0f,
            )
        }
        board = sessions
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { store = ViewModelProvider(it)[SessionStore::class.java] }
        listening = CoroutineScope(Dispatchers.Main.immediate).launch {
            store.beats.collect { called += SystemClock.elapsedRealtime() }
        }
        store.showForTest(board)
        rule.waitForIdle()
        stand(1_000)
    }

    /** The store's clock running on, with nothing else happening. */
    private fun stand(millis: Long) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis))
        rule.waitForIdle()
    }

    /** A session frame turning [id] [status], as the stream brings it. */
    private fun frame(vararg changes: Pair<String, AgentStatus>) {
        board = board.map { session -> changes.firstOrNull { it.first == session.id }?.let { session.copy(status = it.second) } ?: session }
        store.showForTest(board, live = true)
        rule.waitForIdle()
    }

    private val bar = SemanticsMatcher("the needs-you bar") {
        it.config.getOrNull(SemanticsActions.OnClick)?.label == "show that session"
    }

    private fun barSays(): String = rule.onNode(bar).fetchSemanticsNode()
        .config.getOrNull(SemanticsProperties.ContentDescription).orEmpty().joinToString()

    /** The bar's place: its button, which takes the press and is what TalkBack is told of. */
    private fun place(): Rect = rule.onNode(bar).fetchSemanticsNode().boundsInRoot

    /**
     * What the bar draws, its words, wherever the beat has them: the button's
     * one child. Where it stands, not where it shows: as a beat starts it is
     * drawn wholly below the screen's edge, where nothing of it shows.
     */
    private fun drawn(): Rect {
        val words = rule.onNode(bar, useUnmergedTree = true).onChildAt(0).fetchSemanticsNode()
        return Rect(words.positionInRoot, words.size.toSize())
    }

    private fun list(): Rect = rule.onNode(hasScrollToIndexAction()).fetchSemanticsNode().boundsInRoot

    /** Where the bar, the list and the bar's words stand, frame by frame. */
    private data class Frame(val place: Rect, val list: Rect, val drawn: Rect)

    private fun frameNow() = Frame(place(), list(), drawn())

    /**
     * The half second ends, then [count] frames, each as drawn: the store's
     * clock run past the half second, then the board's own clock stepped a
     * frame at a time.
     */
    private fun framesPastTheHalfSecond(count: Int = 24): List<Frame> {
        rule.mainClock.autoAdvance = false
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
        val frames = List(count) {
            rule.mainClock.advanceTimeByFrame()
            frameNow()
        }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        return frames
    }

    /** How far below its place, in px, the bar's words stand in each frame, from where they rest. */
    private fun List<Frame>.below(rest: Frame): List<Float> = map { it.drawn.top - rest.drawn.top }

    private fun assertNoBeat(frames: List<Frame>, rest: Frame) {
        assertEquals("no beat called", emptyList<Long>(), called)
        assertTrue("nothing moved: ${frames.below(rest)}", frames.all { it == rest })
    }

    @Test
    fun `a rise while the bar shows beats once, drawn only, with the new count already in it`() {
        launch()
        assertEquals("1 blocked: Session s1, in acme-api, Show", barSays())
        val rest = frameNow()

        frame("w1" to AgentStatus.BLOCKED)
        // The count changes in place at once; the beat comes half a second on.
        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertEquals(rest, frameNow())
        val frames = framesPastTheHalfSecond()

        assertEquals("one beat called", 1, called.size)
        val below = frames.below(rest)
        val height = rest.place.height
        val moving = below.dropWhile { it == 0f }
        assertTrue("the words moved: $below", moving.isNotEmpty())
        assertTrue("from the half second's end: $below", below.size - moving.size <= 2)
        assertTrue("from their own height below their place: $below of $height", moving.first() > height * 0.8f)
        assertTrue("and back up, never past it: $below", moving.zipWithNext().all { (a, b) -> b <= a } && moving.all { it >= 0f })
        assertEquals("to rest: $below", 0f, below.last(), 0.5f)
        assertTrue("its place never moves", frames.all { it.place == rest.place })
        assertTrue("nor the list", frames.all { it.list == rest.list })
        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertEquals(rest, frameNow())
    }

    @Test
    fun `a press while the bar is still coming up lands on the bar`() {
        launch()
        val rest = frameNow()
        frame("w1" to AgentStatus.BLOCKED)

        rule.mainClock.autoAdvance = false
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
        repeat(3) { rule.mainClock.advanceTimeByFrame() }
        val midway = drawn().top - rest.drawn.top
        assertTrue("mid-beat, the words well below their place: $midway", midway > rest.place.height / 3)
        // At the top of the bar's place, which its words have left: where the
        // bar stands on the screen, not where its node says it is.
        rule.onRoot().performTouchInput { click(Offset(rest.place.center.x, rest.place.top + 2f)) }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()

        assertEquals("the press brought the card the bar named", "s1", store.brought.value)
    }

    @Test
    fun `the first block is the bar's arrival, and no beat`() {
        launch(listOf(card("w1"), card("w2")))

        frame("w1" to AgentStatus.BLOCKED)
        val rest = frameNow()
        val frames = framesPastTheHalfSecond()

        assertNoBeat(frames, rest)
    }

    @Test
    fun `a fall is no beat`() {
        launch(listOf(card("s1", AgentStatus.BLOCKED), card("s2", AgentStatus.BLOCKED), card("w1")))
        val rest = frameNow()

        frame("s2" to AgentStatus.CODING)
        val frames = framesPastTheHalfSecond()

        assertEquals("1 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `one block in place of another is no beat`() {
        launch(listOf(card("s1", AgentStatus.BLOCKED), card("s2", AgentStatus.BLOCKED), card("w1")))

        frame("s2" to AgentStatus.CODING, "w1" to AgentStatus.BLOCKED)
        val rest = frameNow()
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `a session that blocks again within its minute is no beat`() {
        launch()
        frame("w1" to AgentStatus.BLOCKED)
        framesPastTheHalfSecond()
        assertEquals(1, called.size)
        frame("w1" to AgentStatus.CODING)
        stand(20_000)
        called.clear()

        frame("w1" to AgentStatus.BLOCKED)
        val rest = frameNow()
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `with animations off the count changes in place and nothing moves`() {
        launch(animationsOff = true)

        frame("w1" to AgentStatus.BLOCKED)
        val rest = frameNow()
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `a block while another screen is over the board is no beat, nor on the way back`() {
        launch()
        val rest = frameNow()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()

        frame("w1" to AgentStatus.BLOCKED)
        stand(600)
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        val frames = List(24) {
            rule.mainClock.advanceTimeByFrame()
            frameNow()
        }

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `a block that lands with the board in front, the app leaving within the half second, is no beat`() {
        launch()
        val rest = frameNow()

        frame("w1" to AgentStatus.BLOCKED)
        scenario.moveToState(Lifecycle.State.STARTED)
        stand(600)
        scenario.moveToState(Lifecycle.State.RESUMED)
        rule.waitForIdle()
        val frames = List(24) {
            rule.mainClock.advanceTimeByFrame()
            frameNow()
        }

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    @Test
    fun `a block while another screen is over the board, the reader back on the board within the half second, is no beat`() {
        launch()
        val rest = frameNow()
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.waitForIdle()

        frame("w1" to AgentStatus.BLOCKED)
        val blocked = SystemClock.elapsedRealtime()
        // Back at once: the board is in front again well before the half
        // second ends, so only where the board was as the block landed keeps
        // the beat away.
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        val back = SystemClock.elapsedRealtime() - blocked
        assertTrue("the board in front again ${back}ms after the block", store.boardResumed && back < 500)
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    /**
     * A board with a token, whose own button opens the pairing sheet: adopted
     * as a QR code would adopt it, and its stream let go at once, so its
     * sessions are the test's.
     */
    private fun pairABoard() {
        store.adopt(Board(baseUrl = "http://127.0.0.1:9", token = "ags_" + "a".repeat(32)))
        store.disconnect()
        store.showForTest(board)
        rule.waitForIdle()
        stand(1_000)
    }

    /** The real pairing sheet, opened from the board's own button. */
    private fun openThePairingSheet() {
        rule.onNodeWithContentDescription("Pair your computer").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Pair your computer").assertExists()
    }

    /**
     * The pairing sheet is a window of its own over the board, so the board's
     * screen stays resumed under it: only the app's word that the sheet is
     * open keeps the beat away. The real sheet, opened from the board's own
     * button, which shows for a board with a token.
     */
    @Test
    fun `a block while the pairing sheet is over the board is no beat`() {
        launch()
        pairABoard()
        val rest = frameNow()
        openThePairingSheet()

        frame("w1" to AgentStatus.BLOCKED)
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertNoBeat(frames, rest)
    }

    /**
     * Closed, the sheet takes its word with it: the board is in front again,
     * and a rise beats. Closed as a reader closes it, by a tap on the board
     * above it.
     */
    @Test
    fun `once the pairing sheet is closed, a rise beats again`() {
        launch()
        pairABoard()
        openThePairingSheet()
        rule.onNodeWithContentDescription("Close sheet").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Pair your computer").assertDoesNotExist()
        stand(1_000)
        val rest = frameNow()

        frame("w1" to AgentStatus.BLOCKED)
        val frames = framesPastTheHalfSecond()

        assertEquals("2 blocked: Session s1, in acme-api, Show", barSays())
        assertEquals("one beat called", 1, called.size)
        val below = frames.below(rest)
        assertTrue("the words came in from their own height below their place: $below", below.any { it > rest.place.height * 0.8f })
        assertEquals("to rest: $below", 0f, below.last(), 0.5f)
    }
}
