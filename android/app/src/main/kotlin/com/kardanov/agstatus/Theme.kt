package com.kardanov.agstatus

import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.FormatListBulleted
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Science
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import kotlin.math.sqrt

/**
 * The AgStatus design system, third client.
 *
 * The web is the source (public/tokens.css, in OKLCH) and iOS converted it
 * once (ios/AgStatus/Theme.swift), keeping every OKLCH original written beside
 * its concrete value. This is a TRANSCRIPTION of that table, not a second
 * conversion: the three clients must agree to the byte, and re-deriving the
 * maths here would be a third chance to disagree.
 *
 * What this replaces: `#0B0D12` with six unmodified Tailwind defaults on it
 * (blue-500 planning, purple-500 coding, amber-500 testing, red-500 blocked,
 * emerald-500 done). That is the "generic AI dashboard" the project brief
 * names as its first anti-reference, and it is what v1.5.0's own release notes
 * meant by "Android still has the old palette".
 *
 * WHY WARM. Every neutral is tinted toward hue 155 at very low chroma —
 * imperceptible as colour, but it stops the ground reading as cold blue-black.
 *
 * COLOUR IS RANKED BY WHO IS WAITING, not by lifecycle stage. `done` and
 * `blocked` are the two states that need a human, so they carry the chroma;
 * planning, coding and testing recede. Ranking by stage put the brightest
 * colour on `coding` — the most common state — and the dimmest on the ones
 * that actually need you.
 */
object Theme {
    // ---- Surfaces --------------------------------------------------------
    // Low-glare on purpose: the top surface is 20.5% lightness, not black. A
    // dark room plus a bright card is the glare this product is read under.

    /** oklch(16.5% 0.008 155) */
    val background = Color(0xFF0C0F0D)

    /** oklch(20.5% 0.009 155) */
    val card = Color(0xFF141815)

    /** oklch(24.5% 0.010 155) — raised: tracks, pressed states */
    val raised = Color(0xFF1D221E)

    /**
     * oklch(30% 0.011 155).
     *
     * Opaque now, where it used to be `Color(0x14FFFFFF)` — white at 8%. Four
     * call sites use this as a background FILL rather than as a border, and a
     * translucent white over the new ground is not the same colour as the
     * token; the opaque value is what the other two clients draw.
     */
    val cardBorder = Color(0xFF2A302B)

    /**
     * oklch(38% 0.012 155) — hairlines, emphatic: a RULE, never a glyph.
     *
     * 1.80:1 against a card. The web board used this token's equivalent for the
     * "·" between the facts on a card's meta line, and that was the only thing
     * its contrast audit failed — seventeen times, at 1.52:1. A separator is
     * text whatever job it is doing, and takes [textTertiary].
     */
    val hairlineStrong = Color(0xFF3E4440)

    // ---- Text ------------------------------------------------------------
    // All three clear WCAG AA on `card`. The palette this replaces used a
    // tertiary at 2.90:1 for the project name, the timestamp and every Focus
    // label — the three things you most need to read at a glance.

    /** oklch(94% 0.010 155) */
    val textPrimary = Color(0xFFE6EDE8)

    /** oklch(74% 0.012 155) */
    val textSecondary = Color(0xFFA5ADA7)

    /** oklch(64.5% 0.012 155) — lifted from 60% to survive the card tint */
    val textTertiary = Color(0xFF88908A)

    // ---- State -----------------------------------------------------------

    /** oklch(66% 0.020 155) — registered and silent, so nearly neutral */
    val idle = Color(0xFF89968D)

    /** oklch(78% 0.100 320) */
    val planning = Color(0xFFD4A3DF)

    /** oklch(74% 0.085 240) */
    val coding = Color(0xFF78B2DB)

    /** oklch(74% 0.080 200) */
    val testing = Color(0xFF69BABF)

    /** oklch(68% 0.190 28) — the loudest colour here, and the only alarm */
    val blocked = Color(0xFFF75E51)

    /** oklch(76% 0.125 155) — the board's accent */
    val done = Color(0xFF69C88E)

    /**
     * The application accent.
     *
     * It was `planning` blue in 27 places — buttons, switches, the FAB, links.
     * The accent is `done` now, because `done` is the state that hands the
     * turn back to you.
     *
     * ANYTHING FILLED WITH THIS TAKES [onAccent] AS ITS CONTENT COLOUR. White
     * on it measures 2.05:1 and [textPrimary] 1.72:1; the background measures
     * 9.41:1. The old blue was already failing at 2.72:1, so this is a fix
     * rather than a new constraint.
     */
    val accent = done

    /** What to draw on top of [accent]: 9.41:1, where white is 2.05:1. */
    val onAccent = background

    fun colorFor(status: AgentStatus): Color = when (status) {
        AgentStatus.IDLE -> idle
        AgentStatus.PLANNING -> planning
        AgentStatus.CODING -> coding
        AgentStatus.TESTING -> testing
        AgentStatus.BLOCKED -> blocked
        AgentStatus.DONE -> done
    }

    /**
     * The glyph for a status.
     *
     * Shape first, colour second: peripheral vision resolves form long before
     * hue, and roughly 1 in 12 men cannot separate the red and green states by
     * colour at all. This board had nothing but colour — the status word was
     * tinted and that was the whole signal. These mirror iOS's SF Symbols and
     * the web board's marks, state for state.
     *
     * Blocked is the filled one. It is the only alarm here, and a filled mark
     * reads as louder than an outline at a glance, before any colour arrives.
     */
    fun iconFor(status: AgentStatus): ImageVector = when (status) {
        AgentStatus.IDLE -> Icons.Outlined.Schedule
        AgentStatus.PLANNING -> Icons.Outlined.FormatListBulleted
        AgentStatus.CODING -> Icons.Outlined.Code
        AgentStatus.TESTING -> Icons.Outlined.Science
        AgentStatus.BLOCKED -> Icons.Filled.Error
        AgentStatus.DONE -> Icons.Outlined.CheckCircle
    }

    /**
     * A card's surface: the state mixed 10% into [card], 14% for blocked.
     *
     * Baked rather than mixed at runtime, from the same oklab maths the web
     * and iOS use, so the three cannot drift. 10% is solved, not chosen: at
     * 6% the meta line fell to 4.01:1 and failed AA, so the tertiary was
     * lifted to 64.5% lightness, which bought the headroom to tint harder.
     *
     * What this is NOT: a coloured stripe down the card's edge. That is the
     * most overused device in dashboard UI and never reads as intentional,
     * whatever colour or radius it is given.
     *
     * STALE — a working card that has heard nothing for ten minutes
     * ([STALE_AFTER_MILLIS]) — is the same mix with the state's share at
     * nothing, which is [card] itself: the board can no longer vouch for the
     * state a tint would claim. It replaces a 0.62 alpha on the whole card,
     * which left the message at 3.42:1 and the meta line at 2.61:1 against the
     * ground, under WCAG AA on a card that is still a control. On [card] every
     * text token clears AA, the tertiary meta line lowest at 5.47:1, and the
     * card is darker than every tinted one, which is what reads from across
     * the room. The web and iOS boards draw the same.
     */
    fun cardSurface(status: AgentStatus, stale: Boolean = false): Color {
        if (stale) return card
        return when (status) {
            AgentStatus.IDLE -> Color(0xFF1E231F)
            AgentStatus.PLANNING -> Color(0xFF242426)
            AgentStatus.CODING -> Color(0xFF1D2525)
            AgentStatus.TESTING -> Color(0xFF1C2623)
            AgentStatus.BLOCKED -> Color(0xFF30231D)
            AgentStatus.DONE -> Color(0xFF1C271F)
        }
    }

    /**
     * A card's border, from the same mix against [cardBorder]. Blocked keeps a
     * brighter edge — the one state that means a human is needed — and is the
     * only entry derived at runtime rather than baked, so that behaviour
     * survives a change to the blocked colour. No glow: a lit halo is the
     * crypto-terminal tell, and it is exactly wrong in a dark room at 1am.
     *
     * A stale card's edge is [cardBorder] itself, for the reason its surface
     * is [card].
     */
    fun cardEdge(status: AgentStatus, stale: Boolean = false): Color {
        if (stale) return cardBorder
        return when (status) {
            AgentStatus.IDLE -> Color(0xFF4C544E)
            AgentStatus.PLANNING -> Color(0xFF66596A)
            AgentStatus.CODING -> Color(0xFF475E69)
            AgentStatus.TESTING -> Color(0xFF43615F)
            AgentStatus.DONE -> Color(0xFF43664F)
            AgentStatus.BLOCKED -> blocked.copy(alpha = 0.42f)
        }
    }

    // ---- Limits ----------------------------------------------------------

    /**
     * oklch(78% 0.150 80).
     *
     * Not a state — a LIMIT, and the one place a traffic light is right. Amber
     * was wrong as the board's accent, because `coding` is the most common
     * state and every working card then implied a warning; a plan limit
     * filling up genuinely is a caution, so it keeps the convention.
     */
    val limitWarn = Color(0xFFE9AB2B)

    /** Green, amber, red as the window fills — the same 60/85 as the others. */
    fun usageColor(usedPct: Double): Color = when {
        usedPct >= 85 -> blocked
        usedPct >= 60 -> limitWarn
        else -> done
    }

    // ---- Usage chart -----------------------------------------------------
    //
    // The limit lines on the usage screen, which iOS (Theme.seriesColors,
    // seriesStroke, seriesMarker) and the web (LINE_COLORS, LINE_DASHES,
    // LINE_MARKS in public/app.js) draw the same way: the same colours in the
    // same order, the same patterns, the same marks. A window drawn teal on one
    // client and lilac on another is the drift a shared palette exists to stop.

    /**
     * Limit-history line colours: done, coding, planning, testing, idle,
     * blocked. The first three are what Claude reports, and they are as far
     * apart as six state colours allow. Red, the alarm, comes last, because a
     * red limit line reads as a limit in trouble and only a sixth window draws
     * one.
     *
     * It was done, coding, testing: blue and teal are 0.056 apart in OKLab
     * (0.044 for a deuteranope), so "week" and "week_fable" drew as one blue
     * line. Before that it started planning, coding, … while the other clients
     * started done, coding, …. All of these are measured on the colours as
     * drawn, 8-bit sRGB, with Machado 2009 for colour-blind vision.
     */
    private val usageLines = listOf(done, coding, planning, testing, idle, blocked)

    fun usageLineColor(index: Int): Color = usageLines[index.mod(usageLines.size)]

    /** A limit line's width in dp, in the chart and in its key. */
    const val USAGE_LINE_WIDTH = 1.75f

    /**
     * Each limit line's pattern, paired with its colour by position: solid,
     * dashed, dotted, dash-dot, long dash, dash-dot-dot. Hue is not enough on
     * its own (the second principle): blue and lilac collapse for a protanope
     * (0.009), and blue and teal meet again from a fourth window on. The two
     * patterns most alike, dashed and long dash or dash-dot and dash-dot-dot,
     * fall on colours that hue does tell apart.
     *
     * Lengths run along the path, in dp. The round caps add half the line's
     * width to each end of a mark, so a mark reads 1.75dp longer than written
     * and a gap 1.75dp shorter, and a mark of zero length is a round dot.
     * Every gap reads 3 to 3.5dp, the least that stays open on this line.
     */
    private val usageLineDashes: List<List<Float>> = listOf(
        emptyList(),                                 // solid
        listOf(4.25f, 5.25f),                        // dashed: 6dp marks
        listOf(0f, 4.5f),                            // dotted
        listOf(4.25f, 4.75f, 0f, 4.75f),             // dash, dot
        listOf(9.25f, 5.25f),                        // long dash: 11dp marks
        listOf(4.25f, 4.75f, 0f, 4.75f, 0f, 4.75f),  // dash, dot, dot
    )

    /** The nth limit line's pattern, in dp along the path; empty is solid. */
    fun usageLineDash(index: Int): List<Float> = usageLineDashes[index.mod(usageLineDashes.size)]

    /**
     * A limit window's mark for a single reading.
     *
     * A window the board has only just started recording has one reading, and
     * a point cannot carry a pattern. Every such reading sits on the same day,
     * today, so a dot in the window's colour would differ from its neighbours
     * by hue alone until the second day's reading. So each window has a shape
     * as well, paired with its colour and pattern by position. A shape rather
     * than a short sample of the line's pattern: along a time axis a sample
     * spans days, and reads as the run of days it is not.
     *
     * Which shape goes on which colour was measured, on the colours as drawn.
     * The first four colours meet one another under one kind of colour-blind
     * vision or another (blue comes within 0.05 of lilac, teal and green), so
     * they take one shape of each kind, and blue, which meets the most, takes
     * the plus, the shape least like the rest. The two pairs alike in shape,
     * square and diamond, triangle up and down, fall on colours that stay
     * 0.128 and 0.143 apart. Red takes the triangle that points down: pointing
     * up, a red triangle is a warning sign.
     *
     * Each covers about what an 8dp circle does, 43 to 52dp², so no window's
     * mark outweighs another's. The sizes are iOS's in points and the web's in
     * px, at the default text size.
     */
    enum class UsageMark {
        CIRCLE, PLUS, SQUARE, TRIANGLE, DIAMOND, TRIANGLE_DOWN;

        /**
         * The mark's outline, in dp from the reading it marks, which is where
         * a triangle's centroid sits: that is where the eye puts it. Empty for
         * the circle, which is [CIRCLE_RADIUS] round the reading.
         */
        val outline: List<Offset>
            get() = when (this) {
                CIRCLE -> emptyList()
                PLUS -> listOf(                       // arms 3.25dp thick, 9.5dp across
                    Offset(-1.625f, -4.75f), Offset(1.625f, -4.75f), Offset(1.625f, -1.625f),
                    Offset(4.75f, -1.625f), Offset(4.75f, 1.625f), Offset(1.625f, 1.625f),
                    Offset(1.625f, 4.75f), Offset(-1.625f, 4.75f), Offset(-1.625f, 1.625f),
                    Offset(-4.75f, 1.625f), Offset(-4.75f, -1.625f), Offset(-1.625f, -1.625f),
                )
                SQUARE -> listOf(
                    Offset(-3.6f, -3.6f), Offset(3.6f, -3.6f), Offset(3.6f, 3.6f), Offset(-3.6f, 3.6f),
                )
                TRIANGLE -> listOf(
                    Offset(0f, -TRIANGLE_HEIGHT * 2 / 3),
                    Offset(5f, TRIANGLE_HEIGHT / 3),
                    Offset(-5f, TRIANGLE_HEIGHT / 3),
                )
                DIAMOND -> listOf(Offset(0f, -5f), Offset(5f, 0f), Offset(0f, 5f), Offset(-5f, 0f))
                TRIANGLE_DOWN -> listOf(
                    Offset(0f, TRIANGLE_HEIGHT * 2 / 3),
                    Offset(5f, -TRIANGLE_HEIGHT / 3),
                    Offset(-5f, -TRIANGLE_HEIGHT / 3),
                )
            }

        /**
         * How far below the middle of its box the reading sits, in dp: a key
         * centres the box beside its name, where the chart centres the shape on
         * the reading.
         */
        val centreBelowMiddle: Float
            get() = when (this) {
                TRIANGLE -> TRIANGLE_HEIGHT / 6
                TRIANGLE_DOWN -> -TRIANGLE_HEIGHT / 6
                else -> 0f
            }

        companion object {
            /** The circle's radius in dp. */
            const val CIRCLE_RADIUS = 4f

            /** A triangle with 10dp sides is 8.66dp tall. */
            val TRIANGLE_HEIGHT = 5f * sqrt(3f)
        }
    }

    private val usageMarks = listOf(
        UsageMark.CIRCLE, UsageMark.PLUS, UsageMark.SQUARE,
        UsageMark.TRIANGLE, UsageMark.DIAMOND, UsageMark.TRIANGLE_DOWN,
    )

    /** The nth limit window's mark for a single reading, in the chart and in its key. */
    fun usageMark(index: Int): UsageMark = usageMarks[index.mod(usageMarks.size)]

    /**
     * Tokens-per-day bars, half-strength so the limit lines read over them.
     * Token spend is not a state, so it takes the accent rather than borrowing
     * a status colour — an earlier pass drew it in `planning` blue, which made
     * a chart of tokens look like a chart of planning.
     */
    val usageTokenBar: Color = done.copy(alpha = 0.5f)
}

private val AgStatusColorScheme = darkColorScheme(
    primary = Theme.accent,
    // Not white: see Theme.onAccent. White on the accent is 2.05:1.
    onPrimary = Theme.onAccent,
    background = Theme.background,
    onBackground = Theme.textPrimary,
    surface = Theme.card,
    onSurface = Theme.textPrimary,
    surfaceVariant = Theme.raised,
    onSurfaceVariant = Theme.textSecondary,
    outline = Theme.cardBorder,
    error = Theme.blocked,
    onError = Theme.onAccent,
)

private val AgStatusTypography = Typography(
    /**
     * Not monospace. tokens.css sanctions mono for text that IS code and
     * rejects it as a stand-in for "technical"; a small uppercase status label
     * is the latter, and it was the loudest thing about this app's voice.
     */
    labelSmall = TextStyle(
        fontWeight = FontWeight.SemiBold,
        fontSize = 11.sp,
        letterSpacing = 0.9.sp,
    ),
)

/**
 * Whether the system has been asked for less motion.
 *
 * Compose has no first-party equivalent of iOS's `accessibilityReduceMotion`
 * and `LocalAccessibilityManager` does not expose one, so this reads the
 * setting the platform actually animates from. A device with animations turned
 * off reports a scale of 0, and the board honours that the same way the web
 * honours `prefers-reduced-motion` — which until now it did nowhere, while
 * running an ambient pulse that reported nothing.
 */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}

@Composable
fun AgStatusTheme(
    @Suppress("UNUSED_PARAMETER") darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    // Always dark, and dark for a reason: late-night and ambient use, not
    // because dark looks cool. The palette is calibrated for this ground.
    MaterialTheme(
        colorScheme = AgStatusColorScheme,
        typography = AgStatusTypography,
        content = content,
    )
}
