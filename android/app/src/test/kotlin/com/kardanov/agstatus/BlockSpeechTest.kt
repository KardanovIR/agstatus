package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The spoken alarm (BlockSpeech): which new blocks the board says aloud, and
 * in what words. Only a block that lands while the board watches, never one
 * a first draw or a snapshot shows; each session at most once a minute;
 * blocks within half a second in one sentence.
 */
class BlockSpeechTest {

    private fun session(
        id: String,
        status: AgentStatus = AgentStatus.CODING,
        name: String = id,
        homeProject: String = "acme-api",
        source: String = "claude",
    ) = Session(id = id, name = name, status = status, project = homeProject, homeProject = homeProject, source = source)

    private val quiet = listOf(session("login", name = "Fix the login redirect"), session("etl", homeProject = "etl-jobs"))

    private fun blocked(board: List<Session>, vararg ids: String) =
        board.map { if (it.id in ids) it.copy(status = AgentStatus.BLOCKED) else it }

    /** A speech that has seen [board] drawn. */
    private fun watching(board: List<Session> = quiet, at: Long = 0) =
        BlockSpeech().also { it.observe(board, live = false, nowMillis = at) }

    @Test
    fun `a session that becomes blocked is said, with its project`() {
        val speech = watching()
        val now = blocked(quiet, "login")

        assertTrue(speech.observe(now, live = true, nowMillis = 1_000))
        assertEquals("Fix the login redirect, in acme-api, needs you", speech.say(now, nowMillis = 1_500))
    }

    @Test
    fun `a session that arrives blocked is said`() {
        val speech = watching()
        val now = listOf(session("new", status = AgentStatus.BLOCKED, name = "Rotate the certificates")) + quiet

        assertTrue(speech.observe(now, live = true, nowMillis = 1_000))
        assertEquals("Rotate the certificates, in acme-api, needs you", speech.say(now, nowMillis = 1_500))
    }

    @Test
    fun `the first draw says nothing, even of blocks`() {
        val speech = BlockSpeech()

        assertFalse(speech.observe(blocked(quiet, "login"), live = true, nowMillis = 0))
        assertNull(speech.say(blocked(quiet, "login"), nowMillis = 500))
    }

    @Test
    fun `a snapshot, a reconnect's or a refresh's, says nothing of the blocks it brings`() {
        val speech = watching()
        val snapshot = blocked(quiet, "login", "etl")

        assertFalse(speech.observe(snapshot, live = false, nowMillis = 1_000))
        assertNull(speech.say(snapshot, nowMillis = 1_500))
        // And what it showed is not news on the next frame either.
        assertFalse(speech.observe(snapshot.map { it.copy(message = "still waiting") }, live = true, nowMillis = 2_000))
    }

    @Test
    fun `a card that stays blocked is said once, whatever else changes`() {
        val speech = watching()
        val now = blocked(quiet, "login")
        speech.observe(now, live = true, nowMillis = 1_000)
        speech.say(now, nowMillis = 1_500)

        assertFalse(speech.observe(now.map { it.copy(message = "Approve: git push") }, live = true, nowMillis = 2_000))
    }

    @Test
    fun `blocks that land within half a second are said together`() {
        val speech = watching()
        val one = blocked(quiet, "login")
        val two = blocked(quiet, "login", "etl")

        assertTrue(speech.observe(one, live = true, nowMillis = 1_000))
        // The gathering is open: the second joins it rather than starting one.
        assertFalse(speech.observe(two, live = true, nowMillis = 1_300))
        assertEquals("2 sessions need you", speech.say(two, nowMillis = 1_500))
    }

    @Test
    fun `a block answered within the half second is not news`() {
        val speech = watching()

        assertTrue(speech.observe(blocked(quiet, "login"), live = true, nowMillis = 1_000))
        speech.observe(quiet, live = true, nowMillis = 1_200)
        assertNull(speech.say(quiet, nowMillis = 1_500))
    }

    @Test
    fun `of two gathered, the one still standing is said alone`() {
        val speech = watching()
        speech.observe(blocked(quiet, "login"), live = true, nowMillis = 1_000)
        speech.observe(blocked(quiet, "login", "etl"), live = true, nowMillis = 1_100)
        val now = blocked(quiet, "etl")
        speech.observe(now, live = true, nowMillis = 1_200)

        assertEquals("etl, in etl-jobs, needs you", speech.say(now, nowMillis = 1_500))
    }

    @Test
    fun `a session is said at most once a minute`() {
        val speech = watching()
        val on = blocked(quiet, "login")
        speech.observe(on, live = true, nowMillis = 0)
        assertEquals("Fix the login redirect, in acme-api, needs you", speech.say(on, nowMillis = 500))

        // Answered, then blocked again within the minute: not said.
        speech.observe(quiet, live = true, nowMillis = 10_000)
        assertFalse(speech.observe(on, live = true, nowMillis = 30_000))
        assertNull(speech.say(on, nowMillis = 30_500))

        // A minute after it was said, it is news again.
        speech.observe(quiet, live = true, nowMillis = 40_000)
        assertTrue(speech.observe(on, live = true, nowMillis = 60_500))
        assertEquals("Fix the login redirect, in acme-api, needs you", speech.say(on, nowMillis = 61_000))
    }

    @Test
    fun `another session's block is said within the first's minute`() {
        val speech = watching()
        speech.observe(blocked(quiet, "login"), live = true, nowMillis = 0)
        speech.say(blocked(quiet, "login"), nowMillis = 500)
        val both = blocked(quiet, "login", "etl")

        assertTrue(speech.observe(both, live = true, nowMillis = 5_000))
        assertEquals("etl, in etl-jobs, needs you", speech.say(both, nowMillis = 5_500))
    }

    @Test
    fun `a card that finishes is not a block`() {
        val speech = watching()
        val done = quiet.map { it.copy(status = AgentStatus.DONE) }

        assertFalse(speech.observe(done, live = true, nowMillis = 1_000))
    }

    @Test
    fun `the words are the bar's`() {
        // In No project, its agent instead of a folder.
        assertEquals(
            "Reading the brief, Codex, needs you",
            BlockSpeech.sentence(listOf(session("a", name = "Reading the brief", homeProject = "", source = "codex"))),
        )
        // No place where it would only repeat the name, and then a plain
        // sentence with no comma at all, as iOS says it.
        assertEquals(
            "Codex needs you",
            BlockSpeech.sentence(listOf(session("a", name = "", homeProject = "", source = "codex"))),
        )
        assertEquals("acme-api needs you", BlockSpeech.sentence(listOf(session("a", name = "acme-api"))))
        assertEquals("3 sessions need you", BlockSpeech.sentence(listOf(session("a"), session("b"), session("c"))))
        assertNull(BlockSpeech.sentence(emptyList()))
    }
}
