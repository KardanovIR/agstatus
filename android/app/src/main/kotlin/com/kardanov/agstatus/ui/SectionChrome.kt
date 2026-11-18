package com.kardanov.agstatus.ui

import android.os.Build
import android.view.RoundedCorner
import android.view.View
import androidx.annotation.RequiresApi
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.RippleConfiguration
import androidx.compose.material3.RippleDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.positionOnScreen
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.LayoutAwareModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.node.requireLayoutCoordinates
import androidx.compose.ui.node.requireView
import androidx.compose.ui.platform.InspectorInfo
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.kardanov.agstatus.AgentStatus
import com.kardanov.agstatus.DisplayStatus
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.Theme
import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * The chrome of the board grouped by project (docs/design/project-sections.md):
 * the label over each section, the needs-you bar along the bottom edge, the
 * agents' marks, and the ring a card the bar brought wears for two seconds.
 * What they say is worked out in ProjectSections (Models.kt), so it can be
 * tested; these only draw it.
 */

// MARK: - Spacing

/**
 * Spacing does the grouping, as in 1.6.5: 24dp between sections, 12dp
 * between cards, 8dp from a label to its first card. Nothing is boxed. The
 * board's LazyColumn spaces nothing itself, so each item carries its own:
 * a label its top and bottom, a card the gap below it.
 */
internal val LABEL_TOP = 8.dp
internal val LABEL_TO_CARD = 8.dp
internal val CARD_GAP = 12.dp

/** Below a section's last card: with the next label's own top, 24dp between projects. */
internal val SECTION_GAP = 24.dp - LABEL_TOP

// MARK: - Agent marks

/**
 * The agent behind a card: an asterisk for Claude, a hexagon for Codex, a
 * diamond for any other. Neutral geometry, by the owner's decision, and never
 * Anthropic's or OpenAI's logo: the board is open source and self-hosted by
 * other people. Told apart by shape and never by a colour, because colour on
 * this board means state. Matched by prefix, as on iOS, so `claude-code` and
 * `codex-cli` keep theirs.
 *
 * Path for path from public/marks.js (ICON.claude, ICON.codex) on its 16-unit
 * grid, a 1.5 stroke with round ends. marks.js had no mark for any other
 * agent, so the diamond is drawn here, as tall as the hexagon.
 */
internal fun agentMark(source: String): ImageVector {
    val kind = source.lowercase(Locale.ROOT)
    return when {
        kind.startsWith("claude") -> claudeMark
        kind.startsWith("codex") -> codexMark
        else -> otherMark
    }
}

/**
 * An agent's mark, hidden from TalkBack: it is decoration beside words that
 * say the same thing, and the card says its agent first ([ProjectSections.cardLead]).
 */
@Composable
internal fun AgentMark(source: String, size: Dp, tint: Color, modifier: Modifier = Modifier) {
    Icon(
        imageVector = agentMark(source),
        contentDescription = null,
        tint = tint,
        modifier = modifier.size(size),
    )
}

/** `M8 2.4v11.2M3.15 5.2l9.7 5.6M3.15 10.8l9.7-5.6`: three strokes through the middle. */
private val claudeMark: ImageVector by lazy {
    strokedMark("Claude") {
        moveTo(8f, 2.4f)
        verticalLineToRelative(11.2f)
        moveTo(3.15f, 5.2f)
        lineToRelative(9.7f, 5.6f)
        moveTo(3.15f, 10.8f)
        lineToRelative(9.7f, -5.6f)
    }
}

/** `M8 1.9 13.3 4.95v6.1L8 14.1 2.7 11.05v-6.1Z`: a hexagon standing on a point. */
private val codexMark: ImageVector by lazy {
    strokedMark("Codex") {
        moveTo(8f, 1.9f)
        lineTo(13.3f, 4.95f)
        verticalLineToRelative(6.1f)
        lineTo(8f, 14.1f)
        lineTo(2.7f, 11.05f)
        verticalLineToRelative(-6.1f)
        close()
    }
}

/** `M8 1.9 14.1 8 8 14.1 1.9 8Z`: a diamond, the hexagon's height. */
private val otherMark: ImageVector by lazy {
    strokedMark("Agent") {
        moveTo(8f, 1.9f)
        lineTo(14.1f, 8f)
        lineTo(8f, 14.1f)
        lineTo(1.9f, 8f)
        close()
    }
}

/** Black, because Icon tints it. */
private fun strokedMark(
    name: String,
    commands: PathBuilder.() -> Unit,
): ImageVector = ImageVector.Builder(
    name = name,
    defaultWidth = 16.dp,
    defaultHeight = 16.dp,
    viewportWidth = 16f,
    viewportHeight = 16f,
).path(
    stroke = SolidColor(Color.Black),
    strokeLineWidth = 1.5f,
    strokeLineCap = StrokeCap.Round,
    strokeLineJoin = StrokeJoin.Round,
    pathBuilder = commands,
).build()

// MARK: - Label

/** A label's name: under a card's 20sp name, so the card stays the loudest thing in its section. */
private val LABEL_TEXT = 15.sp

/**
 * A section's label: the folder name in its exact case, semibold, and how
 * many sessions it holds, in tertiary ink with tabular digits, on one line.
 * Where the line is short the count goes before any letter of the name does,
 * then the name is cut in the middle, where a folder name says least: its
 * start and its end are what tell `acme-api` from `acme-web`. No project is
 * the board's own words, so secondary ink at regular weight.
 *
 * Not a control: no tap, no mark, no colour, no limit, no token total, no
 * alarm. It sits on the board's opaque ground so cards pass under it while it
 * sticks, and TalkBack hears one heading, "acme-api, 3 sessions", count
 * included even where the count is not drawn.
 *
 * Handed only what it draws, as plain values: its [title] (the section's),
 * whether it [isNoProject], and how many sessions it holds ([count]). Handed
 * the section, which carries its sessions and is made afresh on every hook
 * event, every label in view ran again for a message on one card.
 */
@Composable
internal fun ProjectLabel(title: String, isNoProject: Boolean, count: Int, modifier: Modifier = Modifier) {
    val name = @Composable { nameModifier: Modifier ->
        Text(
            text = title,
            fontSize = LABEL_TEXT,
            lineHeight = 20.sp,
            fontWeight = if (isNoProject) FontWeight.Normal else FontWeight.SemiBold,
            color = if (isNoProject) Theme.textSecondary else Theme.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = nameModifier,
        )
    }
    FirstFitting(
        modifier = modifier
            .fillMaxWidth()
            .background(Theme.background)
            .padding(start = 2.dp, end = 2.dp, top = LABEL_TOP, bottom = LABEL_TO_CARD)
            .clearAndSetSemantics {
                heading()
                contentDescription = ProjectSections.labelDescription(title, count)
            },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            name(Modifier.alignByBaseline())
            Text(
                text = ProjectSections.sessionCount(count),
                fontSize = 13.sp,
                lineHeight = 20.sp,
                style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum"),
                color = Theme.textTertiary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
        }
        name(Modifier)
    }
}

// MARK: - Needs-you bar

/**
 * What the bar says, in its own words and nothing else: how many are
 * [blocked], the [name] of the session it names and [where] it is
 * (ProjectSections.barName, barWhere), and whether its verb is "Next" rather
 * than "Show" ([walks]). Equal while the words are, so a hook event that
 * leaves them as they were is not the bar's news. It held the session it
 * names, made afresh on every event, and the bar ran again for a message on
 * any card.
 */
internal data class BarReading(
    val blocked: Int,
    val name: String,
    val where: String?,
    val walks: Boolean,
) {
    val said: String get() = ProjectSections.barDescription(blocked, name, where, walks)

    companion object {
        /** The bar's words for [target], the card it names, with [blocked] cards blocked. */
        fun of(blocked: Int, target: Session, walks: Boolean) = BarReading(
            blocked = blocked,
            name = ProjectSections.barName(target),
            where = ProjectSections.barWhere(target),
            walks = walks,
        )
    }
}

/** The board's ease (public/tokens.css `--ease`) and its `--d-mid`, as the subagent rows move. */
private val BarEase = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
private const val BAR_MOVE_MILLIS = 220

/** How far in from its sides, inside the insets, the bar's words start. */
private val BAR_SIDE_PADDING = 16.dp

/**
 * What the bar's ripple draws: nothing under a finger, a pointer or a
 * keyboard's focus. Material shows each by laying a layer of the content
 * colour over the ground and the words, and the blocked ink has only 4.82:1
 * on the ground it rests on: a press or a keyboard's focus, each a 10% layer,
 * took the 12sp red word to 3.95:1, under AA. So the ground holds, whatever
 * the bar is doing. Under a finger or a pointer the verb lights instead
 * ([NeedsYouBar]), as under the web's pointer, and a keyboard's focus is a
 * ring inside the bar ([barFocusRing]), as on the web. Every other control on
 * the board keeps Material's layer in 1.7.0, by the owner's call of
 * 2026-11-17, and on a blocked card a keyboard's focus takes the same red
 * word to 3.95:1.
 */
private val BarRipple = RippleConfiguration(
    rippleAlpha = RippleAlpha(
        draggedAlpha = RippleDefaults.RippleAlpha.draggedAlpha,
        focusedAlpha = 0f,
        hoveredAlpha = 0f,
        pressedAlpha = 0f,
    ),
)

/**
 * The needs-you bar: the board's one alarm, along the screen's bottom edge,
 * present only while a session is blocked. "(!) 2 BLOCKED · Fix the login
 * redirect · in acme-api · Show". The mark, the count and the word are in the
 * blocked ink, the session in primary ink, the place and the verb in
 * secondary. It names the card a press brings; after a press the next one,
 * and its verb is "Next" ([BarReading.walks]).
 *
 * Its ground and its top edge are a blocked card's own, its surface and its
 * edge (Theme.cardSurface, Theme.cardEdge), as on iOS and the web. On a
 * card's neutral ground, 1.07:1 against the page under a neutral hairline,
 * the resting bar was a line of text whose only colour was a 12sp word,
 * found by reading it; on the blocked surface, 1.27:1, under the blocked
 * edge, 2.45:1, it is a band the corner of the eye finds, in a colour the
 * board already uses for exactly this. Every ink on it clears AA: the mark,
 * the count and the word 4.82:1, the session 12.75:1, the place and the verb
 * 6.60:1. Under a finger the ground holds and the verb lights to the
 * session's ink ([BarRipple]).
 *
 * A keyboard's focus on the bar is a square ring of 2dp in the accent, inside
 * the bar, as the web's focus outline is ([barFocusRing]): not Material's
 * focus layer, which every other control on the board shows, because that
 * layer would lighten the blocked ground under the red word and take it
 * under AA. The ground and every ink keep their values under focus.
 *
 * One line on a wide screen, and on a phone two, the alarm over the session.
 * On one line, when room runs out it gives up, in order: the word BLOCKED
 * (the mark and the count stay), the place, then the end of the name. On two,
 * each line gives way on its own, since dropping a word from one frees no
 * room on the other: the session line drops the place, then cuts the name at
 * its end, and the alarm line drops BLOCKED only when it lacks room itself.
 * The whole bar is one button, at least 48dp tall, and TalkBack hears "2
 * blocked: Fix the login redirect, in acme-api, Show", every word it shows,
 * the place included where it is not drawn, then "double-tap to show that
 * session".
 *
 * It enters from the bottom edge as the first block lands and leaves when none
 * remain; with animations off it appears and goes in place. Its words change
 * in place, never cross-faded. While it leaves it keeps the last thing it said.
 *
 * Its beat: each time the store calls one ([beats], SessionStore.beats), the
 * count having risen while the bar shows, the bar comes in from the bottom
 * edge again, once, by its own arrival's 220ms and ease, with the new count
 * already in it. Its ground, edge and words are drawn their own height below
 * their place and come back up. Drawn only, as a layer layout never sees: the
 * bar's place, the board's insets and the list's padding, the scroll, the
 * focus and its ring, and what TalkBack is told all stay where they are, and
 * a press lands on the bar throughout. Never while it is entering or leaving,
 * which is motion already, nor with animations off, where the count changes
 * in place.
 */
@Composable
internal fun NeedsYouBar(
    reading: BarReading?,
    reduceMotion: Boolean,
    beats: Flow<Unit>,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // A plain holder, not state: what the bar said last, for it to say while it leaves.
    val last = remember { LastReading() }
    if (reading != null) last.value = reading
    val interactions = remember { MutableInteractionSource() }
    AnimatedVisibility(
        visible = reading != null,
        enter = if (reduceMotion) {
            EnterTransition.None
        } else {
            expandVertically(tween(BAR_MOVE_MILLIS, easing = BarEase), expandFrom = Alignment.Top)
        },
        exit = if (reduceMotion) {
            ExitTransition.None
        } else {
            shrinkVertically(tween(BAR_MOVE_MILLIS, easing = BarEase), shrinkTowards = Alignment.Top)
        },
    ) {
        val shown = reading ?: last.value ?: return@AnimatedVisibility
        val pressed by interactions.collectIsPressedAsState()
        val hovered by interactions.collectIsHoveredAsState()
        // Read by the ring alone, as it draws: focus coming and going runs nothing here.
        val focused = interactions.collectIsFocusedAsState()
        // The system bars and any cutout beside or under the bar, which it
        // runs under: its words keep inside them, and so does the ring.
        val safe = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)
        // How far below its place the bar is drawn, as a share of its own
        // height: read in the layer alone, so a beat recomposes nothing.
        val below = remember { Animatable(0f) }
        LaunchedEffect(beats, reduceMotion) {
            beats.collectLatest {
                val stands = transition.currentState == EnterExitState.Visible &&
                    transition.targetState == EnterExitState.Visible
                if (reduceMotion || !stands) return@collectLatest
                below.snapTo(1f)
                below.animateTo(0f, tween(BAR_MOVE_MILLIS, easing = BarEase))
            }
        }
        CompositionLocalProvider(LocalRippleConfiguration provides BarRipple) {
            Column(
                // The press, the name and the focus first, at the bar's place,
                // and the focus's ring over all the bar draws; then the layer,
                // which moves only what the bar draws, and not the ring.
                modifier = modifier
                    .fillMaxWidth()
                    .clickable(
                        interactionSource = interactions,
                        indication = LocalIndication.current,
                        role = Role.Button,
                        onClickLabel = "show that session",
                        onClick = onPress,
                    )
                    .semantics { contentDescription = shown.said }
                    .barFocusRing(focused, safe)
                    .graphicsLayer { translationY = below.value * size.height }
                    .background(Theme.cardSurface(DisplayStatus.BLOCKED)),
            ) {
                HorizontalDivider(thickness = 1.dp, color = Theme.cardEdge(DisplayStatus.BLOCKED))
                BarContent(
                    reading = shown,
                    lit = pressed || hovered,
                    modifier = Modifier
                        .windowInsetsPadding(safe)
                        .defaultMinSize(minHeight = 47.dp)
                        .padding(horizontal = BAR_SIDE_PADDING, vertical = 8.dp)
                        .clearAndSetSemantics {},
                )
            }
        }
    }
}

/** What the bar said last. Updating it must not recompose. */
private class LastReading {
    var value: BarReading? = null
}

/** The bar's words; [lit] while a finger or a pointer is on the bar, when its verb takes the session's ink. */
@Composable
private fun BarContent(reading: BarReading, lit: Boolean, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        // A phone's width is two lines, as on iOS; a wide screen's one.
        val oneLine = maxWidth >= 600.dp
        val verb = @Composable {
            Text(
                text = if (reading.walks) "Next" else "Show",
                fontSize = 14.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
                color = if (lit) Theme.textPrimary else Theme.textSecondary,
                maxLines = 1,
            )
        }
        if (oneLine) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                FirstFitting(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Alarm(reading.blocked, word = true)
                        BarGap()
                        NameAndWhere(reading.name, reading.where)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Alarm(reading.blocked, word = false)
                        BarGap()
                        NameAndWhere(reading.name, reading.where)
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Alarm(reading.blocked, word = false)
                        BarGap()
                        BarName(reading.name)
                    }
                }
                BarGap()
                verb()
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    FirstFitting(Modifier.weight(1f)) {
                        Alarm(reading.blocked, word = true)
                        Alarm(reading.blocked, word = false)
                    }
                    BarGap()
                    verb()
                }
                FirstFitting {
                    NameAndWhere(reading.name, reading.where)
                    BarName(reading.name)
                }
            }
        }
    }
}

/**
 * The alarm: blocked's own mark, the count, and the word, all in the blocked
 * ink. The mark grows with the reader's text, so at 200% it is not a dot
 * beside a word twice its height.
 */
@Composable
private fun Alarm(blocked: Int, word: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Icon(
            imageVector = Theme.iconFor(AgentStatus.BLOCKED),
            contentDescription = null,
            tint = Theme.blocked,
            modifier = Modifier.size(textDp(15.sp)),
        )
        Text(
            text = if (word) "$blocked BLOCKED" else "$blocked",
            fontSize = 12.sp,
            lineHeight = 20.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum"),
            color = Theme.blocked,
            maxLines = 1,
        )
    }
}

/** The session, then where it is, which goes first when the line is short. */
@Composable
private fun NameAndWhere(name: String, where: String?) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        BarName(name)
        if (where != null) {
            Text(
                text = " · $where",
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = Theme.textSecondary,
                maxLines = 1,
            )
        }
    }
}

/** The session's name, cut at its end only when nothing else is left to give. */
@Composable
private fun BarName(name: String) {
    Text(
        text = name,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.Medium,
        color = Theme.textPrimary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun BarGap() = Spacer(Modifier.size(10.dp))

// MARK: - The bar's focus ring

/** The ring's stroke, and how far in from the bar's edges its outer edge stands: the web's 2px outline at -4px. */
private val BAR_RING_STROKE = 2.dp
private val BAR_RING_GAP = 2.dp

/**
 * The most a side of the ring moves in to keep clear of a rounded corner: as
 * far as leaves 2dp between the ring and the bar's words.
 */
private val BAR_RING_ROOM = BAR_SIDE_PADDING - BAR_RING_GAP - BAR_RING_STROKE - 2.dp

/**
 * A keyboard's focus on the needs-you bar: a square ring of 2dp in the
 * accent, which is the web's focus outline (public/board.css `:focus-visible`,
 * shell.css `.needs:focus-visible`), drawn wholly inside the bar. Its outer
 * edge stands 2dp in from the bar's edges, so 1dp of ground shows between
 * the blocked edge along the top and the ring, and 2dp in from the system
 * bars and any cutout beside or under the bar ([insets], what its words are
 * padded by), so no part of it is under the navigation bar, the gesture
 * handle or a camera.
 *
 * From Android 12, which reports rounded corners, a side whose bottom corner
 * a curve would cut moves in until the corner is 2dp inside the curve, as far
 * as leaves 2dp between the ring and the words ([barRingOutline]). The curves
 * are the display's own corners, and the window's where the window itself is
 * rounded: a corner whose curve meets the window's own bottom edge and its
 * own side, as a split screen's window has them above the divider and beside
 * it ([ringCorners]). Not a corner the window reports at an inset's edge:
 * with three buttons, Android reports the window's corners at the navigation
 * bar's edge, beside the bar or under it, where nothing is drawn over a board
 * that runs under a clear navigation bar, and following them would move the
 * ring in by 10dp for a curve that is not there. A large screen's taskbar
 * with three buttons is reported the same way, though it draws its corners
 * over the window: nothing Android hands an app tells the two apart, so
 * there the taskbar's corners still cut the ring's two bottom corners, by 6
 * to 6.5dp (12 to 13 px on a 1600 by 2560 screen at 320 dpi).
 *
 * Where a curve would need a side to move further than 10dp, as a split
 * screen's window above the divider needs, the side stops there and the
 * ring's corner stands nearer the curve than 2dp: on the Pixel 7 emulator's
 * 48 px corners, 1.8 px inside it, so the ring is drawn whole. A curve wider
 * than that would cut what is left of the corner.
 *
 * Drawn while the bar holds a keyboard's focus ([focused], the bar's own
 * focus interaction). Compose lets the bar take focus only out of touch mode
 * and takes it away when a finger puts the screen back in touch mode, so a
 * touch never shows the ring, nor does a pointer resting on the bar, which
 * gives it no focus.
 *
 * Drawn over the beat's layer, outside it: in a beat the ring holds at the
 * bar's place while the bar's ground, edge and words rise under it, as on
 * the web. [focused] and the insets are read here, as it draws, so focus
 * coming and going runs no composable again, and a beat redraws no ring.
 * The corners are asked of the platform once the bar is placed, on the first
 * draw with the focus, and kept until it is placed again; the ring's edges
 * are kept until the bar's size or insets change, and its stroke until the
 * density does. So a draw with the focus asks nothing of the platform and
 * makes nothing new.
 */
private fun Modifier.barFocusRing(focused: State<Boolean>, insets: WindowInsets): Modifier =
    this then BarFocusRingElement(focused, insets)

private data class BarFocusRingElement(
    val focused: State<Boolean>,
    val insets: WindowInsets,
) : ModifierNodeElement<BarFocusRingNode>() {
    override fun create() = BarFocusRingNode(focused, insets)

    override fun update(node: BarFocusRingNode) {
        node.focused = focused
        node.insets = insets
        node.invalidateDraw()
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "barFocusRing"
    }
}

private class BarFocusRingNode(
    var focused: State<Boolean>,
    var insets: WindowInsets,
) : Modifier.Node(), DrawModifierNode, LayoutAwareModifierNode {
    /** The curves that can cut the ring, in the bar's pixels, for where the bar was last placed; null until asked. */
    private var corners: RingCorners? = null

    /** The ring's outer edge, and the bar's size, insets and density it stands for. */
    private var ring = Rect.Zero
    private var ringSize = Size.Unspecified
    private var ringLeft = Float.NaN
    private var ringRight = Float.NaN
    private var ringBottom = Float.NaN
    private var ringDensity = Float.NaN

    /** The ring's line, in whole pixels so every edge of it is sharp, for [ringDensity]. */
    private var stroke = Stroke()

    override fun onPlaced(coordinates: LayoutCoordinates) {
        corners = null
    }

    override fun onDetach() {
        corners = null
    }

    override fun ContentDrawScope.draw() {
        drawContent()
        if (!focused.value) return
        val left = insets.getLeft(this, layoutDirection).toFloat()
        val right = insets.getRight(this, layoutDirection).toFloat()
        val bottom = insets.getBottom(this).toFloat()
        // New insets can come with new corners, where the window's are reported.
        if (left != ringLeft || right != ringRight || bottom != ringBottom) corners = null
        if (corners == null || size != ringSize || density != ringDensity) {
            val around = corners ?: workOutCorners().also { corners = it }
            ring = barRingOutline(
                width = size.width,
                height = size.height,
                left = left,
                right = right,
                bottom = bottom,
                gap = BAR_RING_GAP.roundToPx().toFloat(),
                room = BAR_RING_ROOM.roundToPx().toFloat(),
                corners = around,
            )
            if (density != ringDensity) stroke = Stroke(width = BAR_RING_STROKE.roundToPx().toFloat())
            ringSize = size
            ringLeft = left
            ringRight = right
            ringBottom = bottom
            ringDensity = density
        }
        val line = stroke.width
        if (ring.width <= 2 * line || ring.height <= 2 * line) return
        drawRect(
            color = Theme.accent,
            topLeft = Offset(ring.left + line / 2, ring.top + line / 2),
            size = Size(ring.width - line, ring.height - line),
            style = stroke,
        )
    }

    /** The rounded corners the platform reports ([RingCornerSource]), in the bar's pixels where it is placed now. */
    private fun workOutCorners(): RingCorners {
        val reported = RingCornerSource.read(requireView()) ?: return RingCorners.None
        val placed = requireLayoutCoordinates()
        return ringCorners(reported, inWindow = placed.positionInWindow(), onScreen = placed.positionOnScreen())
    }
}

/** A rounded corner: the centre of its curve and its radius, in pixels. */
internal data class CornerCurve(val x: Float, val y: Float, val radius: Float)

/**
 * The rounded bottom corners Android reports, from Android 12: the display's
 * own, in the display's pixels as it is turned now, and the window's, in the
 * window's pixels, with the window's size.
 */
internal class ReportedCorners(
    val displayLeft: CornerCurve?,
    val displayRight: CornerCurve?,
    val windowLeft: CornerCurve?,
    val windowRight: CornerCurve?,
    val windowWidth: Float,
    val windowHeight: Float,
)

/**
 * Where the bar's ring reads the rounded corners: the platform's own
 * reports, which only a device makes (Robolectric reports none). A test
 * stands in for them here, to check what the ring does with a report: which
 * corners it keeps clear of and where they fall in the bar's pixels. What
 * the platform reports in each window is the device's to show.
 */
internal object RingCornerSource {
    var read: (View) -> ReportedCorners? = { view ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) platformCorners(view) else null
    }
}

@RequiresApi(Build.VERSION_CODES.S)
private fun platformCorners(view: View): ReportedCorners {
    val display = view.display
    val window = view.rootWindowInsets
    return ReportedCorners(
        displayLeft = display?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT).curve(),
        displayRight = display?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_RIGHT).curve(),
        windowLeft = window?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_LEFT).curve(),
        windowRight = window?.getRoundedCorner(RoundedCorner.POSITION_BOTTOM_RIGHT).curve(),
        windowWidth = view.rootView.width.toFloat(),
        windowHeight = view.rootView.height.toFloat(),
    )
}

@RequiresApi(Build.VERSION_CODES.S)
private fun RoundedCorner?.curve(): CornerCurve? =
    this?.let { CornerCurve(it.center.x.toFloat(), it.center.y.toFloat(), it.radius.toFloat()) }

/** The curves that can cut the bar's ring, in the bar's pixels: the display's bottom corners, and the window's own. */
internal data class RingCorners(
    val displayLeft: CornerCurve? = null,
    val displayRight: CornerCurve? = null,
    val windowLeft: CornerCurve? = null,
    val windowRight: CornerCurve? = null,
) {
    companion object {
        val None = RingCorners()
    }
}

/**
 * [reported] in the pixels of a bar that stands at [inWindow] in its window
 * and at [onScreen] on the display. The window's corners count only where
 * the window itself is rounded: where a corner's curve meets the window's own
 * bottom edge and its own side, to within a pixel. Android reports a corner
 * at an inset's edge instead where an inset with rounded corners stands
 * beside or under the window, a navigation bar with three buttons or a large
 * screen's taskbar, and those are left out. The bottom edge alone does not
 * tell: a phone held sideways with three buttons has nothing under the bar,
 * and reports the corner beside the navigation bar, at the window's bottom
 * edge, 126 px in from its side.
 */
internal fun ringCorners(reported: ReportedCorners, inWindow: Offset, onScreen: Offset): RingCorners {
    val windowLeft = reported.windowLeft?.takeIf {
        abs(it.y + it.radius - reported.windowHeight) <= 1f && abs(it.x - it.radius) <= 1f
    }
    val windowRight = reported.windowRight?.takeIf {
        abs(it.y + it.radius - reported.windowHeight) <= 1f && abs(it.x + it.radius - reported.windowWidth) <= 1f
    }
    return RingCorners(
        displayLeft = reported.displayLeft?.from(onScreen),
        displayRight = reported.displayRight?.from(onScreen),
        windowLeft = windowLeft?.from(inWindow),
        windowRight = windowRight?.from(inWindow),
    )
}

/** This corner counted from [origin]. */
private fun CornerCurve.from(origin: Offset) = CornerCurve(x - origin.x, y - origin.y, radius)

/**
 * Where the bar's focus ring stands, its outer edge, in the bar's pixels: a
 * bar [width] by [height] whose [left], [right] and [bottom] insets keep its
 * words clear of the system bars and any cutout. The ring stands [gap] in
 * from the bar's top and from each inset. Where a rounded bottom corner
 * ([corners]) would reach the ring's corner, nearer the curve than [gap] or
 * past it, that side moves in until the corner is [gap] inside the curve, by
 * [room] at most; the bottom stays. Whole pixels.
 */
internal fun barRingOutline(
    width: Float,
    height: Float,
    left: Float,
    right: Float,
    bottom: Float,
    gap: Float,
    room: Float,
    corners: RingCorners = RingCorners.None,
): Rect {
    val foot = height - bottom - gap
    val leftmost = left + gap
    val rightmost = width - right - gap
    var start = clearLeft(leftmost, corners.displayLeft, foot, gap, leftmost + room)
    start = clearLeft(start, corners.windowLeft, foot, gap, leftmost + room)
    var end = clearRight(rightmost, corners.displayRight, foot, gap, rightmost - room)
    end = clearRight(end, corners.windowRight, foot, gap, rightmost - room)
    return Rect(ceil(start), gap, floor(end), foot)
}

/**
 * How far across from a corner's centre the ring's corner may stand at its
 * [foot] to stay [gap] inside the curve; NaN where the foot is above the
 * centre, where the window's edge is still straight, or the curve is no
 * wider than the gap.
 */
private fun across(corner: CornerCurve, foot: Float, gap: Float): Float {
    val reach = corner.radius - gap
    val down = foot - corner.y
    if (reach <= 0f || down <= 0f) return Float.NaN
    return sqrt((reach * reach - down * down).coerceAtLeast(0f))
}

/** Where the ring's left side starts, at [start] or further in to clear a bottom-left [corner], never past [limit]. */
private fun clearLeft(start: Float, corner: CornerCurve?, foot: Float, gap: Float, limit: Float): Float {
    if (corner == null) return start
    val across = across(corner, foot, gap)
    return if (across.isNaN()) start else maxOf(start, minOf(corner.x - across, limit))
}

/** Where the ring's right side ends, at [end] or further in to clear a bottom-right [corner], never past [limit]. */
private fun clearRight(end: Float, corner: CornerCurve?, foot: Float, gap: Float, limit: Float): Float {
    if (corner == null) return end
    val across = across(corner, foot, gap)
    return if (across.isNaN()) end else minOf(end, maxOf(corner.x + across, limit))
}

// MARK: - Ring

/** How long a card the bar brought wears its ring, as a subagent row the card's tap arrived at keeps its lit ground. */
internal const val RING_HOLD_MILLIS = 2_000L

/** How the ring lets go: at once with animations off. */
internal const val RING_FADE_MILLIS = 600

/**
 * The ring a card the bar brought wears: 2dp in a neutral ink, 2dp clear of
 * the card's 1dp edge so it never reads as the blocked card's own brighter
 * edge. Not a colour, because colour on this board is state, and no glow.
 * [alpha] is read in the draw phase alone, so its fade recomposes nothing.
 *
 * Drawn inside the card's bounds, in its 14dp padding, so no label can cover
 * it. Drawn outside, it lost its top edge whenever the card sat flush under
 * the label that sticks: the list places that label last, over the cards,
 * and at the top of the list the card cannot be moved out from under it.
 *
 * Two rings over one [alpha] are equal, so a card's modifier is the same
 * from one pass of the board to the next and an unchanged card skips. Built
 * from drawWithContent, the ring was a new lambda on every pass, never equal
 * to the last, and every card on screen ran again on each hook event.
 */
internal fun Modifier.jumpRing(alpha: State<Float>): Modifier = this then JumpRingElement(alpha)

private data class JumpRingElement(val alpha: State<Float>) : ModifierNodeElement<JumpRingNode>() {
    override fun create() = JumpRingNode(alpha)

    override fun update(node: JumpRingNode) {
        node.alpha = alpha
    }

    override fun InspectorInfo.inspectableProperties() {
        name = "jumpRing"
    }
}

private class JumpRingNode(var alpha: State<Float>) : Modifier.Node(), DrawModifierNode {
    override fun ContentDrawScope.draw() {
        drawContent()
        val shown = alpha.value
        if (shown <= 0f) return
        val stroke = 2.dp.toPx()
        val inset = 1.dp.toPx() + 2.dp.toPx() + stroke / 2
        drawRoundRect(
            color = Theme.textSecondary.copy(alpha = shown),
            topLeft = Offset(inset, inset),
            size = Size(size.width - 2 * inset, size.height - 2 * inset),
            cornerRadius = CornerRadius((16.dp.toPx() - inset).coerceAtLeast(0f)),
            style = Stroke(width = stroke),
        )
    }
}

// MARK: - Spoken

/** How long the spoken line holds its words: long enough for TalkBack to take them, short enough not to linger as a stop. */
private const val SPOKEN_HOLD_MILLIS = 5_000L

/**
 * How long the line is empty between two sentences, so the second is a
 * change even when its words are the first's: Compose sends the
 * accessibility tree's changes at most every 100ms.
 */
private const val SPOKEN_GAP_MILLIS = 250L

/**
 * What the app says aloud ([SpokenLine]): a new block, "Fix the login
 * redirect, in acme-api, needs you" (BlockSpeech, through [SpokenAlarm]), and
 * where a press of the bar went when its card could not take focus. Each
 * sentence holds for a few seconds and goes, so the next one, even in the
 * same words, is news.
 *
 * One for the whole app, made above the NavHost, and it says everything in
 * its own [scope], that one's: a sentence handed over from a screen that then
 * leaves is still let go of on time, not left holding its words.
 */
@Stable
internal class Speaker(private val scope: CoroutineScope) {
    var said: String? by mutableStateOf(null)
        private set
    private var saying: Job? = null

    fun say(sentence: String) {
        saying?.cancel()
        saying = scope.launch {
            if (said != null) {
                said = null
                delay(SPOKEN_GAP_MILLIS)
            }
            said = sentence
            delay(SPOKEN_HOLD_MILLIS)
            said = null
        }
    }
}

/**
 * Where the app speaks: a polite live region, which TalkBack reads out
 * when its words change, after whatever it is saying. Not an announcement:
 * View.announceForAccessibility is deprecated from Android 16, which asks
 * for a live region instead. Draws nothing, and holds no words between
 * sentences, so TalkBack has nothing to stop on. One dp, because a node
 * without size is left out of what TalkBack is handed. It stands over the
 * NavHost, so it is there on every screen.
 */
@Composable
internal fun SpokenLine(speaker: Speaker, modifier: Modifier = Modifier) {
    val said = speaker.said
    Box(
        modifier.size(1.dp).semantics {
            liveRegion = LiveRegionMode.Polite
            if (said != null) contentDescription = said
        },
    )
}

/**
 * Hands [speaker] what the store says aloud ([spoken], SessionStore.spoken)
 * while the app is in front, on whichever screen shows: it is composed
 * above the NavHost. It was the board's, and a block that landed while
 * History, Settings or Usage was open was counted as said and said nowhere.
 *
 * Not in front, the app says nothing, as iOS says nothing while it is
 * inactive, and what arrives then is let go rather than kept: by the time
 * the app is in front again it is not news, and a block standing then is
 * the bar's to show. "In front" is resumed, so from Android 10 a board left
 * showing in another window of a split screen still speaks; on 8 and 9 only
 * the focused window is resumed.
 */
@Composable
internal fun SpokenAlarm(spoken: Flow<String>, speaker: Speaker) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(spoken, speaker, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            spoken.collect { sentence -> speaker.say(sentence) }
        }
    }
}

// MARK: - Layout

/**
 * The first child whose one line fits the width offered, else the last, which
 * is then measured at that width so it can cut itself short: the count before
 * the name, the place before the name's end. Fit is asked of each child's
 * intrinsic width, so only the chosen one is measured, and so the last one can
 * be measured at the real width rather than its own.
 */
@Composable
internal fun FirstFitting(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        if (measurables.isEmpty()) return@Layout layout(constraints.minWidth, constraints.minHeight) {}
        val chosen = measurables.firstOrNull { it.maxIntrinsicWidth(Constraints.Infinity) <= constraints.maxWidth }
            ?: measurables.last()
        val placeable = chosen.measure(constraints.copy(minWidth = 0))
        layout(placeable.width.coerceIn(constraints.minWidth, constraints.maxWidth), placeable.height) {
            placeable.placeRelative(0, 0)
        }
    }
}

/** [size] in the reader's text size, as Android 14 and later scale it. */
@Composable
internal fun textDp(size: TextUnit): Dp = with(LocalDensity.current) { size.toDp() }
