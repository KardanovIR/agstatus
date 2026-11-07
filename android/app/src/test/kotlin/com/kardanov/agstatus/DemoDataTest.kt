package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * The demo's workflow session is where the Android app is seen running
 * subagents, and the only visual check the Android client gets before a
 * real 1.7 board (spec 8.5). So it has to reach every state a card with
 * subagents can be in, each one exactly as the server would report it.
 */
class DemoDataTest {

    @Test
    fun `the workflow session reaches every state a card with subagents has`() {
        val seen = HashSet<String>()
        replay { _, review -> seen += readings(review) }

        assertEquals(
            setOf("turn running", "blocked", "working", "failed row", "count only", "reading results", "done"),
            seen,
        )
    }

    @Test
    fun `every reading of the workflow session is the one the server would send`() {
        replay { _, review -> assertReportedAsTheServerWould(review) }
    }

    @Test
    fun `a row's words change only with its state, and the done count only climbs within a turn`() {
        replay { before, after ->
            val earlier = before.subtasks?.items.orEmpty().associateBy { it.id }
            for (row in after.subtasks?.items.orEmpty()) {
                val was = earlier[row.id] ?: continue
                // The 1.7 hook posts a change of state, never an activity alone.
                if (was.state == row.state) assertEquals(was, row)
            }
            val done = before.subtasks?.done
            if (done != null && after.subtasks != null) assertTrue("$done then ${after.subtasks?.done}", after.subtasks!!.done >= done)
        }
    }

    @Test
    fun `the demo board shares projects, both agents in one, and No project last`() {
        val sections = ProjectSections.of(SessionStore.sortedByUpdate(DemoData.initialSessions()))

        assertEquals(listOf("acme-api", "claude-status", "docs", "etl-jobs", "No project"), sections.map { it.title })
        assertTrue("a shared project", sections.any { it.sessions.size >= 2 })
        assertTrue(
            "Claude and Codex in one section",
            sections.any { section -> section.sessions.map { it.source }.toSet() == setOf("claude", "codex") },
        )
    }

    @Test
    fun `the demo board has a moved card and two blocked for the bar to walk`() {
        val sessions = DemoData.initialSessions()
        val sections = ProjectSections.of(SessionStore.sortedByUpdate(sessions))

        assertEquals(listOf("demo-webapp"), sessions.filter { ProjectSections.place(it) != null }.map { it.id })
        assertEquals(2, sessions.count { it.isBlocked })
        val first = ProjectSections.barTarget(sections, shown = null)
        assertEquals("demo-login", first?.id)
        assertEquals("demo-data-pipeline", ProjectSections.barTarget(sections, shown = first?.id)?.id)
    }

    /** Ticks the demo from its first board, handing [check] the workflow session before and after each tick. */
    private fun replay(check: (before: Session, after: Session) -> Unit) {
        val random = Random(17)
        var sessions = DemoData.initialSessions()
        repeat(TICKS) {
            val before = sessions.first { it.id == REVIEW }
            sessions = DemoData.tick(sessions, random)
            check(before, sessions.first { it.id == REVIEW })
        }
    }

    private fun readings(session: Session): Set<String> {
        val subtasks = session.subtasks ?: return setOf("done")
        return setOfNotNull(
            "turn running".takeIf { session.message == REVIEW_MESSAGE },
            "blocked".takeIf { session.status == AgentStatus.BLOCKED },
            "working".takeIf { session.displayStatus == DisplayStatus.WORKING },
            "failed row".takeIf { subtasks.items.any { it.state == SubtaskState.FAILED } },
            "count only".takeIf { subtasks.items.isEmpty() && subtasks.done > 0 },
            "reading results".takeIf { session.message == READING_RESULTS },
        )
    }

    /** The server's derivation (spec 4.5), stated again on its own, against what the demo reports. */
    private fun assertReportedAsTheServerWould(session: Session) {
        val subtasks = session.subtasks
        if (subtasks == null) {
            assertEquals(AgentStatus.DONE, session.status)
            assertEquals("Turn finished", session.message)
            return
        }
        val items = subtasks.items
        val live = items.filter { it.state != SubtaskState.FAILED }
        val blocked = live.filter { it.state == SubtaskState.BLOCKED }
        val working = live.filter { it.state.isWorking }

        assertEquals(working.size, subtasks.running)
        assertEquals(blocked.size, subtasks.blocked)
        assertEquals(items.count { it.state == SubtaskState.FAILED }, subtasks.failed)
        assertTrue("shown with nothing to show", items.isNotEmpty() || subtasks.done > 0)
        assertEquals("start order", items.sortedBy { it.n }, items)
        assertEquals("ordinals", items.size, items.map { it.n }.toSet().size)
        assertTrue("ids", items.all { Subtask.ID_REGEX.matches(it.id) })
        if (subtasks.turnEnded) assertTrue("turnEnded with nothing live", live.isNotEmpty())

        when {
            blocked.isNotEmpty() -> {
                assertEquals(AgentStatus.BLOCKED, session.status)
                val more = if (blocked.size > 1) " +${blocked.size - 1}" else ""
                assertEquals("Needs approval: ${blocked.first().label}$more", session.message)
            }
            subtasks.turnEnded -> {
                val busiest = listOf(SubtaskState.TESTING, SubtaskState.CODING, SubtaskState.PLANNING)
                    .first { state -> working.any { it.state == state } }
                assertEquals(busiest.wire, session.status.wire)
                val noun = if (working.size == 1) "subagent" else "subagents"
                assertEquals("${working.size} $noun still running", session.message)
            }
            session.message == READING_RESULTS -> {
                assertEquals(AgentStatus.PLANNING, session.status)
                assertTrue("reading results with a subagent still live", live.isEmpty())
            }
            else -> {
                assertEquals(AgentStatus.PLANNING, session.status)
                assertEquals(REVIEW_MESSAGE, session.message)
            }
        }
        assertEquals(
            "WORKING",
            subtasks.turnEnded && blocked.isEmpty() && working.isNotEmpty(),
            session.displayStatus == DisplayStatus.WORKING,
        )
    }

    private companion object {
        const val REVIEW = "demo-review"
        const val REVIEW_MESSAGE = "Running the review-and-verify workflow"
        const val READING_RESULTS = "Reading subagent results"

        /** About four hours of demo at a tick every four seconds: some sixty turns of the workflow. */
        const val TICKS = 4_000
    }
}
