//
//  AgentSections.swift
//  AgStatus
//
//  The board's chrome above and between the cards: the agents' heads (who
//  each agent is, how many sessions it has, how much of its plan is gone) and
//  the label that names a project's section.
//
//  Since 1.7.0 the sections are projects, not agents. An agent keeps its head,
//  because plan limits belong to an agent's account and to no project, and a
//  mark on every card's meta line; the alarm its head carried is the
//  needs-you bar now (BoardView.swift).
//
//  Which of these is on screen, and how wide, is BoardLayout.swift's decision;
//  these views are handed a width and draw at it.
//

import SwiftUI

// MARK: - Mark and name

/// The agent's mark: the neutral geometric ones, by decision — no vendor logo
/// goes on this board (Theme.agentSymbol says why).
///
/// Told apart by shape and never by a brand colour, because colour here means
/// state and nothing else. It is decoration beside a name that says the same
/// thing, so a screen reader is not shown it.
private struct AgentMark: View {
    let source: String

    /// A fixed box, so an asterisk, a hexagon and a diamond — three glyphs of
    /// three widths — all start their agent's name at the same place.
    @ScaledMetric(relativeTo: .footnote) private var box: CGFloat = 16

    var body: some View {
        Image(systemName: Theme.agentSymbol(for: source))
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.textSecondary)
            .frame(width: box, height: box)
            .accessibilityHidden(true)
    }
}

/// The agent's mark and name, as a head sets them.
///
/// Two steps up from the caption2 the limit blocks used to be titled in: it
/// was the label on a box of bars, and it is the title of a head.
private struct AgentIdentity: View {
    let source: String

    var body: some View {
        HStack(spacing: 7) {
            AgentMark(source: source)
            Text(UsageInfo.displayName(for: source))
                .font(.system(.footnote, design: .rounded).weight(.bold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
        }
    }
}

// MARK: - AgentHead

/// One agent's head: who it is, how many sessions it has on the board, and
/// how much of each of its plan limits is gone. The whole head opens that
/// agent's thirty days of usage.
///
/// In 1.6.5 it also headed the agent's section, with an alarm and the
/// blocked card's edge whenever a session of its was waiting on you. The
/// sections are projects now, and with too many of them to keep every label
/// in view an alarm per section could not work the way the heads' did, so
/// the board has one alarm, the needs-you bar along its bottom edge. A head
/// keeps only its limits, and red in a head can only mean a limit past 85%.
///
/// One view in four forms (HeadForm), chosen from the width it is handed. No
/// reader inside it: every arrangement already knows how wide its heads are,
/// and a head that measured itself would pick its form a pass late.
///
/// Made with `.equatable()` wherever it is made, so that it runs only when
/// something it draws has changed — see `==`.
struct AgentHead: View {
    @Environment(\.openUsage) private var openUsage
    /// What it draws of its agent: not the agent's sessions, which change
    /// with every event on any of its cards.
    let group: AgentSummary
    /// The head's full width, edge to edge.
    let width: CGFloat
    /// Whether it stands alone on its row — see `HeadForm.resolve`.
    var canStrip = false
    /// "No plan limits reported", for an agent with sessions and no report.
    /// The phone turns it off: there the heads are pinned above a short list,
    /// and a sentence about what is absent costs a line of every screen.
    var showsNoLimits = true
    /// Stretch to the row's height, so heads side by side on an idle board
    /// are drawn as one band.
    var fillsHeight = false
    /// The Dynamic Type factor the board was laid out with, 1 at the default.
    var scale: CGFloat = 1
    /// Alone on its row where the heads go two across: the only agent, or a
    /// third one under a pair on an idle board. It has the whole width, so it
    /// takes the fuller line whenever that line actually fits — see `content`.
    var alone = false
    /// Beside another head on its row: pinned two across the one-list board,
    /// as Frame A draws them on a phone, or on an idle board's row. Where
    /// that makes it narrow, as it always does on a phone, it is too narrow
    /// for its session count and never draws it; a regular one, as an iPad's
    /// pair can be, draws it where it fits (`HeadForm.offersCount`).
    var sharesRow = false
    /// The board's one clock, so every countdown on screen turns over together
    /// whether its head is pinned or scrolling.
    let now: Date

    private var form: HeadForm {
        HeadForm.resolve(outer: width, canStrip: canStrip, scale: scale)
    }

    /// What the head has to lay out in, inside its padding.
    private var inner: CGFloat { max(0, width - 2 * HeadForm.padding) }

    var body: some View {
        content
            .padding(.horizontal, HeadForm.padding)
            .padding(.vertical, Theme.Space.sm)
            // A head with no limits is its name line and padding, 40pt on a
            // phone: under the 44pt a control needs, and the head is one. The
            // extra goes underneath, so its name stays level with the name of
            // the head beside it, 12pt from the top as every head's is.
            .frame(minHeight: 44, alignment: .top)
            .frame(width: width, alignment: .leading)
            .frame(maxHeight: fillsHeight ? .infinity : nil, alignment: .top)
            // The surface is the head's one control, drawn underneath, and
            // everything over it is closed to touches, so a tap on the name, a
            // bar or bare padding falls through to it and opens usage. It
            // stays underneath rather than becoming a button around the
            // content: each meter is an element VoiceOver reads on its own,
            // and inside a button they would be folded into its label.
            //
            // A button that asks the board to push usage, not a
            // NavigationLink — the same reason the cards open history through
            // a closure. Where the heads scroll they are a row of the List,
            // and a link in a List row draws its own disclosure chevron and
            // claims the whole row. A button with a style of its own is left
            // to be the size it is drawn.
            .background {
                Button {
                    openUsage(group.source)
                } label: {
                    Color.clear
                }
                .buttonStyle(HeadSurfaceStyle())
                // Not a heading any more: the headings are the projects, which
                // is what the rotor walks. The heads stand together in the
                // "Plan limits" container instead (`HeadRows`).
                .accessibilityLabel(summary)
                .accessibilityHint("Shows 30 days of usage")
                // Drawn underneath its meters, and read before them: who,
                // then how much of each limit is gone.
                .accessibilitySortPriority(1)
                // Voice Control: "Tap Claude usage", or "Tap Claude". The label
                // is a sentence whose count moves while it is being said.
                .accessibilityInputLabels(["\(group.name) usage", group.name])
            }
            // Read as one agent: the head, then its limits.
            .accessibilityElement(children: .contain)
    }

    /// "Claude, 5 sessions": what the head says.
    private var summary: String {
        group.sessions > 0 ? "\(group.name), \(sessionCount)" : group.name
    }

    private var sessionCount: String {
        "\(group.sessions) session\(group.sessions == 1 ? "" : "s")"
    }

    // MARK: Forms

    @ViewBuilder
    private var content: some View {
        if alone && form == .narrow {
            // By fit, not by the scaled threshold. At larger text the
            // threshold alone put a head with the phone's whole width into
            // the half-phone form, every value under its label, which the
            // lone limit block it replaces never did. So the full line is
            // used while it holds, and the half-phone form only when it does
            // not.
            ViewThatFits(in: .horizontal) {
                content(.regular)
                content(.narrow)
            }
        } else {
            content(form)
        }
    }

    @ViewBuilder
    private func content(_ form: HeadForm) -> some View {
        switch form {
        case .strip:
            // Centred on each other, not top-aligned: the identity is one line
            // and the limits are three, and a name level with the first label
            // reads as the title of that column alone.
            HStack(alignment: .center, spacing: HeadForm.stripGap) {
                line
                    .frame(width: identityWidth, alignment: .leading)
                limits(form)
            }
        case .narrow, .regular, .across:
            VStack(alignment: .leading, spacing: 10) {
                line
                limits(form)
            }
        }
    }

    /// The head's one line: mark, name, and how many sessions. On a strip it
    /// is the block at the left, at a fixed width so the limits beside it
    /// start at the same place on every agent's strip.
    ///
    /// The same in every form, but for a narrow head that shares its row,
    /// whose line holds no count (`HeadForm.offersCount`). The count was kept
    /// off every narrow line, and at larger text a head the whole width of a
    /// phone takes that form too, by its scaled threshold, so heads that lead
    /// the list lost it although their line had room: on an SE from extra
    /// large text, on a 6.9" from extra extra extra large, at every
    /// accessibility size.
    private var line: some View {
        HStack(spacing: 0) {
            // The name is offered the width first. When the line is tight the
            // count goes before a letter of the name does: the count is a
            // number you can get by looking down, and the name is the only
            // thing saying whose limits these are.
            AgentIdentity(source: group.source)
                .layoutPriority(1)
            if HeadForm.offersCount(sessions: group.sessions, sharesRow: sharesRow, form: form) {
                // Whole or not at all, and the gap travels with it, so a count
                // that has dropped out leaves no space behind.
                ViewThatFits(in: .horizontal) {
                    count.padding(.leading, Theme.Space.xs)
                    FitsAsNothing()
                }
            }
            Spacer(minLength: 0)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var identityWidth: CGFloat { HeadForm.stripIdentity * scale }

    private var count: some View {
        Text(sessionCount)
            .font(.caption)
            .monospacedDigit()
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
            .fixedSize()
    }

    // MARK: Limits

    /// The meters, or for an agent that reports no limits the sentence that
    /// says so, in whatever form the head takes (`HeadForm.saysNoLimits`).
    @ViewBuilder
    private func limits(_ form: HeadForm) -> some View {
        if HeadForm.saysNoLimits(windows: group.windows.count, showsNoLimits: showsNoLimits) {
            // Every word of it, on a second line where one is too short, as
            // on the web and Android.
            Text("No plan limits reported")
                .font(.caption)
                .foregroundStyle(Theme.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .allowsHitTesting(false)
        } else if !group.windows.isEmpty {
            meters(form)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func meters(_ form: HeadForm) -> some View {
        switch form {
        case .narrow:
            // Half a phone fits the label OR the value, not both. Pinned, it
            // is never asked for more than four: from a fifth window the
            // phone's heads open the list at the whole width instead
            // (`BoardArrangement.narrowPinnedWindows`). An idle board is the
            // exception, with nothing else to show.
            meterRows(stacked: true)
        case .regular:
            meterRows(stacked: false)
        case .across:
            // Always three tracks, so six windows make two even rows and a
            // lone window does not stretch into one bar the width of a column.
            meterGrid(tracks: 3, gap: 20, width: inner)
        case .strip:
            let available = inner - identityWidth - HeadForm.stripGap
            meterGrid(tracks: HeadForm.stripTracks(available: available,
                                                   windows: group.windows.count,
                                                   scale: scale),
                      gap: HeadForm.stripGap,
                      width: available)
        }
    }

    private func meterRows(stacked: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(group.windows) { window in
                LimitMeter(sourceName: group.name, window: window, now: now, stacked: stacked)
            }
        }
    }

    /// Windows in `tracks` equal tracks, wrapping to further rows.
    ///
    /// Each track is given its width outright. A flexible grid would share the
    /// row by what each label asks for, and "Weekly (GPT-6-Astra)" beside
    /// "Current session" would come out as three bars of three lengths —
    /// which, on a meter, reads as three different scales.
    private func meterGrid(tracks: Int, gap: CGFloat, width: CGFloat) -> some View {
        let trackWidth = BoardArrangement.track(width: width, count: tracks, gap: gap)
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(group.windows.rows(of: tracks), id: \.first?.id) { row in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(row) { window in
                        LimitMeter(sourceName: group.name, window: window, now: now, stacked: true)
                            .frame(width: trackWidth, alignment: .leading)
                    }
                }
            }
        }
    }
}

extension AgentHead: Equatable {
    /// Equal when it would be drawn the same: every input.
    ///
    /// The board makes every head afresh on every pass, and a hook event is
    /// one card's news: most passes change nothing a head draws. Handed the
    /// agent's sessions, a head was never equal to the last one by SwiftUI's
    /// own comparison, so every head on the board ran again for every event,
    /// and was laid out again. Made with `.equatable()`, a head is compared by
    /// this instead, and runs when what it draws has changed: a session
    /// arriving or leaving under its agent, a limit report, the minute clock.
    /// Where heads stand in rows, the rows must be left alone too, or they lay
    /// their heads out again regardless (`HeadRows`).
    static func == (lhs: AgentHead, rhs: AgentHead) -> Bool {
        // In two parts: as one chain of nine comparisons it took the type
        // checker of Swift 6.2, which CI builds with, over 1 MB of solver
        // memory, where the chain of eight before it took less.
        guard lhs.alone == rhs.alone, lhs.sharesRow == rhs.sharesRow else { return false }
        return lhs.group == rhs.group
            && lhs.width == rhs.width
            && lhs.canStrip == rhs.canStrip
            && lhs.showsNoLimits == rhs.showsNoLimits
            && lhs.fillsHeight == rhs.fillsHeight
            && lhs.scale == rhs.scale
            && lhs.now == rhs.now
    }
}

/// How a head asks the board to open an agent's usage, by its source key.
///
/// The board pushes a `UsageDetailRoute` onto its own path; the destination is
/// declared at its root, beside the session one.
private struct OpenUsageKey: EnvironmentKey {
    static let defaultValue = BoardAction<String>(name: "none") { _ in }
}

extension EnvironmentValues {
    var openUsage: BoardAction<String> {
        get { self[OpenUsageKey.self] }
        set { self[OpenUsageKey.self] = newValue }
    }
}

/// The head's surface, and the whole of its tap target.
///
/// A style rather than a background on the label, because the press has to
/// show: the head is a control the size of a banner, and one that does nothing
/// under a thumb until the next screen arrives feels broken. It lifts to the
/// raised surface and changes nothing else — no accent, since opening usage is
/// not a state. Its edge is the hairline every head has: the blocked edge it
/// took while a session of its agent's waited went with the alarm.
private struct HeadSurfaceStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.Radius.head, style: .continuous)
        configuration.label
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(shape.fill(configuration.isPressed ? Theme.raised : Theme.card))
            .overlay(shape.strokeBorder(Theme.cardBorder))
            .contentShape(shape)
    }
}

// MARK: - ProjectLabel

/// The name over a project's cards: the folder, and how many sessions it has.
///
/// Not a box, and not a control: no mark, no colour, no tap, no limit, no
/// token total, no alarm. A name on the ground is enough to start a group, and
/// a container here would be a card holding cards. Every section has one, the
/// only project on the board and a one-card project included, because the
/// cards no longer say where they are working unless they have moved.
///
/// In the list it sticks while its cards scroll by, and so it carries its own
/// opaque ground: the cards pass underneath it, and a see-through label over a
/// card's name is two names on one line. On a wide board it scrolls with its
/// section (`BoardView.stackedBoard`).
///
/// One line. The name is offered the width first and the count is the first
/// to go, whole, so it never squeezes a letter out of the name; past that the
/// name is cut in the middle, where a folder's two ends — `claude-status-…
/// release-1.6` — are the parts that tell siblings apart. "No project" is
/// the board's own words rather than a folder's name, so it takes the
/// secondary ink at a regular weight.
///
/// Handed only what it draws (`SectionLabel`) and compared as a value, with
/// `.equatable()` wherever it is made: a message on one of its cards is none
/// of its business.
struct ProjectLabel: View, Equatable {
    let label: SectionLabel
    /// Its distance from the edge the cards line up on: two points in from
    /// the cards' own edge, where they have rounded away.
    var inset: CGFloat = 2
    /// Above the name. In the list, 18 with the 6pt the card above keeps
    /// below itself makes the 24 between two projects; a label that sticks
    /// keeps the same 18, so the name stands at the same height whichever
    /// label is stuck.
    var top: CGFloat = 18
    /// Under the name: with the 6pt a card keeps above itself in the list,
    /// the first card is 8pt down. A card on a stack carries 8 of its own.
    var bottom: CGFloat = 2

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(label.title)
                .font(label.isNoProject ? .subheadline : .subheadline.weight(.semibold))
                .foregroundStyle(label.isNoProject ? Theme.textSecondary : Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            // Whole or not at all, and the gap travels with it.
            ViewThatFits(in: .horizontal) {
                Text(label.countText)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.leading, Theme.Space.xs)
                FitsAsNothing()
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, inset)
        .padding(.top, top)
        .padding(.bottom, bottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.background)
        // One heading, "acme-api, 3 sessions", so the Headings rotor walks
        // the projects.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.spoken)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - LimitMeter

/// One plan-limit window: its label, how much of it is gone, and when it
/// resets. A percentage of a quota nobody has told us — never a token count,
/// and nothing here converts one into the other.
private struct LimitMeter: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let sourceName: String
    let window: UsageWindow
    let now: Date
    /// The value under its label instead of beside it. For a head too narrow
    /// to hold both on a line, and for the heads that lay their windows out
    /// across, where each track is a narrow column of its own.
    var stacked = false

    private var fraction: Double {
        min(max(window.usedPct / 100, 0), 1)
    }

    /// Green, amber, red as the window fills — see Theme.limitColor.
    ///
    /// An earlier pass made this neutral-until-85% on the argument that colour
    /// on this board means state. That was the wrong call: the entire point of
    /// a limit bar is to be caught before it lands, and a grey bar at 62% tells
    /// you nothing you would act on. The middle band is amber rather than the
    /// `testing` teal it used to borrow, so the meter reads as its own scale
    /// instead of wearing a status colour.
    private var barColor: Color { Theme.limitColor(window.usedPct) }

    private var pctText: String {
        "\(Int(window.usedPct.rounded()))%"
    }

    /// When the window resets: "resets in 2h 15m", and the bare span, "2h 15m",
    /// for a line with no room for the words. Nil once the reset time is
    /// unknown or passed; inside the last minute "resets soon", with no span.
    private var reset: (phrase: String, span: String?)? {
        guard let date = window.resetsDate else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        guard seconds > 60 else { return seconds > 0 ? ("resets soon", nil) : nil }
        // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
        let span = Self.span(minutes: (seconds + 30) / 60)
        return ("resets in \(span)", span)
    }

    /// The reset said in words — "resets in 2 hours, 17 minutes" — for
    /// VoiceOver, which may read the face's "2h 17m" as a length.
    private var spokenReset: String? {
        guard let date = window.resetsDate else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        guard seconds > 60 else { return seconds > 0 ? "resets soon" : nil }
        let minutes = (seconds + 30) / 60
        let parts = minutes < 60 ? DateComponents(minute: minutes)
            : minutes < 1440 ? DateComponents(hour: minutes / 60, minute: minutes % 60)
            : DateComponents(day: minutes / 1440, hour: (minutes / 60) % 24)
        return SessionCardView.spokenUnits.string(from: parts).map { "resets in \($0)" } ?? reset?.phrase
    }

    private static func span(minutes totalMinutes: Int) -> String {
        if totalMinutes < 60 { return "\(totalMinutes)m" }
        let totalHours = totalMinutes / 60
        if totalHours < 24 {
            let minutes = totalMinutes % 60
            return minutes > 0 ? "\(totalHours)h \(minutes)m" : "\(totalHours)h"
        }
        let days = totalHours / 24
        let hours = totalHours % 24
        return hours > 0 ? "\(days)d \(hours)h" : "\(days)d"
    }

    private var label: some View {
        Text(window.label)
            .font(.system(.caption2, design: .rounded).weight(.semibold))
            .kerning(0.4)
            .textCase(.uppercase)
            .foregroundStyle(Theme.textSecondary)
            // Two lines at an accessibility text size. On one, at AX4, both of
            // Claude's weekly windows read "WEEKLY…" and which limit was which
            // could not be told. A phone's heads lead the list and scroll away
            // at those sizes, so the line costs no pinned height there. At the
            // standard sizes a pinned head keeps one line a label: its height
            // comes out of the room left for the cards.
            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
    }

    private var value: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(pctText)
                .font(.system(.caption, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
                // The number never gives way: neither the label beside it
                // nor its own reset squeezes it.
                .fixedSize()
            if let reset {
                resetLine(reset)
                    .font(.system(.caption2, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
            }
        }
    }

    /// The reset whole, as the bare span, or not at all — never cut.
    ///
    /// It used to truncate: at the largest standard text size a 2h 17m reset
    /// read "resets in 2h 1…", which is a different number. The span alone is
    /// still a countdown beside a meter, and the words stay in the VoiceOver
    /// label. Where even the span does not fit, the reset is drawn nowhere —
    /// the usage screen does not show resets — which at these widths is
    /// rare. The last option is FitsAsNothing, not EmptyView, which
    /// ViewThatFits does not count (see its note); and the two cases are
    /// spelled out rather than an `if` inside the cascade, as the card's meta
    /// line does.
    ///
    /// Each meter decides for itself, from its own string: one head can show
    /// "34% · 2h 17m" over "62% · resets in 2d 5h", and a row can gain or
    /// lose its words as its countdown's digits change. Deciding once per
    /// head from a template would hold the form still, at the price of
    /// showing the bare span where the words fit; every form is whole either
    /// way.
    @ViewBuilder
    private func resetLine(_ reset: (phrase: String, span: String?)) -> some View {
        if let span = reset.span {
            ViewThatFits(in: .horizontal) {
                Text("· \(reset.phrase)").fixedSize()
                Text("· \(span)").fixedSize()
                FitsAsNothing()
            }
        } else {
            ViewThatFits(in: .horizontal) {
                Text("· \(reset.phrase)").fixedSize()
                FitsAsNothing()
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if stacked {
                // The label and the value each get a line: half a phone, or
                // one track of a head that lays its windows out across, fits
                // one of them and not both.
                label
                value
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    label
                        // Beside its value, the label is offered the width
                        // first: it says which limit this is, and the reset
                        // steps down to its span, or goes, to make room.
                        // Ranked level with the value, the row split the
                        // width between them and cut the label while the
                        // whole "resets in …" phrase was drawn.
                        .layoutPriority(1)
                    Spacer(minLength: 8)
                    value
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.meterTrack)
                    Capsule()
                        .fill(barColor)
                        // A hairline of progress stays visible even at ~0%.
                        .frame(width: fraction > 0 ? max(geo.size.width * fraction, 4) : 0)
                        .motion(.snappy, value: fraction)
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(sourceName) \(window.label): \(pctText) used\(spokenReset.map { ", \($0)" } ?? "")"
        )
    }
}
