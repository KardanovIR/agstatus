package com.kardanov.agstatus

import android.content.Intent
import android.os.Looper
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * The spoken alarm (S1): a block that lands while the app is in front is
 * said on whichever screen shows, and nothing is said while the app is not
 * in front. The real app, in its demo: one session blocks a few seconds in
 * (MainActivity's agstatus_demo_block), as a session frame would block it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SpokenAlarmTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    private fun launchDemo(): ActivityScenario<MainActivity> = ActivityScenario.launch(
        Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra("agstatus_demo", true)
            .putExtra("agstatus_demo_freeze", true)
            .putExtra("agstatus_demo_block", BLOCKED)
            .putExtra("agstatus_demo_block_after", BLOCK_AFTER_SECONDS),
    )

    /** What every polite live region on screen holds now. */
    private fun said(): List<String> = rule
        .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite), useUnmergedTree = true)
        .fetchSemanticsNodes()
        .flatMap { it.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() } }

    /** Runs the store's clock past the block and its half-second gathering. */
    private fun letTheBlockLand() {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BLOCK_AFTER_SECONDS * 1_000L + 600))
        rule.waitForIdle()
    }

    @Test
    fun `a block that lands while Settings is open is said`() {
        launchDemo().use {
            rule.onNodeWithContentDescription("Settings").performClick()
            rule.waitForIdle()
            // The board has left: its cards are not composed.
            assertTrue(rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)).fetchSemanticsNodes().none {
                it.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }.any { words -> "session" in words }
            })

            letTheBlockLand()

            assertEquals(listOf(SENTENCE), said())
        }
    }

    @Test
    fun `a block that lands on the board is said there too`() {
        launchDemo().use {
            rule.waitForIdle()
            letTheBlockLand()

            assertEquals(listOf(SENTENCE), said())
        }
    }

    @Test
    fun `nothing is said while the app is not in front, nor once it is again`() {
        launchDemo().use { scenario ->
            rule.waitForIdle()
            // Paused: another app has the front, or the shade is down. The
            // test cannot read the screen while it is, so it reads it the
            // moment the app is back, well inside the five seconds a
            // sentence is held for.
            scenario.moveToState(Lifecycle.State.STARTED)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(BLOCK_AFTER_SECONDS * 1_000L + 600))

            scenario.moveToState(Lifecycle.State.RESUMED)
            rule.waitForIdle()
            assertEquals(emptyList<String>(), said())
            // The block itself landed: the bar counts it, without a word said.
            val bars = rule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.ContentDescription))
                .fetchSemanticsNodes()
                .flatMap { it.config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() } }
                .filter { it.startsWith("3 blocked: ") }
            assertEquals(1, bars.size)
        }
    }

    private companion object {
        const val BLOCKED = "demo-webapp"
        const val BLOCK_AFTER_SECONDS = 5

        /** DemoData's demo-webapp, filed under acme-api though it ran `cd web`. */
        const val SENTENCE = "Add rate limiting to /login, in acme-api, needs you"
    }
}
