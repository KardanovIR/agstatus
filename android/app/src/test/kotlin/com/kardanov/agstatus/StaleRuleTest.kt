package com.kardanov.agstatus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stale rule the card and its history share: a working session (planning,
 * coding, testing) that has heard nothing for more than ten minutes. The web
 * (STALE_MS in public/app.js) and iOS (SessionCardView.staleAfter) keep the
 * same line, and the same strict comparison.
 */
class StaleRuleTest {

    private val now = 1_700_000_000_000L
    private val tenMinutes = 10 * 60 * 1000L

    private fun session(status: AgentStatus, silentForMillis: Long) =
        Session(id = "s1", status = status, updatedAt = now - silentForMillis)

    @Test
    fun `the line is ten minutes, and a card on it is not yet stale`() {
        assertFalse(session(AgentStatus.CODING, tenMinutes).isStale(now))
        assertTrue(session(AgentStatus.CODING, tenMinutes + 1).isStale(now))
    }

    @Test
    fun `every working state goes stale`() {
        for (status in listOf(AgentStatus.PLANNING, AgentStatus.CODING, AgentStatus.TESTING)) {
            assertTrue(status.name, session(status, 14 * 60_000L).isStale(now))
        }
    }

    @Test
    fun `a state that waits on a person never does, however old`() {
        for (status in listOf(AgentStatus.IDLE, AgentStatus.BLOCKED, AgentStatus.DONE)) {
            assertFalse(status.name, session(status, 3 * 86_400_000L).isStale(now))
        }
    }

    @Test
    fun `a report from a clock ahead of this one is fresh`() {
        assertFalse(session(AgentStatus.CODING, -5 * 60_000L).isStale(now))
    }
}
