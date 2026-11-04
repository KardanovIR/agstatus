//
//  AgentSections.swift
//  AgStatus
//
//  The chrome of an agent's section: its head (who it is, whether anything of
//  its is waiting on you, how much of the plan is gone), the alarm inside the
//  head, the one line that stands in for the heads when they have to scroll,
//  and the label that names a group in the phone's list.
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

/// The agent's mark and name, as a head and the agent line set them.
///
/// Two steps up from the caption2 the limit blocks used to be titled in: it
/// was the label on a box of bars, and it is now the title of a section.
private struct AgentIdentity: View {
    let group: AgentGroup

    var body: some View {
        HStack(spacing: 7) {
            AgentMark(source: group.source)
            Text(group.name)
                .font(.system(.footnote, design: .rounded).weight(.bold))
                .kerning(0.6)
                .textCase(.uppercase)
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
        }
    }
}

// MARK: - AgentHead

/// The head of one agent's section.
///
/// This used to be the plan-limit block and nothing else: the agent's name
/// over its bars, with the sessions in a separate list below. It was already
/// one block per agent. Here it becomes the head of that agent's section — who
/// it is, whether anything of its is waiting on you, how much of the plan is
/// gone — and the sessions hang beneath it. As before, the whole head opens
/// that agent's thirty days of usage.
///
/// One view in four forms (HeadForm), chosen from the width it is handed. No
/// reader inside it: every arrangement already knows how wide its heads are,
/// and a head that measured itself would pick its form a pass late.
struct AgentHead: View {
    @Environment(\.openUsage) private var openUsage
    let group: AgentGroup
    /// The head's full width, edge to edge.
    let width: CGFloat
    /// Whether it stands alone on its row — see `HeadForm.resolve`.
    var canStrip = false
    /// "No plan limits reported", for an agent with sessions and no report.
    /// The phone turns it off: there the heads are pinned above a short list,
    /// and a sentence about what is absent costs a line of every screen.
    var showsNoLimits = true
    /// Stretch to the row's height. Heads standing over columns are drawn as
    /// one band, so the first card of every column starts on the same line.
    var fillsHeight = false
    /// The Dynamic Type factor the board was laid out with, 1 at the default.
    var scale: CGFloat = 1
    /// Alone on its row where the heads go two across: the only agent, or a
    /// third one under a pair. It has the whole width, so it takes the fuller
    /// line whenever that line actually fits — see `content`.
    var alone = false
    /// The other heads of its row that carry an alarm. Two heads side by side
    /// must agree on where the alarm goes — see `line`.
    var peers: [AgentGroup] = []
    /// The board's one clock, so every countdown on screen turns over together
    /// whether its head is pinned or scrolling.
    let now: Date
    /// Brings this agent's first blocked card into view.
    let onJump: () -> Void

    private var form: HeadForm {
        HeadForm.resolve(outer: width, canStrip: canStrip, scale: scale)
    }

    /// What the head has to lay out in, inside its padding.
    private var inner: CGFloat { max(0, width - 2 * HeadForm.padding) }

    private var edge: Color {
        // Something of this agent's is blocked. The head takes the blocked
        // card's own edge, because a red word is not enough on its own here: a
        // plan limit past 85% is also drawn in that red, and a quiet head with
        // a full bar must not read like a head that needs you. The box
        // changing is a second channel the bar does not have.
        group.blocked > 0 ? Theme.cardEdge(for: .blocked) : Theme.cardBorder
    }

    var body: some View {
        content
            .padding(.horizontal, HeadForm.padding)
            .padding(.vertical, 12)
            // A head with no limits is its name line and padding, 40pt on a
            // phone: under the 44pt a control needs, and the head is one.
            .frame(minHeight: 44)
            .frame(width: width, alignment: .leading)
            .frame(maxHeight: fillsHeight ? .infinity : nil, alignment: .top)
            // The head's tap and its alarm are two controls, and they are
            // SIBLINGS: the link is the surface underneath, the alarm sits in
            // the content drawn over it, and neither contains the other.
            //
            // This codebase has been here before. A full-card NavigationLink
            // once lay across the session card and swallowed the taps meant
            // for the Focus control on top of it. A button nested inside a
            // link fails the other way round as well — it is one element to
            // VoiceOver, and which of the two a tap reaches is not something
            // SwiftUI promises.
            //
            // So everything drawn over the link is closed to touches except
            // the alarm. A tap on the name, a bar or bare padding falls
            // through to the surface and opens usage; a tap on the alarm stops
            // at the alarm.
            //
            // The surface is a button that asks the board to push usage, not
            // a NavigationLink — the same reason the cards open history
            // through a closure. On a phone with three agents the heads are
            // rows of the List, and a link in a List row draws its own
            // disclosure chevron and claims the whole row. A button with a
            // style of its own is left to be the size it is drawn.
            .background {
                Button {
                    openUsage(group.source)
                } label: {
                    Color.clear
                }
                .buttonStyle(HeadSurfaceStyle(edge: edge))
                .accessibilityLabel(summary)
                .accessibilityAddTraits(.isHeader)
                .accessibilityHint("Shows 30 days of usage")
            }
            // Read as one agent: the head, its alarm, then its limits.
            .accessibilityElement(children: .contain)
    }

    /// "Claude, 5 sessions, 1 blocked" — what the head says, for a reader who
    /// cannot see the edge change colour.
    private var summary: String {
        var parts = [group.name]
        if !group.sessions.isEmpty { parts.append(sessionCount) }
        if group.blocked > 0 { parts.append("\(group.blocked) blocked") }
        return parts.joined(separator: ", ")
    }

    private var sessionCount: String {
        "\(group.sessions.count) session\(group.sessions.count == 1 ? "" : "s")"
    }

    // MARK: Forms

    @ViewBuilder
    private var content: some View {
        if alone && form == .narrow {
            // By fit, not by the scaled threshold. At larger text the
            // threshold alone put a head with the phone's whole width into
            // the half-phone form — no count, no word, every value under its
            // label — which the lone limit block it replaces never did. So
            // the full line is used while it holds, and the half-phone form
            // only when it does not.
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
                stripIdentity
                    .frame(width: identityWidth, alignment: .leading)
                limits(form)
            }
        case .narrow, .regular, .across:
            VStack(alignment: .leading, spacing: 10) {
                line(form)
                limits(form)
            }
        }
    }

    /// The head's one line: mark, name, how many sessions, and — only while
    /// something is blocked — the alarm at the far end.
    ///
    /// Half a phone is the one place the name and the alarm can be too much
    /// for a line: at the largest text sizes "CLAUDE" beside "! 1 ⌄" came out
    /// as "C", and it was the head that needed you which lost its name. There
    /// the alarm goes under the name instead. Only when the pair does not fit,
    /// so at an ordinary size the head is the one line it was drawn as.
    @ViewBuilder
    private func line(_ form: HeadForm) -> some View {
        if form == .narrow && group.blocked > 0 {
            ViewThatFits(in: .horizontal) {
                // Every head of a row tests the row's WIDEST line, not just
                // its own, so they fall the same way. Each deciding for itself
                // left "CLAUDE" with its alarm underneath beside "CODEX" with
                // its alarm alongside: two heads of two heights, and the eye
                // sent to two different places for the same reading. The
                // peers' lines are laid out hidden for their width alone.
                ZStack(alignment: .leading) {
                    ForEach(peers) { peer in
                        HStack(spacing: 0) {
                            AgentIdentity(group: peer)
                            Spacer(minLength: Theme.Space.xs)
                            AlarmButton(agent: peer.name, count: peer.blocked, showsWord: false, action: {})
                        }
                        .hidden()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                    oneLine(form)
                }
                VStack(alignment: .leading, spacing: 6) {
                    AgentIdentity(group: group)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    alarm(form)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            oneLine(form)
        }
    }

    private func oneLine(_ form: HeadForm) -> some View {
        HStack(spacing: 0) {
            // The name is offered the width first. When the line is tight the
            // count goes before a letter of the name does: the count is a
            // number you can get by looking down, and the name is the only
            // thing saying whose section this is.
            AgentIdentity(group: group)
                .layoutPriority(1)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            if form != .narrow && !group.sessions.isEmpty {
                // Whole or not at all, and the gap travels with it, so a count
                // that has dropped out leaves no space behind.
                ViewThatFits(in: .horizontal) {
                    count.padding(.leading, Theme.Space.xs)
                    FitsAsNothing()
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            Spacer(minLength: Theme.Space.xs)
            if group.blocked > 0 {
                alarm(form)
                    .layoutPriority(2)
            }
        }
    }

    /// The strip's left-hand block: the same three things, at a fixed width so
    /// the limits beside them start at the same place on every agent's strip.
    /// The alarm follows the count here instead of standing at the far end,
    /// and goes under it when the three do not fit on a line.
    private var stripIdentity: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.xs) {
                identityAndCount
                if group.blocked > 0 { alarm(.strip) }
            }
            VStack(alignment: .leading, spacing: 6) {
                identityAndCount
                if group.blocked > 0 { alarm(.strip) }
            }
        }
    }

    private var identityAndCount: some View {
        HStack(spacing: Theme.Space.xs) {
            AgentIdentity(group: group)
            if !group.sessions.isEmpty { count }
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

    private func alarm(_ form: HeadForm) -> some View {
        AlarmButton(agent: group.name,
                    count: group.blocked,
                    showsWord: form != .narrow,
                    action: onJump)
    }

    // MARK: Limits

    @ViewBuilder
    private func limits(_ form: HeadForm) -> some View {
        if group.windows.isEmpty {
            if showsNoLimits && form != .narrow {
                Text("No plan limits reported")
                    .font(.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .allowsHitTesting(false)
            }
        } else {
            meters(form)
                .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func meters(_ form: HeadForm) -> some View {
        switch form {
        case .narrow:
            // Half a phone fits the label OR the value, not both.
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

/// How a head asks the board to open an agent's usage, by its source key.
///
/// The board pushes a `UsageDetailRoute` onto its own path; the destination is
/// declared at its root, beside the session one.
private struct OpenUsageKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}

extension EnvironmentValues {
    var openUsage: (String) -> Void {
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
/// not a state.
private struct HeadSurfaceStyle: ButtonStyle {
    let edge: Color

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        configuration.label
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(shape.fill(configuration.isPressed ? Theme.raised : Theme.card))
            // Not animated, as a card's own edge is not: a state arriving is
            // drawn, it is not faded in.
            .overlay(shape.strokeBorder(edge))
            .contentShape(shape)
    }
}

// MARK: - AlarmButton

/// The alarm: how many of this agent's sessions are blocked, and the way to
/// the first of them.
///
/// Absent unless something is blocked — a quiet head means nothing of this
/// agent's is waiting on you. It is the same solid mark and the same word the
/// blocked card carries, so it is never hue alone. It is also the way to that
/// card, which matters because a card that becomes blocked stays where it is
/// and may be a screen down: hence the arrow, which says it goes somewhere.
private struct AlarmButton: View {
    let agent: String
    let count: Int
    /// Half a phone has room for the mark, the number and the arrow, and not
    /// for the word.
    var showsWord = true
    let action: () -> Void

    /// How far the target reaches past the glyphs, each way.
    ///
    /// The alarm is 18pt tall to look at and has to be 44 to hit. The reach is
    /// padding INSIDE the label, where the button's hit shape includes it,
    /// cancelled by the same padding negative outside — so the head's line is
    /// laid out around the glyphs alone and stays one line tall.
    private static let reach = (x: Theme.Space.xs, y: CGFloat(14))

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Space.xxs) {
                Image(systemName: Theme.symbol(for: .blocked))
                Text("\(count)")
                    .monospacedDigit()
                if showsWord {
                    Text(AgentStatus.blocked.label.uppercased())
                }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .font(.footnote.weight(.semibold))
            .kerning(0.5)
            .foregroundStyle(Theme.color(for: .blocked))
            .lineLimit(1)
            // A fixed token: "1 BLOC…" beside an arrow reads as a bug, and the
            // name beside it is the part that can afford to give way.
            .fixedSize()
            .padding(.horizontal, Self.reach.x)
            .padding(.vertical, Self.reach.y)
            .contentShape(Rectangle())
        }
        .buttonStyle(AlarmButtonStyle())
        .padding(.horizontal, -Self.reach.x)
        .padding(.vertical, -Self.reach.y)
        .accessibilityLabel("\(agent): \(count) blocked, show the first")
    }
}

/// Dims under the finger and does nothing else. The alarm is already the
/// loudest thing in its head; a pressed state that added a surface behind it
/// would make it louder at the one moment it has been acknowledged.
private struct AlarmButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

// MARK: - AgentLine

/// One pinned line for a board whose sections scroll.
///
/// With more agents than fit, the limits scroll away with their sections —
/// decided, because pinning four heads would leave no board. This line is what
/// stays: each agent's mark and name, which take you to its section, and its
/// alarm, which takes you to its first blocked card. Two controls side by
/// side, because one cannot sit inside the other.
struct AgentLine: View {
    let groups: [AgentGroup]
    let width: CGFloat
    var scale: CGFloat = 1
    let onSection: (String) -> Void
    let onJump: (String) -> Void

    /// Wide enough for a mark, a name and an alarm. A further agent starts a
    /// second row sooner than any name is cut to a letter.
    private static let cellMin: CGFloat = 150

    private var perRow: Int {
        let gutter = BoardArrangement.agentGutter
        let fit = Int(((width + gutter) / (Self.cellMin * scale + gutter)).rounded(.down))
        return max(1, min(groups.count, fit))
    }

    private var cellWidth: CGFloat {
        BoardArrangement.track(width: width, count: perRow)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(groups.rows(of: perRow), id: \.first?.source) { row in
                HStack(spacing: BoardArrangement.agentGutter) {
                    ForEach(row) { group in
                        cell(group)
                    }
                }
            }
            Rectangle()
                .fill(Theme.cardBorder)
                .frame(height: 1)
        }
        .frame(width: width, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agents")
    }

    private func cell(_ group: AgentGroup) -> some View {
        HStack(spacing: Theme.Space.xs) {
            Button {
                onSection(group.source)
            } label: {
                AgentIdentity(group: group)
                    .padding(.horizontal, 2)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(group.name), show its sessions")
            if group.blocked > 0 {
                AlarmButton(agent: group.name,
                            count: group.blocked,
                            // The same cut-off the head uses, measured on the
                            // cell: narrower than this and the word goes.
                            showsWord: cellWidth > HeadForm.narrowMax * scale,
                            action: { onJump(group.source) })
            }
            Spacer(minLength: 0)
        }
        .frame(width: cellWidth, alignment: .leading)
        .frame(minHeight: 44)
    }
}

// MARK: - GroupLabel

/// The name over a group of cards in the phone's list.
///
/// Not a box. A mark and a name on the ground are enough to start a group; a
/// container here would be a card holding cards. The name sticks while its
/// group scrolls, because with the agent's chip gone from the card it is the
/// only thing saying whose cards these are — which is why it carries its own
/// opaque ground: the cards pass underneath it, and a see-through label over a
/// card's name is two names on one line.
struct GroupLabel: View {
    let group: AgentGroup
    /// The first group's name stands directly under the pinned heads, with no
    /// card above it to bring its own 6pt, so it carries that space itself.
    var leads = false

    var body: some View {
        HStack(spacing: 7) {
            AgentMark(source: group.source)
            Text(group.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
            Text("\(group.sessions.count) session\(group.sessions.count == 1 ? "" : "s")")
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(Theme.textTertiary)
                .lineLimit(1)
        }
        // Two points in from the cards' edge, so the mark sits over the
        // card's rounded corner and not hard against its side.
        .padding(.horizontal, Theme.Space.md + 2)
        // With the 6pt each row keeps above and below itself, this puts the
        // name 16pt clear of the card before it and the card after it.
        .padding(.top, leads ? 14 : 10)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(group.name), \(group.sessions.count) session\(group.sessions.count == 1 ? "" : "s")")
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - LimitMeter

/// One plan-limit window: its label, how much of it is gone, and when it
/// resets. A percentage of a quota nobody has told us — never a token count,
/// and nothing here converts one into the other.
private struct LimitMeter: View {
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

    /// "resets in 2h 15m" — nil once the reset time is unknown or passed.
    private var resetText: String? {
        guard let date = window.resetsDate else { return nil }
        let seconds = Int(date.timeIntervalSince(now))
        guard seconds > 60 else { return seconds > 0 ? "resets soon" : nil }
        // Derive units from one rounded minute total so 7199s is "2h", never "1h 60m".
        let totalMinutes = (seconds + 30) / 60
        if totalMinutes < 60 { return "resets in \(totalMinutes)m" }
        let totalHours = totalMinutes / 60
        if totalHours < 24 {
            let minutes = totalMinutes % 60
            return minutes > 0 ? "resets in \(totalHours)h \(minutes)m" : "resets in \(totalHours)h"
        }
        let days = totalHours / 24
        let hours = totalHours % 24
        return hours > 0 ? "resets in \(days)d \(hours)h" : "resets in \(days)d"
    }

    private var label: some View {
        Text(window.label)
            .font(.system(.caption2, design: .rounded).weight(.semibold))
            .kerning(0.4)
            .textCase(.uppercase)
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
    }

    private var value: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(pctText)
                .font(.system(.caption, design: .rounded).weight(.bold))
                .monospacedDigit()
                .foregroundStyle(Theme.textPrimary)
            if let resetText {
                Text("· \(resetText)")
                    .font(.system(.caption2, design: .rounded))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    // Truncating this to a bare "·" helps nobody: drop it whole.
                    .layoutPriority(stacked ? 0 : -1)
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
                    Spacer(minLength: 8)
                    value
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.white.opacity(0.06))
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
            "\(sourceName) \(window.label): \(pctText) used\(resetText.map { ", \($0)" } ?? "")"
        )
    }
}
