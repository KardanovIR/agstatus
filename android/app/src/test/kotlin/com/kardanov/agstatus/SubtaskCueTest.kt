package com.kardanov.agstatus

import androidx.compose.runtime.AbstractApplier
import androidx.compose.runtime.BroadcastFrameClock
import androidx.compose.runtime.Composition
import androidx.compose.runtime.Recomposer
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import com.kardanov.agstatus.ui.rememberCue
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A row's state cell re-enters when the row is blocked, unblocked or fails,
 * and for nothing else; and a change that is not news, arriving while a cue
 * runs, leaves the cue to finish. The cue is a composable whose keyed effect
 * is what is under test, so it runs here in a real composition, on a frame
 * clock the test drives a frame every 16 ms, with nothing drawn. The
 * android.jar calls the Compose runtime makes on the way (Trace, Log) return
 * defaults in unit tests (`isReturnDefaultValues`).
 */
class SubtaskCueTest {

    @Test
    fun `an approved row's state cell re-enters, and comes to rest`() {
        val cue = cue(SubtaskState.BLOCKED, 0L to SubtaskState.CODING)

        assertTrue("it moved: $cue", cue.any { it < 0.5f })
        assertEquals(1f, cue.last(), 0f)
    }

    @Test
    fun `a class change in the middle of a cue leaves the cue to finish as it would have`() {
        val alone = cue(SubtaskState.BLOCKED, 0L to SubtaskState.CODING)

        // Approved, then testing 64 ms later: the second change is not news.
        // It used to cancel the cue, leaving the cell at 45%, raised, for good.
        for (gap in listOf(32L, 64L, 128L, 256L)) {
            val interrupted = cue(SubtaskState.BLOCKED, 0L to SubtaskState.CODING, gap to SubtaskState.TESTING)
            assertEquals("testing after $gap ms", alone, interrupted)
        }

        // Failed, then resumed: the resumption is not news either.
        val failed = cue(SubtaskState.CODING, 0L to SubtaskState.FAILED)
        assertEquals(failed, cue(SubtaskState.CODING, 0L to SubtaskState.FAILED, 64L to SubtaskState.CODING))
        assertEquals(1f, failed.last(), 0f)
    }

    @Test
    fun `news in the middle of a cue starts it over`() {
        val again = cue(SubtaskState.BLOCKED, 0L to SubtaskState.CODING, 160L to SubtaskState.BLOCKED)

        val restart = (160 / FRAME_MILLIS).toInt()
        assertTrue("it went back down: $again", again.drop(restart).any { it < 0.5f })
        assertEquals(1f, again.last(), 0f)
    }

    @Test
    fun `a class change alone does not move the cell, and nothing does under reduced motion`() {
        val still = List(FRAMES) { 1f }

        assertEquals(still, cue(SubtaskState.CODING, 0L to SubtaskState.TESTING))
        assertEquals(still, cue(SubtaskState.BLOCKED, 0L to SubtaskState.CODING, enabled = false))
        assertEquals(still, cue(SubtaskState.CODING, 0L to SubtaskState.FAILED, enabled = false))
    }

    /**
     * The cue's value at every frame of [FRAMES], for a row first drawn in
     * [first] whose state then changes at the given milliseconds.
     */
    private fun cue(
        first: SubtaskState,
        vararg changes: Pair<Long, SubtaskState>,
        enabled: Boolean = true,
    ): List<Float> = runBlocking {
        val clock = BroadcastFrameClock()
        val context = coroutineContext + clock
        val recomposer = Recomposer(context)
        val loop = launch(context) { recomposer.runRecomposeAndApplyChanges() }
        val state = mutableStateOf(first)
        var progress: State<Float>? = null
        val composition = Composition(NoNodes, recomposer)
        composition.setContent {
            progress = rememberCue(state.value, enabled, CUE_MILLIS, SubtaskSlots::stateCellMoves)
        }

        val pending = changes.sortedBy { it.first }.toMutableList()
        val samples = ArrayList<Float>(FRAMES)
        for (frame in 0 until FRAMES) {
            val now = frame * FRAME_MILLIS
            while (pending.isNotEmpty() && pending.first().first <= now) {
                state.value = pending.removeAt(0).second
                Snapshot.sendApplyNotifications()
            }
            repeat(YIELDS) { yield() }
            clock.sendFrame(now * 1_000_000L)
            repeat(YIELDS) { yield() }
            samples += progress!!.value
        }

        composition.dispose()
        recomposer.cancel()
        loop.cancel()
        samples
    }

    /** A composition that emits no nodes: the cue is all there is to it. */
    private object NoNodes : AbstractApplier<Unit>(Unit) {
        override fun insertTopDown(index: Int, instance: Unit) = Unit
        override fun insertBottomUp(index: Int, instance: Unit) = Unit
        override fun remove(index: Int, count: Int) = Unit
        override fun move(from: Int, to: Int, count: Int) = Unit
        override fun onClear() = Unit
    }

    private companion object {
        /** The state cell's duration on the cards (SubtaskRows' STATE_IN_MILLIS). */
        const val CUE_MILLIS = 420
        const val FRAME_MILLIS = 16L

        /** A second: the cue and then some, so every run comes to rest. */
        const val FRAMES = 63

        /** Enough turns of the event loop for each frame's effects and animation to run. */
        const val YIELDS = 8
    }
}
