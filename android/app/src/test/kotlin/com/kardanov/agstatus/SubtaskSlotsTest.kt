package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.roundToInt

/**
 * The slot rule — oldest, slot-stable — is shared with the web board's pick()
 * and the iOS app's SubtaskSlots, so the same subagent sits in the same slot
 * on every client. Android draws every card by the phone rules: two slots,
 * and no list unfolding in place, so neither case is here.
 */
class SubtaskSlotsTest {

    /** A subagent whose ordinal follows its one-letter id: a is 1, b is 2. */
    private fun sub(id: String, state: SubtaskState = SubtaskState.CODING) =
        Subtask(id = id, n = id[0] - 'a' + 1, label = "label $id", state = state, activity = "doing $id")

    private val blocked = SubtaskState.BLOCKED

    /** The rows a card shows, starting from [ledger], by id. */
    private fun rows(ledger: SubtaskLedger?, vararg items: Subtask): List<String> =
        SubtaskSlots.pick(ledger, items.toList()).rows.map { it.id }

    /** The ledger a card keeps after drawing [items] from [ledger]. */
    private fun ledger(ledger: SubtaskLedger?, vararg items: Subtask): SubtaskLedger =
        SubtaskSlots.pick(ledger, items.toList()).ledger

    // MARK: - First drawing

    @Test
    fun `a first drawing shows the oldest subagents in start order`() {
        assertEquals(listOf("a", "b"), rows(null, sub("a"), sub("b"), sub("c")))
        assertEquals(listOf("a"), rows(null, sub("a")))
        assertEquals(emptyList<String>(), rows(null))
    }

    @Test
    fun `a first drawing gives blocked subagents their slots first, still in start order`() {
        assertEquals(listOf("a", "c"), rows(null, sub("a"), sub("b"), sub("c", blocked), sub("d")))
        assertEquals(listOf("c", "d"), rows(null, sub("a"), sub("b"), sub("c", blocked), sub("d", blocked)))
        assertEquals(listOf("b", "c"), rows(null, sub("a"), sub("b", blocked), sub("c", blocked), sub("d", blocked)))
    }

    @Test
    fun `thirty running show the first two and nothing else moves`() {
        val thirty = (0 until 30).map { Subtask(id = "agent$it", n = it + 1, label = "l$it", state = SubtaskState.CODING) }
        val first = SubtaskSlots.pick(null, thirty)

        assertEquals(listOf("agent0", "agent1"), first.rows.map { it.id })
        assertEquals(SubtaskLedger(2, listOf("agent0", "agent1")), first.ledger)

        // The first finishes: the oldest hidden one takes its slot in place.
        val next = SubtaskSlots.pick(first.ledger, thirty.drop(1))
        assertEquals(listOf("agent2", "agent1"), next.rows.map { it.id })
    }

    // MARK: - Finishes

    @Test
    fun `a finish is filled in place by the next hidden subagent`() {
        val start = ledger(null, sub("a"), sub("b"), sub("c"), sub("d"))

        // a finishes: c takes the top slot, b keeps the second.
        assertEquals(listOf("c", "b"), rows(start, sub("b"), sub("c"), sub("d")))
        // b finishes instead: c takes the second slot, a keeps the top.
        assertEquals(listOf("a", "c"), rows(start, sub("a"), sub("c"), sub("d")))
    }

    @Test
    fun `a slot nothing can take closes, and the next start opens one at the bottom`() {
        val start = ledger(null, sub("a"), sub("b"))

        val closed = SubtaskSlots.pick(start, listOf(sub("b")))
        assertEquals(listOf("b"), closed.rows.map { it.id })
        assertEquals(SubtaskLedger(2, listOf("b")), closed.ledger)

        assertEquals(listOf("b", "c"), rows(closed.ledger, sub("b"), sub("c")))
    }

    @Test
    fun `every subagent finishing leaves no rows`() {
        val start = ledger(null, sub("a"), sub("b"))
        val empty = SubtaskSlots.pick(start, emptyList())

        assertEquals(emptyList<Subtask>(), empty.rows)
        assertEquals(SubtaskLedger(2, emptyList()), empty.ledger)
    }

    // MARK: - Blocked

    @Test
    fun `a hidden blocked subagent takes the bottom-most slot that is not blocked`() {
        val start = ledger(null, sub("a"), sub("b"), sub("c"))

        assertEquals(listOf("a", "c"), rows(start, sub("a"), sub("b"), sub("c", blocked)))
    }

    @Test
    fun `a blocked subagent skips a blocked bottom slot and displaces the one above`() {
        val start = ledger(null, sub("a"), sub("b", blocked), sub("c"), sub("d"))
        assertEquals(SubtaskLedger(2, listOf("a", "b")), start)

        assertEquals(listOf("d", "b"), rows(start, sub("a"), sub("b", blocked), sub("c"), sub("d", blocked)))
    }

    @Test
    fun `with every slot blocked a newly blocked subagent stays hidden`() {
        val start = ledger(null, sub("a", blocked), sub("b", blocked), sub("c"))

        val next = SubtaskSlots.pick(start, listOf(sub("a", blocked), sub("b", blocked), sub("c", blocked)))
        assertEquals(listOf("a", "b"), next.rows.map { it.id })
        assertEquals(
            SubtaskSlots.Footer(more = "+1 more", done = null),
            SubtaskSlots.footer(total = 3, shown = next.rows.size, done = 0),
        )
    }

    @Test
    fun `a blocked subagent takes a slot a finish freed before displacing anyone`() {
        val start = ledger(null, sub("a"), sub("b"), sub("c"), sub("d"))

        // a finishes in the same frame as d blocks: d takes a's slot, b stays.
        assertEquals(listOf("d", "b"), rows(start, sub("b"), sub("c"), sub("d", blocked)))
    }

    @Test
    fun `an approved row keeps its slot, and the row it displaced waits for a finish`() {
        val start = ledger(null, sub("a"), sub("b"), sub("c"))
        val blockedLedger = ledger(start, sub("a"), sub("b"), sub("c", blocked))
        assertEquals(SubtaskLedger(2, listOf("a", "c")), blockedLedger)

        // c is approved: it stays where it is, and b does not come back.
        val approved = ledger(blockedLedger, sub("a"), sub("b"), sub("c"))
        assertEquals(SubtaskLedger(2, listOf("a", "c")), approved)

        // Only a finish brings b back, into the slot that finish freed.
        assertEquals(listOf("b", "c"), rows(approved, sub("b"), sub("c")))
    }

    @Test
    fun `a failed row is an ordinary row a blocked one can displace`() {
        val start = ledger(null, sub("a"), sub("b", SubtaskState.FAILED), sub("c"))
        assertEquals(SubtaskLedger(2, listOf("a", "b")), start)

        assertEquals(
            listOf("a", "c"),
            rows(start, sub("a"), sub("b", SubtaskState.FAILED), sub("c", blocked)),
        )
    }

    // MARK: - Ledger

    @Test
    fun `picking again with the ledger it returned answers the same`() {
        val cases = listOf(
            listOf(sub("a"), sub("b"), sub("c")),
            listOf(sub("a"), sub("b", blocked), sub("c"), sub("d", blocked), sub("e", blocked)),
            listOf(sub("a", blocked), sub("b", blocked), sub("c", blocked)),
            listOf(sub("b"), sub("c", SubtaskState.FAILED)),
            listOf(sub("a")),
            emptyList(),
        )
        val earlier = listOf(null, SubtaskLedger(2, listOf("a", "b")), SubtaskLedger(2, listOf("c")))

        for (items in cases) {
            for (from in earlier) {
                val once = SubtaskSlots.pick(from, items)
                val twice = SubtaskSlots.pick(once.ledger, items)
                assertEquals("from $from with ${items.map { it.id }}", once, twice)
            }
        }
    }

    @Test
    fun `a ledger made for another slot count starts over`() {
        val other = SubtaskLedger(3, listOf("c", "b", "a"))

        assertEquals(listOf("a", "b"), rows(other, sub("a"), sub("b"), sub("c")))
    }

    @Test
    fun `cards keep their ledgers while they have subtasks, and lose them when they do not`() {
        val items = listOf(sub("a"), sub("b"), sub("c"))
        val working = Session(id = "working", subtasks = Subtasks(running = 3, items = items))
        val countOnly = Session(id = "count", subtasks = Subtasks(done = 12))
        val plain = Session(id = "plain")

        val first = SubtaskSlots.resolve(emptyMap(), listOf(working, countOnly, plain))
        assertEquals(setOf("working", "count"), first.keys)
        assertEquals(SubtaskLedger(2, listOf("a", "b")), first["working"])
        assertEquals(SubtaskLedger(2, emptyList()), first["count"])

        // a finishes: the ledger moves on from the one the card had.
        val finished = working.copy(subtasks = Subtasks(running = 2, done = 1, items = items.drop(1)))
        val second = SubtaskSlots.resolve(first, listOf(finished, countOnly))
        assertEquals(SubtaskLedger(2, listOf("c", "b")), second["working"])

        // The block goes, then the card: each takes its ledger with it.
        assertEquals(setOf("count"), SubtaskSlots.resolve(second, listOf(plain, countOnly)).keys)
        assertEquals(emptyMap<String, SubtaskLedger>(), SubtaskSlots.resolve(second, emptyList()))
    }

    // MARK: - Footer

    @Test
    fun `the footer navigates while anything is hidden and is a count otherwise`() {
        val both = SubtaskSlots.footer(total = 10, shown = 2, done = 15)!!
        assertEquals("+8 more · 15 done", both.text)
        assertTrue(both.navigates)

        val hiddenOnly = SubtaskSlots.footer(total = 3, shown = 2, done = 0)!!
        assertEquals("+1 more", hiddenOnly.text)
        assertTrue(hiddenOnly.navigates)

        val countOnly = SubtaskSlots.footer(total = 2, shown = 2, done = 12)!!
        assertEquals("12 done", countOnly.text)
        assertFalse(countOnly.navigates)

        assertNull(SubtaskSlots.footer(total = 2, shown = 2, done = 0))
        assertNull(SubtaskSlots.footer(total = 0, shown = 0, done = 0))
    }

    // MARK: - Session screen and motion

    @Test
    fun `the session screen lists blocked subagents first, then start order`() {
        val items = listOf(
            sub("a"),
            sub("b", SubtaskState.FAILED),
            sub("c", blocked),
            sub("d", SubtaskState.TESTING),
            sub("e", blocked),
        )

        assertEquals(listOf("c", "e", "a", "b", "d"), SubtaskSlots.screenOrder(items).map { it.id })
    }

    @Test
    fun `an arrival scrolls the row to the middle from wherever the row is`() {
        // At the top, where scrollToItem leaves a row with a screenful after
        // it: back by half the screen, less half the row.
        assertEquals(-319f, SubtaskSlots.arrivalScroll(rowOffset = 0, rowSize = 52, viewportStart = 0, viewportEnd = 690), 0f)
        // Already in the middle: nowhere.
        assertEquals(0f, SubtaskSlots.arrivalScroll(rowOffset = 319, rowSize = 52, viewportStart = 0, viewportEnd = 690), 0f)
        // Where the list stopped short of the top: on, from there, which the
        // list's end then clamps. Never back by half a screen from the top.
        assertEquals(181f, SubtaskSlots.arrivalScroll(rowOffset = 500, rowSize = 52, viewportStart = 0, viewportEnd = 690), 0f)
        // Top padding puts the viewport's start above the first row: the
        // middle is the screen's, so the row lands 319 below its top edge.
        assertEquals(-303f, SubtaskSlots.arrivalScroll(rowOffset = 0, rowSize = 52, viewportStart = -16, viewportEnd = 674), 0f)
    }

    @Test
    fun `an arrived row is on screen wherever it is in the list, and centred where there is room`() {
        // The session screen before its history arrives, on a 690-high phone:
        // header, Subtasks label, twenty 52 rows, the done line, the Timeline
        // heading, and 24 of bottom padding. 1,224 in all, so 534 of scroll.
        val heights = listOf(56, 42) + List(20) { 52 } + listOf(20, 42)
        val viewport = 690
        val tops = heights.runningFold(0, Int::plus)
        val maxScroll = tops.last() + 24 - viewport

        for (index in 2..21) {
            // scrollToItem asks for the row at the top, and the list stops at its end...
            var scroll = minOf(tops[index], maxScroll)
            // ...then the arrival's scroll, which the list clamps at both ends.
            val arrival = SubtaskSlots.arrivalScroll(tops[index] - scroll, heights[index], 0, viewport)
            scroll = (scroll + arrival.roundToInt()).coerceIn(0, maxScroll)
            val offset = tops[index] - scroll

            assertTrue("row $index at $offset", offset >= 0 && offset + heights[index] <= viewport)
            if (tops[index] - 319 in 0..maxScroll) assertEquals("row $index", 319, offset)
        }

        // The nineteenth row, in the last screenful: the list stops with it at
        // 500, and there it stays, on screen. Back by half a screen from the
        // top, as if it were there, would have put it at 819, past the bottom.
        val nineteenth = tops[20] - maxScroll
        assertEquals(500, nineteenth)
        assertEquals(181f, SubtaskSlots.arrivalScroll(nineteenth, 52, 0, viewport), 0f)
    }

    @Test
    fun `a state cell moves into and out of blocked and into failed, and for nothing else`() {
        val moves = listOf(
            SubtaskState.CODING to blocked,
            blocked to SubtaskState.TESTING,
            SubtaskState.PLANNING to SubtaskState.FAILED,
            blocked to SubtaskState.FAILED,
            SubtaskState.FAILED to blocked,
        )
        val stills = listOf(
            SubtaskState.PLANNING to SubtaskState.CODING,
            SubtaskState.CODING to SubtaskState.TESTING,
            SubtaskState.TESTING to SubtaskState.PLANNING,
            SubtaskState.FAILED to SubtaskState.CODING,
            blocked to blocked,
            SubtaskState.CODING to SubtaskState.CODING,
        )

        for ((from, to) in moves) assertTrue("$from to $to", SubtaskSlots.stateCellMoves(from, to))
        for ((from, to) in stills) assertFalse("$from to $to", SubtaskSlots.stateCellMoves(from, to))
    }
}
