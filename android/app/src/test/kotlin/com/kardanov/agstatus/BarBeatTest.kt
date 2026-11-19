package com.kardanov.agstatus

import com.kardanov.agstatus.BarBeat.Verdict.ANSWERED
import com.kardanov.agstatus.BarBeat.Verdict.ARRIVAL
import com.kardanov.agstatus.BarBeat.Verdict.AWAY
import com.kardanov.agstatus.BarBeat.Verdict.BEATS
import com.kardanov.agstatus.BarBeat.Verdict.NO_RISE
import com.kardanov.agstatus.BarBeat.Verdict.STILL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When the needs-you bar beats ([BarBeat]), as the store drives it
 * (SessionStore.setSessions): every change of the board is noted; one that
 * starts the voice's half second ([BlockSpeech.observe]) starts the beat's,
 * with the board in front of the reader or not; and when the half second is
 * over the voice says what still stands and the beat decides, with the board
 * in front or not and animations on or off as they are then. The clock is
 * the table's own.
 *
 * Case for case iOS's table (BoardLayout.swift, verifyBarBeat), so the two
 * clients, and the web, which keeps the same rule, agree.
 */
class BarBeatTest {
    private var now = 0L
    private var cards = emptyList<Session>()
    private var speech = BlockSpeech()
    private var beat = BarBeat()
    private var due: Long? = null
    private var starts = 0
    private val verdicts = mutableListOf<BarBeat.Verdict>()

    // The board in front of the reader, and animations on, unless a case says otherwise.
    private var inFront = true
    private var moves = true

    private fun card(id: String, status: AgentStatus = AgentStatus.CODING) = Session(
        id = id,
        name = "Session $id",
        status = status,
        project = "acme-api",
        homeProject = "acme-api",
        createdAt = 1,
        updatedAt = 1,
    )

    /**
     * One update of the board, as the store takes it. [live] is a session
     * frame; anything else (a snapshot, a refresh, a dismissal and the card a
     * refused one puts back) only shows what stands.
     */
    private fun update(live: Boolean = true, change: (List<Session>) -> List<Session>) {
        cards = change(cards)
        beat.note(cards, now)
        if (speech.observe(cards, live, now)) {
            assertNull("one half second at a time", due)
            beat.gather(inFront)
            due = now + BlockSpeech.GATHER_MILLIS
            starts++
        }
    }

    /** Time passing, and the half second ending when it is due, with the board as it is then. */
    private fun pass(millis: Long) {
        val then = now + millis
        val at = due
        if (at != null && at <= then) {
            now = at
            due = null
            val sentence = speech.say(cards, now)
            beat.end(answered = sentence == null, inFront = inFront, moves = moves)?.let { verdicts += it }
        }
        now = then
    }

    /** A session frame about [id], which turns it [status], or brings it new. */
    private fun frame(id: String, status: AgentStatus): (List<Session>) -> List<Session> = { list ->
        if (list.any { it.id == id }) {
            list.map { if (it.id == id) it.copy(status = status) else it }
        } else {
            listOf(card(id, status)) + list
        }
    }

    private fun frames(vararg changes: Pair<String, AgentStatus>): (List<Session>) -> List<Session> = { list ->
        changes.fold(list) { board, (id, status) -> frame(id, status)(board) }
    }

    private fun without(id: String): (List<Session>) -> List<Session> = { list -> list.filter { it.id != id } }

    /** A board drawn from its first snapshot, its blocks standing, and left to rest. */
    private fun board(blocked: List<String>, working: List<String> = listOf("w1", "w2", "w3")) {
        now = 0
        cards = emptyList()
        speech = BlockSpeech()
        beat = BarBeat()
        due = null
        starts = 0
        verdicts.clear()
        inFront = true
        moves = true
        update(live = false) { blocked.map { card(it, AgentStatus.BLOCKED) } + working.map { card(it) } }
        pass(10_000)
    }

    @Test
    fun `a first draw is no beat`() {
        board(blocked = listOf("a", "b"))

        assertEquals(0, starts)
        assertEquals(emptyList<BarBeat.Verdict>(), verdicts)
    }

    @Test
    fun `a rise while the bar shows beats once, when the half second is over, and each later rise again`() {
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(400)
        assertEquals("nothing until the half second is over", emptyList<BarBeat.Verdict>(), verdicts)
        pass(200)
        assertEquals(listOf(BEATS), verdicts)

        pass(10_000)
        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("one beat for each rise", listOf(BEATS, BEATS), verdicts)
        assertEquals(2, starts)
        assertEquals("and the bar rests on the count it beat with", 3, beat.rest)
    }

    @Test
    fun `blocks that land together make one beat`() {
        // 15 ms apart, as two hook events do.
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(15)
        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals(listOf(BEATS), verdicts)
        assertEquals(1, starts)
    }

    @Test
    fun `the first block is the bar's arrival, and so is one that lands as it arrives`() {
        board(blocked = emptyList())
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("the first block is the bar's arrival, no beat", listOf(ARRIVAL), verdicts)

        board(blocked = emptyList())
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(300)
        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("nor for one that lands as the bar arrives", listOf(ARRIVAL), verdicts)

        // An arrival that is no news of its own (its session said within the
        // minute), and a block a third of a second after it: still the arrival.
        update(change = frames("w1" to AgentStatus.CODING, "w2" to AgentStatus.CODING))
        pass(5_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        assertEquals("a session that was news within the minute is no news", 1, starts)
        pass(300)
        update(change = frame("w3", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("a block a third of a second after any arrival is part of it", listOf(ARRIVAL, ARRIVAL), verdicts)

        // Half a second later the bar rests on the count, and a rise beats.
        pass(5_000)
        update(change = frame("x", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("a rise once the bar has arrived beats", listOf(ARRIVAL, ARRIVAL, BEATS), verdicts)
    }

    @Test
    fun `a fall is no beat`() {
        // An unblock, then two dismissals, which take the card away with no frame.
        board(blocked = listOf("a", "b", "c"))
        update(change = frame("b", AgentStatus.CODING))
        pass(1_000)
        update(live = false, change = without("c"))
        pass(1_000)
        update(live = false, change = without("a"))
        pass(1_000)

        assertEquals(0, starts)
        assertEquals(emptyList<BarBeat.Verdict>(), verdicts)
    }

    @Test
    fun `one block in place of another is no rise, whichever lands first`() {
        board(blocked = listOf("a", "b"))
        update(change = frames("w1" to AgentStatus.BLOCKED, "a" to AgentStatus.CODING))
        pass(1_000)
        assertEquals("a swap in one update is no beat", listOf(NO_RISE), verdicts)

        board(blocked = listOf("a", "b"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(100)
        update(change = frame("a", AgentStatus.CODING))
        pass(1_000)
        assertEquals("nor a block answered just after another lands", listOf(NO_RISE), verdicts)

        board(blocked = listOf("a", "b"))
        update(change = frame("a", AgentStatus.CODING))
        pass(100)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("nor a block that lands just after another is answered", listOf(NO_RISE), verdicts)
    }

    @Test
    fun `a block seconds after another was answered is a rise`() {
        board(blocked = listOf("a", "b"))
        update(change = frame("a", AgentStatus.CODING))
        pass(5_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals(listOf(BEATS), verdicts)
    }

    @Test
    fun `a swap just after a beat is no second beat`() {
        // The bar rests on the count it beat with.
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(300)
        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(300)
        update(change = frame("a", AgentStatus.CODING))
        pass(300)
        update(change = frame("w3", AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals(listOf(BEATS, NO_RISE), verdicts)
    }

    @Test
    fun `a card put back after a refused dismissal, a refetch and a reconnect bring no beat`() {
        // A1: no frame brought them, so they are no news, though the count rises.
        board(blocked = listOf("a", "b"))
        val refused = cards
        update(live = false, change = without("b"))
        pass(200)
        update(live = false) { refused }
        pass(1_000)
        update(live = false) { refused }
        pass(1_000)
        assertEquals("a restored card is no beat", 0, starts)

        // A block a pull to refresh brings in ahead of its frame, then that
        // frame; and a reconnect's snapshot with a block that landed while
        // the stream was down.
        update(live = false, change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        update(live = false, change = frame("w2", AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals("nor a refetch's block, nor a reconnect's", 0, starts)
        assertEquals(emptyList<BarBeat.Verdict>(), verdicts)
    }

    @Test
    fun `a session that was news within the minute is no beat, whatever the first did, and is again after it`() {
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        update(change = frame("w1", AgentStatus.CODING))
        pass(20_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("a repeat within the minute is no beat", listOf(BEATS), verdicts)
        assertEquals(1, starts)

        pass(60_000)
        update(change = frame("w1", AgentStatus.CODING))
        pass(5_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("past the minute it beats again", listOf(BEATS, BEATS), verdicts)
    }

    @Test
    fun `the arrival's session is held for its minute too`() {
        board(blocked = emptyList())
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(5_000)
        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(5_000)
        update(change = frame("w1", AgentStatus.CODING))
        pass(5_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals(listOf(ARRIVAL, BEATS), verdicts)
    }

    @Test
    fun `a block answered within the half second is no beat`() {
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(200)
        update(change = frame("w1", AgentStatus.CODING))
        pass(1_000)

        assertEquals(listOf(ANSWERED), verdicts)
    }

    @Test
    fun `a bar that empties and comes back within the half second has arrived again`() {
        board(blocked = listOf("a"))
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(100)
        update(change = frames("a" to AgentStatus.CODING, "w1" to AgentStatus.CODING))
        pass(100)
        update(change = frames("w1" to AgentStatus.BLOCKED, "w2" to AgentStatus.BLOCKED))
        pass(1_000)

        assertEquals(listOf(ARRIVAL), verdicts)
    }

    @Test
    fun `with animations off nothing moves, and the session is held for its minute all the same`() {
        board(blocked = listOf("a"))
        moves = false
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals(listOf(STILL), verdicts)

        moves = true
        update(change = frame("w1", AgentStatus.CODING))
        pass(5_000)
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals(listOf(STILL), verdicts)
    }

    @Test
    fun `a board not in front of the reader, when the block lands, when the half second ends or both, is no beat`() {
        // The app paused or stopped, another screen over the board, or the
        // pairing sheet.
        board(blocked = listOf("a"))
        inFront = false
        update(change = frame("w1", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("a block while the board is not in front is no beat", listOf(AWAY), verdicts)

        update(change = frame("w2", AgentStatus.BLOCKED))
        pass(200)
        inFront = true
        pass(1_000)
        assertEquals("nor on the way back, within its half second", listOf(AWAY, AWAY), verdicts)

        update(change = frame("w3", AgentStatus.BLOCKED))
        pass(200)
        inFront = false
        pass(1_000)
        assertEquals("nor when the reader leaves within it", listOf(AWAY, AWAY, AWAY), verdicts)

        inFront = true
        update(change = frame("x", AgentStatus.BLOCKED))
        pass(1_000)
        assertEquals("back in front, a rise beats", listOf(AWAY, AWAY, AWAY, BEATS), verdicts)
    }

    @Test
    fun `the verdict's order`() {
        assertEquals(ARRIVAL, BarBeat.verdict(rest = 0, answered = false, count = 1, inFront = false, moves = false))
        assertEquals(NO_RISE, BarBeat.verdict(rest = 2, answered = false, count = 2, inFront = false, moves = false))
        assertEquals(AWAY, BarBeat.verdict(rest = 2, answered = false, count = 3, inFront = false, moves = false))
        assertEquals(STILL, BarBeat.verdict(rest = 2, answered = false, count = 3, inFront = true, moves = false))
        assertEquals(ANSWERED, BarBeat.verdict(rest = 2, answered = true, count = 3, inFront = true, moves = true))
        assertEquals(BEATS, BarBeat.verdict(rest = 2, answered = false, count = 3, inFront = true, moves = true))
    }
}
