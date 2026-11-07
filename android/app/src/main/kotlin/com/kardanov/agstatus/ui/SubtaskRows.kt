package com.kardanov.agstatus.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.Subtask
import com.kardanov.agstatus.SubtaskCopy
import com.kardanov.agstatus.SubtaskSlots
import com.kardanov.agstatus.SubtaskState
import com.kardanov.agstatus.Subtasks
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.rememberReduceMotion
import kotlinx.coroutines.launch

/**
 * A session's subagents, twice: two rows and a footer on its card, and the
 * Subtasks section of its session screen. Which rows a card shows is
 * SubtaskSlots' business; what they say is SubtaskCopy's.
 */

// MARK: - Motion
//
// A row moves when it starts, finishes or is blocked, and at no other time. A
// new activity is written in place: it is not news. The web board's ease and
// durations (public/tokens.css `--ease`, `--d-mid`, `--d-slow`), so the three
// clients move alike. Nothing loops, and all of it is instant on a device that
// asked for less motion.

private val BoardEase = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

/** A row that starts fades in from just above its slot. */
private const val ROW_IN_MILLIS = 220
private val ROW_RISE = 3.dp

/** A row's state cell re-enters when the row is blocked, unblocked, or fails. */
private const val STATE_IN_MILLIS = 420

/** A count that changes ticks in from above. */
private const val TICK_MILLIS = 220
private val TICK_RISE = 5.dp

/** A slot nothing takes closes rather than snapping shut. */
private const val SLOT_CLOSE_MILLIS = 200

/** How long the row a card's tap arrived at keeps its lit ground, and how it lets go. */
internal const val ARRIVAL_HOLD_MILLIS = 2_000L
private const val ARRIVAL_FADE_MILLIS = 600

/** The most of a card row's text its label may take; the activity keeps the rest. */
private const val LABEL_SHARE = 0.58f

/** A row's task and activity, and the em that [STACK_BELOW_EMS] counts. */
private val ROW_TEXT = 13.sp

/**
 * Below this many of its own ems a row takes two lines ([SubtaskRow]), as
 * below the web board's `20em`. Counted from [ROW_TEXT] rather than written
 * as 260sp: since Android 14 type scales nonlinearly, and a length that large
 * barely grows — at 200% 260sp is still about 260dp, under a 412dp phone's
 * 351dp of row, while the 13sp text beside it doubles. Counted this way it is
 * 260dp at the default size, under the rows of any phone from 360dp up, and
 * about 500dp at 200%: it switches at about 115% on a 360dp phone and 150% on
 * a 412dp one.
 */
private const val STACK_BELOW_EMS = 20

// MARK: - Card

/**
 * A card's subagents: up to two rows under one hairline in the card's edge
 * colour ([rule]), then the footer. No box and no fill — a tinted band here
 * would be a card inside a card.
 *
 * [rows] are SubtaskSlots.pick's choice. [drawnBefore] says the card was on
 * screen before this composition: a row that joins then is news and fades
 * in, while the rows a card is first drawn with — after a scroll, say — are
 * simply there.
 */
@Composable
internal fun SubtaskBlock(
    subtasks: Subtasks,
    rows: List<Subtask>,
    rule: Color,
    drawnBefore: Boolean,
    onOpenSubtask: (String) -> Unit,
    onOpenSession: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = rememberReduceMotion()
    val footer = SubtaskSlots.footer(total = subtasks.items.size, shown = rows.size, done = subtasks.done)
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val stacked = maxWidth < with(LocalDensity.current) { ROW_TEXT.toDp() } * STACK_BELOW_EMS
        Column(
            modifier = modifier
                .fillMaxWidth()
                // A finished row's slot that nothing takes closes over 200ms, and
                // a slot opens the same way, instead of the card jumping.
                .then(if (reduceMotion) Modifier else Modifier.animateContentSize(tween(SLOT_CLOSE_MILLIS, easing = BoardEase))),
        ) {
            HorizontalDivider(thickness = 1.dp, color = rule)
            Spacer(Modifier.height(2.dp))
            for (subtask in rows) {
                key(subtask.id) {
                    SubtaskRow(
                        subtask = subtask,
                        stacked = stacked,
                        animateArrival = drawnBefore && !reduceMotion,
                        reduceMotion = reduceMotion,
                        onClick = { onOpenSubtask(subtask.id) },
                    )
                }
            }
            footer?.let { SubtaskFooter(footer = it, reduceMotion = reduceMotion, onOpenSession = onOpenSession) }
        }
    }
}

/**
 * One subagent: what it was asked to do, what it is doing, and its state as a
 * mark and a word at the trailing edge, under the card's own badge, so the
 * marks make one column a glance reads before any word.
 *
 * 28dp, not 48. A row opens the same session screen as its neighbours, only
 * at a different subagent, so a mis-tap costs a scroll. Focus, the card's one
 * control that reaches across to another machine, keeps its 44.
 *
 * [stacked] below [STACK_BELOW_EMS]: at a reader's larger text the three
 * parts no longer share a line, and at 200% the task and the activity came
 * down to a few letters each. So the task takes the whole width, two lines
 * if it needs them, and the activity and the state share the next, the state
 * still at the trailing edge under the badge, its mark and word together.
 * None of the three is dropped, and TalkBack hears the same row either way.
 */
@Composable
private fun SubtaskRow(
    subtask: Subtask,
    stacked: Boolean,
    animateArrival: Boolean,
    reduceMotion: Boolean,
    onClick: () -> Unit,
) {
    val blocked = subtask.state == SubtaskState.BLOCKED
    val arrival = rememberArrival(animateArrival, ROW_IN_MILLIS)
    val stateCue = rememberCue(subtask.state, !reduceMotion, STATE_IN_MILLIS, SubtaskSlots::stateCellMoves)
    // The one row that needs you is lit, not heavier: a bold red word under
    // the BLOCKED badge would be a second BLOCKED.
    val labelColor = if (blocked) Theme.textPrimary else Theme.textSecondary
    val rowModifier = Modifier
        .fillMaxWidth()
        .defaultMinSize(minHeight = 28.dp)
        .rising(arrival, ROW_RISE)
        // Its own button inside the card's merged node, read as one line.
        // The semantics are set after clickable on purpose: set before it,
        // they would clear the click action along with the children.
        .clickable(role = Role.Button, onClick = onClick)
        .clearAndSetSemantics { contentDescription = SubtaskCopy.rowDescription(subtask) }
    val state = @Composable {
        StateMark(
            state = subtask.state,
            markSize = 11.dp,
            fontSize = 11.sp,
            lineHeight = 13.sp,
            modifier = Modifier.rising(stateCue, ROW_RISE),
        )
    }
    if (stacked) {
        // Its two lines close, and 8dp between rows, so a row reads as one.
        Column(
            modifier = rowModifier.padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            // Two lines, since it is how you know which row this is.
            Text(
                text = subtask.label,
                fontSize = ROW_TEXT,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                color = labelColor,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = subtask.activity,
                    fontSize = ROW_TEXT,
                    lineHeight = 16.sp,
                    color = Theme.textTertiary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                state()
            }
        }
    } else {
        Row(
            modifier = rowModifier,
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            LabelAndActivity(
                label = subtask.label,
                activity = subtask.activity,
                labelColor = labelColor,
                modifier = Modifier.weight(1f),
            )
            state()
        }
    }
}

/**
 * Label and activity on one line. The label takes its own width up to 58% of
 * the line and the activity whatever is left: the label outlasts the activity,
 * because it is how you know which row this is, but the cap keeps a long
 * description from cutting the activity — the live part, the reason the row
 * exists — to nothing. About 100dp of activity on a phone with a p90 label.
 */
@Composable
private fun LabelAndActivity(
    label: String,
    activity: String,
    labelColor: Color,
    modifier: Modifier = Modifier,
) {
    Layout(
        content = {
            Text(
                text = label,
                fontSize = ROW_TEXT,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                color = labelColor,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = activity,
                fontSize = ROW_TEXT,
                lineHeight = 16.sp,
                color = Theme.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        modifier = modifier,
    ) { measurables, constraints ->
        val gap = 8.dp.roundToPx()
        val bounded = constraints.hasBoundedWidth
        val labelRoom = if (bounded) (constraints.maxWidth * LABEL_SHARE).toInt() else Constraints.Infinity
        val labelText = measurables[0].measure(Constraints(maxWidth = labelRoom, maxHeight = constraints.maxHeight))
        val activityRoom = if (bounded) {
            (constraints.maxWidth - labelText.width - gap).coerceAtLeast(0)
        } else {
            Constraints.Infinity
        }
        val activityText = measurables[1].measure(Constraints(maxWidth = activityRoom, maxHeight = constraints.maxHeight))
        val width = if (bounded) constraints.maxWidth else labelText.width + gap + activityText.width
        val height = maxOf(labelText.height, activityText.height)
            .coerceIn(constraints.minHeight, constraints.maxHeight)
        layout(width, height) {
            labelText.placeRelative(0, (height - labelText.height) / 2)
            activityText.placeRelative(labelText.width + gap, (height - activityText.height) / 2)
        }
    }
}

/**
 * A row's state: the badge's own mark a size down, in the state's colour, and
 * its word in the quiet ink, lower case, regular weight. The card's badge
 * stays the one coloured word on the card, with a column of small coloured
 * marks under it, and each row's state is still a mark and a word, never hue
 * alone. Blocked's word takes the colour too: that row needs you.
 */
@Composable
private fun StateMark(
    state: SubtaskState,
    markSize: Dp,
    fontSize: TextUnit,
    lineHeight: TextUnit,
    modifier: Modifier = Modifier,
) {
    val color = Theme.colorFor(state)
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = Theme.iconFor(state),
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(markSize),
        )
        Text(
            text = state.wire,
            fontSize = fontSize,
            lineHeight = lineHeight,
            color = if (state == SubtaskState.BLOCKED) color else Theme.textTertiary,
            maxLines = 1,
        )
    }
}

/**
 * "+4 more · 12 done". Under the phone rules — Android's only rules — it is a
 * control while any subagent has no row, and opens the session screen, where
 * every one is listed. With nothing hidden it is plain text, a count. In the
 * secondary ink: it summarises the rows, it is not a reading.
 */
@Composable
private fun SubtaskFooter(
    footer: SubtaskSlots.Footer,
    reduceMotion: Boolean,
    onOpenSession: () -> Unit,
) {
    val control = if (footer.navigates) {
        Modifier
            .clickable(onClickLabel = SubtaskCopy.OPEN_SESSION, role = Role.Button, onClick = onOpenSession)
            // Read as its words, without the dot between them: a separator
            // is not something to say aloud, as on the meta line.
            .clearAndSetSemantics {
                contentDescription = listOfNotNull(footer.more, footer.done).joinToString(", ")
            }
    } else {
        Modifier
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 28.dp)
            .then(control),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        footer.more?.let { FooterCount(text = it, reduceMotion = reduceMotion) }
        if (footer.more != null && footer.done != null) {
            Text(
                text = "·",
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = Theme.textTertiary,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
        footer.done?.let { FooterCount(text = it, reduceMotion = reduceMotion) }
        if (footer.navigates) {
            Icon(
                imageVector = Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                contentDescription = null,
                tint = Theme.textTertiary,
                modifier = Modifier
                    .padding(start = 2.dp)
                    .size(12.dp),
            )
        }
    }
}

/** One part of the footer, which ticks in when its number changes. */
@Composable
private fun FooterCount(text: String, reduceMotion: Boolean) {
    val tick = rememberCue(text, !reduceMotion, TICK_MILLIS) { from, to -> from != to }
    Text(
        text = text,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        color = Theme.textSecondary,
        maxLines = 1,
        modifier = Modifier.rising(tick, TICK_RISE),
    )
}

// MARK: - Session screen

/**
 * The session screen's Subtasks section, as items for its LazyColumn above
 * the timeline: the counts, every subagent — blocked first, so the row the
 * footer leads to is on top, then start order — and how many finished this
 * turn. Painted from the live session, not from the history fetch, so it is
 * there while the history loads, and when it comes back empty or fails.
 *
 * [lit] is the row a card's tap arrived at, while its ground is lit;
 * [arrival] is that row, which [arrivalFocus] can move focus to.
 */
internal fun LazyListScope.subtaskSection(
    subtasks: Subtasks,
    ordered: List<Subtask>,
    lit: String?,
    arrival: String?,
    arrivalFocus: FocusRequester,
) {
    item(key = "subtasks") {
        SessionSectionLabel(
            title = SubtaskCopy.SECTION,
            counts = SubtaskCopy.counts(subtasks.running, subtasks.blocked, subtasks.failed),
        )
    }
    items(ordered, key = { "subtask:${it.id}" }) { subtask ->
        RoomySubtaskRow(
            subtask = subtask,
            lit = subtask.id == lit,
            focus = if (subtask.id == arrival) arrivalFocus else null,
        )
    }
    if (subtasks.done > 0) {
        item(key = "subtasks-done") {
            Text(
                text = SubtaskCopy.doneThisTurn(subtasks.done),
                fontSize = 13.sp,
                lineHeight = 16.sp,
                color = Theme.textTertiary,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp),
            )
        }
    }
}

/**
 * A section's name on the session screen, in the small uppercase voice the
 * usage bars use for a limit, with its counts beside it in plain figures:
 * "SUBTASKS  9 running · 1 blocked". A heading, so TalkBack can jump from the
 * subagents to the timeline.
 */
@Composable
internal fun SessionSectionLabel(title: String, counts: String = "") {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 16.dp, top = 22.dp, bottom = 6.dp)
            .semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.6.sp,
            color = Theme.textTertiary,
            maxLines = 1,
            modifier = Modifier.alignByBaseline(),
        )
        if (counts.isNotEmpty()) {
            Text(
                text = counts,
                fontSize = 12.sp,
                color = Theme.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.alignByBaseline(),
            )
        }
    }
}

/**
 * A subagent with room: its label on the first line with its state at the
 * end, its activity whole on the second. 52dp. Android has only the phone
 * layout, so the state never moves to a leading column here. A plain list
 * item: a tap does nothing.
 *
 * The row a card's tap arrived at has a lit ground, for two seconds, then it
 * goes out — a fade, or at once under reduced motion. Not a ring: a
 * full-width outline was the brightest thing on the screen and boxed the row
 * like a card inside a card. The ground reaches 8dp past the text on either
 * side, so nothing moves when it goes.
 */
@Composable
private fun RoomySubtaskRow(subtask: Subtask, lit: Boolean, focus: FocusRequester?) {
    val reduceMotion = rememberReduceMotion()
    val ground = animateFloatAsState(
        targetValue = if (lit) 1f else 0f,
        animationSpec = if (reduceMotion) snap() else tween(ARRIVAL_FADE_MILLIS, easing = BoardEase),
        label = "subtaskArrival",
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .background(Theme.raised.copy(alpha = ground.value), RoundedCornerShape(6.dp))
            // Only the arrived row can take focus, so the arrival can move
            // TalkBack there. It is then a stop for a keyboard's Tab and arrow
            // keys as well, the one row that is: Compose has no focus only
            // code can give, like the web's tabindex="-1", and this is the
            // nearest thing to it.
            .then(if (focus != null) Modifier.focusRequester(focus).focusable() else Modifier)
            .clearAndSetSemantics { contentDescription = SubtaskCopy.rowDescription(subtask) }
            .defaultMinSize(minHeight = 52.dp)
            .padding(horizontal = 8.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = subtask.label,
                fontSize = 15.sp,
                lineHeight = 19.sp,
                fontWeight = FontWeight.Medium,
                color = Theme.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(12.dp))
            StateMark(state = subtask.state, markSize = 12.dp, fontSize = 12.sp, lineHeight = 13.sp)
        }
        if (subtask.activity.isNotEmpty()) {
            Text(
                text = subtask.activity,
                fontSize = 13.sp,
                lineHeight = 16.sp,
                color = Theme.textTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

// MARK: - Motion helpers

/**
 * 0 → 1 once, as a node joins a card already on screen. A node the card was
 * first drawn with, or any node under reduced motion, starts at 1.
 */
@Composable
private fun rememberArrival(animate: Boolean, durationMillis: Int): State<Float> {
    val progress = remember { Animatable(if (animate) 0f else 1f) }
    LaunchedEffect(progress) {
        progress.animateTo(1f, tween(durationMillis, easing = BoardEase))
    }
    return progress.asState()
}

/**
 * 1 at rest, and 0 → 1 again each time [value] changes in a way [moves] calls
 * news. Never for the value the node was first drawn with, and never with
 * [enabled] false, which is reduced motion.
 *
 * The cue runs in the node's own scope, not in the effect that started it.
 * The next change of [value] replaces that effect, and a change that is not
 * news — a row approved, then testing a moment later — would otherwise stop
 * the cue where it was and leave the node half faded, raised, until its next
 * block or failure. Only news restarts a cue; any other change leaves it to
 * finish.
 */
@Composable
internal fun <T> rememberCue(
    value: T,
    enabled: Boolean,
    durationMillis: Int,
    moves: (from: T, to: T) -> Boolean,
): State<Float> {
    val progress = remember { Animatable(1f) }
    val last = remember { LastDrawn(value) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(value) {
        val from = last.value
        last.value = value
        if (enabled && moves(from, value)) {
            scope.launch {
                // A cue still running is cancelled by the snap: this one replaces it.
                progress.snapTo(0f)
                progress.animateTo(1f, tween(durationMillis, easing = BoardEase))
            }
        }
    }
    return progress.asState()
}

/** The value a node was last drawn with. A plain holder: updating it must not recompose. */
private class LastDrawn<T>(var value: T)

/** Fades a node in from [rise] above as [progress] runs 0 → 1, in the draw phase alone. */
private fun Modifier.rising(progress: State<Float>, rise: Dp): Modifier = graphicsLayer {
    alpha = progress.value
    translationY = -rise.toPx() * (1f - progress.value)
}
