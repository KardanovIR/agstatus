package com.kardanov.agstatus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.Layout
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
import com.kardanov.agstatus.FocusCopy
import com.kardanov.agstatus.FocusStatus
import com.kardanov.agstatus.MachinePresence
import com.kardanov.agstatus.Session
import com.kardanov.agstatus.SessionHost
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
    onCommand: (CommandType) -> Unit = {},
) {
    val stale = session.isStale(nowMillis)
    val shape = RoundedCornerShape(16.dp)

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
            .background(Theme.cardSurface(session.status, stale))
            .border(1.dp, Theme.cardEdge(session.status, stale), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
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
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            StatusMark(session = session, stale = stale, nowMillis = nowMillis)
        }

        if (session.message.isNotEmpty()) {
            Text(
                text = session.message,
                fontSize = 14.sp,
                color = Theme.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
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
    val status = session.status
    val color = Theme.colorFor(status)
    val said = if (stale) {
        "${status.label}, no update for ${TimeFormat.spokenAge(session.updatedAt, nowMillis)}"
    } else {
        status.label
    }
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

// MARK: - Meta

/**
 * Agent, machine, directory, when — four different facts, one line.
 *
 * The machine is the one the card never showed: it was buried inside the Focus
 * control's label, so two sessions of the same project on two machines were
 * indistinguishable at a glance.
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
    val project = session.project.takeIf { it.isNotEmpty() && it != session.displayName }

    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        // Which agent, as a word in a box. No glyph: "CLAUDE" and "CODEX" are
        // already distinct at a glance, and the one mark this card needs to
        // carry without colour is the status.
        Text(
            text = session.source.uppercase(),
            style = TextStyle(
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.4.sp,
            ),
            color = Theme.textTertiary,
            maxLines = 1,
            modifier = Modifier
                .border(1.dp, Theme.cardBorder, RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp),
        )
        if (machine != null) {
            MetaSeparator()
            MetaFact(machine)
        }
        // Only when it says something the name does not. The name is the
        // session's title when the agent has one (the Claude app titles every
        // session) and the folder it started in otherwise, while `project`
        // follows the live directory — with a Claude worktree root reported as
        // its repository, not the folder name the app made up. So a titled card
        // shows "in <repo>", where that work is happening, and an untitled one
        // shows the directory once the session has MOVED. At a worktree root it
        // shows from the first event, because the name is the worktree's own
        // folder and the project its repository ("feature-x · in my-repo");
        // anywhere else the two are the same word until the session moves.
        if (project != null) {
            MetaSeparator()
            MetaFact("in $project")
        }
        MetaSeparator()
        if (stale) {
            FirstThatFits(Modifier.clearAndSetSemantics {}) {
                MetaTime("no update for ${TimeFormat.age(session.updatedAt, nowMillis)}", Theme.textSecondary)
                MetaTime(TimeFormat.relative(session.updatedAt, nowMillis), Theme.textSecondary)
            }
        } else {
            MetaTime(TimeFormat.relative(session.updatedAt, nowMillis), Theme.textTertiary)
        }
    }
}

@Composable
private fun MetaTime(text: String, color: Color) {
    Text(
        text = text,
        // Tabular figures: this ticks in place on the board's clock, and
        // proportional digits make the whole line twitch sideways each time.
        style = TextStyle(fontSize = 12.sp, fontFeatureSettings = "tnum"),
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
private fun FirstThatFits(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
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
