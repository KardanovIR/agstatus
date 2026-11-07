package com.kardanov.agstatus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.FlipToFront
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.QuestionMark
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.CommandType
import com.kardanov.agstatus.DisplayStatus
import com.kardanov.agstatus.FocusCopy
import com.kardanov.agstatus.FocusStatus
import com.kardanov.agstatus.MachinePresence
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.SessionHost
import com.kardanov.agstatus.SubtaskLedger
import com.kardanov.agstatus.SubtaskSlots
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.TimeFormat

/**
 * One agent session, readable at arm's length: big name, the state as a shape
 * and a word, the last message, and the facts underneath. `nowMillis` is
 * supplied by the caller's clock so the timestamp and staleness refresh
 * together.
 *
 * A stale card — working, and silent for ten minutes ([Session.isStale]) —
 * keeps every word at full strength and says what it is three other ways, as
 * the web and iOS cards do: the untinted surface and edge
 * ([Theme.cardSurface]), "?" in place of its state's glyph ([StatusMark]), and
 * "no update for 14m" where its time was ([MetaLine]). TalkBack hears "Coding,
 * no update for 14 minutes".
 *
 * A session running subagents lists them under its message: two rows, each
 * opening the session screen at that subagent, and a footer that opens it at
 * the top when more are running than fit. [subtaskLedger] is the store's
 * record of which subagents hold the rows. A card without subagents is
 * today's card, view for view.
 *
 * A session that reports a host gets a Focus footer: an explicit control —
 * never the card's tap, which is history — enabled only while that machine's
 * listener is online, and the outcome of the last tap under it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionCard(
    session: Session,
    nowMillis: Long,
    modifier: Modifier = Modifier,
    machines: Map<String, MachinePresence> = emptyMap(),
    focus: FocusStatus? = null,
    subtaskLedger: SubtaskLedger? = null,
    onCommand: (CommandType) -> Unit = {},
    onOpenHistory: (subtaskId: String?) -> Unit = {},
) {
    // Everything that shows the state reads the display status, which is the
    // wire status except for WORKING: the turn is over, subagents still work.
    val display = session.displayStatus
    val stale = session.isStale(nowMillis)
    val shape = RoundedCornerShape(16.dp)
    // Rows a card is first drawn with are not news; one that joins a card
    // already on screen is. A plain holder, not state: setting it must not
    // recompose the card.
    val drawn = remember { DrawnOnce() }
    SideEffect { drawn.value = true }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .semantics(mergeDescendants = true) {}
            // Nothing dims. A stale card was drawn whole at 0.62 alpha, which
            // took its message to 3.42:1 and its meta line to 2.61:1 against
            // the ground — under AA on the card most worth a closer look, and
            // one that is still a control — while TalkBack was told nothing.
            // `done` was once dimmed too, from when it meant "finished,
            // nothing to see"; it means the agent handed back and is waiting
            // on YOU, the state this board most needs to surface.
            //
            // Crossing into stale is the board's own clock passing a line, not
            // news from the agent, and it is drawn, never animated: the colours
            // below are set, not animated to, and a card that goes stale keeps
            // its place in the list.
            //
            // No glow. The blocked card used to carry a 12dp coloured shadow;
            // a lit halo is the trading-terminal tell, and it is exactly wrong
            // in a dark room at 1am, which is when this board gets read. The
            // brighter edge below is what marks blocked instead.
            .clip(shape)
            // The whole surface carries the state, so the board can be sorted
            // by colour before a word is read. This replaces a 4dp coloured
            // stripe down the leading edge: that pattern is the most overused
            // device in dashboard UI and never reads as intentional, whatever
            // colour or corner radius it is given. A large tinted area also
            // reads from much further away than a 4dp sliver.
            //
            // Except on a stale card, drawn on the plain card and its plain
            // edge: the board can no longer vouch for the state a tint claims.
            .background(Theme.cardSurface(display, stale))
            .border(1.dp, Theme.cardEdge(display, stale), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CardHeader(session = session, stale = stale, nowMillis = nowMillis)

        if (session.message.isNotEmpty()) {
            Text(
                text = session.message,
                fontSize = 14.sp,
                color = Theme.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // After the message, before the facts: the message says what the
        // card is doing, the rows say who is doing it.
        session.subtasks?.let { subtasks ->
            val rows = remember(subtaskLedger, subtasks.items) {
                SubtaskSlots.pick(subtaskLedger, subtasks.items).rows
            }
            SubtaskBlock(
                subtasks = subtasks,
                rows = rows,
                rule = Theme.cardEdge(display, stale),
                drawnBefore = drawn.value,
                onOpenSubtask = { subtaskId -> onOpenHistory(subtaskId) },
                onOpenSession = { onOpenHistory(null) },
            )
        }

        MetaLine(session = session, nowMillis = nowMillis, machines = machines, stale = stale)

        session.host?.let { host ->
            FocusFooter(
                host = host,
                machines = machines,
                status = focus,
                nowMillis = nowMillis,
                onCommand = onCommand,
            )
        }
    }
}

/**
 * The name and the state: side by side, the name taking what the state
 * leaves on one line, until the card stacks ([cardStacks]). At 200% text the
 * state took 145dp of a 412dp phone's card and left the name "Review an…",
 * and on a 240dp window it left nothing.
 *
 * Stacked, as iOS's card does at the accessibility sizes, the state takes a
 * line of its own above the name at the leading edge, and the name takes the
 * whole width and up to two lines. The subagent rows' states move to the
 * leading edge with it ([SubtaskRow]), so badge and marks still make one
 * column. TalkBack hears the card the same way in either form: its agent
 * first, then its name, "Claude, Fix the login redirect"
 * ([ProjectSections.cardLead]), then its state. Claude's and Codex's cards
 * share a section, and the mark that tells them apart on the meta line is
 * not read.
 */
@Composable
private fun CardHeader(session: Session, stale: Boolean, nowMillis: Long) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (with(LocalDensity.current) { cardStacks(maxWidth) }) {
            Layout(
                content = {
                    Text(
                        text = session.displayName,
                        style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
                        color = Theme.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    StatusMark(session = session, stale = stale, nowMillis = nowMillis)
                },
                // Drawn under the state, heard before it, as when they share
                // a line. TalkBack takes a card's parts in the order they
                // stand, top to bottom, so the two are said as one here.
                modifier = Modifier.clearAndSetSemantics {
                    contentDescription =
                        "${ProjectSections.cardLead(session)}, ${spokenStatus(session, stale, nowMillis)}"
                },
            ) { measurables, constraints ->
                val loose = constraints.copy(minWidth = 0, minHeight = 0)
                val name = measurables[0].measure(loose)
                val state = measurables[1].measure(loose)
                val gap = 4.dp.roundToPx()
                val width = if (constraints.hasBoundedWidth) constraints.maxWidth else maxOf(name.width, state.width)
                layout(width, state.height + gap + name.height) {
                    state.placeRelative(0, 0)
                    name.placeRelative(0, state.height + gap)
                }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = session.displayName,
                    style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
                    color = Theme.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .clearAndSetSemantics { contentDescription = ProjectSections.cardLead(session) },
                )
                Spacer(Modifier.width(8.dp))
                StatusMark(session = session, stale = stale, nowMillis = nowMillis)
            }
        }
    }
}

// MARK: - Status

/**
 * The state as a shape, a word and a colour — in that order of reliability.
 *
 * The pulsing pill that used to live here is gone, and so is the pill. It
 * looped forever on every active card, which is ambient animation: it reported
 * nothing, it never stopped, and on a board left open all day it cost battery
 * to say the same thing continuously. Motion on this board now means something
 * changed. The pill itself was a status badge of the kind the enterprise admin
 * panel is made of; the card's own tint does that job across a far larger area.
 *
 * A stale session keeps its last reading — the word, in its colour — and
 * trades the glyph for a question: "? CODING", what the board last heard,
 * which it can no longer vouch for. Not a clock, which is idle's glyph, nor an
 * exclamation mark, which is blocked's. The "?" is drawn in the glyph's own
 * 14dp box, at its trailing edge beside the word, so the mark is exactly as
 * wide as it was: beside the name on a card, and beside the directory in the
 * history header, nothing re-wraps or cuts differently when the clock crosses
 * the line. TalkBack hears "Coding, no update for 14 minutes".
 *
 * The history screen draws this too, so the screen a card opens shows its "?".
 */
@Composable
internal fun StatusMark(session: Session, stale: Boolean, nowMillis: Long) {
    // The display status: WORKING once the turn is over and subagents still work.
    val status = session.displayStatus
    val color = Theme.colorFor(status)
    val said = spokenStatus(session, stale, nowMillis)
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        // One node reading "Coding", not a glyph and a word in sequence.
        modifier = Modifier.clearAndSetSemantics { contentDescription = said },
    ) {
        if (stale) {
            // Material's "?" is a narrow glyph centred in its square: 6.54 to
            // 17.46 of the 24 units, so at 14dp it ends 3.81dp short of the
            // box's trailing edge, where the state glyphs end 1.17dp short
            // (2 to 22: idle, coding, blocked, done) or 1.75dp (2.5 or 3 to
            // 21: planning, testing). Moved 2.6dp it ends 1.21dp short and
            // stands as far from the word as they do; the box, and so the
            // row, keeps its width.
            Icon(
                imageVector = Icons.Outlined.QuestionMark,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(14.dp).offset(x = 2.6.dp),
            )
        } else {
            Icon(
                imageVector = Theme.iconFor(status),
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(14.dp),
            )
        }
        Text(
            text = status.label.uppercase(),
            style = TextStyle(
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.6.sp,
            ),
            color = color,
            maxLines = 1,
        )
    }
}

/** What TalkBack hears for the state: "Coding", or "Coding, no update for 14 minutes". */
internal fun spokenStatus(session: Session, stale: Boolean, nowMillis: Long): String {
    val label = session.displayStatus.label
    return if (stale) "$label, no update for ${TimeFormat.spokenAge(session.updatedAt, nowMillis)}" else label
}

/** Whether a card has been composed before; flipped after its first composition. */
private class DrawnOnce {
    var value = false
}

// MARK: - Meta

/**
 * Agent, machine, place, when — four different facts, one line.
 *
 * The agent leads, as its mark ([AgentMark]): an asterisk for Claude, a
 * hexagon for Codex, a diamond for any other, in the line's own neutral ink.
 * It replaces a bordered "CLAUDE" box. With the board grouped by project,
 * Claude's and Codex's cards share a section, so every card needs its agent,
 * and a box spelling it out on every card was the loudest thing on the line
 * saying the least. The usage blocks above carry the same marks beside the
 * names, as their legend. The mark never drops and never sits alone: it
 * shares its item with the first fact, so a wrap cannot leave it at the end
 * of a line. TalkBack does not hear it, and hears the agent first instead
 * ([ProjectSections.cardLead]).
 *
 * The machine is the one the card never showed: it was buried inside the Focus
 * control's label, so two sessions of the same project on two machines were
 * indistinguishable at a glance.
 *
 * The place, "in web", only where the session has moved: its live folder is
 * real and differs from both its section and its name ([ProjectSections.place]).
 * No card under a label says "in" that label.
 *
 * It wraps, because it must. The web board shipped this same line as a
 * non-wrapping flex row and a 320px card rendered the machine name four pixels
 * wide — present to a screen reader, invisible to everyone else. A FlowRow
 * cannot fail that way: it takes a second line instead of taking it out of the
 * one item that can shrink.
 *
 * On a stale card the time is the news, so it says so: "no update for 14m", in
 * the brighter secondary ink. The words outrank the machine and the directory:
 * either of those is cut with an ellipsis when it is wider than a line, and
 * the words never are. Where they do not fit a line of their own — the largest
 * font scales on the narrowest windows — the plain "14m ago" stands in, still
 * bright. TalkBack hears none of it here: it hears "no update for 14
 * minutes" straight after the state ([StatusMark]).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetaLine(
    session: Session,
    nowMillis: Long,
    machines: Map<String, MachinePresence>,
    stale: Boolean,
) {
    val machine = session.host?.let { remember(it, machines) { FocusCopy.machineLabel(it, machines) } }
    // Where the session is now, only once it has moved away from the folder
    // its section is named after. That section is the folder it started in,
    // pinned by the server, so this is the card's one sign of a `cd`: before
    // project sections the line said "in <repo>" on every titled card, and
    // under a label that already says the repo it would say it twice.
    val place = ProjectSections.place(session)
    val facts = listOfNotNull(machine, place?.let { "in $it" })
    val time = @Composable {
        if (stale) {
            FirstThatFits(Modifier.clearAndSetSemantics {}) {
                MetaTime("no update for ${TimeFormat.age(session.updatedAt, nowMillis)}", Theme.textSecondary)
                MetaTime(TimeFormat.relative(session.updatedAt, nowMillis), Theme.textSecondary)
            }
        } else {
            MetaTime(TimeFormat.relative(session.updatedAt, nowMillis), Theme.textTertiary)
        }
    }

    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // The mark and the first fact are one item, so they wrap together.
        // In the facts' own size, so at a reader's larger text the agent is
        // still told apart at a glance.
        Row(verticalAlignment = Alignment.CenterVertically) {
            AgentMark(source = session.source, size = textDp(13.sp), tint = Theme.textTertiary)
            Spacer(Modifier.width(6.dp))
            if (facts.isEmpty()) time() else MetaFact(facts.first())
        }
        for (fact in facts.drop(1)) {
            MetaSeparator()
            MetaFact(fact)
        }
        if (facts.isNotEmpty()) {
            MetaSeparator()
            time()
        }
    }
}

@Composable
private fun MetaTime(text: String, color: Color) {
    Text(
        text = text,
        fontSize = 12.sp,
        // Tabular figures: this ticks in place on the board's clock, and
        // proportional digits make the whole line twitch sideways each time.
        //
        // Otherwise the facts' own style ([MetaFact] takes the ambient one):
        // their 24sp line and their tracking. A bare TextStyle dropped both,
        // and the time rode about 4dp above the line it ends, with tighter
        // letters, which the stale card's brighter words made plain.
        style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum"),
        color = color,
        maxLines = 1,
    )
}

/**
 * The first child that fits the width offered, else the last: the two-way
 * ViewThatFits that Compose does not have. Each child is measured once, at its
 * own full width, and only the one chosen is placed. In a FlowRow the width
 * offered is a whole line, so a child that fits is moved to a line of its own
 * rather than passed over.
 */
@Composable
internal fun FirstThatFits(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        val natural = constraints.copy(minWidth = 0, maxWidth = Constraints.Infinity)
        val placeables = measurables.map { it.measure(natural) }
        if (placeables.isEmpty()) return@Layout layout(constraints.minWidth, constraints.minHeight) {}
        val chosen = placeables.firstOrNull { it.width <= constraints.maxWidth } ?: placeables.last()
        layout(chosen.width.coerceIn(constraints.minWidth, constraints.maxWidth), chosen.height) {
            chosen.placeRelative(0, 0)
        }
    }
}

@Composable
private fun MetaFact(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        color = Theme.textTertiary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * The dot between two facts.
 *
 * [Theme.textTertiary], the same colour as the facts it separates — NOT a
 * hairline token. The web board shipped these in `--ink-700` and they were the
 * only contrast failure its audit found, all seventeen of them, at 1.52:1. The
 * strong hairline is barely better: 1.80:1 against the card. A glyph is text
 * whatever job it is doing.
 */
@Composable
private fun MetaSeparator() {
    Text(
        text = "·",
        fontSize = 12.sp,
        color = Theme.textTertiary,
        modifier = Modifier.clearAndSetSemantics {},
    )
}

// MARK: - Focus footer

/**
 * "Focus" on the machine this session runs on, a Resume control after
 * "not running", and one line of status: why the control is disabled, or how
 * the last tap went.
 *
 * The verb alone on the button. "Bring to front on Mac mini" is the better
 * sentence but it is most of a card's width, and it was the second-loudest
 * element on a card whose job is to have exactly one. The full phrasing
 * survives where width is free: the accessibility label.
 */
@Composable
private fun FocusFooter(
    host: SessionHost,
    machines: Map<String, MachinePresence>,
    status: FocusStatus?,
    nowMillis: Long,
    onCommand: (CommandType) -> Unit,
) {
    val name = remember(host, machines) { FocusCopy.machineLabel(host, machines) }
    val online = FocusCopy.isOnline(host, machines)
    // Shown under the control, and read with it: TalkBack announces a
    // disabled button as "<label>, disabled" and nothing else, while the
    // reason would otherwise only surface in the card's merged node.
    val offlineNote = if (online) null else FocusCopy.offlineNote(host, name, machines, nowMillis)

    Column(
        modifier = Modifier.padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FocusButton(
                label = "Focus",
                description = "Bring to front on $name",
                icon = Icons.Outlined.FlipToFront,
                enabled = online,
                disabledReason = offlineNote,
                onClick = { onCommand(CommandType.FOCUS) },
            )
            if (status?.offersResume == true) {
                FocusButton(
                    label = "Resume",
                    description = "Resume on $name",
                    icon = Icons.Outlined.PlayArrow,
                    enabled = online,
                    disabledReason = offlineNote,
                    onClick = { onCommand(CommandType.RESUME) },
                )
            }
        }

        when {
            status != null -> {
                val color = when (status.phase) {
                    FocusStatus.Phase.PENDING -> Theme.textSecondary
                    FocusStatus.Phase.OK -> Theme.done
                    FocusStatus.Phase.FAIL -> Theme.blocked
                }
                Text(
                    text = status.text,
                    fontSize = 12.sp,
                    color = color,
                    // Its own node, so the card's merged description doesn't
                    // become a live region and only this line is announced.
                    modifier = Modifier.semantics(mergeDescendants = true) {
                        liveRegion = LiveRegionMode.Polite
                        contentDescription = status.text
                    },
                )
            }

            offlineNote != null -> Text(
                text = offlineNote,
                fontSize = 12.sp,
                color = Theme.textTertiary,
            )
        }
    }
}

/**
 * [description] is what TalkBack reads — the whole sentence the visible label
 * abbreviates. [disabledReason], when given, becomes the state description, so
 * the label, "disabled", and why are read together.
 */
@Composable
private fun FocusButton(
    label: String,
    description: String,
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    disabledReason: String? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        modifier = modifier
            // 44dp, the comfortable target. The side padding is deliberately
            // modest: this sits on a card, and width here comes off the name.
            .defaultMinSize(minHeight = 44.dp)
            .semantics {
                contentDescription = description
                if (!enabled && disabledReason != null) stateDescription = disabledReason
            },
        // NOT the accent, though it is the card's only control.
        //
        // Filled in accent green it became the loudest thing on the card by a
        // wide margin — a 56dp saturated pill against a 20sp name — and a card
        // with two loudest elements has failed the first design principle. The
        // state is what you read; this is what you do about it, and it waits.
        // iOS's FocusButtonStyle is the same raised surface and hairline.
        //
        // Disabled drops to the card surface rather than rising above it, so
        // "no listener on that machine" reads as recessed at a glance and not
        // only in the label's brightness.
        colors = ButtonDefaults.buttonColors(
            containerColor = Theme.raised,
            contentColor = Theme.textPrimary,
            disabledContainerColor = Theme.card,
            disabledContentColor = Theme.textTertiary,
        ),
        border = BorderStroke(1.dp, Theme.cardBorder),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            text = label,
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
