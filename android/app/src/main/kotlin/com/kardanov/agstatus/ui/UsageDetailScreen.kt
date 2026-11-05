package com.kardanov.agstatus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kardanov.agstatus.ProjectTotal
import com.kardanov.agstatus.SessionStore
import com.kardanov.agstatus.Theme
import com.kardanov.agstatus.UsageDetail
import com.kardanov.agstatus.UsageHistory
import com.kardanov.agstatus.UsageSeries
import com.kardanov.agstatus.sourceDisplayName
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * One agent's last thirty days: the tokens it actually spent, the plan limits
 * recorded over the same span, and where those tokens went. Mirrors the web
 * dashboard's usage detail view (public/app.js, "usage detail") so every
 * client tells the same story with the same numbers.
 *
 * The endpoint behind it is new. An older server 404s, the store turns that
 * into an empty [UsageHistory], and this screen simply draws nothing — it
 * never fails loudly over a board that predates the feature.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageDetailScreen(
    store: SessionStore,
    source: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val usage by store.usage.collectAsState()
    val info = usage.firstOrNull { it.source == source }
    val name = info?.displayName ?: sourceDisplayName(source)

    var data by remember(source) { mutableStateOf(UsageHistory()) }
    var loaded by remember(source) { mutableStateOf(false) }
    var refreshing by remember(source) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Live, like the session timeline: a fresh limit reading on the board is a
    // fresh point on this chart.
    LaunchedEffect(source, info?.updatedAt) {
        data = store.usageHistory()
        loaded = true
    }

    val days = remember(data) { UsageDetail.dayRange(data.days.coerceIn(1, UsageDetail.MAX_DAYS)) }
    val tokensPerDay = remember(data, source, days) {
        UsageDetail.tokensPerDay(data.projects, source, days)
    }
    val projects = remember(data, source) { UsageDetail.projectTotals(data.projects, source) }
    val series = remember(data, source) { data.history.filter { it.source == source } }
    // Each window on the day grid, which both the chart and its keys read: a
    // window with a single day's reading is a mark in the one and the other.
    val sampled = remember(series, days) { series.map { UsageDetail.sampleSeries(it.points, days) } }
    val totalTokens = remember(tokensPerDay) { tokensPerDay.sum() }
    val maxTokens = remember(tokensPerDay) { max(1L, tokensPerDay.maxOrNull() ?: 0L) }

    // What TalkBack hears in the chart's place, in the words VoiceOver and a
    // web screen reader hear. A window goes by the name the board's own block
    // gives it ("Weekly (all models)"), and one the board no longer reports
    // keeps its id, as its key does.
    val labels = remember(info) {
        info?.windows.orEmpty().distinctBy { it.id }.associate { it.id to it.displayLabel }
    }
    val tokensSummary = remember(name, days, tokensPerDay) {
        UsageDetail.tokensSummary(name, days, tokensPerDay)
    }
    val limitsSummary = remember(name, days, series, sampled, labels) {
        UsageDetail.limitsSummary(name, days, series.map { it.windowId }, sampled, labels)
    }

    Scaffold(
        modifier = modifier,
        containerColor = Theme.background,
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "$name · last ${days.size} days",
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Theme.background,
                    scrolledContainerColor = Theme.background,
                    titleContentColor = Theme.textPrimary,
                    navigationIconContentColor = Theme.textPrimary,
                    actionIconContentColor = Theme.textPrimary,
                ),
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                scope.launch {
                    refreshing = true
                    data = store.usageHistory()
                    loaded = true
                    refreshing = false
                }
            },
            modifier = Modifier
                .padding(padding)
                .fillMaxSize(),
        ) {
            if (!loaded) {
                LoadingState()
            } else {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp)
                        .padding(top = 4.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    DetailCard {
                        ChartHeader(totalTokens = totalTokens, series = series, sampled = sampled)
                        TokensChart(
                            days = days,
                            tokensPerDay = tokensPerDay,
                            maxTokens = maxTokens,
                            sampled = sampled,
                            tokensSummary = tokensSummary,
                            limitsSummary = limitsSummary,
                            modifier = Modifier.padding(top = 6.dp),
                        )
                    }

                    DetailCard {
                        SectionTitle("WHERE THE TOKENS WENT")
                        if (projects.isEmpty()) {
                            Text(
                                text = "No per-project token data reported yet.",
                                fontSize = 13.sp,
                                color = Theme.textSecondary,
                                modifier = Modifier.padding(top = 8.dp),
                            )
                        } else {
                            // Bar widths compare projects to the biggest one;
                            // the percentage is of everything this agent spent.
                            val largest = max(1L, projects.first().tokens)
                            for (total in projects) {
                                ProjectRow(
                                    total = total,
                                    share = (total.tokens.toDouble() / largest).toFloat(),
                                    percent = if (totalTokens > 0L) {
                                        (total.tokens * 100.0 / totalTokens).roundToInt()
                                    } else {
                                        0
                                    },
                                    modifier = Modifier.padding(top = 10.dp),
                                )
                            }
                        }
                    }

                    // The two series share an axis but not a unit, and saying so
                    // is the whole reason this note is not optional.
                    Text(
                        text = "Bars are tokens your agent spent, read from its own local logs. " +
                            "Lines are the account-wide plan limit, recorded from when this " +
                            "board first saw it. They track each other but are not the same measure.",
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        color = Theme.textTertiary,
                        modifier = Modifier.padding(horizontal = 2.dp),
                    )
                }
            }
        }
    }
}

// MARK: - Cards

@Composable
private fun DetailCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Theme.card, shape)
            .border(1.dp, Theme.cardBorder, shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        content = content,
    )
}

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = Theme.textSecondary,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        // A heading, so TalkBack can move between the two cards as VoiceOver
        // does on iOS and a screen reader does between the web's h3s.
        modifier = modifier.semantics { heading() },
    )
}

/** "TOKENS PER DAY · 512.4M total" on the left, the line legend on the right. */
@Composable
private fun ChartHeader(totalTokens: Long, series: List<UsageSeries>, sampled: List<List<Double?>>) {
    // A phone width cannot hold the title and three legend keys on one line
    // without cutting one of them, so there the legend drops underneath.
    val wide = LocalConfiguration.current.screenWidthDp >= 600
    if (wide) {
        // The title keeps its width and the keys wrap in the rest, right
        // aligned, so a sixth window adds a row of keys, not a cut title.
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.Top,
        ) {
            ChartTitle(
                totalTokens = totalTokens,
                modifier = Modifier.padding(end = 16.dp),
            )
            ChartLegend(series, sampled, Modifier.weight(1f), alignment = Alignment.End)
        }
    } else {
        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ChartTitle(totalTokens, Modifier.fillMaxWidth())
            ChartLegend(series, sampled, Modifier.fillMaxWidth(), alignment = Alignment.Start)
        }
    }
}

@Composable
private fun ChartTitle(totalTokens: Long, modifier: Modifier = Modifier) {
    Row(modifier = modifier) {
        SectionTitle("TOKENS PER DAY", Modifier.alignByBaseline())
        // Weighted, so a cramped header trims the total rather than the label.
        val total = UsageDetail.fmtTokens(totalTokens)
        Text(
            text = " · $total total",
            fontSize = 11.sp,
            color = Theme.textTertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .alignByBaseline()
                .weight(1f, fill = false)
                // Not the "·", which is layout; iOS says the same.
                .clearAndSetSemantics { contentDescription = "$total tokens in total" },
        )
    }
}

/**
 * One key per window, in the order the lines are drawn, each what the chart
 * draws for its window: a sample of its line, or its mark while it has a
 * single reading. The keys wrap as words do, one row where they fit and a new
 * row where the next does not, so six windows take two rows rather than
 * three with a cut-off name.
 */
@Composable
private fun ChartLegend(
    series: List<UsageSeries>,
    sampled: List<List<Double?>>,
    modifier: Modifier = Modifier,
    alignment: Alignment.Horizontal = Alignment.End,
) {
    if (series.isEmpty()) {
        Text(
            text = "limit history starts once reported",
            fontSize = 10.sp,
            color = Theme.textTertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = modifier,
        )
        return
    }
    FlowRow(
        // The keys are for eyes. TalkBack hears every window named, with its
        // readings, from the chart (TokensChart), as on iOS and the web.
        modifier = modifier.clearAndSetSemantics { },
        horizontalArrangement = Arrangement.spacedBy(12.dp, alignment),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for ((index, entry) in series.withIndex()) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (UsageDetail.isSingleReading(sampled.getOrElse(index) { emptyList() })) {
                    MarkKey(index)
                } else {
                    LineKey(index)
                }
                Text(
                    text = entry.windowId,
                    fontSize = 10.sp,
                    color = Theme.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * A limit line's key: a sample of the line, drawn as the chart draws it, so
 * key and line match by pattern as well as by hue. It holds as many whole
 * marks as fit, so no key ends in a stub that reads as another pattern.
 */
@Composable
private fun LineKey(index: Int) {
    val color = Theme.usageLineColor(index)
    val dash = Theme.usageLineDash(index)
    Canvas(Modifier.size(width = KEY_WIDTH, height = 6.dp)) {
        val lineWidth = Theme.USAGE_LINE_WIDTH.dp.toPx()
        val length = UsageDetail.keySampleLength(dash, Theme.USAGE_LINE_WIDTH, KEY_WIDTH.value).dp.toPx()
        val start = (size.width - length) / 2f + lineWidth / 2f
        drawLine(
            color = color,
            start = Offset(start, size.height / 2f),
            end = Offset(start + length - lineWidth, size.height / 2f),
            strokeWidth = lineWidth,
            cap = StrokeCap.Round,
            pathEffect = dashEffect(dash),
        )
    }
}

/**
 * A single reading's key: its mark, as the chart draws it, without the
 * casing, which on the card it sits on draws nothing. A triangle is centred on
 * its box here, beside the name, and on its centroid in the chart. It grows
 * with the text as the chart's marks do.
 */
@Composable
private fun MarkKey(index: Int) {
    val growth = UsageDetail.growth(LocalDensity.current.fontScale)
    val mark = Theme.usageMark(index)
    val color = Theme.usageLineColor(index)
    Canvas(Modifier.size(12.dp * growth)) {
        val centre = Offset(size.width / 2f, size.height / 2f + mark.centreBelowMiddle.dp.toPx() * growth)
        drawPath(markPath(mark, centre, growth), color)
    }
}

private val KEY_WIDTH = 26.dp

/** A line's pattern as a path effect, in px; none for a solid line. */
private fun DrawScope.dashEffect(dash: List<Float>): PathEffect? =
    if (dash.isEmpty()) null else PathEffect.dashPathEffect(FloatArray(dash.size) { dash[it].dp.toPx() }, 0f)

/** [mark] as a path round [centre], [growth] times its size at the default text size. */
private fun DrawScope.markPath(mark: Theme.UsageMark, centre: Offset, growth: Float): Path {
    val unit = 1.dp.toPx() * growth
    return Path().apply {
        if (mark == Theme.UsageMark.CIRCLE) {
            addOval(Rect(centre, Theme.UsageMark.CIRCLE_RADIUS * unit))
        } else {
            mark.outline.forEachIndexed { i, point ->
                val x = centre.x + point.x * unit
                val y = centre.y + point.y * unit
                if (i == 0) moveTo(x, y) else lineTo(x, y)
            }
            close()
        }
    }
}

// MARK: - Chart

/** The plot's height at the default text size; it grows with the text. */
private val PLOT_HEIGHT = 166.dp

/**
 * Tokens per day as bars against the left axis, each recorded limit window as
 * a line against the right axis, on one shared 30-day scale. Hand-drawn on a
 * Canvas — the app carries no charting dependency.
 *
 * TalkBack has the two measures in the chart's place as two summaries, as
 * VoiceOver has two charts on iOS: [tokensSummary] over the upper half and
 * [limitsSummary] over the lower, so a swipe reads them in turn and a touch
 * finds one. It used to hear one fixed sentence and none of the numbers.
 */
@Composable
private fun TokensChart(
    days: List<String>,
    tokensPerDay: List<Long>,
    maxTokens: Long,
    sampled: List<List<Double?>>,
    tokensSummary: String,
    limitsSummary: String?,
    modifier: Modifier = Modifier,
) {
    Box(modifier = modifier.fillMaxWidth()) {
        ChartCanvas(days, tokensPerDay, maxTokens, sampled)
        Column(Modifier.matchParentSize()) {
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .semantics { contentDescription = tokensSummary },
            )
            if (limitsSummary != null) {
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .semantics { contentDescription = limitsSummary },
                )
            }
        }
    }
}

/** The chart as drawn. For eyes: TalkBack hears [TokensChart]'s summaries. */
@Composable
private fun ChartCanvas(
    days: List<String>,
    tokensPerDay: List<Long>,
    maxTokens: Long,
    sampled: List<List<Double?>>,
) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val axisStyle = remember { TextStyle(fontSize = 9.sp, color = Theme.textTertiary) }
    val topLabel = remember(maxTokens) { UsageDetail.fmtTokens(maxTokens) }
    val barColor = Theme.usageTokenBar
    val gridColor = Theme.cardBorder

    // The plot grows at half the rate of the reader's text, as on iOS and the
    // web, and the space above and below it holds its labels at their size:
    // half a label over the plot for "100%", and under it half a label for
    // "0%", a gap and the dates. At the default size these are the 10 and
    // 20dp they always were.
    val growth = UsageDetail.growth(density.fontScale)
    val labelHeight = remember(measurer, density) {
        with(density) { measurer.measure("0", axisStyle).size.height.toDp() }
    }
    val above = maxOf(10.dp, labelHeight / 2 + 1.dp)
    val below = maxOf(20.dp, labelHeight / 2 + 3.dp + labelHeight + 1.dp)

    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(above + PLOT_HEIGHT * growth + below),
    ) {
        if (days.isEmpty()) return@Canvas
        // The insets are measured from the labels, so they fit at any text
        // size, and never under the 40 and 34dp they always were. Today's mark
        // for a single reading reaches past the plot's right edge, and grows
        // with the plot, so the gap before the percentages grows by the same
        // rule and the mark never meets "100%".
        val percentLabels = (0..100 step 25).map { it to measurer.measure("$it%", axisStyle) }
        val maxLabel = measurer.measure(topLabel, axisStyle)
        val zeroLabel = measurer.measure("0", axisStyle)
        val gap = 8.dp.toPx()
        val percentGap = 6.dp.toPx() * growth
        val left = max(40.dp.toPx(), max(maxLabel.size.width, zeroLabel.size.width) + gap)
        val right = max(34.dp.toPx(), percentLabels.maxOf { it.second.size.width } + percentGap)
        val top = above.toPx()
        val bottom = below.toPx()
        val plotWidth = size.width - left - right
        val plotHeight = size.height - top - bottom
        if (plotWidth <= 0f || plotHeight <= 0f) return@Canvas

        // A day is a bar's width, and the first and last days sit half a bar
        // in from the plot's edges, as on iOS and the web. Centred on the
        // edges, half of today's bar, and today's mark, ran under "100%".
        val lastIndex = days.lastIndex
        val barWidth = max(2.dp.toPx(), (plotWidth / days.size) * 0.62f)
        val dayStep = if (lastIndex > 0) (plotWidth - barWidth) / lastIndex else 0f
        fun xAt(index: Int): Float =
            if (lastIndex == 0) left + plotWidth / 2f else left + barWidth / 2f + index * dayStep

        fun yAt(percent: Double): Float =
            top + plotHeight - (percent.coerceIn(0.0, 100.0) / 100.0).toFloat() * plotHeight

        // Grid, and the right-hand percentage axis the lines are read against.
        for ((percent, label) in percentLabels) {
            val gridY = yAt(percent.toDouble())
            drawLine(
                color = gridColor,
                start = Offset(left, gridY),
                end = Offset(size.width - right, gridY),
                strokeWidth = 1.dp.toPx(),
            )
            drawText(
                textLayoutResult = label,
                topLeft = Offset(
                    size.width - right + percentGap,
                    gridY - label.size.height / 2f,
                ),
            )
        }

        // Left-hand axis: only the busiest day and zero, because the bars are
        // a relative shape, not a table.
        drawText(
            textLayoutResult = maxLabel,
            topLeft = Offset(left - gap - maxLabel.size.width, top - maxLabel.size.height / 2f),
        )
        drawText(
            textLayoutResult = zeroLabel,
            topLeft = Offset(
                left - gap - zeroLabel.size.width,
                top + plotHeight - zeroLabel.size.height / 2f,
            ),
        )

        // Bars: tokens spent, scaled to the busiest day.
        for (index in days.indices) {
            val tokens = tokensPerDay.getOrElse(index) { 0L }
            if (tokens <= 0L) continue
            val height = (tokens.toDouble() / maxTokens.toDouble()).toFloat() * plotHeight
            drawRoundRect(
                color = barColor,
                topLeft = Offset(xAt(index) - barWidth / 2f, top + plotHeight - height),
                size = Size(barWidth, height),
                cornerRadius = CornerRadius(1.5.dp.toPx()),
            )
        }

        // Lines: the plan limits, over the bars, each in its own colour and
        // pattern. Each is cased in the card's colour first, 1.25dp each side,
        // so it holds where it crosses a bar and passes visibly over the lines
        // drawn before it. Uncased, a line over a bar is 1.83:1 (blocked) to
        // 2.81:1 (done, the bars' own green); cased, its neighbour is the card,
        // 5.70:1 at the least.
        val lineWidth = Theme.USAGE_LINE_WIDTH.dp.toPx()
        val casing = 2.5.dp.toPx()
        for ((seriesIndex, values) in sampled.withIndex()) {
            val color = Theme.usageLineColor(seriesIndex)
            if (values.none { it != null }) continue
            if (UsageDetail.isSingleReading(values)) {
                // A board that has only just started recording a window holds
                // a single reading, and a one-point path draws nothing at all:
                // mark it with the window's shape, cased as a line is.
                val index = values.indexOfFirst { it != null }
                val mark = markPath(
                    Theme.usageMark(seriesIndex),
                    Offset(xAt(index), yAt(values[index] ?: 0.0)),
                    growth,
                )
                drawPath(mark, Theme.card, style = Stroke(width = casing, join = StrokeJoin.Round))
                drawPath(mark, color)
                continue
            }
            val path = Path()
            var started = false
            for (index in values.indices) {
                val value = values[index] ?: continue
                val pointX = xAt(index)
                val pointY = yAt(value)
                if (started) path.lineTo(pointX, pointY) else path.moveTo(pointX, pointY)
                started = true
            }
            drawPath(
                path = path,
                color = Theme.card,
                style = Stroke(width = lineWidth + casing, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
            drawPath(
                path = path,
                color = color,
                style = Stroke(
                    width = lineWidth,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                    pathEffect = dashEffect(Theme.usageLineDash(seriesIndex)),
                ),
            )
        }

        // Day ticks, every seventh day plus the final one when it fits.
        val tickY = size.height - bottom + 4.dp.toPx()
        for (index in days.indices) {
            if (!UsageDetail.showTick(index, lastIndex)) continue
            val label = measurer.measure(UsageDetail.dayLabel(days[index]), axisStyle)
            val tickX = (xAt(index) - label.size.width / 2f)
                .coerceIn(0f, max(0f, size.width - label.size.width))
            drawText(textLayoutResult = label, topLeft = Offset(tickX, tickY))
        }
    }
}

// MARK: - Projects

@Composable
private fun ProjectRow(
    total: ProjectTotal,
    share: Float,
    percent: Int,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = total.project,
                fontSize = 13.sp,
                color = Theme.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .alignByBaseline()
                    .weight(1f)
                    .padding(end = 10.dp),
            )
            Text(
                text = UsageDetail.fmtTokens(total.tokens),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = Theme.textPrimary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
            Text(
                text = " $percent%",
                fontSize = 12.sp,
                color = Theme.textTertiary,
                maxLines = 1,
                modifier = Modifier.alignByBaseline(),
            )
        }
        Canvas(modifier = Modifier.fillMaxWidth().height(6.dp)) {
            val radius = CornerRadius(size.height / 2)
            // Theme.raised, the surface token for exactly this. White at 6%
            // over the new ground is not that colour, and drifts from it.
            drawRoundRect(color = Theme.raised, cornerRadius = radius)
            if (share > 0f) {
                // A hairline keeps the smallest project visible next to the top one.
                val filled = max(size.width * share, 4.dp.toPx())
                drawRoundRect(
                    // Solid. This was a blue-to-lighter-blue gradient with a
                    // hand-typed #7CC0FF on the end of it — decoration on a
                    // bar whose only job is to be read as a length, and the
                    // one hex in this app that belonged to no token at all.
                    color = Theme.usageTokenBar,
                    size = Size(filled, size.height),
                    cornerRadius = radius,
                )
            }
        }
    }
}

// MARK: - Loading

@Composable
private fun LoadingState() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Theme.textSecondary)
    }
}
