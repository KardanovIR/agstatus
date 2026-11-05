package com.kardanov.agstatus

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.abs

/**
 * The arithmetic behind the usage detail screen. It has to match the web
 * dashboard's exactly — the two render the same numbers from the same payload,
 * so a drift here is a drift users would notice between their phone and their
 * browser.
 */
class UsageDetailTest {

    /** 2026-09-08T12:00:00Z. */
    private val noon = 1788868800000L

    // MARK: - dayRange

    @Test
    fun dayRangeEndsTodayAndRunsOldestFirst() {
        val days = UsageDetail.dayRange(30, noon)

        assertEquals(30, days.size)
        assertEquals("2026-08-10", days.first())
        assertEquals("2026-09-08", days.last())
        assertEquals(days.sorted(), days)
    }

    @Test
    fun dayRangeUsesUtcDaysNotLocalOnes() {
        // 23:30 UTC is already the 9th in Sydney and still the 8th in London;
        // both phones must draw the same grid, so the day is the UTC one.
        val lateEvening = 1788910200000L // 2026-09-08T23:30:00Z
        assertEquals("2026-09-08", UsageDetail.dayRange(1, lateEvening).single())
    }

    @Test
    fun dayRangeOfNothingIsEmpty() {
        assertTrue(UsageDetail.dayRange(0, noon).isEmpty())
        assertTrue(UsageDetail.dayRange(-5, noon).isEmpty())
    }

    // MARK: - sampleSeries

    @Test
    fun sampleSeriesStepsAndLeavesDaysBeforeTheSeriesNull() {
        val days = UsageDetail.dayRange(4, noon) // 09-05 .. 09-08
        val points = listOf(
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-06") + 3_600_000L, usedPct = 12.0),
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-06") + 7_200_000L, usedPct = 25.0),
            UsagePoint(at = UsageDetail.dayStartMillis("2026-09-08") + 3_600_000L, usedPct = 61.0),
        )

        val sampled = UsageDetail.sampleSeries(points, days)

        // Nothing recorded yet on the 5th; the 7th holds the 6th's last reading.
        assertEquals(listOf(null, 25.0, 25.0, 61.0), sampled)
    }

    @Test
    fun sampleSeriesReadsTheVeryLastSecondOfADay() {
        val days = listOf("2026-09-08")
        val atMidnightMinusOne = UsageDetail.dayEndMillis("2026-09-08")

        val sampled = UsageDetail.sampleSeries(
            listOf(UsagePoint(at = atMidnightMinusOne, usedPct = 99.0)),
            days,
        )

        assertEquals(listOf(99.0), sampled)
    }

    @Test
    fun aBrandNewBoardsSinglePointStillSamples() {
        val days = UsageDetail.dayRange(30, noon)
        val points = listOf(UsagePoint(at = noon, usedPct = 7.0))

        val sampled = UsageDetail.sampleSeries(points, days)

        assertEquals(1, sampled.count { it != null })
        assertNotNull(sampled.last())
        assertNull(sampled[28])
    }

    // MARK: - Tokens

    @Test
    fun tokensPerDayBucketsOneSourceOntoTheGrid() {
        val days = UsageDetail.dayRange(3, noon) // 09-06, 09-07, 09-08
        val rows = listOf(
            ProjectDay("claude", "api", "2026-09-06", 10),
            ProjectDay("claude", "web", "2026-09-06", 5),
            ProjectDay("codex", "docs", "2026-09-06", 1000),
            ProjectDay("claude", "api", "2026-09-08", 7),
            ProjectDay("claude", "api", "2026-07-01", 999), // outside the grid
        )

        assertEquals(listOf(15L, 0L, 7L), UsageDetail.tokensPerDay(rows, "claude", days))
        assertEquals(listOf(1000L, 0L, 0L), UsageDetail.tokensPerDay(rows, "codex", days))
        assertEquals(listOf(0L, 0L, 0L), UsageDetail.tokensPerDay(rows, "gemini", days))
    }

    @Test
    fun projectTotalsSumTheRangeLargestFirst() {
        val rows = listOf(
            ProjectDay("claude", "api", "2026-09-06", 10),
            ProjectDay("claude", "web", "2026-09-06", 40),
            ProjectDay("claude", "api", "2026-09-07", 60),
            ProjectDay("codex", "docs", "2026-09-07", 900),
        )

        val totals = UsageDetail.projectTotals(rows, "claude")

        assertEquals(listOf("api", "web"), totals.map { it.project })
        assertEquals(listOf(70L, 40L), totals.map { it.tokens })
        assertTrue(UsageDetail.projectTotals(rows, "gemini").isEmpty())
    }

    // MARK: - Formatting

    @Test
    fun fmtTokensClimbsThroughTheSameLadderAsTheWeb() {
        assertEquals("0", UsageDetail.fmtTokens(0))
        assertEquals("870", UsageDetail.fmtTokens(870))
        assertEquals("12K", UsageDetail.fmtTokens(12_000))
        assertEquals("3.4M", UsageDetail.fmtTokens(3_400_000))
        assertEquals("1.2B", UsageDetail.fmtTokens(1_234_000_000))
    }

    @Test
    fun ticksEverySeventhDayAndOnTheLastWhenItWouldNotCollide() {
        val shown = (0..29).filter { UsageDetail.showTick(it, 29) }

        // 29 % 7 == 1, so the last day sits too close to day 28 to earn a tick.
        assertEquals(listOf(0, 7, 14, 21, 28), shown)
        // 31 days: the last day is 3 clear of day 28.
        assertTrue(UsageDetail.showTick(31, 31))
    }

    // MARK: - Wire format

    @Test
    fun usageHistoryDecodesTheServerPayload() {
        val json = """
            {"days":30,
             "history":[{"source":"claude","windowId":"week",
                         "points":[{"at":1788800000000,"usedPct":54}]}],
             "projects":[{"source":"claude","project":"jobsearch",
                          "day":"2026-09-07","tokens":87600000}]}
        """.trimIndent()

        val history = AgStatusJson.decodeFromString<UsageHistory>(json)

        assertEquals(30, history.days)
        assertEquals("week", history.history.single().windowId)
        assertEquals(1788800000000L, history.history.single().points.single().at)
        assertEquals(54.0, history.history.single().points.single().usedPct, 0.0001)
        assertEquals(87_600_000L, history.projects.single().tokens)
        assertEquals("2026-09-07", history.projects.single().day)
    }

    @Test
    fun usageHistoryToleratesAnEmptyOrPartialAnswer() {
        val empty = AgStatusJson.decodeFromString<UsageHistory>("""{"days":7}""")

        assertEquals(7, empty.days)
        assertTrue(empty.history.isEmpty())
        assertTrue(empty.projects.isEmpty())

        val partial = AgStatusJson.decodeFromString<UsageHistory>(
            """{"days":30,"history":[{"source":"codex"}],"projects":[{"source":"codex"}]}"""
        )

        assertTrue(partial.history.single().points.isEmpty())
        assertEquals(0L, partial.projects.single().tokens)
    }

    // MARK: - Demo mode

    @Test
    fun demoHistoryCoversBothAgentsWithAscendingPoints() {
        val demo = DemoData.usageHistory(UsageDetail.DEFAULT_DAYS, noon)
        val days = UsageDetail.dayRange(demo.days, noon)

        assertEquals(setOf("claude", "codex"), demo.history.map { it.source }.toSet())
        assertEquals(setOf("claude", "codex"), demo.projects.map { it.source }.toSet())

        for (series in demo.history) {
            assertTrue(series.points.isNotEmpty())
            assertEquals(series.points.sortedBy { it.at }, series.points)
            assertTrue(series.points.all { it.usedPct in 0.0..100.0 })
            // Every series must land on today, or the chart's last day is blank.
            assertNotNull(UsageDetail.sampleSeries(series.points, days).last())
        }
        for (row in demo.projects) {
            assertTrue(row.day in days)
            assertTrue(row.tokens > 0L)
        }
        assertTrue(UsageDetail.tokensPerDay(demo.projects, "claude", days).sum() > 0L)
        assertTrue(UsageDetail.projectTotals(demo.projects, "codex").isNotEmpty())
    }

    @Test
    fun demoHistoryIsDeterministic() {
        assertEquals(DemoData.usageHistory(30, noon), DemoData.usageHistory(30, noon))
    }

    @Test
    fun demoFirstDayGivesEachWindowOneReadingAndCodexItsSix() {
        // The switches behind the first-day captures: every window starts
        // today, and Codex reports all six windows a report may carry.
        try {
            DemoData.limitWindows = 6
            DemoData.firstDayWindows = setOf("all")
            val demo = DemoData.usageHistory(UsageDetail.DEFAULT_DAYS, noon)
            val days = UsageDetail.dayRange(demo.days, noon)

            assertEquals(6, demo.history.count { it.source == "codex" })
            for (series in demo.history) {
                val sampled = UsageDetail.sampleSeries(series.points, days)
                assertTrue(series.windowId, UsageDetail.isSingleReading(sampled))
                assertNotNull(sampled.last())
            }
        } finally {
            DemoData.limitWindows = 0
            DemoData.firstDayWindows = emptySet()
        }
    }

    // MARK: - Lines, patterns and marks

    @Test
    fun limitLinesTakeTheOtherClientsColoursInTheirOrder() {
        // done, coding, planning, testing, idle, blocked, as iOS's
        // seriesColors and the web's LINE_COLORS. It was done, coding,
        // testing, which drew "week" and "week_fable" as one blue line.
        assertEquals(
            listOf(Theme.done, Theme.coding, Theme.planning, Theme.testing, Theme.idle, Theme.blocked),
            (0 until 6).map { Theme.usageLineColor(it) },
        )
        assertEquals(Theme.done, Theme.usageLineColor(6))
    }

    @Test
    fun eachLineHasAPatternPairedWithItsColour() {
        assertEquals(
            listOf(
                emptyList(),                                 // solid
                listOf(4.25f, 5.25f),                        // dashed
                listOf(0f, 4.5f),                            // dotted
                listOf(4.25f, 4.75f, 0f, 4.75f),             // dash, dot
                listOf(9.25f, 5.25f),                        // long dash
                listOf(4.25f, 4.75f, 0f, 4.75f, 0f, 4.75f),  // dash, dot, dot
            ),
            (0 until 6).map { Theme.usageLineDash(it) },
        )
    }

    @Test
    fun aKeyEndsOnAWholeMark() {
        // The web's keys, 26 wide: solid fills them, three 6dp dashes take 25,
        // six dots 24.25. Never a stub that reads as another pattern.
        assertEquals(
            listOf(26f, 25f, 24.25f),
            (0 until 3).map {
                UsageDetail.keySampleLength(Theme.usageLineDash(it), Theme.USAGE_LINE_WIDTH, 26f)
            },
        )
    }

    @Test
    fun eachWindowHasAMarkPairedWithItsColourAndPattern() {
        assertEquals(
            listOf(
                Theme.UsageMark.CIRCLE, Theme.UsageMark.PLUS, Theme.UsageMark.SQUARE,
                Theme.UsageMark.TRIANGLE, Theme.UsageMark.DIAMOND, Theme.UsageMark.TRIANGLE_DOWN,
            ),
            (0 until 6).map { Theme.usageMark(it) },
        )
    }

    @Test
    fun marksWeighTheSameAndSitOnTheirCentres() {
        for (mark in Theme.UsageMark.entries) {
            val outline = mark.outline
            val area = if (mark == Theme.UsageMark.CIRCLE) {
                PI * Theme.UsageMark.CIRCLE_RADIUS * Theme.UsageMark.CIRCLE_RADIUS
            } else {
                // The shoelace formula over the outline.
                abs(outline.indices.sumOf { i ->
                    val a = outline[i]
                    val b = outline[(i + 1) % outline.size]
                    (a.x * b.y - b.x * a.y).toDouble()
                }) / 2
            }
            // About an 8dp circle each, so no window's mark outweighs another's.
            assertTrue("$mark covers $area dp²", area in 43.0..52.0)
            // The reading is the mark's centre: a triangle's centroid.
            if (outline.isNotEmpty()) {
                assertEquals(0.0, outline.map { it.x.toDouble() }.average(), 1e-4)
                assertEquals(0.0, outline.map { it.y.toDouble() }.average(), 1e-4)
            }
        }
        // In a key a triangle's box is centred instead, beside the name.
        for (mark in listOf(Theme.UsageMark.TRIANGLE, Theme.UsageMark.TRIANGLE_DOWN)) {
            val top = mark.outline.minOf { it.y } + mark.centreBelowMiddle
            val bottom = mark.outline.maxOf { it.y } + mark.centreBelowMiddle
            assertEquals(0f, top + bottom, 1e-4f)
        }
    }

    @Test
    fun aWindowWithOneDaysReadingIsMarkedRatherThanDrawn() {
        assertTrue(UsageDetail.isSingleReading(listOf(null, null, 34.0)))
        assertFalse(UsageDetail.isSingleReading(listOf(null, 20.0, 34.0)))
        assertFalse(UsageDetail.isSingleReading(listOf(null, null)))
    }

    // MARK: - What TalkBack hears

    @Test
    fun tokensSummarySaysTheTotalAndTheBusiestDay() {
        val days = UsageDetail.dayRange(4, noon) // 09-05 .. 09-08
        assertEquals(
            "Claude tokens per day over the last 4 days. 3.5M tokens in total; " +
                "the busiest day, ${UsageDetail.dayLabel("2026-09-06")}, 3.0M.",
            UsageDetail.tokensSummary("Claude", days, listOf(0L, 3_000_000L, 0L, 500_000L)),
        )
        assertEquals(
            "Claude tokens per day over the last 4 days: none reported.",
            UsageDetail.tokensSummary("Claude", days, listOf(0L, 0L, 0L, 0L)),
        )
    }

    @Test
    fun limitsSummaryNamesEachWindowWithItsReadings() {
        // The web's and iOS's words. A window recorded from before the range
        // began has no "since"; one the board no longer reports keeps its id;
        // one with no reading yet is left out.
        val days = UsageDetail.dayRange(4, noon) // 09-05 .. 09-08
        val sampled = listOf(
            listOf(10.0, 58.0, 58.0, 34.0),
            listOf(20.0, 20.0, 20.0, 62.0),
            listOf(null, null, 70.0, 41.0),
            listOf(null, null, null, 33.4),
            listOf(null, null, null, null),
        )
        val labels = mapOf(
            "session" to "Current session",
            "week" to "Weekly (all models)",
            "week_fable" to "Weekly (Fable)",
        )
        assertEquals(
            "Claude plan limit used, by day, over the last 4 days. " +
                "Current session: 34% at the latest reading, 58% on the highest day. " +
                "Weekly (all models): 62% at the latest reading, 62% on the highest day. " +
                "Weekly (Fable), since ${UsageDetail.dayLabel("2026-09-07")}: " +
                "41% at the latest reading, 70% on the highest day. " +
                "week_retired, since ${UsageDetail.dayLabel("2026-09-08")}: " +
                "33% at the latest reading, 33% on the highest day.",
            UsageDetail.limitsSummary(
                "Claude",
                days,
                listOf("session", "week", "week_fable", "week_retired", "week_new"),
                sampled,
                labels,
            ),
        )
        assertNull(
            UsageDetail.limitsSummary("Claude", days, listOf("week"), listOf(listOf(null, null, null, null)), labels),
        )
    }

    @Test
    fun marksGrowAtHalfTheRateOfTheText() {
        assertEquals(1f, UsageDetail.growth(1f), 0f)
        assertEquals(1.5f, UsageDetail.growth(2f), 0f)
        // A smaller text size leaves the plot as it is.
        assertEquals(1f, UsageDetail.growth(0.85f), 0f)
    }
}
