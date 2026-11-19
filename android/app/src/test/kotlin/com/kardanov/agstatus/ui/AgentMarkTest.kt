package com.kardanov.agstatus.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * An agent's mark goes by how its source starts, as on every board: an
 * asterisk for any Claude, a hexagon for any Codex, a diamond for the rest.
 * A second Claude account tagged claude-work keeps Claude's mark.
 */
class AgentMarkTest {

    @Test
    fun `a source that starts with claude has the asterisk`() {
        assertEquals("Claude", agentMark("claude").name)
        assertEquals("Claude", agentMark("claude-work").name)
        assertEquals("Claude", agentMark("claude-code").name)
    }

    @Test
    fun `a source that starts with codex has the hexagon`() {
        assertEquals("Codex", agentMark("codex").name)
        assertEquals("Codex", agentMark("codex-cli").name)
    }

    @Test
    fun `any other source has the diamond`() {
        assertEquals("Agent", agentMark("gemini").name)
        assertEquals("Agent", agentMark("opencode").name)
        assertEquals("Agent", agentMark("my-claude").name)
    }
}
