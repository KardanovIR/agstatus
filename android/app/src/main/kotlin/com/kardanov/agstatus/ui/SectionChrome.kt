package com.kardanov.agstatus.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
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
import com.kardanov.agstatus.ProjectSection
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.Theme
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
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
 */
@Composable
internal fun ProjectLabel(section: ProjectSection, modifier: Modifier = Modifier) {
    val name = @Composable { nameModifier: Modifier ->
        Text(
            text = section.title,
            fontSize = LABEL_TEXT,
            lineHeight = 20.sp,
            fontWeight = if (section.isNoProject) FontWeight.Normal else FontWeight.SemiBold,
            color = if (section.isNoProject) Theme.textSecondary else Theme.textPrimary,
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
                contentDescription = ProjectSections.labelDescription(section)
            },
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            name(Modifier.alignByBaseline())
            Text(
                text = ProjectSections.sessionCount(section.sessions.size),
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

/** What the bar says. [walks] is whether its verb is "Next" rather than "Show". */
internal data class BarReading(
    val blocked: Int,
    val target: Session,
    val walks: Boolean,
) {
    val name: String get() = ProjectSections.barName(target)
    val where: String? get() = ProjectSections.barWhere(target)
    val said: String get() = ProjectSections.barDescription(blocked, target, walks)
}

/** The board's ease (public/tokens.css `--ease`) and its `--d-mid`, as the subagent rows move. */
private val BarEase = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
private const val BAR_MOVE_MILLIS = 220

/**
 * The needs-you bar: the board's one alarm, along the screen's bottom edge,
 * present only while a session is blocked. "(!) 2 BLOCKED · Fix the login
 * redirect · in acme-api · Show". The mark, the count and the word are in the
 * blocked ink, the session in primary ink, the place and the verb in
 * secondary. It names the card a press brings; after a press the next one,
 * and its verb is "Next" ([BarReading.walks]).
 *
 * One line on a wide screen, and on a phone two, the alarm over the session.
 * When room runs out it gives up, in order: the word BLOCKED (the mark and the
 * count stay), the place, then the end of the name. The whole bar is one
 * button, at least 48dp tall, and TalkBack hears "2 blocked: Fix the login
 * redirect, in acme-api, Show", every word it shows, then "double-tap to
 * show that session".
 *
 * It enters from the bottom edge as the first block lands and leaves when none
 * remain; with animations off it appears and goes in place. Its words change
 * in place, never cross-faded. While it leaves it keeps the last thing it said.
 */
@Composable
internal fun NeedsYouBar(
    reading: BarReading?,
    reduceMotion: Boolean,
    onPress: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // A plain holder, not state: what the bar said last, for it to say while it leaves.
    val last = remember { LastReading() }
    if (reading != null) last.value = reading
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
        Column(
            modifier = modifier
                .fillMaxWidth()
                .background(Theme.card)
                .clickable(role = Role.Button, onClickLabel = "show that session", onClick = onPress)
                .semantics { contentDescription = shown.said },
        ) {
            HorizontalDivider(thickness = 1.dp, color = Theme.cardBorder)
            BarContent(
                reading = shown,
                modifier = Modifier
                    .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))
                    .defaultMinSize(minHeight = 47.dp)
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .clearAndSetSemantics {},
            )
        }
    }
}

/** What the bar said last. Updating it must not recompose. */
private class LastReading {
    var value: BarReading? = null
}

@Composable
private fun BarContent(reading: BarReading, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
        // A phone's width is two lines, as on iOS; a wide screen's one.
        val oneLine = maxWidth >= 600.dp
        val verb = @Composable {
            Text(
                text = if (reading.walks) "Next" else "Show",
                fontSize = 14.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
                color = Theme.textSecondary,
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
 * the bar's to show. "In front" is resumed, so a board left showing in
 * another window of a split screen still speaks.
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
