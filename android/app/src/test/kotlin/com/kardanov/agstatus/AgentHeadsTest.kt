package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * H2: which agents get a usage block, and in what order (agentHeads), by
 * iOS's rule (AgentSummary.make). On a board with sessions every agent with
 * sessions has one, with or without plan limits; on an empty board every agent
 * that reports limits does. By source.
 */
class AgentHeadsTest {

    private fun session(id: String, source: String) = Session(id = id, name = id, source = source)

    private fun report(source: String) =
        UsageInfo(source = source, windows = listOf(UsageWindow(id = "five_hour", label = "5-hour", usedPct = 12.0)))

    @Test
    fun `every agent with sessions gets a block, by source, with its limits or none`() {
        val sessions = listOf(
            session("g1", "gemini"),
            session("c1", "claude"),
            session("w1", "claude-work"),
            session("x1", "codex"),
            session("g2", "gemini"),
        )
        val heads = agentHeads(sessions, listOf(report("codex"), report("claude")))

        assertEquals(listOf("claude", "claude-work", "codex", "gemini"), heads.map { it.source })
        assertEquals(listOf(true, false, true, false), heads.map { it.windows.isNotEmpty() })
    }

    @Test
    fun `an agent that reports limits but has no sessions on a board with sessions gets none`() {
        val heads = agentHeads(listOf(session("c1", "claude")), listOf(report("claude"), report("codex")))

        assertEquals(listOf("claude"), heads.map { it.source })
    }

    @Test
    fun `a board with no limits at all has a block for each agent with sessions`() {
        val heads = agentHeads(listOf(session("c1", "claude"), session("g1", "gemini")), emptyList())

        assertEquals(listOf("claude", "gemini"), heads.map { it.source })
        assertTrue(heads.all { it.windows.isEmpty() })
    }

    @Test
    fun `an empty board has a block for every agent that reports limits, and none for one that reports none`() {
        val heads = agentHeads(emptyList(), listOf(report("codex"), UsageInfo(source = "gemini"), report("claude")))

        assertEquals(listOf("claude", "codex"), heads.map { it.source })
        assertEquals(emptyList<UsageInfo>(), agentHeads(emptyList(), emptyList()))
    }

    @Test
    fun `a source's first report wins, as on iOS`() {
        val first = report("claude")
        val second = UsageInfo(source = "claude", windows = listOf(UsageWindow(id = "week", usedPct = 90.0)))

        assertEquals(listOf(first), agentHeads(listOf(session("c1", "claude")), listOf(first, second)))
    }

    @Test
    fun `sources sort by code unit, as Swift sorts them`() {
        // The server takes a-z, 0-9, '_' and '-': '-' before the digits, the
        // digits before '_', '_' before the letters, as a 1.7.0 server orders
        // its usage reports too. A locale's collation, as servers before
        // 1.7.0 sorted them with localeCompare, puts '_' before '-'. The heads
        // are sorted here, so the server's order changes none of this.
        val sources = listOf("claude_x", "claude2", "claude-x", "claudex", "claude")
        val heads = agentHeads(sources.mapIndexed { i, source -> session("s$i", source) }, emptyList())

        assertEquals(listOf("claude", "claude-x", "claude2", "claude_x", "claudex"), heads.map { it.source })
    }
}
