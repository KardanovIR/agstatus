package com.kardanov.agstatus

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The card the needs-you bar holds between presses (SessionStore.brought):
 * none until the first press, and none again once the bar leaves, which is
 * when nothing is blocked, whatever screen is showing then. The store sees
 * every frame while History, Settings or Usage is on top; the board, a
 * NavHost destination, does not.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BarHoldTest {

    private fun session(id: String, name: String, home: String, status: AgentStatus) =
        Session(id = id, name = name, project = home, homeProject = home, status = status)

    private val a = session("a", "Ay", "billing", AgentStatus.BLOCKED)
    private val b = session("b", "Bee", "zeta", AgentStatus.BLOCKED)
    private val c = session("c", "Cee", "acme-api", AgentStatus.BLOCKED)
    private val d = session("d", "Dee", "zeta", AgentStatus.BLOCKED)

    private fun SessionStore.reading(): Pair<String?, Boolean> {
        val sections = ProjectSections.of(sessions.value)
        return ProjectSections.barTarget(sections, brought.value)?.id to ProjectSections.barWalks(sections, brought.value)
    }

    @Test
    fun `the bar holds the card it brought while anything is blocked`() {
        val store = SessionStore(ApplicationProvider.getApplicationContext())
        store.showForTest(listOf(a, b))
        assertNull(store.brought.value)

        store.bring("a")
        assertEquals("b" to true, store.reading())
        // One approved: the other still needs you, and the walk goes on.
        store.showForTest(listOf(a.copy(status = AgentStatus.CODING), b), live = true)
        assertEquals("a", store.brought.value)
    }

    @Test
    fun `the bar lets go of it once nothing is blocked, so the next block starts over with Show`() {
        val store = SessionStore(ApplicationProvider.getApplicationContext())
        store.showForTest(listOf(a, b))
        store.bring("a")

        // Both approved on the Mac while History is on top, then C and D block.
        store.showForTest(listOf(a.copy(status = AgentStatus.CODING), b.copy(status = AgentStatus.CODING)), live = true)
        assertNull(store.brought.value)
        store.showForTest(
            listOf(c, a.copy(status = AgentStatus.CODING), b.copy(status = AgentStatus.CODING), d),
            live = true,
        )

        // Back on the board: C, the first blocked card in reading order, and
        // Show, as on iOS and the web. Holding on to A gave "Dee, Next".
        assertEquals("c" to false, store.reading())
    }
}
