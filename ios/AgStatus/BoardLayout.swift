//
//  BoardLayout.swift
//  AgStatus
//
//  How the board arranges itself: which agents get a section, which of four
//  arrangements a width allows, which form an agent's head takes at the width
//  it is given, and which side a card sits on where cards run two across.
//
//  Values only — no views. Everything here is arithmetic on a measured width
//  and on the store's own array, which is what lets it be checked by the
//  assertion tables at the bottom rather than by looking at a screenshot.
//  The views that draw the result are in AgentSections.swift and BoardView.swift.
//

import CoreGraphics
import Foundation

// MARK: - AgentGroup

/// One agent's section: its sessions, and its plan limits when it reports any.
///
/// Derived on every render from the store's flat array and never stored, so
/// grouping cannot drift from the list it describes — and the store's own
/// ordering, its dismiss-and-restore and its refresh are left exactly as they
/// were.
struct AgentGroup: Identifiable, Equatable {
    /// The agent's key as sessions carry it ("claude", "codex", …).
    let source: String
    /// This agent's sessions in the store's order, filtered and NEVER
    /// re-sorted. A card keeps its place: the store freezes a card's position
    /// when its state changes, and a second sort here would quietly undo that.
    let sessions: [Session]
    /// Nil when the agent reports no limits — a third-party agent, or usage
    /// reporting switched off — and also when it reported an empty list, which
    /// tolerant decoding allows and which leaves nothing to draw.
    let usage: UsageInfo?

    var id: String { source }
    /// What the phone's list knows this group by. Not the bare source key: a
    /// list is scrolled to a card by the card's session id, and a session
    /// whose id happened to equal an agent's key would send that scroll to
    /// the top of the agent's section instead.
    var section: JumpTarget { .section(source) }
    var name: String { UsageInfo.displayName(for: source) }
    var windows: [UsageWindow] { usage?.windows ?? [] }

    /// How many of its sessions are waiting on a person.
    ///
    /// `done` is deliberately not counted. Codex has no session-end hook, so
    /// its finished cards rest on the board for a day, and a standing "6 done"
    /// in the head would be a tally of nothing.
    var blocked: Int {
        sessions.reduce(0) { $0 + ($1.status == .blocked ? 1 : 0) }
    }

    /// The first blocked card as the eye meets it in a single column.
    var firstBlocked: Session? {
        sessions.first { $0.status == .blocked }
    }

    /// The agents on the board, sorted by key.
    ///
    /// By key and never by activity, so an agent's place does not move while
    /// the same agents are on the board — a column that changed sides because
    /// its agent got busier would be a card moving on a change of state, which
    /// is the one thing this board has decided not to do.
    ///
    /// With no sessions there is nothing to disambiguate and your limits still
    /// matter between runs, so every agent that reports limits gets a head.
    /// That is the rule the limit bars already followed.
    static func make(sessions: [Session], usage: [UsageInfo]) -> [AgentGroup] {
        let reports = Dictionary(usage.filter { !$0.windows.isEmpty }.map { ($0.source, $0) }) { first, _ in first }
        let bySource = Dictionary(grouping: sessions, by: \.source)
        let sources = bySource.isEmpty ? Array(reports.keys) : Array(bySource.keys)
        return sources.sorted().map { source in
            AgentGroup(source: source, sessions: bySource[source] ?? [], usage: reports[source])
        }
    }
}

// MARK: - Windows

extension Array where Element == AgentGroup {
    /// The most limit windows any one of these agents reports: what the
    /// tallest of their heads has to hold. A phone's pinned row is as tall as
    /// its tallest head, so this is the count `BoardArrangement.headsScroll`
    /// is given — not a sum over the agents.
    var mostWindows: Int { map(\.windows.count).max() ?? 0 }
}

// MARK: - BoardArrangement

/// Which arrangement a width allows. This is the whole rule:
///
///     fit = how many `minColumn` columns the board holds
///     fit < 2, or a short
///     screen              → narrow: sessions in one list under named groups,
///                           the heads pinned two across — or scrolling with
///                           their groups (`headsScroll`) from a third agent,
///                           and from the first on a short screen, at an
///                           accessibility text size, or when a head would
///                           hold a fifth limit window
///     2 ≤ agents ≤ fit    → columns: one column per agent
///     one agent           → stackedOne: its head full width, cards two across
///     otherwise           → stackedMany: agents stacked full width, cards two
///                           across, the heads scrolling with them
///
/// The arrangement is decided by MEASURED width and never by horizontal size
/// class. An iPad in Split View or Slide Over is a regular-width device
/// showing a phone-width board, and a size class would give it two 150pt
/// columns.
///
/// Height is the one thing a size class is asked: a compact vertical size
/// class is a phone held sideways. Most iPhones are wide enough on their side
/// for two columns, but a 6.9" one leaves the board about 300pt of height
/// between the navigation bar and the streak, and two pinned heads with their
/// limits took half of that, over a card and a third. Columns are not the
/// phone's anyway: only the list can be swiped, and the swipe is how a phone
/// has always dismissed a card. So a short screen keeps the list, as 1.5.0
/// did in every orientation, with only the agent line pinned. An iPad's
/// vertical size class is regular in every orientation and every split.
enum BoardArrangement: Equatable {
    case narrow
    case columns
    case stackedOne
    case stackedMany

    /// The narrowest a column may be. At 340pt a card with a Focus button
    /// leaves the name about 211pt — some twenty characters a line. That
    /// holds an ordinary folder name on one line, and gives a session title,
    /// which runs to several words, the two lines the card allows a name
    /// (SessionCardView's `nameAndMessage`). Narrower than that and titles
    /// start to be cut even on two.
    static let minColumn: CGFloat = 340

    /// The most heads the phone pins: two across, one row.
    ///
    /// A third agent's head went on a row of its own, and with limits the
    /// pinned heads ran to almost half of a 6.9" screen, leaving two and a
    /// half cards under them. So from a third agent the phone does what a
    /// wide board does with more agents than fit: one pinned line keeps every
    /// agent's name and alarm, and each full head scrolls with its group.
    static let narrowPinnedHeads = 2

    /// The most limit windows the phone pins in one head.
    ///
    /// Half a phone stacks a window's label over its value: 53pt a window at
    /// the default text size. Four is the most either agent reports in
    /// ordinary use — Claude's session, its week and two models' weeks;
    /// Codex's general pair and one model's pair — and four two across make a
    /// pinned row of 266pt: a third of a 6.9" board, under half of an SE's,
    /// with two cards beneath. One report may carry six (MAX_USAGE_WINDOWS in
    /// src/store.ts), and Codex reaches it with a second model: six made the
    /// row 373pt, 63% of an SE's board with a card and a fifth under it.
    ///
    /// So from a fifth window in any head the phone does what it does from a
    /// third agent: the agent line keeps every agent's name and alarm pinned,
    /// and each full head opens its group in the list. Nothing is left out —
    /// every window is in that head, a row each across the whole width.
    ///
    /// Not four of them pinned and "+2 more". Which four would be the
    /// report's first, leaving out a model's week that can be the one about
    /// to run out, or the fullest, which would move bars in and out of the
    /// head as the percentages pass each other.
    ///
    /// A count, not a measured height. A head's height is the text's to
    /// decide — Dynamic Type, an alarm going under its name — and a board that
    /// measured its heads would draw them before it could decide not to, at
    /// every launch: the frame late that the root reader exists to avoid.
    static let narrowPinnedWindows = 4

    /// Whether the heads scroll with their sections, one pinned `AgentLine`
    /// standing in for them. Columns, and a lone agent's strip, always pin
    /// their heads.
    ///
    /// `largeText` is an accessibility text size. There a phone's two pinned
    /// heads, with every limit in each, took most of the screen: on a 6.9"
    /// phone at AX4 they and the group label left the cards about 90pt. So
    /// the narrow board pins the agent line from the first agent, as it does
    /// from the third at other sizes, and the heads scroll with their groups.
    ///
    /// `compactHeight` is a phone held sideways, short of height in the same
    /// way at every text size: the same answer, for the same reason.
    ///
    /// `windows` is the most limit windows any one of the agents reports
    /// (`mostWindows`). Past `narrowPinnedWindows` the narrow board pins the
    /// agent line from the first agent, as large text does, and for the same
    /// reason: the heads would take the room the cards are for.
    ///
    /// Columns and a lone agent's strip keep their heads whatever the count.
    /// There a head has a column or the whole width to itself: it gives a
    /// window one row beside its value, or lays them three to five across, so
    /// six come to 264pt at the default size: 41% of an iPad mini's board held
    /// sideways, the shortest full-screen one. Larger text, and a short Stage
    /// Manager window, take more.
    static func headsScroll(_ arrangement: BoardArrangement, agents: Int, windows: Int = 0,
                            largeText: Bool = false, compactHeight: Bool = false) -> Bool {
        switch arrangement {
        case .narrow:
            agents > narrowPinnedHeads
                || (agents > 0 && (largeText || compactHeight || windows > narrowPinnedWindows))
        case .stackedMany: true
        case .columns, .stackedOne: false
        }
    }

    /// Between two agents. Twice the gap between two cards, on purpose:
    /// proximity is what says which cards belong to which head, so nothing has
    /// to be drawn around them.
    static let agentGutter = Theme.Space.lg

    /// Between two cards, down a column or across a pair.
    static let cardGap = Theme.Space.sm

    /// Between two heads that are not standing over columns: the phone's rows
    /// of two, and an empty board's row of limits. As the limit blocks shipped.
    static let headGap: CGFloat = 10

    /// Above the heads, under the navigation bar: the same wherever they are
    /// pinned, and where an idle board opens its scrolling empty state with
    /// them, so heads that move between the two are not moved down the screen.
    static let headsTop: CGFloat = 10

    /// How many `minColumn` columns fit in `width`, gutters included. Never
    /// less than one: a board always has room for a list.
    static func fit(width: CGFloat, minColumn: CGFloat = minColumn) -> Int {
        max(1, Int(((max(0, width) + agentGutter) / (minColumn + agentGutter)).rounded(.down)))
    }

    /// `minColumn` is a parameter because the caller scales it with Dynamic
    /// Type: at a large text size an iPad steps down to the list instead of
    /// squeezing two columns of clipped names onto the screen.
    ///
    /// `compactHeight` is a compact vertical size class, a phone held
    /// sideways, and it keeps the list whatever the width (see above).
    static func resolve(width: CGFloat, agents: Int, minColumn: CGFloat = minColumn,
                        compactHeight: Bool = false) -> BoardArrangement {
        let fit = fit(width: width, minColumn: minColumn)
        if fit < 2 || compactHeight { return .narrow }
        if agents >= 2 && agents <= fit { return .columns }
        return agents <= 1 ? .stackedOne : .stackedMany
    }

    /// The width of one of `count` equal tracks sharing `width`.
    ///
    /// Every track on the board is this number, applied as a fixed frame —
    /// the pinned heads and the columns beneath them alike. Two rows that each
    /// asked for "equal shares" would agree only while nothing in either had a
    /// larger minimum, and one unshrinkable line in one card would be enough
    /// to pull a column out from under its head. The same arithmetic on both
    /// sides cannot disagree.
    static func track(width: CGFloat, count: Int, gap: CGFloat = agentGutter) -> CGFloat {
        let count = max(1, count)
        return max(0, (width - gap * CGFloat(count - 1)) / CGFloat(count))
    }

    /// Whether a card is a whole column wide at the reader's text size,
    /// `minColumn` scaled as the caller scales it.
    ///
    /// Columns and pairs are, by construction: `fit` admits a second column
    /// only once each is that wide (checked in `verify`). The list is a column
    /// only where its width is one — an iPad's full width, or a phone held
    /// sideways at the smaller accessibility sizes (635 to 800pt against a
    /// column of 527 at AX1 and 629 at AX2; the 6.9" at AX3 too), and never a
    /// phone in portrait. At an accessibility size this decides whether a card
    /// keeps its rail beside its text (SessionCardView's `stacked`), so a
    /// phone turned at those sizes can change a card's arrangement.
    static func cardIsColumnWide(_ arrangement: BoardArrangement, width: CGFloat,
                                 minColumn: CGFloat = minColumn) -> Bool {
        arrangement != .narrow || width >= minColumn
    }
}

// MARK: - HeadForm

/// The shape an agent's head takes at the width it is given.
///
/// One view, four forms, chosen by arithmetic from a width the caller already
/// knows — not by a reader inside the head, which would decide a frame late,
/// and not by size class, for the reason `BoardArrangement` gives.
enum HeadForm: Equatable {
    /// Half a phone. The value drops under its label; the alarm keeps its
    /// mark, its number and its arrow and gives up the word; the session count
    /// goes, and an agent with no limits to show is one line.
    case narrow
    /// A phone's full width, or a third of a tablet: one row per window, label
    /// left and value right, as the limit blocks shipped.
    case regular
    /// A wide column. Three windows fit across, so the head is two rows
    /// instead of four — fifty points handed back to the list, and far less
    /// bar for the alarm to be seen against.
    case across
    /// A head with the whole board to itself: who it is on the left, the
    /// limits in one strip beside it. The same height with or without an
    /// alarm, whatever the window count.
    case strip

    /// The head's own horizontal padding, each side. Layout is measured
    /// inside it.
    static let padding: CGFloat = 14

    /// What the design's thresholds leave out of the head's width. They were
    /// drawn against the head's content box, and the prototype's box carries a
    /// 1pt border outside its 14pt padding where ours strokes inside it, so
    /// the thresholds sit 30 in from the edge, not 28.
    static let chrome: CGFloat = 30

    /// The widths the forms change at, measured inside the head.
    static let narrowMax: CGFloat = 300
    static let acrossMin: CGFloat = 520
    static let stripMin: CGFloat = 806

    /// The strip's identity block, and the least one of its limit tracks may
    /// be before a window starts another row.
    static let stripIdentity: CGFloat = 284
    static let stripTrackMin: CGFloat = 150
    static let stripGap = Theme.Space.lg

    /// `canStrip` is whether this head stands alone on its row. A column's
    /// head never takes the strip however wide the column: beside another
    /// head, an identity block on the left would put two agents' names at
    /// different places in their tracks.
    ///
    /// `scale` is the Dynamic Type factor, 1 at the default size, so the
    /// thresholds grow with the text that has to fit inside them.
    static func resolve(outer: CGFloat, canStrip: Bool, scale: CGFloat = 1) -> HeadForm {
        let inner = outer - chrome
        if canStrip && inner >= stripMin * scale { return .strip }
        if inner >= acrossMin * scale { return .across }
        return inner > narrowMax * scale ? .regular : .narrow
    }

    /// How many limit tracks a strip `available` points wide holds, for
    /// `windows` windows: as many as are at least `stripTrackMin` wide, and
    /// never more tracks than there are windows to put in them.
    static func stripTracks(available: CGFloat, windows: Int, scale: CGFloat = 1) -> Int {
        let fit = Int(((max(0, available) + stripGap) / (stripTrackMin * scale + stripGap)).rounded(.down))
        return max(1, min(windows, fit))
    }
}

// MARK: - CardSides

/// Which side each card sits on where cards run two across.
///
/// Two across is drawn as two columns that each keep their cards, not as a
/// grid filled in reading order. In a grid, dismissing one card slides every
/// card after it one cell along — half of them across the screen to the other
/// side. Here a card is given a side once, so a dismissal moves the cards
/// beneath it up and never across: the same promise the rest of the board
/// makes, that a card keeps its place.
///
/// Kept by the board view for as long as it shows one board, and never
/// persisted. Like the store's own ordering it belongs to this device.
struct CardSides: Equatable {
    enum Side: Equatable, CaseIterable {
        case leading
        case trailing
    }

    private var assigned: [String: Side] = [:]

    /// A card nobody has placed yet reads as leading. Nothing is ever drawn
    /// from that default — the board draws from `resolved(for:)`, which places
    /// every card present — but a lookup needs an answer.
    subscript(id: String) -> Side { assigned[id] ?? .leading }

    /// The ledger with a side for every card on the board.
    ///
    /// Pure, so the view can draw from the answer in the same pass that it
    /// stores it, and no frame ever shows a card that has not been placed.
    ///
    /// Each agent is walked top to bottom, and a card with no side yet takes
    /// the side holding fewer of that agent's PRESENT cards, leading on a tie.
    /// A first fill therefore alternates, exactly as the design drew it, and a
    /// later arrival lands on the shorter side — which is what re-balances two
    /// columns after dismissals without moving anybody already there.
    ///
    /// Entries are kept when a card leaves. A dismiss that fails on the server
    /// puts the card back where it was in the list, and it has to come back on
    /// the side it left as well.
    func resolved(for groups: [AgentGroup]) -> CardSides {
        var next = self
        for group in groups {
            var leading = 0
            var trailing = 0
            for session in group.sessions {
                switch assigned[session.id] {
                case .leading: leading += 1
                case .trailing: trailing += 1
                case nil: break
                }
            }
            for session in group.sessions where assigned[session.id] == nil {
                if trailing < leading {
                    next.assigned[session.id] = .trailing
                    trailing += 1
                } else {
                    next.assigned[session.id] = .leading
                    leading += 1
                }
            }
        }
        return next
    }

    /// One side's cards, in the order they were given.
    func cards(_ sessions: [Session], on side: Side) -> [Session] {
        sessions.filter { self[$0.id] == side }
    }

    /// The first blocked card as the eye meets it two across: topmost, then
    /// leftmost.
    ///
    /// Topmost is approximated by position within its own side, with the
    /// leading side winning a tie: the blocked card third down on one side is
    /// taken to be above the one fourth down on the other. It needs no
    /// measured frames — which would arrive a pass late and make the jump
    /// depend on what happened to be laid out.
    func firstBlocked(in sessions: [Session]) -> Session? {
        let candidates = Side.allCases.compactMap { side -> (row: Int, session: Session)? in
            let column = cards(sessions, on: side)
            guard let row = column.firstIndex(where: { $0.status == .blocked }) else { return nil }
            return (row, column[row])
        }
        // `min(by:)` keeps the first of equals, and `allCases` lists leading first.
        return candidates.min { $0.row < $1.row }?.session
    }
}

// MARK: - Rows

extension Array {
    /// The array cut into rows of `count`, the last one short if it has to be.
    ///
    /// Heads, limit windows and the agent line are all laid out as explicit
    /// rows of fixed-width tracks rather than in a flexible grid, so that the
    /// width of a track is a number this file chose and not one the grid
    /// arrived at.
    func rows(of count: Int) -> [[Element]] {
        let count = Swift.max(1, count)
        return stride(from: 0, to: self.count, by: count).map {
            Array(self[$0..<Swift.min($0 + count, self.count)])
        }
    }
}

// MARK: - JumpTarget

/// Where an alarm or a name on the agent line can send the scroll view.
///
/// Its own type so that an agent's section can never collide with a session:
/// both would otherwise be bare strings, and nothing stops an agent being
/// called what a session id happens to be.
enum JumpTarget: Hashable {
    case card(String)
    case section(String)
}

// MARK: - Checks

#if DEBUG
extension BoardArrangement {
    /// The layout rule, the head's thresholds and the side ledger, checked
    /// when demo mode starts in a debug build — beside `Streak.verifyDerivation`
    /// and for the same reason. This project has no test target, and these are
    /// the parts of the board a screenshot proves least: a capture shows that
    /// one width with one set of agents came out right, and says nothing about
    /// the width one point narrower, or about what a dismissal does to the
    /// cards that stay.
    static func verify() {
        // The rule, at the board widths of the devices it was drawn for — a
        // 6.1" phone (361), a 6.9" phone (408), an iPad in Split View (646),
        // and an iPad full screen in portrait (1000), 11" landscape (1178) and
        // 13" landscape (1344) — against zero to four agents.
        let phone: [BoardArrangement] = [.narrow, .narrow, .narrow, .narrow, .narrow]
        let twoFit: [BoardArrangement] = [.stackedOne, .stackedOne, .columns, .stackedMany, .stackedMany]
        let threeFit: [BoardArrangement] = [.stackedOne, .stackedOne, .columns, .columns, .stackedMany]
        let table: [(width: CGFloat, fit: Int, expected: [BoardArrangement])] = [
            (361, 1, phone),
            (408, 1, phone),
            (646, 1, phone),
            (1000, 2, twoFit),
            (1178, 3, threeFit),
            (1344, 3, threeFit),
        ]
        for row in table {
            assert(fit(width: row.width) == row.fit, "fit at \(row.width)")
            for (agents, expected) in row.expected.enumerated() {
                assert(resolve(width: row.width, agents: agents) == expected,
                       "\(agents) agents at \(row.width)")
            }
        }

        // Which heads are pinned. A phone pins two and no more; from a third
        // agent it pins the agent line, as a wide board with more agents than
        // fit does. Where there are columns, every head stands over its own.
        let scrolls: [(width: CGFloat, expected: [Bool])] = [
            (361, [false, false, false, true, true]),
            (408, [false, false, false, true, true]),
            (646, [false, false, false, true, true]),
            (1000, [false, false, false, true, true]),
            (1344, [false, false, false, false, true]),
        ]
        for row in scrolls {
            for (agents, expected) in row.expected.enumerated() {
                let arrangement = resolve(width: row.width, agents: agents)
                assert(headsScroll(arrangement, agents: agents) == expected,
                       "heads scroll with \(agents) agents at \(row.width)")
            }
        }
        // At an accessibility text size the phone pins the agent line from
        // the first agent; columns, and a lone agent's strip, keep their heads.
        assert(!headsScroll(.narrow, agents: 0, largeText: true), "large text, no agents")
        assert(headsScroll(.narrow, agents: 1, largeText: true), "large text, one agent")
        assert(headsScroll(.narrow, agents: 2, largeText: true), "large text, two agents")
        assert(!headsScroll(.columns, agents: 2, largeText: true), "large text, columns")
        assert(!headsScroll(.stackedOne, agents: 1, largeText: true), "large text, one strip")

        // A phone held sideways keeps the list, at the widths a phone has on
        // its side — a 6.1" phone (702), a 6.3" one (718), a 6.9" one (800) —
        // where the width alone would give it columns. And it pins the agent
        // line from the first agent, as large text does.
        for width: CGFloat in [702, 718, 800] {
            for agents in 0...4 {
                assert(resolve(width: width, agents: agents, compactHeight: true) == .narrow,
                       "\(agents) agents held sideways at \(width)")
            }
        }
        assert(resolve(width: 800, agents: 2) == .columns, "by its width alone, columns")
        assert(!headsScroll(.narrow, agents: 0, compactHeight: true), "sideways, no agents")
        assert(headsScroll(.narrow, agents: 1, compactHeight: true), "sideways, one agent")
        assert(headsScroll(.narrow, agents: 2, compactHeight: true), "sideways, two agents")

        // A head with more limit windows than a phone pins. From a fifth
        // window in any head the narrow board pins the agent line, as it does
        // from a third agent; four stay pinned, and so do the demo's three
        // (the App Store's). Six is the most one report carries
        // (MAX_USAGE_WINDOWS in src/store.ts). At an SE or a mini (343), a
        // 6.1" phone (361), a 6.9" one (408) and a 320pt Slide Over window
        // (288), for one agent and for two.
        for width: CGFloat in [343, 361, 408, 288] {
            for agents in 1...2 {
                let arrangement = resolve(width: width, agents: agents)
                assert(arrangement == .narrow, "\(agents) agents at \(width) are a list")
                for windows in 0...6 {
                    assert(headsScroll(arrangement, agents: agents, windows: windows) == (windows > 4),
                           "\(windows) windows, \(agents) agents at \(width)")
                }
            }
        }
        assert(!headsScroll(.narrow, agents: 0, windows: 6), "no agents, nothing pinned")
        assert(headsScroll(.narrow, agents: 3, windows: 0), "a third agent, whatever its windows")
        // A wide board keeps its heads whatever the count: a column's head
        // gives a window one row or lays three across, a strip three to five.
        assert(!headsScroll(.columns, agents: 2, windows: 6), "columns, six windows")
        assert(!headsScroll(.stackedOne, agents: 1, windows: 6), "one strip, six windows")

        // The threshold itself: two 340pt columns and one gutter.
        assert(fit(width: 703) == 1 && fit(width: 704) == 2, "two columns from 704")
        assert(fit(width: 0) == 1 && fit(width: -20) == 1, "never less than one")
        // Large text raises the bar instead of squeezing the columns.
        assert(resolve(width: 1000, agents: 2, minColumn: 340 * 1.5) == .narrow, "scaled column")

        // A card is a column wide in columns and pairs, by `fit`, and in the
        // list only where the list's width is one. At AX1 a column is 527pt
        // (title3 at 31 over 20), so no card on a phone in portrait is, nor in
        // a Slide Over window; a 6.9" phone held sideways (800) is. At AX5
        // (55 over 20) a 13" iPad's portrait list still is and an 11" one's is
        // not.
        let ax1 = minColumn * 31 / 20, ax5 = minColumn * 55 / 20
        for width: CGFloat in [288, 343, 370, 408] {
            assert(!cardIsColumnWide(.narrow, width: width, minColumn: ax1), "a phone's card at AX1, \(width)")
        }
        assert(cardIsColumnWide(.narrow, width: 800, minColumn: ax1), "a sideways 6.9\" list at AX1")
        assert(cardIsColumnWide(.narrow, width: 1000, minColumn: ax5), "13\" portrait list at AX5")
        assert(!cardIsColumnWide(.narrow, width: 802, minColumn: ax5), "11\" portrait list at AX5")
        assert(cardIsColumnWide(.columns, width: 1344, minColumn: ax1), "columns at AX1")
        for width in stride(from: CGFloat(704), through: 1400, by: 1) where fit(width: width) >= 2 {
            assert(track(width: width, count: fit(width: width)) >= minColumn, "a track is a column at \(width)")
            assert(track(width: width, count: 2, gap: cardGap) >= minColumn, "a pair is a column at \(width)")
        }

        // Tracks: the gutters come out first, and what is left is shared.
        assert(track(width: 1344, count: 2) == 660, "two tracks")
        assert(track(width: 1344, count: 3) == 432, "three tracks")
        assert(track(width: 408, count: 2, gap: headGap) == 199, "half a phone")
        assert(track(width: 1344, count: 2, gap: cardGap) == 666, "two across")
        assert(track(width: 408, count: 0) == 408, "no tracks is one track")

        // Head forms. The thresholds are inside the head, 30 in from its edge.
        assert(HeadForm.resolve(outer: 199, canStrip: false) == .narrow, "half a phone")
        assert(HeadForm.resolve(outer: 408, canStrip: true) == .regular, "a phone's width")
        assert(HeadForm.resolve(outer: 330, canStrip: false) == .narrow, "300 inside is still narrow")
        assert(HeadForm.resolve(outer: 331, canStrip: false) == .regular, "301 inside is regular")
        assert(HeadForm.resolve(outer: 432, canStrip: false) == .regular, "a third of a 13\" iPad")
        assert(HeadForm.resolve(outer: 488, canStrip: false) == .regular, "half an iPad in portrait")
        assert(HeadForm.resolve(outer: 549, canStrip: false) == .regular, "519 inside")
        assert(HeadForm.resolve(outer: 550, canStrip: false) == .across, "520 inside")
        assert(HeadForm.resolve(outer: 660, canStrip: false) == .across, "half a 13\" iPad")
        assert(HeadForm.resolve(outer: 835, canStrip: true) == .across, "805 inside")
        assert(HeadForm.resolve(outer: 836, canStrip: true) == .strip, "806 inside")
        assert(HeadForm.resolve(outer: 1344, canStrip: true) == .strip, "the full board")
        assert(HeadForm.resolve(outer: 1344, canStrip: false) == .across, "never a strip beside another head")
        assert(HeadForm.resolve(outer: 660, canStrip: false, scale: 1.3) == .regular, "scaled thresholds")
        assert(HeadForm.stripTracks(available: 1008, windows: 3) == 3, "three windows, room for five")
        assert(HeadForm.stripTracks(available: 664, windows: 6) == 3, "six windows make two rows")
        assert(HeadForm.stripTracks(available: 100, windows: 3) == 1, "always one track")
        assert(HeadForm.stripTracks(available: 1008, windows: 0) == 1, "no windows is still one track")

        // Groups.
        func session(_ id: String, _ source: String, _ status: AgentStatus = .coding) -> Session {
            Session(id: id, name: id, status: status, message: "", project: "",
                    source: source, createdAt: 0, updatedAt: 0)
        }
        func report(_ source: String, windows: Int = 1) -> UsageInfo {
            UsageInfo(source: source,
                      windows: (0..<windows).map { UsageWindow(id: "w\($0)", label: "w", usedPct: 10, resetsAt: nil) },
                      updatedAt: 0)
        }
        let board = [session("d", "codex"), session("a", "claude"), session("c", "codex", .blocked),
                     session("b", "claude"), session("e", "gemini", .done)]
        let groups = AgentGroup.make(sessions: board,
                                     usage: [report("codex"), report("claude"), report("cursor"),
                                             report("gemini", windows: 0)])
        assert(groups.map(\.source) == ["claude", "codex", "gemini"], "by key, and only agents with sessions")
        assert(groups[1].sessions.map(\.id) == ["d", "c"], "the store's order, never re-sorted")
        assert(groups[0].usage?.source == "claude" && groups[2].usage == nil, "an empty report is no report")
        assert(groups.map(\.blocked) == [0, 1, 0], "done is not counted")
        assert(groups[1].firstBlocked?.id == "c", "first blocked in a column")
        let idle = AgentGroup.make(sessions: [], usage: [report("codex"), report("claude"),
                                                         report("gemini", windows: 0)])
        assert(idle.map(\.source) == ["claude", "codex"], "no sessions: every agent that reports limits")
        assert(AgentGroup.make(sessions: [], usage: []).isEmpty, "nothing at all")

        // What the window rule is given: the most windows any one agent
        // reports, not a sum.
        assert(groups.mostWindows == 1, "one window each, and an empty report is none")
        let tall = AgentGroup.make(sessions: board,
                                   usage: [report("codex", windows: 6), report("claude", windows: 3)])
        assert(tall.mostWindows == 6, "the tallest head")
        assert(AgentGroup.make(sessions: [session("g", "gemini")], usage: []).mostWindows == 0,
               "no limits, no windows")

        // Rows.
        assert([1, 2, 3].rows(of: 2) == [[1, 2], [3]], "a short last row")
        assert([1, 2, 3].rows(of: 3) == [[1, 2, 3]] && [1, 2, 3].rows(of: 0) == [[1], [2], [3]], "rows")
        assert([Int]().rows(of: 2).isEmpty, "no rows of nothing")

        // Sides. A first fill alternates down each agent.
        let five = (1...5).map { session("s\($0)", "claude") }
        let filled = CardSides().resolved(for: AgentGroup.make(sessions: five, usage: []))
        assert(five.map { filled[$0.id] } == [.leading, .trailing, .leading, .trailing, .leading],
               "first fill alternates")
        assert(filled.resolved(for: AgentGroup.make(sessions: five, usage: [])) == filled, "settled")

        // Removing a card never changes another card's side.
        for removed in five {
            let rest = five.filter { $0.id != removed.id }
            let after = filled.resolved(for: AgentGroup.make(sessions: rest, usage: []))
            assert(rest.allSatisfy { after[$0.id] == filled[$0.id] }, "others stay when \(removed.id) leaves")
            // …and it comes back to the side it left, as a failed dismiss needs.
            let restored = after.resolved(for: AgentGroup.make(sessions: five, usage: []))
            assert(restored[removed.id] == filled[removed.id], "\(removed.id) returns to its side")
        }

        // An arrival takes the shorter side of what is PRESENT: with s1 and s3
        // gone the leading side holds one card and the trailing side two.
        let thinned = five.filter { $0.id != "s1" && $0.id != "s3" }
        let arrived = filled.resolved(for: AgentGroup.make(sessions: [session("new", "claude")] + thinned,
                                                           usage: []))
        assert(arrived["new"] == .leading, "an arrival takes the shorter side")
        // Each agent keeps its own count.
        let mixed = [session("x1", "claude"), session("y1", "codex"), session("x2", "claude")]
        let both = CardSides().resolved(for: AgentGroup.make(sessions: mixed, usage: []))
        assert(both["x1"] == .leading && both["x2"] == .trailing && both["y1"] == .leading,
               "sides are counted per agent")

        // Two across, the first blocked card is the higher one, leading on a tie.
        let lower = [session("p1", "claude"), session("p2", "claude"),
                     session("p3", "claude", .blocked), session("p4", "claude", .blocked)]
        let lowerSides = CardSides().resolved(for: AgentGroup.make(sessions: lower, usage: []))
        assert(lowerSides.firstBlocked(in: lower)?.id == "p3", "a tie goes to the leading side")
        let higher = [session("q1", "claude"), session("q2", "claude", .blocked),
                      session("q3", "claude", .blocked)]
        let higherSides = CardSides().resolved(for: AgentGroup.make(sessions: higher, usage: []))
        assert(higherSides.firstBlocked(in: higher)?.id == "q2", "the higher card, whichever side")
        assert(higherSides.firstBlocked(in: [session("z", "claude")]) == nil, "nothing blocked")
    }
}
#endif
