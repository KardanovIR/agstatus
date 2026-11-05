package com.kardanov.agstatus

import org.junit.Assert.assertEquals
import org.junit.Test

class TimeFormatTest {

    private val now = 1_700_000_000_000L

    private fun agoSeconds(seconds: Long): String =
        TimeFormat.relative(now - seconds * 1000, now)

    @Test
    fun `same instant reads as just now`() {
        assertEquals("just now", TimeFormat.relative(now, now))
    }

    @Test
    fun `future timestamps clamp to just now`() {
        assertEquals("just now", TimeFormat.relative(now + 90_000, now))
    }

    @Test
    fun `sub-minute stays just now up to 45 seconds`() {
        assertEquals("just now", agoSeconds(44))
    }

    @Test
    fun `45 seconds rounds up to one minute`() {
        assertEquals("1m ago", agoSeconds(45))
        assertEquals("1m ago", agoSeconds(59))
    }

    @Test
    fun `minutes floor within the hour`() {
        assertEquals("1m ago", agoSeconds(60))
        assertEquals("5m ago", agoSeconds(5 * 60))
        assertEquals("59m ago", agoSeconds(3599))
    }

    @Test
    fun `hours start at exactly one hour`() {
        assertEquals("1h ago", agoSeconds(3600))
        assertEquals("3h ago", agoSeconds(3 * 3600 + 59 * 60))
        assertEquals("23h ago", agoSeconds(86_399))
    }

    @Test
    fun `days start at exactly one day`() {
        assertEquals("1d ago", agoSeconds(86_400))
        assertEquals("2d ago", agoSeconds(2 * 86_400 + 3600))
        assertEquals("30d ago", agoSeconds(30 * 86_400))
    }

    @Test
    fun `sub-second remainders truncate rather than round`() {
        assertEquals("just now", TimeFormat.relative(now - 44_999, now))
        assertEquals("1m ago", TimeFormat.relative(now - 45_001, now))
    }

    // A stale card's "no update for 14m": relative's span without "ago", on
    // the same steps, so the words and the "14m ago" they fall back to agree.
    @Test
    fun `age is the relative span without ago`() {
        val ago = { seconds: Long -> TimeFormat.age(now - seconds * 1000, now) }
        assertEquals("10m", ago(10 * 60))
        assertEquals("14m", ago(14 * 60 + 59))
        assertEquals("59m", ago(3599))
        assertEquals("1h", ago(3600))
        assertEquals("23h", ago(86_399))
        assertEquals("1d", ago(86_400))
        for (seconds in listOf(10L * 60, 14L * 60, 3600L, 2L * 86_400)) {
            assertEquals("${ago(seconds)} ago", agoSeconds(seconds))
        }
    }

    @Test
    fun `spoken age spells its units out, one without an s`() {
        val said = { seconds: Long -> TimeFormat.spokenAge(now - seconds * 1000, now) }
        assertEquals("1 minute", said(30))
        assertEquals("14 minutes", said(14 * 60))
        assertEquals("1 hour", said(3600))
        assertEquals("2 hours", said(2 * 3600 + 59 * 60))
        assertEquals("1 day", said(86_400))
        assertEquals("3 days", said(3 * 86_400))
    }
}
