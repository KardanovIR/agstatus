package com.kardanov.agstatus.ui

import android.content.Intent
import androidx.compose.material3.Typography
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.createFontFamilyResolver
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.MainActivity
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.SessionStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * A card's state glyph grows with the reader's text, as the needs-you bar's
 * mark and the meta line's do: 14dp at the default size, and at 200% the size
 * 14sp is there, not half the height of its word. The real app, on a phone
 * held sideways, where a card's state sits beside its name.
 *
 * The glyph has no node of its own (the state is one node, "Coding"), so its
 * width is the state's less the gap and the word, measured in the same type.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w915dp-h411dp-land-xxhdpi")
class StatusGlyphTest {

    @get:Rule
    val rule = createEmptyComposeRule()

    @After
    fun reset() = RuntimeEnvironment.setFontScale(1f)

    private fun glyphWidthPx(fontScale: Float): Pair<Float, Float> {
        RuntimeEnvironment.setFontScale(fontScale)
        val scenario = ActivityScenario.launch<MainActivity>(
            Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
                .putExtra("agstatus_demo", true)
                .putExtra("agstatus_demo_freeze", true),
        )
        scenario.use {
            val card = Session(
                id = "c1",
                name = "Tune the cache",
                status = AgentStatus.CODING,
                message = "Profiling the hot path",
                project = "zeta",
                homeProject = "zeta",
                createdAt = System.currentTimeMillis(),
                updatedAt = System.currentTimeMillis(),
            )
            it.onActivity { activity -> ViewModelProvider(activity)[SessionStore::class.java].showForTest(listOf(card)) }
            rule.waitForIdle()

            val state = rule.onNode(
                SemanticsMatcher("the card's state") {
                    it.config.getOrNull(SemanticsProperties.ContentDescription) == listOf("Coding")
                },
                useUnmergedTree = true,
            ).fetchSemanticsNode()
            val density = rule.density
            // The word as StatusMark sets it, over the theme's body style.
            val word = TextMeasurer(
                defaultFontFamilyResolver = createFontFamilyResolver(ApplicationProvider.getApplicationContext()),
                defaultDensity = density,
                defaultLayoutDirection = LayoutDirection.Ltr,
            ).measure(
                "CODING",
                Typography().bodyLarge.merge(TextStyle(fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp)),
            ).size.width
            val glyph = state.size.width - word - with(density) { 4.dp.toPx() }
            return glyph to with(density) { 14.sp.toPx() }
        }
    }

    @Test
    fun `at the default text size the glyph is 14dp`() {
        val (glyph, expected) = glyphWidthPx(1f)
        assertEquals(with(rule.density) { 14.dp.toPx() }, expected, 0.5f)
        assertEquals(expected, glyph, 1.5f)
    }

    @Test
    fun `at twice the text size the glyph grows with it`() {
        val (glyph, expected) = glyphWidthPx(2f)
        assertEquals(expected, glyph, 1.5f)
    }
}
