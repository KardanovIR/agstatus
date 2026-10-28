//
//  SubtaskRows.swift
//  AgStatus
//
//  A session's subagents, drawn: the rows and the footer under a card's own
//  line, and the Subtasks section above the session screen's timeline, with
//  the words they print. Which subagents a card shows, and in which slot, is
//  BoardLayout.swift's `SubtaskSlots`; these views draw what they are handed.
//

import SwiftUI

// MARK: - Copy

/// Every word the subagent views print, pinned in one place because the web
/// board and the Android app print exactly the same ones (the spec's copy
/// table, §6.12). `verify()` holds them to it.
enum SubtaskCopy {
    /// U+00B7 with a space either side, as everywhere else on the board.
    static let separator = " · "

    static func more(_ hidden: Int) -> String { "+\(hidden) more" }
    static func done(_ done: Int) -> String { "\(done) done" }
    static let showLess = "Show less"

    /// "9 running · 1 blocked · 1 failed", the parts that are not zero. A
    /// blocked subagent is not counted as running: it is waiting on you.
    static func counts(running: Int, blocked: Int, failed: Int) -> String {
        [(running, "running"), (blocked, "blocked"), (failed, "failed")]
            .filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)" }
            .joined(separator: separator)
    }

    /// `counts` as it may wrap when it cannot keep to one line: after a dot,
    /// and never inside a count — a "1" ending one line and "blocked" starting
    /// the next would be two readings. The same words; the spaces that must
    /// not break are made non-breaking, so it looks no different.
    static func wrapping(_ counts: String) -> String {
        counts.components(separatedBy: separator)
            .map { $0.replacingOccurrences(of: " ", with: "\u{00A0}") }
            .joined(separator: "\u{00A0}\u{00B7} ")
    }

    static func doneThisTurn(_ done: Int) -> String { "\(done) done this turn" }

    static let section = "Subtasks"
    static let timeline = "Timeline"
    /// What VoiceOver calls a card's rows, taken together.
    static let group = "Subagents"
    /// The phone's footer leaves the board, which its words do not say.
    static let opensScreen = "Opens the session screen"

    /// A row's name: "verify:hook, blocked: Approve: npm test -- hook", or
    /// without the activity when it has none.
    static func row(_ item: Subtask) -> String {
        item.activity.isEmpty
            ? "\(item.label), \(item.state.rawValue)"
            : "\(item.label), \(item.state.rawValue): \(item.activity)"
    }
}

// MARK: - Footer

/// What closes a card's subagent block, if anything: a count, or a control.
///
/// A control only where it leads somewhere — open the list in place, fold it,
/// or, under the phone's rules, open the session screen — and plain words
/// where it is only a count. Separate from the view so the decision can be
/// checked by the table in `SubtaskCopy.verify()`.
enum SubtaskFooter: Equatable {
    /// "12 done": nothing hidden, nothing to open.
    case count(done: Int)
    /// "+7 more · 15 done", opening every row in place (chevron down).
    case expand(hidden: Int, done: Int)
    /// "Show less · 15 done", folding back to the slots (chevron up).
    case fold(done: Int)
    /// "+8 more · 15 done", opening the session screen (chevron right).
    case screen(hidden: Int, done: Int)

    /// The spec's footer rule (§6.5). `items` and `shown` are the card's
    /// subagents and the rows it draws of them; nil means no footer at all.
    ///
    /// Open is a flag the reader set and only the reader clears, so a list
    /// that shrinks to fit its slots and grows again is still open — but it is
    /// only offered as "Show less" while there is something to fold.
    static func resolve(items: Int, shown: Int, done: Int, slots: Int,
                        open: Bool, phoneRules: Bool) -> SubtaskFooter? {
        let hidden = max(0, items - shown)
        if phoneRules && hidden > 0 { return .screen(hidden: hidden, done: done) }
        if !phoneRules && open && items > slots { return .fold(done: done) }
        if !phoneRules && hidden > 0 { return .expand(hidden: hidden, done: done) }
        if done > 0 { return .count(done: done) }
        return nil
    }

    /// The words in order, each with the number it carries, which is the part
    /// that ticks when it changes.
    var parts: [(text: String, count: Int?)] {
        switch self {
        case .count(let done):
            [(SubtaskCopy.done(done), done)]
        case .expand(let hidden, let done), .screen(let hidden, let done):
            [(SubtaskCopy.more(hidden), hidden)] + (done > 0 ? [(SubtaskCopy.done(done), done)] : [])
        case .fold(let done):
            [(SubtaskCopy.showLess, nil)] + (done > 0 ? [(SubtaskCopy.done(done), done)] : [])
        }
    }

    var text: String {
        parts.map(\.text).joined(separator: SubtaskCopy.separator)
    }

    /// The same words for VoiceOver, with a pause where the dot is.
    var spoken: String {
        parts.map(\.text).joined(separator: ", ")
    }
}

// MARK: - Card block

/// A card's subagents: one hairline in the card's edge colour, a row for each
/// subagent on show, and the footer.
///
/// No box, no fill, no radius. A tinted band here would be a card inside a
/// card, and the card's own status word has to stay the loudest thing on it;
/// a row's state is the same mark-and-word system, smaller and quieter.
struct SubtaskBlock: View {
    @Environment(\.openSession) private var openSession
    @Environment(\.toggleSubtasks) private var toggleSubtasks
    @Environment(\.subtaskSlots) private var ledger
    @Environment(\.subtasksOpenScreen) private var phoneRules
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 28pt a row, not 44. A row opens the same session screen as its
    /// neighbours, only scrolled to a different subagent, so a mis-tap costs
    /// a scroll. Focus is the card's one control that reaches across to
    /// another machine, and it keeps its 44. Scaled with the rows' text, so
    /// large text keeps the air the design gives a row at the default size.
    @ScaledMetric(relativeTo: .footnote) private var rowHeight: CGFloat = 28

    let session: Session
    let subtasks: Subtasks
    /// The card's edge colour, which the one hairline inside it shares: both
    /// come from the card's state, so the two cannot drift.
    let rule: Color

    var body: some View {
        let rows = ledger.rows(for: session)
        let footer = SubtaskFooter.resolve(items: subtasks.items.count,
                                           shown: rows.count,
                                           done: subtasks.done,
                                           slots: ledger.slots,
                                           open: !phoneRules && ledger.isOpen(session.id),
                                           phoneRules: phoneRules)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { item in
                SubtaskRow(item: item, height: rowHeight) {
                    openSession(SessionRoute(sessionId: session.id, subtaskId: item.id))
                }
                // A row moves when it starts, and at no other time: it fades
                // in where it stands. A finished one simply goes, and the row
                // that takes its slot is the one that fades in — fading the
                // leaver too would draw it over the rows that have already
                // closed up beneath it. The animation rides on the transition
                // itself, so nothing else in the card is animated with it: an
                // activity written in place is not news.
                .transition(.asymmetric(insertion: reduceMotion ? .identity : Self.rowIn, removal: .identity))
            }
            if let footer {
                footerView(footer)
            }
        }
        // 2pt under the hairline, and the 8pt above it that the card's own
        // spacing would otherwise leave to chance.
        .padding(.top, 3)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(rule)
                .frame(height: 1)
                .accessibilityHidden(true)
        }
        .padding(.top, Theme.Space.xs)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(SubtaskCopy.group)
    }

    /// From 3pt up, over the board's middle duration (220ms).
    static let rowIn = AnyTransition.opacity
        .combined(with: .offset(y: -3))
        .animation(.easeOut(duration: 0.22))

    @ViewBuilder
    private func footerView(_ footer: SubtaskFooter) -> some View {
        switch footer {
        case .count:
            FooterWords(footer: footer)
                .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        case .expand:
            Button { toggleSubtasks(session.id) } label: {
                FooterControl(footer: footer, chevron: "chevron.down", height: rowHeight)
            }
            .buttonStyle(SubtaskPressStyle())
            .accessibilityHint("Shows every subagent in the card")
        case .fold:
            Button { toggleSubtasks(session.id) } label: {
                FooterControl(footer: footer, chevron: "chevron.up", height: rowHeight)
            }
            .buttonStyle(SubtaskPressStyle())
            .accessibilityHint("Folds the list back to the first rows")
        case .screen:
            Button { openSession(SessionRoute(sessionId: session.id)) } label: {
                FooterControl(footer: footer, chevron: "chevron.right", height: rowHeight)
            }
            .buttonStyle(SubtaskPressStyle())
            .accessibilityHint(SubtaskCopy.opensScreen)
        }
    }
}

/// One subagent on a card: what it was asked to do, what it is doing, and its
/// state, which stands at the trailing edge — under the badge in the rail, so
/// the badge and the rows' marks make one column down the card's right side.
private struct SubtaskRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: Subtask
    /// The block's row height — see `SubtaskBlock.rowHeight`.
    let height: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Space.xs) {
                SubtaskTextLayout {
                    Text(item.label)
                        .font(.footnote.weight(.medium))
                        // The one row that needs you is lit; the rest are the
                        // quiet ink.
                        .foregroundStyle(item.state == .blocked ? Theme.textPrimary : Theme.textSecondary)
                    Text(item.activity)
                        .font(.footnote)
                        .foregroundStyle(Theme.textTertiary)
                }
                .lineLimit(1)
                // Written in place: a new activity or label is not news, and
                // must never cross-fade over the old one.
                .contentTransition(.identity)
                .frame(maxWidth: .infinity, alignment: .leading)

                SubtaskStateLabel(state: item.state)
                    // Ordinary changes of class are written in place too…
                    .transaction { $0.animation = nil }
                    // …and into or out of blocked, or into failed, the state
                    // re-enters, over the board's slow duration (420ms).
                    .id(item.state.entryKey)
                    .transition(.asymmetric(insertion: reduceMotion ? .identity : Self.stateIn,
                                            removal: .identity))
            }
            .frame(minHeight: height)
            .contentShape(Rectangle())
        }
        .buttonStyle(SubtaskPressStyle())
        .accessibilityLabel(SubtaskCopy.row(item))
        .accessibilityHint("Opens the session screen at this subagent")
    }

    static let stateIn = AnyTransition.opacity
        .combined(with: .offset(y: -3))
        .animation(.easeOut(duration: 0.42))
}

extension SubtaskState {
    /// What a row's state cell re-enters on: into or out of blocked, and into
    /// failed. Planning, coding and testing share one value, because under the
    /// hook's flood rule nearly every post after a start is a change of class
    /// (the rest are a once-a-minute activity, which changes no state), and
    /// animating each would move rows almost continuously.
    var entryKey: Int {
        switch self {
        case .planning, .coding, .testing: 0
        case .blocked: 1
        case .failed: 2
        }
    }
}

/// A row's two texts: the label, capped at 58% of the width they share, and
/// the activity in the rest.
///
/// The label outlasts the activity, since it is how you know which row this
/// is — but only so far. Past the cap it is cut, so the activity, the live
/// part and the reason the row exists, always keeps a share: about 100pt on
/// a phone with a p90 label of 52 characters. An HStack cannot state that: a
/// layout priority gives the label everything it asks for, and a maximum
/// frame on it would be a fixed number of points rather than a share.
struct SubtaskTextLayout: Layout {
    static let labelShare: CGFloat = 0.58
    var spacing: CGFloat = Theme.Space.xs

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let ideal = subviews.map { $0.sizeThatFits(.unspecified) }
        let height = ideal.map(\.height).max() ?? 0
        guard let width = proposal.width, width.isFinite else {
            // Asked for its ideal: both whole, side by side.
            let sum = ideal.map(\.width).reduce(0, +)
            return CGSize(width: sum + spacing * CGFloat(max(0, ideal.count - 1)), height: height)
        }
        return CGSize(width: max(0, width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else {
            for subview in subviews {
                subview.place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                              proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
            }
            return
        }
        let widths = Self.widths(total: bounds.width,
                                 label: subviews[0].sizeThatFits(.unspecified).width,
                                 spacing: spacing)
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading,
                          proposal: ProposedViewSize(width: widths.label, height: bounds.height))
        subviews[1].place(at: CGPoint(x: bounds.minX + widths.label + spacing, y: bounds.midY),
                          anchor: .leading,
                          proposal: ProposedViewSize(width: widths.activity, height: bounds.height))
    }

    /// The label's ideal width up to its share, and what is left after the
    /// gap for the activity. Exposed for `BoardArrangement.verify()`.
    static func widths(total: CGFloat, label: CGFloat, spacing: CGFloat) -> (label: CGFloat, activity: CGFloat) {
        let total = max(0, total)
        let labelWidth = min(label, total * labelShare)
        return (labelWidth, max(0, total - labelWidth - spacing))
    }
}

/// A row's state: the badge's own mark a size down, in the state's colour, and
/// its word in the quiet ink — lower case, regular weight.
///
/// Size could not keep the badge the loudest word on the card: caption2 is
/// the smallest Dynamic Type style and the badge already uses it. Ink does.
/// The badge is the one coloured word on a card, with a column of small
/// coloured marks under it; only a blocked row's word takes its colour, and
/// at the row's weight, not the badge's — a heavy red word under BLOCKED
/// would be a second BLOCKED. textTertiary at 11pt clears AA on every card
/// ground, 4.6:1 on the blocked one, the lowest.
private struct SubtaskStateLabel: View {
    let state: SubtaskState
    /// The session screen's roomier size, a step up from the card's.
    var roomy = false

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: Theme.symbol(for: state))
                .foregroundStyle(Theme.color(for: state))
            Text(state.rawValue)
                .foregroundStyle(state == .blocked ? Theme.color(for: state) : Theme.textTertiary)
        }
        .font(roomy ? .caption : .caption2)
        .lineLimit(1)
        .fixedSize()
        // The row's own label already says it, with the label and activity.
        .accessibilityHidden(true)
    }
}

/// The footer's words, with the dot between them in the quiet ink and each
/// number ticking in from above when it changes.
private struct FooterWords: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let footer: SubtaskFooter

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(footer.parts.enumerated()), id: \.offset) { index, part in
                if index > 0 {
                    Text("·")
                        .foregroundStyle(Theme.textTertiary)
                        .padding(.horizontal, Theme.Space.xxs)
                        .accessibilityHidden(true)
                }
                if let count = part.count, let range = part.text.range(of: "\(count)") {
                    // The number alone ticks; the words around it hold still.
                    HStack(spacing: 0) {
                        Text(part.text[..<range.lowerBound])
                        Text(part.text[range])
                            .monospacedDigit()
                            .id(count)
                            .transition(.asymmetric(insertion: reduceMotion ? .identity : Self.tick,
                                                    removal: .identity))
                        Text(part.text[range.upperBound...])
                    }
                } else {
                    Text(part.text)
                }
            }
        }
        .font(.caption)
        .foregroundStyle(Theme.textSecondary)
        .lineLimit(1)
        // Read as the words it shows, not piece by piece.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(footer.spoken)
    }

    /// The count changed: the new figure drops in from half a line up.
    static let tick = AnyTransition.opacity
        .combined(with: .offset(y: -6))
        .animation(.easeOut(duration: 0.22))
}

/// The footer as a control: its words and a chevron that says where it goes.
private struct FooterControl: View {
    let footer: SubtaskFooter
    let chevron: String
    let height: CGFloat

    var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            FooterWords(footer: footer)
            Image(systemName: chevron)
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
                .foregroundStyle(Theme.textTertiary)
                .padding(.leading, 2)
                .accessibilityHidden(true)
        }
        // The whole width answers, as the row above it does.
        .frame(maxWidth: .infinity, minHeight: height, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Rows and the footer press like text, not like buttons: no fill, no tint,
/// only the dip in ink every plain control on iOS gives, so a touch is seen
/// to land without anything competing with the card.
private struct SubtaskPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
    }
}

// MARK: - Session screen

/// The Subtasks section's name and the timeline's, set as the board sets a
/// limit's label, with the section's counts beside it.
struct SubtaskSectionLabel: View {
    let title: String
    var detail = ""

    var body: some View {
        // The counts beside the name while they fit on its line, and under it
        // when they do not. Cut to the one line instead, they lost their end
        // first, and blocked is the second count: at the accessibility sizes
        // "SUBTASKS 9 running · 1…" hid the one figure that needs you.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                name
                if !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .lineLimit(1)
                }
            }
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                name
                if !detail.isEmpty {
                    // Where even a line of their own is too short, they wrap
                    // between one count and the next, never inside one.
                    Text(SubtaskCopy.wrapping(detail))
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .foregroundStyle(Theme.textTertiary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var name: some View {
        Text(title)
            .font(.system(.caption2, design: .rounded).weight(.bold))
            .kerning(0.6)
            .textCase(.uppercase)
            .lineLimit(1)
    }
}

/// One subagent on the session screen. Not a control: the screen is where a
/// row leads, so here it is a plain list item.
///
/// There is room here, so a subagent gets two lines on a phone — its label,
/// and its activity whole on a line of its own — and 52pt. On a wide screen
/// the state leads in a column of its own, as each timeline event's state
/// leads it below: trailing, it stood a thousand points from its label across
/// an iPad, and the eye could not join the two.
struct SubtaskScreenRow: View {
    let item: Subtask
    /// Six hundred points of list or more, at the default text size.
    let wide: Bool
    /// Arrived at from a card's row: its ground is lit for two seconds.
    let lit: Bool

    /// The state's column on a wide screen, before the 12pt gap to the label.
    /// It holds "planning", the widest word the hook sends, with its mark —
    /// at the reader's text size, not only the default: a fixed 80 let the
    /// word run on into the label from the larger sizes up.
    @ScaledMetric(relativeTo: .caption) private var stateColumn: CGFloat = 80
    /// The list width from which the state leads. The session screen scales
    /// it with the text, as the board scales its columns, so large text
    /// keeps the two-line rows that give an activity a line of its own.
    static let wideFrom: CGFloat = 600

    var body: some View {
        Group {
            if wide {
                HStack(spacing: Theme.Space.sm) {
                    SubtaskStateLabel(state: item.state, roomy: true)
                        .frame(width: stateColumn, alignment: .leading)
                    label
                        .layoutPriority(1)
                    activity
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 7)
                .frame(minHeight: 44)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
                        label
                            .frame(maxWidth: .infinity, alignment: .leading)
                        SubtaskStateLabel(state: item.state, roomy: true)
                    }
                    if !item.activity.isEmpty {
                        activity
                    }
                }
                .padding(.vertical, 7)
                .frame(minHeight: 52)
            }
        }
        // The lit ground reaches 8pt past the text on either side, and the
        // text keeps its place whether it is lit or not.
        .padding(.horizontal, Theme.Space.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(lit ? Theme.raised : Color.clear)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SubtaskCopy.row(item))
    }

    private var label: some View {
        Text(item.label)
            .font(.subheadline)
            .foregroundStyle(Theme.textPrimary)
            .lineLimit(1)
    }

    private var activity: some View {
        Text(item.activity)
            .font(.footnote)
            .foregroundStyle(Theme.textTertiary)
            .lineLimit(1)
    }

    /// The order the session screen lists them in: whoever needs you first,
    /// so the phone's footer lands on it, and the rest — failed included —
    /// in start order.
    static func ordered(_ items: [Subtask]) -> [Subtask] {
        items.filter { $0.state == .blocked } + items.filter { $0.state != .blocked }
    }
}

// MARK: - Environment

/// The board's resolved slot ledger, for every card on it to draw its rows
/// from. The default, outside a board, is an empty ledger, which still draws
/// a first drawing of three — see `SubtaskSlots.rows(for:)`.
private struct SubtaskSlotsKey: EnvironmentKey {
    static let defaultValue = SubtaskSlots()
}

/// Whether the board is laid out under the phone's rules, where a card shows
/// two rows and its footer opens the session screen instead of expanding the
/// list in place.
private struct SubtasksOpenScreenKey: EnvironmentKey {
    static let defaultValue = false
}

/// How a card's footer opens or folds its list in place. A board action,
/// like `openSession`: the open cards are the board's state, not the card's,
/// and an action is equal by name, so the board's fresh one on every pass
/// does not run every card again (`BoardAction`).
private struct ToggleSubtasksKey: EnvironmentKey {
    static let defaultValue = BoardAction<String>(name: "none") { _ in }
}

extension EnvironmentValues {
    var subtaskSlots: SubtaskSlots {
        get { self[SubtaskSlotsKey.self] }
        set { self[SubtaskSlotsKey.self] = newValue }
    }

    var subtasksOpenScreen: Bool {
        get { self[SubtasksOpenScreenKey.self] }
        set { self[SubtasksOpenScreenKey.self] = newValue }
    }

    var toggleSubtasks: BoardAction<String> {
        get { self[ToggleSubtasksKey.self] }
        set { self[ToggleSubtasksKey.self] = newValue }
    }
}

// MARK: - Checks

#if DEBUG
extension SubtaskCopy {
    /// The copy table and the footer rule, checked when demo mode starts in a
    /// debug build, beside the decoders' checks and for their reason: there
    /// is no test target, and a screenshot shows one footer, not the rule.
    /// The web and Android pin the same strings in their own tests.
    static func verify() {
        assert(more(4) == "+4 more" && done(12) == "12 done", "more and done")
        assert(separator == " \u{00B7} ", "the separator is a middle dot with a space either side")
        assert(counts(running: 9, blocked: 1, failed: 1) == "9 running · 1 blocked · 1 failed", "all three counts")
        assert(counts(running: 10, blocked: 0, failed: 0) == "10 running", "zero parts drop out")
        assert(counts(running: 0, blocked: 1, failed: 2) == "1 blocked · 2 failed", "no running")
        assert(counts(running: 0, blocked: 0, failed: 0).isEmpty, "nothing to count")
        // Wrapped at large text, the counts break after a dot and nowhere else.
        assert(wrapping(counts(running: 9, blocked: 1, failed: 1))
               == "9\u{00A0}running\u{00A0}\u{00B7} 1\u{00A0}blocked\u{00A0}\u{00B7} 1\u{00A0}failed",
               "breaks only between counts")
        assert(wrapping("10 running") == "10\u{00A0}running" && wrapping("").isEmpty, "one count never breaks")
        assert(doneThisTurn(15) == "15 done this turn", "done line")
        assert(section == "Subtasks" && timeline == "Timeline" && group == "Subagents", "headings")
        assert(SubtaskState.allCases.map(\.rawValue) == ["planning", "coding", "testing", "blocked", "failed"],
               "row state words")
        assert(DisplayStatus.working.rawValue == "working" && DisplayStatus.working.label == "Working",
               "the card word, in the app's capitalisation")

        let busy = Subtask(id: "a1", n: 3, label: "verify:hook", state: .blocked,
                           activity: "Approve: npm test -- hook")
        assert(row(busy) == "verify:hook, blocked: Approve: npm test -- hook", "row name")
        let quiet = Subtask(id: "a2", n: 4, label: "Subagent 4", state: .coding, activity: "")
        assert(row(quiet) == "Subagent 4, coding", "row name without an activity")

        // The footer rule. Ten items, three slots, fifteen done.
        assert(SubtaskFooter.resolve(items: 10, shown: 3, done: 15, slots: 3, open: false, phoneRules: false)
               == .expand(hidden: 7, done: 15), "wide: a control that expands")
        assert(SubtaskFooter.expand(hidden: 7, done: 15).text == "+7 more · 15 done", "wide footer")
        assert(SubtaskFooter.resolve(items: 10, shown: 10, done: 15, slots: 3, open: true, phoneRules: false)
               == .fold(done: 15), "open: Show less")
        assert(SubtaskFooter.fold(done: 15).text == "Show less · 15 done", "the owner's expanded copy")
        assert(SubtaskFooter.fold(done: 0).text == "Show less", "Show less alone")
        assert(SubtaskFooter.resolve(items: 10, shown: 2, done: 15, slots: 2, open: false, phoneRules: true)
               == .screen(hidden: 8, done: 15), "phone: a control that opens the screen")
        assert(SubtaskFooter.screen(hidden: 8, done: 15).text == "+8 more · 15 done", "phone footer")
        assert(SubtaskFooter.resolve(items: 10, shown: 2, done: 0, slots: 2, open: true, phoneRules: true)
               == .screen(hidden: 8, done: 0), "never open in place under the phone's rules")
        assert(SubtaskFooter.screen(hidden: 8, done: 0).text == "+8 more", "nothing done yet")
        assert(SubtaskFooter.resolve(items: 2, shown: 2, done: 3, slots: 3, open: false, phoneRules: false)
               == .count(done: 3), "only a count: plain words")
        assert(SubtaskFooter.count(done: 3).text == "3 done", "count footer")
        assert(SubtaskFooter.resolve(items: 0, shown: 0, done: 12, slots: 2, open: false, phoneRules: true)
               == .count(done: 12), "every row finished: the count stays")
        assert(SubtaskFooter.resolve(items: 2, shown: 2, done: 0, slots: 3, open: false, phoneRules: false) == nil,
               "nothing to say: no footer")
        // A list that shrank below its slots while open is no longer offered
        // as "Show less" — there is nothing to fold — and is still open.
        assert(SubtaskFooter.resolve(items: 2, shown: 2, done: 4, slots: 3, open: true, phoneRules: false)
               == .count(done: 4), "open, but nothing to fold")
    }
}
#endif
