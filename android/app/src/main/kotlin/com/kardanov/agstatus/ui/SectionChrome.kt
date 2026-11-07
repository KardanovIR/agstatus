package com.kardanov.agstatus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.ProjectSection
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.Theme
import java.util.Locale

/**
 * The chrome of the board grouped by project (docs/design/project-sections.md):
 * the label over each section and the agents' marks. What they say is worked
 * out in ProjectSections (Models.kt), so it can be tested; these only draw it.
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

// MARK: - Layout

/**
 * The first child whose one line fits the width offered, else the last, which
 * is then measured at that width so it can cut itself short: the count before
 * the name goes, then the name's middle. Fit is asked of each child's
 * intrinsic width, so only the chosen one is measured, and so the last one can
 * be measured at the real width rather than its own.
 */
@Composable
private fun FirstFitting(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
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
