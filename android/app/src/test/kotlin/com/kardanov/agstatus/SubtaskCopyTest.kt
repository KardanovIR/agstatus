package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The subtask copy is shared word for word with the web board (public/app.js)
 * and the iOS app, so it is pinned here rather than left to the composables.
 * The server's own lines — "Needs approval: …", "2 subagents still running",
 * "Reading subagent results" — arrive as the session's message and are drawn
 * as sent, so they have no copy here.
 */
class SubtaskCopyTest {

    private fun row(label: String, state: SubtaskState, activity: String) =
        Subtask(id = "k", n = 1, label = label, state = state, activity = activity)

    @Test
    fun `footer parts and their separator`() {
        assertEquals("+8 more", SubtaskCopy.more(8))
        assertEquals("15 done", SubtaskCopy.done(15))
        assertEquals(" · ", SubtaskCopy.SEPARATOR)
        assertEquals('·', SubtaskCopy.SEPARATOR[1])
        assertEquals("+8 more · 15 done", SubtaskSlots.footer(total = 10, shown = 2, done = 15)?.text)
        assertEquals("+1 more", SubtaskSlots.footer(total = 3, shown = 2, done = 0)?.text)
        assertEquals("12 done", SubtaskSlots.footer(total = 0, shown = 0, done = 12)?.text)
    }

    @Test
    fun `session screen header counts, non-zero parts only`() {
        assertEquals("9 running · 1 blocked · 1 failed", SubtaskCopy.counts(running = 9, blocked = 1, failed = 1))
        assertEquals("9 running · 1 blocked", SubtaskCopy.counts(running = 9, blocked = 1, failed = 0))
        assertEquals("9 running", SubtaskCopy.counts(running = 9, blocked = 0, failed = 0))
        assertEquals("1 blocked", SubtaskCopy.counts(running = 0, blocked = 1, failed = 0))
        assertEquals("2 failed", SubtaskCopy.counts(running = 0, blocked = 0, failed = 2))
        assertEquals("", SubtaskCopy.counts(running = 0, blocked = 0, failed = 0))
    }

    @Test
    fun `session screen section, done line and timeline heading`() {
        assertEquals("Subtasks", SubtaskCopy.SECTION)
        assertEquals("15 done this turn", SubtaskCopy.doneThisTurn(15))
        assertEquals("Timeline", SubtaskCopy.TIMELINE)
    }

    @Test
    fun `row state words and the card word`() {
        assertEquals(
            listOf("planning", "coding", "testing", "blocked", "failed"),
            SubtaskState.entries.map { it.wire },
        )
        assertEquals("working", DisplayStatus.WORKING.word)
        // The card's own capitalisation, as for every status it draws.
        assertEquals("Working", DisplayStatus.WORKING.label)
        assertEquals("WORKING", DisplayStatus.WORKING.label.uppercase())
    }

    @Test
    fun `the label the server gives a subagent it cannot name`() {
        assertEquals("Subagent 7", SubtaskCopy.fallbackLabel(7))
    }

    @Test
    fun `row accessibility names`() {
        assertEquals(
            "verify:hook, blocked: Approve: Run the hook suite",
            SubtaskCopy.rowDescription(row("verify:hook", SubtaskState.BLOCKED, "Approve: Run the hook suite")),
        )
        assertEquals(
            "Subagent 4, coding: Edit",
            SubtaskCopy.rowDescription(row("Subagent 4", SubtaskState.CODING, "Edit")),
        )
        assertEquals("review:hook, testing", SubtaskCopy.rowDescription(row("review:hook", SubtaskState.TESTING, "")))
    }

    @Test
    fun `the footer's tap label reads after TalkBack's double-tap prompt`() {
        assertEquals("Open the session screen", SubtaskCopy.OPEN_SESSION)
    }
}
