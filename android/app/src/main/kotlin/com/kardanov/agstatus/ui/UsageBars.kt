package com.kardanov.agstatus.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.ProjectSections
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.agentHeadDescription
import com.kardanov.agstatus.rememberReduceMotion
import com.kardanov.agstatus.UsageInfo
import com.kardanov.agstatus.UsageWindow
import kotlinx.coroutines.delay
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Full-width plan-limit bars pinned above the board: one row per reported
 * window (current 5-hour session, weekly caps, …). [sessionCounts] is how
 * many sessions each agent, by source, has on the board, done included.
 */
@Composable
fun UsageBars(
    usage: List<UsageInfo>,
    onOpenDetail: (String) -> Unit,
    modifier: Modifier = Modifier,
    sessionCounts: Map<String, Int> = emptyMap(),
    firstBlock: Modifier = Modifier,
    lastBlock: Modifier = Modifier,
) {
    // Redraws every minute so the "resets in …" countdowns stay honest.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            now = System.currentTimeMillis()
        }
    }

    val wide = LocalConfiguration.current.screenWidthDp >= 600
    BoxWithConstraints(modifier = modifier.fillMaxWidth()) {
        // Up to three blocks abreast, two on a phone-width screen, wrapping to
        // further rows. Never more columns than blocks, so a lone agent spans
        // the full width instead of leaving a hole. And fewer where that would
        // leave a block less than ten ems of its reading's text across, as
        // the web board's blocks go one to a row: at 200% two on a phone left
        // each 7, and every name and reset in them came down to a few letters
        // ("CURRENT S…", "resets …"). Two stay at the default size on any
        // phone from 360dp up, and on a 412dp one up to 130%.
        val em = textDp(12.sp)
        var columns = max(1, minOf(usage.size, if (wide) 3 else 2))
        while (columns > 1 && (maxWidth - 10.dp * (columns - 1)) / columns - 28.dp < em * 10) columns--
        // Sharing a phone width leaves each block too narrow for a one-line row;
        // those stack the label above the value instead.
        val narrow = !wide && columns > 1

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            usage.chunked(columns).forEachIndexed { r, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEachIndexed { c, info ->
                        val at = r * columns + c
                        UsageSourceBlock(
                            info = info,
                            sessions = sessionCounts[info.source] ?: 0,
                            nowMillis = now,
                            narrow = narrow,
                            onOpenDetail = onOpenDetail,
                            modifier = Modifier
                                .weight(1f)
                                .then(if (at == 0) firstBlock else Modifier)
                                .then(if (at == usage.lastIndex) lastBlock else Modifier),
                        )
                    }
                    // Keep a short final row aligned with the ones above it.
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/**
 * One agent's limits: its name over its own bars, in its own card. The header
 * carries the agent name so the rows inside don't repeat it, and how many
 * [sessions] it has on the board. Tapping the block opens that agent's 30-day
 * usage detail; the layout is unchanged, so the affordance is carried by the
 * tap label screen readers announce.
 */
@Composable
private fun UsageSourceBlock(
    info: UsageInfo,
    sessions: Int,
    nowMillis: Long,
    narrow: Boolean,
    onOpenDetail: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = modifier
            .clip(shape)
            .background(Theme.card, shape)
            .border(1.dp, Theme.cardBorder, shape)
            .clickable(onClickLabel = "Show ${info.displayName} usage detail") {
                onOpenDetail(info.source)
            }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // The agent's mark beside its name: the legend for the marks that
        // lead every card's meta line, now that Claude's and Codex's cards
        // share a project's section. Then how many sessions it has on the
        // board, in a label's quiet ink, where the line has room for it: the
        // count goes before any letter of the name does, since the name is
        // what says whose limits these are. TalkBack is not shown the mark,
        // and hears the name and the count whether or not the count is drawn.
        val name = @Composable { nameModifier: Modifier ->
            AgentMark(source = info.source, size = textDp(12.sp), tint = Theme.textSecondary)
            Text(
                text = info.displayName.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = Theme.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = nameModifier,
            )
        }
        FirstFitting(Modifier.clearAndSetSemantics { contentDescription = agentHeadDescription(info.source, sessions) }) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                name(Modifier.alignByBaseline())
                if (sessions > 0) {
                    Text(
                        text = ProjectSections.sessionCount(sessions),
                        style = TextStyle(fontSize = 12.sp, fontFeatureSettings = "tnum"),
                        color = Theme.textTertiary,
                        maxLines = 1,
                        modifier = Modifier
                            .alignByBaseline()
                            .padding(start = 2.dp),
                    )
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                name(Modifier)
            }
        }
        val rows = @Composable { stacked: Boolean ->
            for (window in info.windows) {
                UsageBarRow(
                    sourceName = info.displayName,
                    window = window,
                    nowMillis = nowMillis,
                    stacked = stacked,
                )
            }
        }
        if (narrow) {
            rows(true)
        } else {
            // Every name beside its reading while all of them fit a line, and
            // every one above it when one does not: one block, one form.
            FirstFitting {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { rows(false) }
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { rows(true) }
            }
        }
    }
}

@Composable
private fun UsageBarRow(
    sourceName: String,
    window: UsageWindow,
    nowMillis: Long,
    stacked: Boolean = false,
) {
    val barColor = Theme.usageColor(window.usedPct)
    val pctText = "${window.usedPct.roundToInt()}%"
    val reset = resetText(window.resetsAt, nowMillis)
    // The bar slides to its new length because the number changed, which is
    // the one reason this board animates anything. A device asked for less
    // motion gets the new length immediately instead.
    val reduceMotion = rememberReduceMotion()
    val fraction by animateFloatAsState(
        targetValue = window.fraction,
        animationSpec = if (reduceMotion) snap() else spring(),
        label = "usageFraction",
    )

    val description = buildString {
        append("$sourceName ${window.displayLabel}: $pctText used")
        if (reset != null) append(", $reset")
    }

    Column(
        modifier = Modifier.clearAndSetSemantics { contentDescription = description },
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        // A name takes a second line rather than being cut, balanced so its
        // lines come out even: "SESSION" over "(GPT-6-ASTRA)". A block is
        // never under ten ems across (UsageBars), and that holds the longest
        // model's name on a line.
        val label: @Composable (Modifier) -> Unit = { m ->
            Text(
                text = window.displayLabel.uppercase(),
                style = MaterialTheme.typography.labelSmall.copy(lineBreak = LineBreak.Heading),
                color = Theme.textSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = m,
            )
        }
        // The share, then when it resets, which wraps under itself rather than
        // being cut, with "2d 5h" kept on one line.
        val reading: @Composable RowScope.() -> Unit = {
            Text(
                text = pctText,
                style = TextStyle(
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    fontFeatureSettings = "tnum",
                ),
                color = Theme.textPrimary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
            if (reset != null) {
                Text(
                    text = " · ${holdUnits(reset)}",
                    fontSize = 11.sp,
                    color = Theme.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.alignByBaseline(),
                )
            }
        }
        if (stacked) {
            // Each half of a phone screen fits the label OR the value, not both.
            label(Modifier.fillMaxWidth())
            Row(modifier = Modifier.fillMaxWidth(), content = reading)
        } else {
            Row(modifier = Modifier.fillMaxWidth()) {
                label(
                    Modifier
                        .alignByBaseline()
                        .weight(1f)
                        .padding(end = 8.dp),
                )
                reading()
            }
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(6.dp)) {
            val radius = CornerRadius(size.height / 2)
            // Theme.raised, the surface token for exactly this. White at 6%
            // over the new ground is not that colour, and drifts from it.
            drawRoundRect(color = Theme.raised, cornerRadius = radius)
            if (fraction > 0f) {
                // A hairline of progress stays visible even at ~0%.
                val filled = max(size.width * fraction, 4.dp.toPx())
                drawRoundRect(
                    color = barColor,
                    size = Size(filled, size.height),
                    cornerRadius = radius,
                )
            }
        }
    }
}

/** "resets in 2d 5h" with its two units on one line. */
private fun holdUnits(text: String): String = text.replace(Regex("(\\d+[dhm]) (\\d+[dhm])$"), "$1\u00A0$2")

/** "resets in 2h 15m" — null once the reset time is unknown or passed. */
internal fun resetText(resetsAt: Long?, nowMillis: Long): String? {
    if (resetsAt == null) return null
    val seconds = ((resetsAt - nowMillis) / 1000L).toInt()
    if (seconds <= 60) return if (seconds > 0) "resets soon" else null
    // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
    val totalMinutes = (seconds + 30) / 60
    if (totalMinutes < 60) return "resets in ${totalMinutes}m"
    val totalHours = totalMinutes / 60
    if (totalHours < 24) {
        val minutes = totalMinutes % 60
        return if (minutes > 0) "resets in ${totalHours}h ${minutes}m" else "resets in ${totalHours}h"
    }
    val days = totalHours / 24
    val hours = totalHours % 24
    return if (hours > 0) "resets in ${days}d ${hours}h" else "resets in ${days}d"
}
