package com.kardanov.agstatus

import android.content.Intent
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A card swiped away comes back whole when its session posts again: the
 * server files it under its home as a new card, and the board draws it as a
 * card, not as the red Dismiss slab with the card off the screen. The real
 * app, in its frozen demo, on a phone-sized screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class SwipeReturnTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var store: SessionStore

    @Before
    fun launch() {
        scenario = ActivityScenario.launch(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.onActivity { store = ViewModelProvider(it)[SessionStore::class.java] }
        rule.waitForIdle()
    }

    @After
    fun close() = scenario.close()

    private fun card() = rule.onNode(hasContentDescription(LEAD, substring = true))

    private fun swipeAway(): Session {
        val gone = store.sessions.value.single { it.id == ID }
        card().performTouchInput { swipeLeft() }
        return gone
    }

    /** The session posts again: a new card on top of the board, as the server makes it. */
    private fun postAgain(gone: Session) {
        val back = gone.copy(createdAt = gone.createdAt + 60_000, updatedAt = gone.updatedAt + 60_000, message = "Back at work")
        store.showForTest(listOf(back) + store.sessions.value, live = true)
    }

    /** Where every card stands: 16dp in from the screen's edge. Swiped away, it is a screen to the left. */
    private fun assertWhole() {
        val left = card().fetchSemanticsNode().positionInRoot.x
        assertEquals(with(rule.density) { 16.dp.toPx() }, left, 1f)
    }

    @Test
    fun `a card swiped away comes back whole when its session posts again`() {
        val gone = swipeAway()
        rule.waitForIdle()
        assertTrue(store.sessions.value.none { it.id == ID })

        postAgain(gone)
        rule.waitForIdle()

        assertWhole()
    }

    @Test
    fun `it comes back whole even while it is still fading out`() {
        rule.mainClock.autoAdvance = false
        val gone = swipeAway()
        // Until the swipe settles and the card leaves the board, then a few
        // frames into its fade.
        var frames = 0
        while (store.sessions.value.any { it.id == ID } && frames < 200) {
            rule.mainClock.advanceTimeByFrame()
            frames++
        }
        assertTrue(store.sessions.value.none { it.id == ID })
        repeat(3) { rule.mainClock.advanceTimeByFrame() }

        postAgain(gone)
        repeat(3) { rule.mainClock.advanceTimeByFrame() }

        assertWhole()
    }

    private companion object {
        /** DemoData's api-server, in acme-api near the top of the board. */
        const val ID = "demo-api-server"
        const val LEAD = "Claude, api-server"
    }
}
