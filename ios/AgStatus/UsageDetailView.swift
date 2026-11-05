//
//  UsageDetailView.swift
//  AgStatus
//
//  One agent's last 30 days: the tokens it spent each day (bars) with the
//  plan-limit readings recorded over them (lines), and where those tokens
//  went. Two different units share one time axis on purpose — the bars come
//  from the agent's own local logs, the lines are the account-wide plan limit
//  the board has been watching — so the screen says so at the bottom.
//
//  The chart is drawn by hand in a Canvas: the Charts framework would raise
//  the deployment target for one screen.
//

import Accessibility
import SwiftUI

// MARK: - Route

/// Navigation value for this screen. Its own type keeps the destination
/// distinct from the board's plain-String session-id destination.
struct UsageDetailRoute: Hashable {
    let source: String
}

// MARK: - Screen

struct UsageDetailView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dynamicTypeSize) private var typeSize
    let source: String

    @State private var detail = UsageDetailData(history: .empty, source: "")
    /// What the board calls each of this agent's windows ("Weekly (all
    /// models)"), which is what VoiceOver says for them on the board too. A
    /// window the board no longer reports keeps its id, as the legend does.
    /// Taken at each load rather than read in `body`, where every usage
    /// report the board receives would draw the screen again.
    @State private var windowNames: [String: String] = [:]
    @State private var loaded = false

    private var name: String {
        UsageInfo.displayName(for: source)
    }

    var body: some View {
        Group {
            if loaded {
                content
            } else {
                loadingState
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("\(name) · last \(detail.days.count) days")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.background, for: .navigationBar)
        .task { await load() }
    }

    private var content: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    tokensCard
                    projectsCard
                        .id(Section.projects)
                    note
                        .id(Section.note)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .refreshable { await load() }
            #if DEBUG
            .task {
                try? await Task.sleep(for: .milliseconds(300))
                scrollForScreenshots(scroller)
            }
            #endif
        }
    }

    private enum Section: String {
        case projects, note
    }

    #if DEBUG
    /// AGSTATUS_USAGE_SCROLL=projects|note scrolls to that part of the screen
    /// once it is laid out. At the accessibility sizes the chart alone fills a
    /// phone's first screen, and simctl cannot scroll.
    private func scrollForScreenshots(_ scroller: ScrollViewProxy) {
        guard let section = ProcessInfo.processInfo.environment["AGSTATUS_USAGE_SCROLL"]
            .flatMap(Section.init(rawValue:)) else { return }
        scroller.scrollTo(section, anchor: section == .note ? .bottom : .top)
    }
    #endif

    private var loadingState: some View {
        ProgressView()
            .controlSize(.large)
            .tint(Theme.textSecondary)
    }

    /// Demo mode never touches the network. A real board may be talking to a
    /// server old enough to have no history endpoint at all: that 404 (like any
    /// other failure) leaves an empty screen rather than an error.
    private func load() async {
        let windows = store.usage.first { $0.source == source }?.windows ?? []
        windowNames = Dictionary(windows.map { ($0.id, $0.label) }, uniquingKeysWith: { first, _ in first })
        if store.isDemo {
            detail = UsageDetailData(history: DemoData.usageHistory(), source: source)
            loaded = true
            return
        }
        guard let board = store.board else {
            loaded = true
            return
        }
        let fetched = (try? await AgStatusAPI.usageHistory(days: UsageHistory.defaultDays,
                                                           for: board)) ?? .empty
        detail = UsageDetailData(history: fetched, source: source)
        loaded = true
    }

    /// A card's title: small capitals over what it holds, and a heading for
    /// VoiceOver's rotor, as the board's heads and group labels are.
    private func sectionTitle(_ title: String) -> some View {
        Text(title)
            .font(.system(.caption2, design: .rounded).weight(.bold))
            .kerning(0.6)
            .textCase(.uppercase)
            .foregroundStyle(Theme.textSecondary)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Tokens per day

    private var tokensCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    tokensHeader
                    Spacer(minLength: 10)
                    legend
                }
                VStack(alignment: .leading, spacing: 6) {
                    tokensHeader
                    legend
                }
            }
            UsageChart(detail: detail, name: name, windowNames: windowNames)
                .dynamicTypeSize(...UsageChart.largestTextSize)
        }
        .usageCard()
    }

    /// The title and the total on one line where they fit. The total is a
    /// number and is never cut: at AX2 on a 375pt phone one line cut it to
    /// "818.1…", so where the two do not share a line it takes its own, and
    /// past AX4 the title wraps at a word rather than ending in "TOKE…".
    private var tokensHeader: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                sectionTitle("Tokens per day")
                tokensTotal(lead: " · ")
            }
            .lineLimit(1)
            VStack(alignment: .leading, spacing: 2) {
                sectionTitle("Tokens per day")
                tokensTotal(lead: "")
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func tokensTotal(lead: String) -> some View {
        let total = UsageDetailData.fmtTokens(detail.totalTokens)
        return Text(lead + total + " total")
            .font(.system(.caption2, design: .rounded))
            .foregroundStyle(Theme.textTertiary)
            // Not the "·", which is layout.
            .accessibilityLabel(total + " tokens in total")
    }

    @ViewBuilder
    private var legend: some View {
        if detail.series.isEmpty {
            Text("limit history starts once reported")
                .font(.system(.caption2, design: .rounded))
                .foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            // The keys wrap as words do: one row where they fit, and a new row
            // where the next does not. Six windows take two rows at the
            // default size rather than six, and at the accessibility sizes
            // each key gets a row of its own.
            FlowRows(spacing: 12, rowSpacing: 4) {
                ForEach(detail.series) { series in
                    HStack(spacing: 6) {
                        SeriesSwatch(index: series.colorIndex)
                        // A key cut short names nothing, and an id is not a
                        // word: wrapped, the system hyphenates it, and at AX5
                        // "session_gpt_6_astra" became "session_gp-" over
                        // "t_6_astra", a window that does not exist. One line,
                        // shrinking where a row is narrower than the name.
                        Text(series.windowId)
                            .font(.system(.caption2, design: .rounded))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                    }
                }
            }
            // The key is for eyes. VoiceOver hears every window named, with
            // its readings, from the chart itself.
            .accessibilityHidden(true)
        }
    }

    // MARK: Where the tokens went

    private var projectsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Where the tokens went")

            if detail.projects.isEmpty {
                Text("No per-project token data reported yet.")
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(detail.projects) { project in
                    projectRow(project)
                }
            }
        }
        .usageCard()
    }

    private func projectRow(_ project: UsageDetailData.Project) -> some View {
        let share = detail.topProjectTokens > 0 ? project.tokens / detail.topProjectTokens : 0
        let percent = detail.totalTokens > 0
            ? Int((project.tokens / detail.totalTokens * 100).rounded())
            : 0
        return VStack(alignment: .leading, spacing: 4) {
            if typeSize.isAccessibilitySize {
                // At AX3 the figures alone took 190pt of a 375pt phone and cut
                // the name to "inf…pts"; at AX5 in a 320pt window they ran past
                // the card. Where name and figures do not share a line, the
                // name takes its own, whole, and the figures go under it.
                ViewThatFits(in: .horizontal) {
                    projectLine(project, percent: percent)
                    VStack(alignment: .leading, spacing: 2) {
                        projectName(project)
                            .fixedSize(horizontal: false, vertical: true)
                        projectFigures(project, percent: percent)
                    }
                }
            } else {
                projectLine(project, percent: percent)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.raised)
                    // Flat, not a gradient. A bar is a quantity; a gradient
                    // across it implies a second dimension that is not there.
                    // It takes the accent because token spend is not a status —
                    // this used to borrow `planning` blue, which made a chart of
                    // tokens look like a chart of planning.
                    Capsule()
                        .fill(Theme.accent)
                        // A hairline keeps the smallest project visible.
                        .frame(width: share > 0 ? max(geo.size.width * share, 4) : 0)
                }
            }
            .frame(height: 6)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(project.name): \(UsageDetailData.fmtTokens(project.tokens)) tokens, \(percent) percent"
        )
    }

    /// Name and figures on one line, the name giving way in its middle.
    private func projectLine(_ project: UsageDetailData.Project, percent: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            projectName(project)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            projectFigures(project, percent: percent)
        }
    }

    private func projectName(_ project: UsageDetailData.Project) -> some View {
        Text(project.name)
            .font(.system(.subheadline, design: .rounded))
            .foregroundStyle(Theme.textPrimary)
    }

    /// The figures never give way: they are the numbers.
    private func projectFigures(_ project: UsageDetailData.Project, percent: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(UsageDetailData.fmtTokens(project.tokens))
                .font(.system(.caption, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
            Text("\(percent)%")
                .font(.system(.caption, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
        }
        .fixedSize()
    }

    // MARK: Note

    private var note: some View {
        Text("Bars are tokens your agent spent, read from its own local logs. "
             + "Lines are the account-wide plan limit, recorded from when this board "
             + "first saw it. They track each other but are not the same measure.")
            .font(.caption2)
            .foregroundStyle(Theme.textTertiary)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 2)
    }
}

// MARK: - Chart

/// Bars (tokens, left axis) with the limit lines over them (percent, right
/// axis). Everything is laid out from the plot rectangle, and the plot from
/// the labels around it as the reader's text size draws them, so it scales
/// from an iPhone SE to an iPad without a second set of numbers.
private struct UsageChart: View {
    let detail: UsageDetailData
    let name: String
    /// VoiceOver's name for each window, by id.
    let windowNames: [String: String]

    /// Where the axis labels stop growing: AX2, 24pt. Past it the two axes'
    /// labels would take most of a phone's width from the plot. The legend
    /// and the titles keep growing, and VoiceOver has every value from the
    /// chart's own description at any size.
    static let largestTextSize = DynamicTypeSize.accessibility2

    /// How far caption2 has grown at the reader's text size, under that cap:
    /// 1 at the default size, 24/11 at the cap.
    @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1

    private static let gridPercents = [0, 25, 50, 75, 100]

    /// 150pt at the default size, growing at half the rate of its labels: the
    /// lines gain room as the text does, and the chart still fits a phone's
    /// screen at the cap.
    private var plotHeight: CGFloat { 150 * (1 + (textScale - 1) / 2) }

    /// caption2's line height, 13pt at the default size.
    private var labelLine: CGFloat { 13 * textScale }

    var body: some View {
        Canvas { context, size in
            draw(&context, size: size)
        }
        // The plot; half a label above it, for "100%"; and under it half a
        // label for "0%", a gap, and the dates. `draw` measures the labels and
        // places them to the same sum.
        .frame(height: plotHeight + 2 * labelLine + 5)
        .accessibilityRepresentation { accessibleCharts }
    }

    private func draw(_ context: inout GraphicsContext, size: CGSize) {
        let count = detail.days.count
        guard count > 0 else { return }

        // Every label is measured before anything is placed: the insets are
        // whatever the reader's text size makes them.
        let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        func width(_ label: GraphicsContext.ResolvedText) -> CGFloat {
            label.measure(in: unbounded).width
        }
        let percentLabels = Self.gridPercents.map { context.resolve(axisText("\($0)%")) }
        let topTokens = context.resolve(axisText(UsageDetailData.fmtTokens(detail.maxTokens)))
        let zeroTokens = context.resolve(axisText("0"))
        let dayLabels = detail.days.map { context.resolve(axisText(UsageDetailData.dayLabel($0))) }
        let lineHeight = zeroTokens.measure(in: unbounded).height
        let widestDay = dayLabels.map(width).max() ?? 0

        // A date is centred under its day, and the first and last days sit on
        // the plot's edges, so half a date must fit either side as well.
        let leading = max(max(width(topTokens), width(zeroTokens)) + 8, widestDay / 2)
        let trailing = max((percentLabels.map(width).max() ?? 0) + 6, widestDay / 2)
        let top = lineHeight / 2 + 1
        let plotWidth = size.width - leading - trailing
        let plotHeight = size.height - top - (lineHeight / 2 + 3 + lineHeight + 1)
        guard plotWidth > 1, plotHeight > 1 else { return }

        let bottom = top + plotHeight
        let last = count - 1
        // A day is a bar's width, at most 24pt however few the days, and the
        // first and last days sit half a bar in from the plot's edges. Centred
        // on the edges, as they were, half a bar ran under the axis labels
        // beside them: into "100%" on a sideways 6.9" phone, and past "53.4M"
        // as well on an iPad, where a bar is 18pt.
        let barWidth = min(24, max(2, (plotWidth / CGFloat(count)) * 0.62))
        let dayStep = last > 0 ? (plotWidth - barWidth) / CGFloat(last) : 0
        func x(_ index: Int) -> CGFloat {
            last == 0 ? leading + plotWidth / 2 : leading + barWidth / 2 + dayStep * CGFloat(index)
        }
        func y(percent: Double) -> CGFloat {
            bottom - plotHeight * min(max(percent, 0), 100) / 100
        }

        // Grid and the right-hand percentage axis.
        for (percent, label) in zip(Self.gridPercents, percentLabels) {
            let lineY = y(percent: Double(percent))
            var line = Path()
            line.move(to: CGPoint(x: leading, y: lineY))
            line.addLine(to: CGPoint(x: size.width - trailing, y: lineY))
            context.stroke(line, with: .color(Theme.cardBorder), lineWidth: 1)
            context.draw(label, at: CGPoint(x: size.width - trailing + 6, y: lineY), anchor: .leading)
        }

        // Left-hand token axis: the busiest day at the top, zero at the bottom.
        context.draw(topTokens, at: CGPoint(x: leading - 8, y: top), anchor: .trailing)
        context.draw(zeroTokens, at: CGPoint(x: leading - 8, y: bottom), anchor: .trailing)

        // Bars: tokens for the day, scaled to the busiest one.
        let barColor = Theme.color(for: .done).opacity(0.5)
        for (index, tokens) in detail.tokensPerDay.enumerated() where tokens > 0 {
            let height = plotHeight * CGFloat(tokens / detail.maxTokens)
            let rect = CGRect(x: x(index) - barWidth / 2,
                              y: bottom - height,
                              width: barWidth,
                              height: max(height, 1))
            context.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(barColor))
        }

        // Lines: one per limit window, over the bars, each in its own colour
        // and pattern. Each is cased in the card's colour first, so it holds
        // up where it crosses a bar (the first line is the bars' own green,
        // 2.81:1 against them uncased) and passes visibly over the lines drawn
        // before it.
        for series in detail.series {
            let color = Theme.seriesColor(series.colorIndex)
            var path = Path()
            var drawn = 0
            var lastPoint = CGPoint.zero
            for (index, value) in series.values.enumerated() {
                guard let value else { continue }
                let point = CGPoint(x: x(index), y: y(percent: value))
                if drawn == 0 { path.move(to: point) } else { path.addLine(to: point) }
                drawn += 1
                lastPoint = point
            }
            if drawn == 1 {
                // A board that only just started recording has a single
                // reading, and a one-point path draws nothing: mark it.
                let dot = CGRect(x: lastPoint.x - 2.5, y: lastPoint.y - 2.5, width: 5, height: 5)
                context.fill(Path(ellipseIn: dot.insetBy(dx: -1.25, dy: -1.25)), with: .color(Theme.card))
                context.fill(Path(ellipseIn: dot), with: .color(color))
            } else if drawn > 1 {
                let style = Theme.seriesStroke(series.colorIndex)
                context.stroke(path,
                               with: .color(Theme.card),
                               style: StrokeStyle(lineWidth: style.lineWidth + 2.5,
                                                  lineCap: .round, lineJoin: .round))
                context.stroke(path, with: .color(color), style: style)
            }
        }

        // Dates every seventh day — every fourteenth or more once the labels
        // outgrow a week's room — plus the last day when its date clears the
        // one before it.
        let room = widestDay + 10
        let step = dayStep > 0 ? 7 * max(1, Int((room / (7 * dayStep)).rounded(.up))) : 1
        var ticks = Array(stride(from: 0, through: last, by: step))
        if let final = ticks.last, final != last, CGFloat(last - final) * dayStep >= room {
            ticks.append(last)
        }
        let dateY = size.height - 1 - lineHeight / 2
        for index in ticks {
            context.draw(dayLabels[index], at: CGPoint(x: x(index), y: dateY), anchor: .center)
        }
    }

    private func axisText(_ string: String) -> Text {
        Text(string)
            .font(.system(.caption2, design: .rounded))
            .foregroundStyle(Theme.textTertiary)
    }

    // MARK: VoiceOver

    /// What VoiceOver has in the canvas's place: the two measures as two
    /// charts, each with a summary and an Audio Graph. Tokens and a plan
    /// limit's percentage do not convert (the fourth principle), so they are
    /// not put on one scale for the ear either.
    @ViewBuilder
    private var accessibleCharts: some View {
        VStack(spacing: 0) {
            Text(tokensSummary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityChartDescriptor(
                    UsageChartDescriptor(measure: .tokens, detail: detail, names: windowNames,
                                         title: "\(name) tokens per day", summary: tokensSummary)
                )
            if !detail.series.isEmpty {
                Text(limitsSummary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityChartDescriptor(
                        UsageChartDescriptor(measure: .limits, detail: detail, names: windowNames,
                                             title: "\(name) plan limit", summary: limitsSummary)
                    )
            }
        }
    }

    private var tokensSummary: String {
        let days = detail.days.count
        guard detail.totalTokens > 0,
              let busiest = detail.tokensPerDay.indices.max(by: { detail.tokensPerDay[$0] < detail.tokensPerDay[$1] })
        else {
            return "\(name) tokens per day over the last \(days) days: none reported."
        }
        return "\(name) tokens per day over the last \(days) days. "
            + "\(UsageDetailData.fmtTokens(detail.totalTokens)) tokens in total; "
            + "the busiest day, \(UsageDetailData.dayLabel(detail.days[busiest])), "
            + "\(UsageDetailData.fmtTokens(detail.maxTokens))."
    }

    /// Each window's latest reading and its highest day, and since when the
    /// board has been recording it where that is inside the range: the lines
    /// start partway because a board only knows the limits it has seen.
    private var limitsSummary: String {
        var parts = ["\(name) plan limit used, by day, over the last \(detail.days.count) days."]
        for series in detail.series {
            let readings = series.values.compactMap { $0 }
            guard let latest = readings.last, let highest = readings.max(),
                  let first = series.values.firstIndex(where: { $0 != nil }) else { continue }
            let since = first > 0 ? ", since \(UsageDetailData.dayLabel(detail.days[first]))" : ""
            parts.append("\(windowNames[series.windowId] ?? series.windowId)\(since): "
                         + "\(Int(latest.rounded())) percent at the latest reading, "
                         + "\(Int(highest.rounded())) percent on the highest day.")
        }
        return parts.joined(separator: " ")
    }
}

/// One of the chart's two measures as data, for VoiceOver's Audio Graphs:
/// the tokens as a bar a day, or the limit windows as a line each.
private struct UsageChartDescriptor: AXChartDescriptorRepresentable {
    enum Measure { case tokens, limits }

    let measure: Measure
    let detail: UsageDetailData
    let names: [String: String]
    let title: String
    let summary: String

    func makeChartDescriptor() -> AXChartDescriptor {
        let days = detail.days.map(UsageDetailData.dayLabel)
        let xAxis = AXCategoricalDataAxisDescriptor(title: "Day", categoryOrder: days)
        switch measure {
        case .tokens:
            let tokens = AXDataSeriesDescriptor(
                name: "Tokens",
                isContinuous: false,
                dataPoints: zip(days, detail.tokensPerDay).map { AXDataPoint(x: $0, y: $1) }
            )
            let yAxis = AXNumericDataAxisDescriptor(title: "Tokens",
                                                    range: 0...detail.maxTokens,
                                                    gridlinePositions: []) {
                UsageDetailData.fmtTokens($0) + " tokens"
            }
            return AXChartDescriptor(title: title, summary: summary, xAxis: xAxis, yAxis: yAxis,
                                     additionalAxes: [], series: [tokens])
        case .limits:
            let lines = detail.series.map { series in
                AXDataSeriesDescriptor(
                    name: names[series.windowId] ?? series.windowId,
                    isContinuous: true,
                    dataPoints: zip(days, series.values).compactMap { day, value in
                        value.map { AXDataPoint(x: day, y: $0) }
                    }
                )
            }
            let yAxis = AXNumericDataAxisDescriptor(title: "Plan limit used",
                                                    range: 0...100,
                                                    gridlinePositions: [0, 25, 50, 75, 100]) {
                "\(Int($0.rounded())) percent"
            }
            return AXChartDescriptor(title: title, summary: summary, xAxis: xAxis, yAxis: yAxis,
                                     additionalAxes: [], series: lines)
        }
    }

    /// A refresh brings new days and readings: take them all.
    func updateChartDescriptor(_ descriptor: AXChartDescriptor) {
        let fresh = makeChartDescriptor()
        descriptor.title = fresh.title
        descriptor.summary = fresh.summary
        descriptor.xAxis = fresh.xAxis
        descriptor.yAxis = fresh.yAxis
        descriptor.series = fresh.series
    }
}

/// A limit line's key: a sample of the line drawn exactly as the chart draws
/// it — colour, width and pattern — so key and line match by shape as well
/// as by hue.
private struct SeriesSwatch: View {
    let index: Int

    var body: some View {
        Canvas { context, size in
            let style = Theme.seriesStroke(index)
            let length = Self.sampleLength(style, within: size.width)
            let start = (size.width - length) / 2 + style.lineWidth / 2
            var line = Path()
            line.move(to: CGPoint(x: start, y: size.height / 2))
            line.addLine(to: CGPoint(x: start + length - style.lineWidth, y: size.height / 2))
            context.stroke(line, with: .color(Theme.seriesColor(index)), style: style)
        }
        .frame(width: 26, height: 6)
    }

    /// How long a sample reads, caps included: as many whole marks of the
    /// pattern as fit, so no key ends in a stub that reads as another
    /// pattern — a long dash cut short is a dash.
    static func sampleLength(_ style: StrokeStyle, within width: CGFloat) -> CGFloat {
        guard !style.dash.isEmpty else { return width }
        var along: CGFloat = 0
        var length: CGFloat = style.lineWidth
        for step in 0..<64 {
            let segment = style.dash[step % style.dash.count]
            if step.isMultiple(of: 2) {
                guard along + segment + style.lineWidth <= width else { break }
                length = along + segment + style.lineWidth
            }
            along += segment
        }
        return length
    }
}

/// Its children in rows, left to right, starting a row wherever the next
/// would not fit. Each is offered its own width, or the row's whole width
/// where its own is more, which a child too wide for any row has to fit
/// itself into (a legend key shrinks its name). Asked for its ideal size it
/// is one row, which is what lets the legend share the header's line when
/// there is room.
private struct FlowRows: Layout {
    let spacing: CGFloat
    let rowSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = arrange(width: bounds.width, subviews: subviews).frames
        for (subview, frame) in zip(subviews, frames) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                          proposal: ProposedViewSize(frame.size))
        }
    }

    private func arrange(width: CGFloat?, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let limit = width ?? .infinity
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let ideal = subview.sizeThatFits(.unspecified)
            let size = ideal.width <= limit
                ? ideal
                : subview.sizeThatFits(ProposedViewSize(width: limit, height: nil))
            if x > 0, x + size.width > limit {
                x = 0
                y += rowHeight + rowSpacing
                rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            widest = max(widest, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: widest, height: y + rowHeight), frames)
    }
}

// MARK: - Derived data

/// Everything the screen draws, worked out once per load: the day grid, the
/// tokens on each of those days, each limit window sampled onto the same grid,
/// and the per-project totals beside it.
struct UsageDetailData {

    struct Series: Identifiable {
        let windowId: String
        /// One value per day; nil for days before the series started.
        let values: [Double?]
        let colorIndex: Int

        var id: String { "\(colorIndex)/\(windowId)" }
    }

    struct Project: Identifiable {
        let name: String
        let tokens: Double

        var id: String { name }
    }

    /// UTC days, oldest first, "YYYY-MM-DD".
    let days: [String]
    let tokensPerDay: [Double]
    let series: [Series]
    let projects: [Project]
    /// Never zero, so bar heights are always divisible.
    let maxTokens: Double
    let totalTokens: Double
    let topProjectTokens: Double

    init(history: UsageHistory, source: String) {
        let days = UsageHistory.dayRange(history.days)
        var indexOfDay: [String: Int] = [:]
        for (index, day) in days.enumerated() { indexOfDay[day] = index }

        var tokensPerDay = [Double](repeating: 0, count: days.count)
        var totalsByProject: [String: Double] = [:]
        var projectOrder: [String] = []
        for row in history.projects where row.source == source {
            if let index = indexOfDay[row.day] { tokensPerDay[index] += row.tokens }
            if totalsByProject[row.project] == nil { projectOrder.append(row.project) }
            totalsByProject[row.project, default: 0] += row.tokens
        }

        let ranks = Dictionary(uniqueKeysWithValues: projectOrder.enumerated().map { ($1, $0) })
        let projects = totalsByProject
            .map { Project(name: $0.key, tokens: $0.value) }
            // Biggest spender first; first seen wins a tie, so the order is
            // stable across refreshes (Swift's sort is not).
            .sorted { ($0.tokens, ranks[$1.name] ?? 0) > ($1.tokens, ranks[$0.name] ?? 0) }

        self.days = days
        self.tokensPerDay = tokensPerDay
        self.series = history.history
            .filter { $0.source == source }
            .enumerated()
            .map { index, series in
                Series(windowId: series.windowId,
                       values: UsageHistory.sampleSeries(series.points, onto: days),
                       colorIndex: index)
            }
        self.projects = projects
        self.maxTokens = max(1, tokensPerDay.max() ?? 1)
        self.totalTokens = tokensPerDay.reduce(0, +)
        self.topProjectTokens = projects.first?.tokens ?? 0
    }

    /// "1.2B", "3.4M", "12K", "907" — the web dashboard's fmtTokens.
    static func fmtTokens(_ tokens: Double) -> String {
        guard tokens.isFinite else { return "0" }
        if tokens >= 1e9 { return String(format: "%.1fB", tokens / 1e9) }
        if tokens >= 1e6 { return String(format: "%.1fM", tokens / 1e6) }
        if tokens >= 1e3 { return "\(Int((tokens / 1e3).rounded()))K" }
        return "\(Int(tokens.rounded()))"
    }

    /// "9 Aug" — a UTC day in the reader's own short date order, mirroring the
    /// web's toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).
    static func dayLabel(_ day: String) -> String {
        let millis = UsageHistory.dayStartMillis(day)
        guard millis > 0 else { return day }
        return dayLabelFormatter.string(from: Date(timeIntervalSince1970: Double(millis) / 1000))
    }

    private static let dayLabelFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("d MMM")
        return formatter
    }()
}

// MARK: - Card chrome

private extension View {
    /// The board's card treatment, so this screen matches the usage block it
    /// was opened from.
    func usageCard() -> some View {
        frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
    }
}
