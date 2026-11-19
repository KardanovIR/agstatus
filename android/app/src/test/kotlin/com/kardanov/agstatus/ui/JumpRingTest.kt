package com.kardanov.agstatus.ui

import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.Modifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The ring a card the bar brought wears is a modifier that compares equal
 * over the same fade. Each pass of the board hands every card a new
 * modifier chain, and a card skips only when that chain equals the last
 * one: a ring that was never equal ran every card on screen again on each
 * hook event, where only the changed card should run.
 */
class JumpRingTest {

    @Test
    fun `two rings over one fade are the same modifier`() {
        val fade = mutableFloatStateOf(0f)

        assertEquals(Modifier.jumpRing(fade), Modifier.jumpRing(fade))
        assertEquals(Modifier.jumpRing(fade).hashCode(), Modifier.jumpRing(fade).hashCode())
        // Followed by the rest of a card's chain, as the board builds it.
        assertEquals(
            Modifier.jumpRing(fade).then(Modifier.jumpRing(fade)),
            Modifier.jumpRing(fade).then(Modifier.jumpRing(fade)),
        )
    }

    @Test
    fun `rings over two fades are two modifiers`() {
        assertNotEquals(Modifier.jumpRing(mutableFloatStateOf(0f)), Modifier.jumpRing(mutableFloatStateOf(0f)))
    }
}
