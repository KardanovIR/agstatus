//
//  BoardLayout.swift
//  AgStatus
//
//  How the board arranges itself: which project each card is under and the
//  order the projects come in, which agents get a head and whether the heads
//  are pinned, which of two arrangements a width allows, which form a head
//  takes at the width it is given, which side a card sits on where cards run
//  two across, the order a reader meets the cards in, which card the
//  needs-you bar names, which blocks are not news, and when the bar beats.
//
//  Values only — no views. Everything here is arithmetic on a measured width
//  and on the store's own array, which is what lets it be checked by the
//  assertion tables at the bottom rather than by looking at a screenshot.
//  The views that draw the result are in AgentSections.swift and BoardView.swift.
//

import CoreGraphics
import Foundation

// MARK: - Exact names

extension String {
    /// Whether this is `other` code unit for code unit: how every board
    /// compares folder names, section keys and session names.
    ///
    /// Not Swift's `==`, which compares by canonical equivalence, so that a
    /// composed "café" (U+00E9) equals a decomposed one (e + U+0301) — and
    /// hashes them alike. The web compares with `===` and Android with
    /// Kotlin's `==`, both code unit by code unit, and the three boards have
    /// to draw one board: the same folder sent in two forms by two machines
    /// is two sections everywhere, never one on a phone and two on the desk.
    /// A 1.7 server sends every name in NFC, where the two rules agree; an
    /// older one sends whatever it was given.
    func isExactly(_ other: String) -> Bool {
        utf16.elementsEqual(other.utf16)
    }
}

// MARK: - ProjectKey

/// Which section a card is under: a folder, by its name in exact case, or no
/// usable folder at all.
///
/// "No project" is a case of its own rather than a reserved name, so a folder
/// that somebody really did call "No project" is a section like any other,
/// and a folder called "codex" is never mistaken for the Codex head or for a
/// session whose id is "codex" (`JumpTarget`).
///
/// Equal, and hashed, code unit by code unit (`isExactly`): a key is a
/// folder's name exactly as it was sent.
enum ProjectKey: Hashable {
    case folder(String)
    case noProject

    static func == (lhs: ProjectKey, rhs: ProjectKey) -> Bool {
        switch (lhs, rhs) {
        case let (.folder(a), .folder(b)): a.isExactly(b)
        case (.noProject, .noProject): true
        default: false
        }
    }

    func hash(into hasher: inout Hasher) {
        switch self {
        case .folder(let name):
            hasher.combine(0 as UInt8)
            hasher.combine(name.utf16.count)
            for unit in name.utf16 { hasher.combine(unit) }
        case .noProject:
            hasher.combine(1 as UInt8)
        }
    }

    /// The section key of the wire contract (docs/design/project-sections.md):
    /// the folder the server pinned for the session's life (`homeProject`);
    /// else, from a server too old to pin one, the live folder; else no
    /// project. Only a name that can name a folder counts, wherever it comes
    /// from (`Session.isFolderName`: not `''`, `/`, `.`, blank or a UUID): a
    /// 1.7 server never pins one that cannot, and a pinned value that somehow
    /// is one is read as no pin at all. The name is kept exactly as sent.
    ///
    /// So a card moves between sections at most once, out of No project when
    /// its first real folder arrives. On an older server it follows the live
    /// folder instead, and a `cd` does move it: the honest fallback, since
    /// that server knows nothing better.
    static func of(_ session: Session) -> ProjectKey {
        if Session.isFolderName(session.homeProject) { return .folder(session.homeProject) }
        if Session.isFolderName(session.project) { return .folder(session.project) }
        return .noProject
    }

    /// The folder's name, exact case; nil for No project.
    var folder: String? {
        if case .folder(let name) = self { return name }
        return nil
    }

    /// What its label says: the folder's name, or the board's own words.
    var title: String { folder ?? "No project" }

    /// Whether this section comes before `other`: the order every client
    /// draws, and the one thing about sections that has to agree across
    /// them.
    ///
    /// By name, case ignored, with exact case breaking a tie — `AgStatus`
    /// before `agstatus` — and No project always last. Never by activity,
    /// state or arrival: a section that moved up the board because one of its
    /// cards got busy would be a card moving on a change of state, which is
    /// the one thing this board does not do. A new project takes its place in
    /// the alphabet, and the sections after it move down as its first card
    /// arrives.
    ///
    /// Compared as UTF-16 code units, the lowercased name first: what
    /// JavaScript's `<` does on `toLowerCase()` and Kotlin's `compareTo` on
    /// `lowercase(Locale.ROOT)`. Not `localizedStandardCompare`, whose order
    /// changes with the reader's locale and puts `agstatus` before `AgStatus`.
    func precedes(_ other: ProjectKey) -> Bool {
        Self.precedes(order, other.order)
    }

    /// The keys in the shared order. Each name is lowercased once, not once
    /// a comparison.
    static func sorted(_ keys: [ProjectKey]) -> [ProjectKey] {
        keys.map { ($0, $0.order) }.sorted { precedes($0.1, $1.1) }.map(\.0)
    }

    /// What the order reads of a folder's name: lowercased, then exact, each
    /// as UTF-16 code units. Nil for No project, which comes last.
    private var order: (folded: [UInt16], exact: [UInt16])? {
        guard case .folder(let name) = self else { return nil }
        return (Array(Self.folded(name).utf16), Array(name.utf16))
    }

    private static func precedes(_ a: (folded: [UInt16], exact: [UInt16])?,
                                 _ b: (folded: [UInt16], exact: [UInt16])?) -> Bool {
        guard let a else { return false }
        guard let b else { return true }
        if a.folded != b.folded { return a.folded.lexicographicallyPrecedes(b.folded) }
        return a.exact.lexicographicallyPrecedes(b.exact)
    }

    /// A name lowercased as JavaScript's `toLowerCase()` and Kotlin's
    /// `lowercase(Locale.ROOT)` lowercase it: Unicode's full mapping with no
    /// locale's rules, the final-sigma rule included, so the Σ that ends a
    /// word becomes ς (U+03C2) and any other σ. The standard library's
    /// `lowercased()` maps each character on its own and makes every Σ a σ,
    /// which put "νομος-api" before "ΝΟΜΟΣ" here and after it on the other
    /// boards. Foundation's, with no locale, applies the rule (`verify`).
    ///
    /// At the rule's corners the platforms part. A Σ before a full stop and
    /// a letter, as in "ΝΟΜΟΣ.api", is σ here on iOS 26 and in JavaScript,
    /// but ς through NSString, which an older iOS may use for this call; and
    /// the desktop JVM makes the Σ of "ΑΣ-Z" a σ. The spec's Risks has the
    /// measurements.
    static func folded(_ name: String) -> String {
        name.lowercased(with: nil)
    }
}

extension Session {
    /// The section this card is under (`ProjectKey.of`).
    var projectKey: ProjectKey { .of(self) }

    /// Where the session works now, when that is news: its live folder, when
    /// that is a folder, and neither its project's nor its own name — which
    /// is to say when the session has moved. The card then reads "in web".
    ///
    /// Under the project's label a card no longer says "in acme-api": the
    /// label already does, for every card beneath it. That includes a titled
    /// session, which 1.6.5 always gave its folder, and a worktree root,
    /// which reports its repository and is grouped under it.
    ///
    /// Both comparisons are exact (`isExactly`), as on the web and Android.
    var movedTo: String? {
        guard let directory, !project.isExactly(name) else { return nil }
        return directory
    }

    /// The live folder, where it is a folder and not the project's own:
    /// what More Content calls Directory. Unlike the face's place it is said
    /// even when it is the card's own name. Exact, as `movedTo` is.
    var directory: String? {
        guard Session.isFolderName(project) else { return nil }
        if let folder = projectKey.folder, project.isExactly(folder) { return nil }
        return project
    }

    /// Whether the session's name says no more than its agent's: none at
    /// all, or exactly its agent's display name, which the hook gives a
    /// session with no folder. Exact, as the bar's comparisons are: "codex"
    /// is a name of its own beside the agent Codex.
    func isNamed(for agent: String) -> Bool {
        name.isEmpty || name.isExactly(agent)
    }

    /// What VoiceOver hears first on a card: "<agent>, <name>" — "Claude,
    /// Fix the login redirect" — or the name alone where it is the agent's,
    /// so the untitled Codex session at `/` is "Codex", never "Codex, Codex".
    /// The same on the web and Android.
    func lead(agent: String) -> String {
        isNamed(for: agent) ? agent : "\(agent), \(name)"
    }
}

// MARK: - ProjectSection

/// One project's section: its folder and its sessions.
///
/// Derived on every render from the store's flat array and never stored, so
/// grouping cannot drift from the list it describes — and the store's own
/// ordering, its dismiss-and-restore and its refresh are left exactly as they
/// were. It carries every field of every session it holds, which is why a
/// label is not handed one (`SectionLabel`).
struct ProjectSection: Identifiable, Equatable {
    let key: ProjectKey
    /// This project's sessions in the store's order, filtered and NEVER
    /// re-sorted. A card keeps its place: the store puts a new session on
    /// top and freezes everyone else's position, and a sort here would
    /// quietly undo that. So a new session goes on top of its section, and a
    /// card that becomes blocked stays where it is: the bar is the way to it.
    let sessions: [Session]

    /// What the list and the stack know a section by: a case of its own,
    /// which no session id and no head can equal.
    var id: JumpTarget { .section(key) }

    /// What its label draws of it.
    var label: SectionLabel { SectionLabel(key: key, count: sessions.count) }

    /// The board's sections, in the shared order (`ProjectKey.precedes`).
    /// Every section holds at least one card: a project is on the board while
    /// it has a session, and its label goes with its last card.
    static func make(sessions: [Session]) -> [ProjectSection] {
        var keys: [ProjectKey] = []
        var members: [ProjectKey: [Session]] = [:]
        for session in sessions {
            let key = session.projectKey
            if members[key] == nil { keys.append(key) }
            members[key, default: []].append(session)
        }
        return ProjectKey.sorted(keys).map { ProjectSection(key: $0, sessions: members[$0] ?? []) }
    }
}

/// A section's label as it is drawn: whose it is and how many cards it
/// holds. Nothing else of its section.
///
/// The section itself changes with every hook event on any of its cards; a
/// label handed it would run again for a message it does not draw. Handed
/// this and compared as a value (`ProjectLabel`'s `==`), it runs when a card
/// arrives or leaves, and otherwise not at all. No token total and no blocked
/// count, on purpose: Claude's and Codex's tokens are not one measure, and
/// the bar is the alarm.
struct SectionLabel: Equatable {
    let key: ProjectKey
    let count: Int

    var title: String { key.title }
    var isNoProject: Bool { key == .noProject }
    var countText: String { "\(count) session\(count == 1 ? "" : "s")" }
    /// "acme-api, 3 sessions": one heading, so the rotor walks the projects.
    var spoken: String { "\(title), \(countText)" }
}

// MARK: - What a head draws

/// An agent as its head draws it: who it is, how many sessions it has, and
/// its limits. Nothing else.
///
/// A head used to be handed the agent's group of sessions. The board rebuilds
/// every value on every pass, and a group carries its sessions, so on every
/// hook event every head was a new value and ran again — and measured every
/// reset time in every one of its meters again — for a message changing on a
/// card it does not draw. Handed this and compared as a value (`AgentHead`'s
/// `==`), a head runs when one of these changes, and otherwise not at all.
///
/// No blocked count any more. The heads gave the alarm up to the needs-you
/// bar, so a card becoming blocked is not a head's news either, and red in a
/// head can only be a limit past 85%.
struct AgentSummary: Identifiable, Equatable {
    let source: String
    /// How many sessions it has on the board.
    let sessions: Int
    let windows: [UsageWindow]

    /// A case of its own, as a section's and a card's are, so the three can
    /// never be taken for one another.
    var id: JumpTarget { .head(source) }
    var name: String { UsageInfo.displayName(for: source) }

    /// The agents that get a head, sorted by key.
    ///
    /// Those with sessions on the board. By key and never by activity, so a
    /// head's place does not move while the same agents are on the board.
    /// With no sessions there is nothing to tell apart and your limits still
    /// matter between runs, so every agent that reports limits gets a head:
    /// the rule the limit bars always followed. A report with no windows,
    /// which tolerant decoding allows, is no report.
    static func make(sessions: [Session], usage: [UsageInfo]) -> [AgentSummary] {
        let reports = Dictionary(usage.filter { !$0.windows.isEmpty }.map { ($0.source, $0) }) { first, _ in first }
        var counts: [String: Int] = [:]
        for session in sessions { counts[session.source, default: 0] += 1 }
        let sources = counts.isEmpty ? Array(reports.keys) : Array(counts.keys)
        return sources.sorted().map { source in
            AgentSummary(source: source, sessions: counts[source] ?? 0, windows: reports[source]?.windows ?? [])
        }
    }
}

extension Array where Element == AgentSummary {
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
///     screen              → list: one list of sections under sticky labels
///     otherwise           → stacked: sections stacked full width, cards two
///                           across inside each
///
/// One wide arrangement for any number of projects. It is 1.6.5's "more
/// agents than fit" board keyed by project, and the agent columns retired with
/// the agent sections: a column per project could hold two or three of them,
/// and a board of nine would have needed both arrangements anyway.
///
/// Decided by MEASURED width and never by horizontal size class. An iPad in
/// Split View or Slide Over is a regular-width device showing a phone-width
/// board, and a size class would give it two 150pt columns.
///
/// Height is the one thing a size class is asked: a compact vertical size
/// class is a phone held sideways. Most iPhones are wide enough on their side
/// for two columns, but a 6.9" one leaves the board about 300pt of height
/// between the navigation bar and the streak, and only the list can be swiped,
/// which is how a phone has always dismissed a card. So a short screen keeps
/// the list, as 1.5.0 did in every orientation. An iPad's vertical size class
/// is regular in every orientation and every split.
enum BoardArrangement: Equatable {
    case list
    case stacked

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
    /// half cards under them. So from a third agent the heads lead the list
    /// and scroll away, and only the label of the section under you is
    /// pinned.
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
    /// third agent: the heads open the list, each across the whole width and
    /// every window in it, and scroll away. Not four of them pinned and "+2
    /// more": which four would be the report's first, leaving out a model's
    /// week that can be the one about to run out, or the fullest, which would
    /// move bars in and out of the head as the percentages pass each other.
    ///
    /// A count, not a measured height. A head's height is the text's to
    /// decide, and a board that measured its heads would draw them before it
    /// could decide not to, at every launch: the frame late that the root
    /// reader exists to avoid.
    static let narrowPinnedWindows = 4

    /// The most strips a wide board pins, one to a row. A lone agent's strip
    /// is pinned whatever it holds; two are pinned at a standard text size
    /// with at most `narrowPinnedWindows` windows each, two rows of about 80pt
    /// over a board of 746. From a third, or at an accessibility size, the
    /// strips lead the scroll instead.
    static let widePinnedHeads = 2

    /// Whether the heads scroll away at the top of the board, leaving nothing
    /// pinned above it. The agent line that used to stand in for them
    /// retired with their alarms: the needs-you bar is the alarm, and there
    /// are no agent sections left for its names to take you to.
    ///
    /// The phone's rule is 1.6.5's. Pinned two across while there are at most
    /// two agents with at most four windows each, at a standard text size,
    /// upright. `largeText` is an accessibility text size: there a phone's two
    /// pinned heads, every limit in each, took most of the screen — on a 6.9"
    /// phone at AX4 they left the cards about 90pt. `compactHeight` is a phone
    /// held sideways, short of height in the same way at every text size.
    ///
    /// A wide board's strips have the whole width each, so a window gets a
    /// track of its own beside the others and six come to two rows of a
    /// strip. A lone agent's is always pinned; two are while
    /// `widePinnedHeads` allows.
    static func headsScroll(_ arrangement: BoardArrangement, agents: Int, windows: Int = 0,
                            largeText: Bool = false, compactHeight: Bool = false) -> Bool {
        switch arrangement {
        case .list:
            agents > narrowPinnedHeads
                || (agents > 0 && (largeText || compactHeight || windows > narrowPinnedWindows))
        case .stacked:
            agents > widePinnedHeads
                || (agents == widePinnedHeads && (largeText || windows > narrowPinnedWindows))
        }
    }

    /// Between two projects, and what `fit` keeps between two columns. Twice
    /// the gap between two cards, on purpose: proximity is what says which
    /// cards belong to which label, so nothing has to be drawn around them.
    static let sectionGap = Theme.Space.lg

    /// Between two cards, down a side or across a pair.
    static let cardGap = Theme.Space.sm

    /// From a label's name to its first card.
    static let labelGap = Theme.Space.xs

    /// Between two heads: the phone's rows of two, a wide board's strips, and
    /// an empty board's row of limits. As the limit blocks shipped.
    static let headGap: CGFloat = 10

    /// Above the heads, under the navigation bar: the same wherever they are
    /// pinned, and where an idle board opens its scrolling empty state with
    /// them, so heads that move between the two are not moved down the screen.
    static let headsTop: CGFloat = 10

    /// How many `minColumn` columns fit in `width`, a section's gap between
    /// each. Never less than one: a board always has room for a list.
    static func fit(width: CGFloat, minColumn: CGFloat = minColumn) -> Int {
        max(1, Int(((max(0, width) + sectionGap) / (minColumn + sectionGap)).rounded(.down)))
    }

    /// `minColumn` is a parameter because the caller scales it with Dynamic
    /// Type: at a large text size an iPad steps down to the list instead of
    /// squeezing two columns of clipped names onto the screen.
    ///
    /// `compactHeight` is a compact vertical size class, a phone held
    /// sideways, and it keeps the list whatever the width (see above).
    static func resolve(width: CGFloat, minColumn: CGFloat = minColumn,
                        compactHeight: Bool = false) -> BoardArrangement {
        fit(width: width, minColumn: minColumn) < 2 || compactHeight ? .list : .stacked
    }

    /// The width of one of `count` equal tracks sharing `width`.
    ///
    /// Every track on the board is this number, applied as a fixed frame —
    /// heads two across and the two sides of a section alike. Two rows that
    /// each asked for "equal shares" would agree only while nothing in either
    /// had a larger minimum, and one unshrinkable line in one card would be
    /// enough to pull a side out of line with the next section's. The same
    /// arithmetic everywhere cannot disagree.
    static func track(width: CGFloat, count: Int, gap: CGFloat = sectionGap) -> CGFloat {
        let count = max(1, count)
        return max(0, (width - gap * CGFloat(count - 1)) / CGFloat(count))
    }

    /// Whether a card is a whole column wide at the reader's text size,
    /// `minColumn` scaled as the caller scales it.
    ///
    /// A stacked board's two sides are, by construction: `fit` admits a
    /// second column only once each is that wide (checked in `verify`). The
    /// list is a column only where its width is one — an iPad's full width,
    /// or a phone held sideways at the smaller accessibility sizes (635 to
    /// 800pt against a column of 527 at AX1 and 629 at AX2; the 6.9" at AX3
    /// too), and never a phone in portrait. At an accessibility size this
    /// decides whether a card keeps its rail beside its text
    /// (SessionCardView's `stacked`), so a phone turned at those sizes can
    /// change a card's arrangement.
    static func cardIsColumnWide(_ arrangement: BoardArrangement, width: CGFloat,
                                 minColumn: CGFloat = minColumn) -> Bool {
        arrangement == .stacked || width >= minColumn
    }
}

// MARK: - HeadForm

/// The shape an agent's head takes at the width it is given.
///
/// One view, four forms, chosen by arithmetic from a width the caller already
/// knows — not by a reader inside the head, which would decide a frame late,
/// and not by size class, for the reason `BoardArrangement` gives.
enum HeadForm: Equatable {
    /// Half a phone, or at larger text a phone's whole width: the value drops
    /// under its label. Its line holds the session count unless the head
    /// shares its row (`offersCount`), and where the board asks for it the
    /// sentence for an agent with no limits stands in place of meters, as in
    /// every form (`saysNoLimits`).
    case narrow
    /// A phone's full width, or a third of a tablet: one row per window, label
    /// left and value right, as the limit blocks shipped.
    case regular
    /// A wide head that is not a strip — an iPad held upright, an idle row
    /// of two or three. Three windows fit across, so the head is two rows
    /// instead of four.
    case across
    /// A head with the whole board to itself: who it is on the left, the
    /// limits in one strip beside it, the same height whatever the window
    /// count up to a row's worth.
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

    /// `canStrip` is whether this head stands alone on its row. A head beside
    /// another never takes the strip however wide its track: an identity
    /// block on the left would put two agents' names at different places in
    /// their tracks.
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

    /// Whether a head offers its line the session count, which the line
    /// draws beside the name where it fits and drops whole where it does not
    /// (`AgentHead`): every head with sessions but a narrow one that shares
    /// its row. Pinned two across a phone-wide board, as Frame A draws them,
    /// a head is narrow at every text size (169 inside on a 6.9", under the
    /// narrow form's 300), too narrow for the count, and never draws it.
    ///
    /// Not by the form alone. At larger text a head with a phone's whole
    /// width takes the narrow form by its scaled threshold — on an SE from
    /// extra large text, on a 6.9" from extra extra extra large, at every
    /// accessibility size — and the heads that lead the list there, each
    /// alone on its row, have room for the count. Nor by the row alone: the
    /// two heads pinned across an iPad's one-list board are regular where
    /// they are wide enough, 396 each on an 11" iPad upright at extra extra
    /// large text and 340 on a board 690 wide at the default size, and draw
    /// it there, as they did at 0a6fd33.
    static func offersCount(sessions: Int, sharesRow: Bool, form: HeadForm) -> Bool {
        sessions > 0 && !(sharesRow && form == .narrow)
    }

    /// Whether a head says "No plan limits reported" in place of meters: for
    /// an agent that reports none, wherever the board asks for the sentence
    /// (`AgentHead.showsNoLimits`) — every head but those pinned above the
    /// one-list board — and in whatever form the head takes, for the reason
    /// `offersCount` gives.
    static func saysNoLimits(windows: Int, showsNoLimits: Bool) -> Bool {
        windows == 0 && showsNoLimits
    }
}

// MARK: - CardSides

/// Which side each card sits on where cards run two across.
///
/// Two across is drawn as two sides that each keep their cards, not as a grid
/// filled in reading order. In a grid, dismissing one card slides every card
/// after it one cell along — half of them across the screen to the other
/// side. Here a card is given a side inside its own section and keeps it
/// there, so a dismissal moves the cards beneath it up and never across: the
/// same promise the rest of the board makes, that a card keeps its place.
///
/// Kept by the board view for as long as it shows one board, and never
/// persisted. Like the store's own ordering it belongs to this device.
struct CardSides: Equatable {
    enum Side: Equatable, CaseIterable {
        case leading
        case trailing
    }

    /// A card's side, and the section it was given that side in.
    private struct Placement: Equatable {
        let side: Side
        let section: ProjectKey
    }

    private var assigned: [String: Placement] = [:]

    /// A card nobody has placed yet reads as leading. Nothing is ever drawn
    /// from that default — the board draws from `resolved(for:)`, which places
    /// every card present — but a lookup needs an answer.
    subscript(id: String) -> Side { assigned[id]?.side ?? .leading }

    /// The ledger with a side for every card on the board.
    ///
    /// Pure, so the view can draw from the answer in the same pass that it
    /// stores it, and no frame ever shows a card that has not been placed.
    ///
    /// Each section is walked top to bottom, and a card with no side in it
    /// yet takes the side holding fewer of that section's PRESENT cards,
    /// leading on a tie. A first fill therefore alternates, and a later
    /// arrival lands on the shorter side — which is what re-balances a section
    /// after dismissals without moving anybody already there.
    ///
    /// Entries are kept when a card leaves. A dismiss that fails on the server
    /// puts the card back where it was in the list, and it has to come back on
    /// the side it left as well.
    ///
    /// A card that moves to another section — once, out of No project, when
    /// its first real folder arrives — has no side in its new section, and
    /// takes one there by the same rule, as an arrival does. It is drawn in a
    /// new place either way. Keeping the side it had in No project left the
    /// trailing side of its new section holding a card with the leading side
    /// empty, or two cards on one side over nothing on the other. The cards
    /// that stay, in either section, keep theirs.
    func resolved(for sections: [ProjectSection]) -> CardSides {
        var next = self
        for section in sections {
            var leading = 0
            var trailing = 0
            for session in section.sessions {
                guard let placed = assigned[session.id], placed.section == section.key else { continue }
                switch placed.side {
                case .leading: leading += 1
                case .trailing: trailing += 1
                }
            }
            for session in section.sessions where assigned[session.id]?.section != section.key {
                let side: Side = trailing < leading ? .trailing : .leading
                next.assigned[session.id] = Placement(side: side, section: section.key)
                switch side {
                case .leading: leading += 1
                case .trailing: trailing += 1
                }
            }
        }
        return next
    }

    /// One side's cards, in the order they were given.
    func cards(_ sessions: [Session], on side: Side) -> [Session] {
        sessions.filter { self[$0.id] == side }
    }
}

// MARK: - ReadingOrder

/// Where a card on the stacked board was last drawn: its top edge, in the
/// section it was drawn in, measured from that section's own origin, so
/// that scrolling never moves it (`BoardView`'s `CardTops`).
struct DrawnTop: Equatable {
    let section: ProjectKey
    let y: CGFloat
}

/// The cards as a reader meets them, which is the order the needs-you bar
/// walks.
enum ReadingOrder {
    /// Sections in their order, then each section's cards in theirs: top to
    /// bottom in the list, and two across where they are drawn — by each
    /// card's top edge, the leading side first on a tie.
    ///
    /// The two sides of a section keep their own cards, at their own
    /// heights, so a card's place down its side is not its row: beside a card
    /// with three subagent rows, the second card on the other side stands
    /// well above the second on this one, and a reader meets it first. So
    /// the order follows `tops`, where each card was last drawn. A section
    /// with a card not yet drawn in it — one that has just arrived or moved
    /// in — is read row by row, by position down each side, the leading side
    /// first, until layout gives that card its edge; on a first fill of
    /// cards of one height the two orders are the same.
    static func make(_ sections: [ProjectSection], arrangement: BoardArrangement,
                     sides: CardSides, tops: [String: DrawnTop] = [:]) -> [Session] {
        sections.flatMap { section -> [Session] in
            guard arrangement == .stacked else { return section.sessions }
            let leading = sides.cards(section.sessions, on: .leading)
            let trailing = sides.cards(section.sessions, on: .trailing)
            guard section.sessions.allSatisfy({ tops[$0.id]?.section == section.key }) else {
                return byRow(leading, trailing)
            }
            return byTop(leading, trailing, tops: tops)
        }
    }

    /// How close two top edges are to be one row: within a point, what the
    /// rounding of layout to the pixel leaves between two cards of one
    /// height. The leading side then comes first.
    static let tie: CGFloat = 1

    /// Down each side in its own order, taking from the side whose next card
    /// is drawn higher, the leading side on a tie.
    private static func byTop(_ leading: [Session], _ trailing: [Session],
                              tops: [String: DrawnTop]) -> [Session] {
        func top(_ session: Session) -> CGFloat { tops[session.id]?.y ?? 0 }
        var order: [Session] = []
        var l = 0, t = 0
        while l < leading.count || t < trailing.count {
            let takesLeading = t == trailing.count
                || (l < leading.count && top(leading[l]) <= top(trailing[t]) + tie)
            if takesLeading {
                order.append(leading[l])
                l += 1
            } else {
                order.append(trailing[t])
                t += 1
            }
        }
        return order
    }

    /// Row by row, a card's position down its side its row.
    private static func byRow(_ leading: [Session], _ trailing: [Session]) -> [Session] {
        var rows: [Session] = []
        for row in 0..<max(leading.count, trailing.count) {
            if row < leading.count { rows.append(leading[row]) }
            if row < trailing.count { rows.append(trailing[row]) }
        }
        return rows
    }

    /// The 'next after' step: the first blocked card after the card `id` in
    /// `order`, round to the first. With `id` nil, or no longer on the board,
    /// the first blocked card of all. With one blocked, that card again.
    static func nextBlocked(after id: String?, in order: [Session]) -> Session? {
        func isBlocked(_ session: Session) -> Bool { session.status == .blocked }
        guard let id, let index = order.firstIndex(where: { $0.id == id }) else {
            return order.first(where: isBlocked)
        }
        return (order[(index + 1)...] + order[...index]).first(where: isBlocked)
    }
}

// MARK: - The needs-you bar

/// What the needs-you bar says, and the card it brings.
///
/// The board's one alarm, present only while a session is blocked. `done` is
/// never counted: Codex has no session-end hook, so its finished cards rest on
/// the board for a day, and a standing "6 done" would be a tally of nothing.
struct NeedsYou: Equatable {
    /// What the bar draws, and nothing else: the blocked count, the session
    /// it names and where that session is, and whether a press brings this
    /// one or the next. Not the session, whose message and tokens change on
    /// events that are none of the bar's business, and not its id, which a
    /// press reads from the board as last drawn.
    struct Face: Equatable {
        let count: Int
        let name: String
        /// "in acme-api"; for a session in No project its agent's name
        /// instead; nil where that would only repeat the name.
        let place: String?
        /// "Next" rather than "Show": the bar has brought a blocked card,
        /// and this is another one.
        let next: Bool

        /// "2 blocked: Fix the login redirect, in acme-api".
        var spoken: String { "\(count) blocked: \(name)\(place.map { ", \($0)" } ?? "")" }

        /// Equal when it draws the same code units (`isExactly`): a name
        /// that changes only its Unicode form is drawn again in its new one.
        static func == (lhs: Face, rhs: Face) -> Bool {
            lhs.count == rhs.count && lhs.next == rhs.next && lhs.name.isExactly(rhs.name)
                && (lhs.place == nil) == (rhs.place == nil) && (lhs.place ?? "").isExactly(rhs.place ?? "")
        }
    }

    let face: Face
    /// The card a press brings into view.
    let target: String

    /// The bar for a board read in `order`, having last brought the card
    /// `after` — nil until it is first pressed. Nil while nothing is blocked.
    ///
    /// It names the first blocked card in reading order, and after a press
    /// the next one, round to the first. A card that has left the board since
    /// leaves the bar naming the first again, as a board with no press; one
    /// that is still there but no longer blocked is where the walk goes on
    /// from.
    static func make(order: [Session], after: String?) -> NeedsYou? {
        let count = order.reduce(0) { $0 + ($1.status == .blocked ? 1 : 0) }
        guard count > 0, let target = ReadingOrder.nextBlocked(after: after, in: order) else { return nil }
        let pressed = after.map { id in order.contains { $0.id == id } } ?? false
        let words = Self.words(for: target)
        return NeedsYou(face: Face(count: count, name: words.name, place: words.place, next: pressed && count > 1),
                        target: target.id)
    }

    /// A blocked session as the bar and the spoken alarm name it: its name,
    /// or its agent's for a session that has none, and its project — "in
    /// acme-api" — or, in No project, its agent: the Codex Desktop session
    /// that started at `/` is "Reading the brief · Codex". Never the live
    /// folder: the project is the section the reader goes looking under.
    ///
    /// The place is left out where it would only say the name again, as the
    /// card's own "in <folder>" is: an untitled Codex session in acme-api,
    /// which the hook names "acme-api", is "acme-api" and not "acme-api · in
    /// acme-api"; one named after its agent in No project is "Codex". Exact
    /// comparisons (`isExactly`), on the web and Android as here.
    static func words(for session: Session) -> (name: String, place: String?) {
        let agent = UsageInfo.displayName(for: session.source)
        let name = session.name.isEmpty ? agent : session.name
        switch session.projectKey {
        case .folder(let folder): return (name, folder.isExactly(name) ? nil : "in \(folder)")
        case .noProject: return (name, name.isExactly(agent) ? nil : agent)
        }
    }

    /// What is said aloud when sessions have just become blocked
    /// (`BoardView.announceBlocks`): "Fix the login redirect, in acme-api,
    /// needs you", or "2 sessions need you" for blocks that came within the
    /// same half second. Which session and where, in the bar's words: its
    /// project rather than its agent, now that the sections are projects and
    /// the card's agent is a mark on it; in No project its agent instead;
    /// and neither where it would only repeat the name, so a session named
    /// after its agent is "Codex needs you" and one named after its folder
    /// "acme-api needs you". Nil for none.
    static func announcement(for sessions: [Session]) -> String? {
        guard let session = sessions.first else { return nil }
        guard sessions.count == 1 else { return "\(sessions.count) sessions need you" }
        let words = words(for: session)
        return words.place.map { "\(words.name), \($0), needs you" } ?? "\(words.name) needs you"
    }
}

// MARK: - Standing blocks

/// The blocked cards the board took in by itself, with no frame of the
/// stream: never said aloud.
///
/// A block is spoken only on a session's transition into `blocked`
/// (`BoardView.announceBlocks`), and the board hears of transitions in the
/// stream's frames. A card can also turn up blocked on this device with no
/// frame at all:
/// - a dismissal the server refused puts the card back as it was, blocked
///   all along on the server;
/// - a fetch (a pull to refresh, or the one that follows a refusal) brings
///   in what the server holds, which the stream has brought or soon will;
/// - a snapshot hands over what stood while the stream was down.
/// Those blocks are standing, not news. The web and Android say none of
/// them, since they listen for blocks only in the stream's `session`
/// frames, and nor does iOS: the store notes here every list it takes in
/// without a frame, and the board leaves what is here unsaid.
///
/// A card stays here until a frame moves it out of `blocked` or brings it
/// anew, or the board loses it. So a card put back, then answered and
/// blocked again, is said once, as the new block it is. A frame that only
/// repeats a standing block, as a subagent's report does, changes nothing.
///
/// The store keeps it beside its cards, and nothing draws it. A frame
/// costs it one look at an empty set, which is what it nearly always is.
struct StandingBlocks {
    private(set) var ids: Set<String> = []

    /// A frame of the stream about the card `id`, which was `old` and is
    /// `new`, nil for a card the frame brings or removes. Any frame but one
    /// that finds the card blocked and leaves it blocked makes it news again.
    mutating func noteFrame(_ id: String, was old: AgentStatus?, is new: AgentStatus?) {
        guard !ids.isEmpty, old != .blocked || new != .blocked else { return }
        ids.remove(id)
    }

    /// The board taking in `new` in place of `old` with no frame: a snapshot,
    /// a fetch, a dismissal, a card put back. A card it makes blocked is
    /// standing, and one that was standing and is still blocked stays so.
    /// A card no longer blocked, or no longer on the board, leaves.
    mutating func noteList(was old: [Session], is new: [Session]) {
        let held = ids
        let blocked = Set(old.lazy.filter { $0.status == .blocked }.map(\.id))
        ids = Set(new.lazy.filter { $0.status == .blocked && (held.contains($0.id) || !blocked.contains($0.id)) }
            .map(\.id))
    }

    func contains(_ id: String) -> Bool {
        ids.contains(id)
    }
}

// MARK: - The bar's beat

/// When the needs-you bar comes in from the bottom edge again: once for each
/// rise in the blocked count while it already shows (the owner's decision of
/// 2026-11-16).
///
/// A second block changes one digit on the bar, a glyph far too small for
/// the corner of the eye, which is where the board is read. The bar's
/// arrival is the one motion on the board that peripheral vision catches, so
/// a rise replays it, with the new count already in it, and nothing else
/// changes: no word, no colour, no focus, no sound.
///
/// It hears what the voice hears (`BoardView.announceBlocks`): a session's
/// transition into blocked on a board watching the stream, never a block
/// that came with a snapshot or a demo's seed, nor one the board took in
/// with no frame (`StandingBlocks`). It gathers them for the voice's half
/// second, so blocks that land together make one beat, and a session that
/// was news here within the last minute is not news again. The minute is its
/// own: the voice's runs from what it said, and it says nothing while push
/// is on or VoiceOver is off, which are no reason to keep the bar still.
///
/// When the half second is over the bar beats only if all of these hold:
/// - one of its blocks is still blocked;
/// - the bar rested on a count when the first of them landed, and has not
///   emptied since. A bar that showed nothing is arriving with them, and its
///   arrival is their beat; so are blocks gathered in the half second that
///   starts with it (`rest`). One that emptied and came back has arrived
///   again.
/// - the count is higher than the one the bar rested on: never on a fall,
///   nor for one block in place of another within half a second of it,
///   whichever lands first, where the bar rested on the count before them
///   both and no half second ends between them;
/// - the board was in front of the reader when the first landed and is now:
///   the app active, and no other screen or sheet over the board. So never
///   for blocks that landed while the reader was away, nor on the way back.
/// - Reduce Motion is off. Under it the count changes in place, as
///   everything on the board does, and the voice carries the news.
///
/// A value, so that its rule is checked on its own (`verifyBarBeat`). The
/// board keeps it, waits out its half second, and draws the beat
/// (`BoardView.noteBeat`, `NeedsYouStyle`).
struct BarBeat {
    /// Why the bar beat when a half second was over, or why it did not.
    enum Verdict: Equatable, CustomStringConvertible {
        case beats
        /// None of the half second's blocks is blocked any more.
        case answered
        /// The bar rested on no count: this is its arrival, the beat itself.
        case arrival
        /// The count is no higher than the one the bar rested on.
        case noRise
        /// The board was not in front of the reader.
        case away
        /// Reduce Motion is on.
        case still

        var description: String {
            switch self {
            case .beats: "the bar beats"
            case .answered: "no beat, answered"
            case .arrival: "no beat, the bar's arrival"
            case .noRise: "no beat, no rise"
            case .away: "no beat, the board was not in front"
            case .still: "no beat, Reduce Motion"
            }
        }
    }

    /// A half second in flight.
    struct Gathering: Equatable {
        /// The count the bar rested on when the first block landed.
        let rest: Int
        /// Its blocks, as they landed.
        var ids: [String]
        /// The bar emptied while it ran: what came after arrived with it.
        var emptied = false
        /// The board was not in front of the reader when the first landed.
        let away: Bool
    }

    /// How long blocks are gathered for, by the voice and the beat alike
    /// (`BoardView.blockGathering`), and how long a count has to stand to be
    /// the one the bar rests on.
    static let gathers: TimeInterval = 0.5
    /// How long a session that was news is not news again: the voice's
    /// minute (`BoardView.blockRepeatWait`).
    static let repeatWait: TimeInterval = 60

    private(set) var gathering: Gathering?
    /// When each session's block was last news here, for a minute.
    private(set) var newsAt: [String: Date] = [:]
    /// The count the bar rests on: one that stood for half a second, or that
    /// a half second ended on; nothing while the bar is empty. Brought up to
    /// date when the blocked cards change and when a half second ends. A rise
    /// is measured from it, so a block that lands just after another was
    /// answered is no rise where the bar rested on the count before the
    /// answer and no half second ended between them, and a block gathered in
    /// the half second that starts with the bar's arrival finds it resting
    /// on nothing.
    private(set) var rest = 0
    /// When the blocked cards last changed.
    private var changedAt: Date?

    /// An update of the board: the blocked cards `old` became `new`, of which
    /// `news` are sessions' transitions into blocked, as the voice hears them,
    /// while the board was in front of the reader or not. True when it starts
    /// a half second: the caller waits it out and then calls `end`.
    mutating func note(old: [String], new: [String], news: [String], inFront: Bool, at now: Date) -> Bool {
        if old.count != new.count || !new.allSatisfy(old.contains) {
            if changedAt.map({ now.timeIntervalSince($0) >= Self.gathers }) ?? true { rest = old.count }
            if new.isEmpty {
                rest = 0
                gathering?.emptied = true
            }
            changedAt = now
        }
        newsAt = newsAt.filter { now.timeIntervalSince($0.value) < Self.repeatWait }
        let fresh = news.filter { newsAt[$0] == nil && gathering?.ids.contains($0) != true }
        guard !fresh.isEmpty else { return false }
        guard gathering == nil else {
            gathering?.ids += fresh
            return false
        }
        gathering = Gathering(rest: rest, ids: fresh, away: !inFront)
        return true
    }

    /// The half second is over, with `blocked` the blocked cards now: what the
    /// bar does. Nil when no half second ran. Its blocks still blocked are
    /// news for the next minute, whatever the verdict.
    mutating func end(blocked: [String], inFront: Bool, moves: Bool, at now: Date) -> Verdict? {
        guard let done = gathering else { return nil }
        gathering = nil
        let still = done.ids.filter { blocked.contains($0) }
        for id in still { newsAt[id] = now }
        rest = blocked.count
        return Self.verdict(rest: done.emptied ? 0 : done.rest, answered: still.isEmpty, count: blocked.count,
                            inFront: inFront && !done.away, moves: moves)
    }

    /// The rule itself, for a half second whose bar rested on `rest`, now
    /// that `count` are blocked.
    static func verdict(rest: Int, answered: Bool, count: Int, inFront: Bool, moves: Bool) -> Verdict {
        if answered { return .answered }
        if rest == 0 { return .arrival }
        if count <= rest { return .noRise }
        if !inFront { return .away }
        if !moves { return .still }
        return .beats
    }
}

// MARK: - SubtaskSlots

/// Which of a card's subagents stand in its row slots, and in which slot.
///
/// The owner's rule is "oldest, slot-stable": the rows that fit are the
/// first to start, and a row keeps its slot until it finishes, whatever its
/// state does meanwhile. A finished row leaves a hole in its own slot, and the
/// next hidden row takes that slot in place — no other row moves. A blocked
/// subagent always gets a slot: a free one, else the bottom-most slot whose
/// row is not blocked, and the row it displaces comes back only into a slot a
/// finish frees. A slot nothing can take closes. So the eye comes back to the
/// same place, and a row that moves has news: it started, finished or is
/// waiting on you.
///
/// Every frame replaces the session whole, so the order cannot live on the
/// session: it is kept here, by the board, beside `CardSides` and for the same
/// reasons — per device, never persisted, and resolved purely so the view can
/// draw from the answer in the pass that stores it (`BoardView`).
struct SubtaskSlots: Equatable {
    /// One card's slots.
    struct Ledger: Equatable {
        /// The slot count it was drawn for. A different count is a card of a
        /// different shape, which starts again from a first drawing.
        let slots: Int
        /// The subagents on show, top to bottom. Longer than `slots` only
        /// while the card is open in place.
        var shown: [String]
    }

    /// Three rows where a card stands in a column, two under the phone's
    /// rules: by `BoardArrangement`, never by device — an iPad in Split View
    /// is a phone, and an iPhone in landscape that fits two columns is not.
    static func slots(for arrangement: BoardArrangement) -> Int {
        arrangement == .list ? 2 : 3
    }

    private var ledgers: [String: Ledger] = [:]
    /// What the ledgers were resolved for, so that a card the board has not
    /// resolved yet still draws its first rows rather than none.
    private(set) var slots = 3
    private var open: Set<String> = []

    /// The ledger with every card on the board resolved against its current
    /// subagents.
    ///
    /// Idempotent: resolving the answer again with the same sessions gives
    /// the same answer, which is what lets the view resolve in `body` and
    /// store in `onChange` without the two ever chasing each other. A card
    /// with no subtask block, or no longer on the board, loses its ledger;
    /// one that comes back starts again.
    ///
    /// `expanded` is the cards open in place. The board passes none under the
    /// phone's rules, where the footer opens the session screen instead.
    func resolved(for sessions: [Session], slots: Int, expanded: Set<String>) -> SubtaskSlots {
        var next = SubtaskSlots()
        next.slots = slots
        next.open = expanded
        for session in sessions {
            guard let items = session.subtasks?.items else { continue }
            next.ledgers[session.id] = Self.pick(ledgers[session.id], items: items, slots: slots,
                                                 open: expanded.contains(session.id)).ledger
        }
        return next
    }

    /// The rows a card shows, top to bottom.
    func rows(for session: Session) -> [Subtask] {
        guard let items = session.subtasks?.items else { return [] }
        // Picking again is free of side effects and, on a resolved ledger,
        // returns exactly what it holds — so one function answers both a card
        // the board has resolved and one it has not.
        return Self.pick(ledgers[session.id], items: items, slots: slots,
                         open: open.contains(session.id)).rows
    }

    /// Whether the card's list is open in place.
    func isOpen(_ sessionId: String) -> Bool {
        open.contains(sessionId)
    }

    /// The spec's `pick`, step for step: one card's ledger, brought up to date
    /// with its subagents in start order.
    static func pick(_ ledger: Ledger?, items: [Subtask], slots: Int,
                     open: Bool) -> (ledger: Ledger, rows: [Subtask]) {
        let slots = max(1, slots)
        let live = Dictionary(items.map { ($0.id, $0) }) { first, _ in first }
        var ledger = ledger.flatMap { $0.slots == slots ? $0 : nil } ?? firstDrawing(items, slots: slots)

        if open {
            // Open in place: the rows on show stay where they are and the rest
            // follow in start order. Nothing is pulled up into a gap, since
            // every row is already showing.
            let kept = ledger.shown.filter { live[$0] != nil }
            let keptSet = Set(kept)
            ledger.shown = kept + items.map(\.id).filter { !keptSet.contains($0) }
            return (ledger, ledger.shown.compactMap { live[$0] })
        }

        // Folded: the first `slots` entries, and a finished row leaves a hole
        // in ITS slot.
        var at: [String?] = ledger.shown.prefix(slots).map { live[$0] == nil ? nil : $0 }
        for item in items where item.state == .blocked && !at.contains(item.id) {
            var index = at.firstIndex(of: nil)
            if index == nil && at.count < slots {
                index = at.count
                at.append(nil)
            }
            if index == nil {
                // The bottom-most slot whose row is not blocked. The row there
                // goes hidden until a finish frees a slot for it.
                index = at.indices.last { slot in at[slot].flatMap { live[$0] }?.state != .blocked }
            }
            if let index { at[index] = item.id }
        }
        // The next hidden row, in start order, takes a freed slot in place.
        var hidden = items.filter { !at.contains($0.id) }
        var slot = 0
        while slot < slots && !hidden.isEmpty {
            if slot == at.count { at.append(nil) }
            if at[slot] == nil { at[slot] = hidden.removeFirst().id }
            slot += 1
        }
        // A slot nothing could take closes.
        ledger.shown = at.compactMap { $0 }
        return (ledger, ledger.shown.compactMap { live[$0] })
    }

    /// The first drawing: blocked subagents first, up to the slot count, then
    /// the first to start — listed in start order either way.
    private static func firstDrawing(_ items: [Subtask], slots: Int) -> Ledger {
        let blocked = items.filter { $0.state == .blocked }.prefix(slots)
        let rest = items.filter { $0.state != .blocked }.prefix(slots - blocked.count)
        let chosen = Set(blocked.map(\.id) + rest.map(\.id))
        return Ledger(slots: slots, shown: items.map(\.id).filter(chosen.contains))
    }
}

// MARK: - Rows

extension Array {
    /// The array cut into rows of `count`, the last one short if it has to be.
    ///
    /// Heads and their limit windows are laid out as explicit rows of
    /// fixed-width tracks rather than in a flexible grid, so that the width
    /// of a track is a number this file chose and not one the grid arrived
    /// at.
    func rows(of count: Int) -> [[Element]] {
        let count = Swift.max(1, count)
        return stride(from: 0, to: self.count, by: count).map {
            Array(self[$0..<Swift.min($0 + count, self.count)])
        }
    }
}

// MARK: - JumpTarget

/// What the board's scroll view and VoiceOver are sent to, and what its list
/// and its stack know their pieces by.
///
/// Its own type, a case for each kind of piece, so none can be taken for
/// another. As bare strings they could: nothing stops a folder being called
/// what an agent is called or what a session id happens to be, and "codex" is
/// all three on many boards.
enum JumpTarget: Hashable {
    /// A session's card: where the needs-you bar sends the scroll view, and
    /// VoiceOver after it.
    case card(String)
    /// An agent's head.
    case head(String)
    /// A project's section.
    case section(ProjectKey)
}

// MARK: - Checks

#if DEBUG
extension BoardArrangement {
    /// The board's rules, checked when demo mode starts in a debug build —
    /// beside `Streak.verifyDerivation` and for the same reason. This project
    /// has no test target, and these are the parts of the board a screenshot
    /// proves least: a capture shows that one width with one set of projects
    /// came out right, and says nothing about the width one point narrower,
    /// about the order of names it did not hold, or about what a `cd`, a
    /// dismissal or a message does to the cards that stay.
    static func verify() {
        verifySectionKeys()
        verifyExactNames()
        verifyAgentNames()
        verifyArrangements()
        verifyHeadForms()
        verifySidesAndReading()
        verifyDrawnOrder()
        verifyNews()
        verifyStandingBlocks()
        verifyBarBeat()
        verifyMatrix()
        verifySubtaskSlots()
    }

    private static func card(_ id: String, _ source: String = "claude", _ status: AgentStatus = .coding,
                             home: String = "", project: String = "", name: String? = nil) -> Session {
        Session(id: id, name: name ?? id, status: status, message: "", project: project, homeProject: home,
                source: source, createdAt: 0, updatedAt: 0)
    }

    private static func report(_ source: String, windows: Int = 1) -> UsageInfo {
        UsageInfo(source: source,
                  windows: (0..<windows).map { UsageWindow(id: "w\($0)", label: "w", usedPct: 10, resetsAt: nil) },
                  updatedAt: 0)
    }

    /// Which section a card is under, the order sections come in, and the
    /// place a card says it has moved to.
    private static func verifySectionKeys() {
        // What can name a folder: anything but an empty name, / and ., and
        // the hook's UUID pattern in either case (not what merely looks close
        // to one), each tested with the whitespace at its ends left out.
        let uuid = "0f3c2a1e-6b4d-4e8f-9a7b-1c2d3e4f5a6b"
        assert(!Session.isFolderName("") && !Session.isFolderName(uuid), "empty, and a UUID")
        assert(!Session.isFolderName(uuid.uppercased()), "a UUID in capitals")
        assert(Session.isFolderName(String(uuid.dropLast())) && Session.isFolderName(uuid + "c"), "35, 37 characters")
        assert(Session.isFolderName(String(uuid.dropLast()) + "g"), "not hex")
        assert(Session.isFolderName("0f3c2a1e66b4d-4e8f-9a7b-1c2d3e4f5a6b"), "a hyphen out of place")
        assert(Session.isFolderName(String(repeating: "é", count: 18)), "36 bytes that are not a UUID")
        assert(!Session.isFolderName("/") && !Session.isFolderName("."), "a session started at /, and here")
        assert(!Session.isFolderName("  ") && !Session.isFolderName("\t\n") && !Session.isFolderName("\u{3000}"),
               "blank")
        assert(!Session.isFolderName(" \(uuid)") && !Session.isFolderName("\(uuid.uppercased())\n"),
               "a UUID with whitespace round it")
        assert(!Session.isFolderName(" / ") && !Session.isFolderName("\t."), "/ and ., padded")
        assert(Session.isFolderName("acme-api") && Session.isFolderName("No project") && Session.isFolderName("..")
               && Session.isFolderName(" web ") && Session.isFolderName("/web"), "names")

        // The shared vector, which the web's and Android's tests assert too:
        // as the live folders an older server sends, as the pins a 1.7 one
        // does, and from every starting point, since the order must not
        // depend on which card arrived first.
        let vector = ["zeta", "", "Alpha", "alpha", "beta", "AgStatus", "agstatus", uuid]
        let expected: [ProjectKey] = [.folder("AgStatus"), .folder("agstatus"), .folder("Alpha"), .folder("alpha"),
                                      .folder("beta"), .folder("zeta"), .noProject]
        for shift in vector.indices {
            let names = Array(vector[shift...] + vector[..<shift])
            let live = names.enumerated().map { card("v\($0.offset)", project: $0.element) }
            assert(ProjectSection.make(sessions: live).map(\.key) == expected, "the shared vector, live, from \(shift)")
            let pinned = names.enumerated().map { card("v\($0.offset)", home: $0.element, project: $0.element) }
            assert(ProjectSection.make(sessions: pinned).map(\.key) == expected, "the shared vector, pinned, from \(shift)")
        }
        assert(ProjectSection.make(sessions: [card("a", project: ""), card("b", project: uuid)]).map(\.label.count)
               == [2], "'' and a UUID are one bucket")
        // The legacy shell hook's / for a session started there, a blank, a
        // UUID with a space before it, and .: No project too. A pin that
        // cannot name a folder is no pin, and a name that can is kept exactly
        // as it was sent.
        assert(ProjectSection.make(sessions: [card("r", project: "/"), card("s", project: "  "),
                                              card("t", project: " \(uuid)"), card("u", project: ".")])
               .map(\.key) == [.noProject], "/, a blank, a padded UUID and . are No project")
        assert(card("p", home: "/", project: "web").projectKey == .folder("web")
               && card("q", home: "  ", project: "/").projectKey == .noProject, "a pin that cannot name a folder")
        assert(card("w", project: " web ").projectKey == .folder(" web ")
               && ProjectSection.make(sessions: [card("w1", project: " web "), card("w2", project: "web")]).count == 2,
               "a name is used as sent")
        assert(card("m", home: "acme-api", project: "/").movedTo == nil
               && card("n", home: "acme-api", project: "  ").movedTo == nil, "/ and a blank are no place to move to")
        assert(ProjectKey.noProject.title == "No project" && ProjectKey.folder("No project") != .noProject,
               "a folder called No project is a folder")
        // Digits and punctuation by code unit, after the case is folded.
        let mixed = ["web", "2fa", "my_app", "my-app", "Myapp", "ÉTÉ", "zeta"]
        assert(ProjectSection.make(sessions: mixed.map { card($0, project: $0) }).map(\.key)
               == ["2fa", "my-app", "my_app", "Myapp", "web", "zeta", "ÉTÉ"].map(ProjectKey.folder),
               "code units, case folded first")

        // Lowercased as JavaScript and Kotlin lowercase, the final-sigma rule
        // included: a Σ that ends a word is ς (03C2), any other σ (03C3).
        // The standard library's lowercased() makes every Σ a σ.
        assert(ProjectKey.folded("ΝΟΜΟΣ").isExactly("νομος") && ProjectKey.folded("ΑΣ-Z").isExactly("ας-z")
               && ProjectKey.folded("ΣΑ").isExactly("σα") && ProjectKey.folded("ΟΔΥΣΣΕΥΣ").isExactly("οδυσσευς")
               && !"ΝΟΜΟΣ".lowercased().isExactly("νομος"), "final sigma")
        // The order table's rows past ASCII, from every starting point: café
        // decomposed and composed as two sections, 'e' (0065) before 'é'
        // (00E9); then the Greek, where ς (03C2) sorts before σ (03C3). Of
        // these only decision U3's two pairs are shared, and the web's and
        // Android's order tests assert those too: the two cafés, and
        // [ΝΟΜΟΣ, νομος-api]. The other Greek rows are iOS's own. Android's
        // tests run on the desktop JVM, which lowercases ΑΣ-Z to ασ-z, not
        // ας-z, and so would put ασ-a first.
        let composed = "caf\u{E9}", decomposed = "cafe\u{301}"
        let unicode = ["νομος-api", "ΝΟΜΟΣ", composed, "ασ-a", decomposed, "χαος2", "ΑΣ-Z", "ΧΑΟΣ"]
        let unicodeOrder: [ProjectKey] = [decomposed, composed, "ΑΣ-Z", "ασ-a", "ΝΟΜΟΣ", "νομος-api", "ΧΑΟΣ", "χαος2"]
            .map(ProjectKey.folder)
        for shift in unicode.indices {
            let names = Array(unicode[shift...] + unicode[..<shift])
            assert(ProjectSection.make(sessions: names.enumerated().map { card("g\($0.offset)", project: $0.element) })
                   .map(\.key) == unicodeOrder, "past ASCII, from \(shift)")
        }
        assert(ProjectKey.folder("ΝΟΜΟΣ").precedes(.folder("νομος-api"))
               && !ProjectKey.folder("νομος-api").precedes(.folder("ΝΟΜΟΣ")), "[ΝΟΜΟΣ, νομος-api]")

        // The section keeps the store's order, and a new card leads it.
        let store = [card("n", home: "api"), card("x", home: "web"), card("o", home: "api"), card("p", home: "api")]
        let sections = ProjectSection.make(sessions: store)
        assert(sections.map(\.key) == [.folder("api"), .folder("web")], "by name")
        assert(sections[0].sessions.map(\.id) == ["n", "o", "p"], "the store's order, never re-sorted")
        assert(sections[0].label == SectionLabel(key: .folder("api"), count: 3)
               && sections[1].label.countText == "1 session" && sections[0].label.spoken == "api, 3 sessions",
               "labels")
        assert(ProjectSection.make(sessions: []).isEmpty, "an idle board has no sections")

        // A cd never re-groups. The pin holds through every move, and the
        // card says where it went instead.
        var mover = card("m", home: "acme-api", project: "acme-api", name: "Add rate limiting to /login")
        assert(mover.projectKey == .folder("acme-api") && mover.movedTo == nil, "at home: nothing to add")
        let before = ProjectSection.make(sessions: [mover, card("q", home: "web", project: "web")])
        for folder in ["web", "src", "", uuid, "acme-api"] {
            mover.project = folder
            assert(mover.projectKey == .folder("acme-api"), "a cd to \(folder) keeps the section")
            assert(ProjectSection.make(sessions: [mover, card("q", home: "web", project: "web")]).map(\.key)
                   == before.map(\.key), "and the board's sections")
        }
        mover.project = "web"
        assert(mover.movedTo == "web", "in web")
        mover.project = uuid
        assert(mover.movedTo == nil, "a UUID is not a place")
        // A folder-named card that moved into a folder of its own name says
        // nothing, nor does a worktree root, which reports its repository.
        assert(card("u", home: "api", project: "web", name: "web").movedTo == nil, "not the name again")
        assert(card("t", home: "claude-status", project: "claude-status", name: "feature-x").movedTo == nil,
               "a worktree under its repository")
        assert(card("w", home: "claude-status", project: "ios", name: "feature-x").movedTo == "ios", "a worktree that moved")
        // From an older server, with no pin: the live folder, which moves.
        var unpinned = card("o", project: "acme-api")
        unpinned.project = "web"
        assert(unpinned.projectKey == .folder("web") && unpinned.movedTo == nil, "no pin: the live folder")
        // Out of No project once, when the server pins the first real folder.
        var desktop = card("d", "codex", project: "", name: "Codex")
        assert(desktop.projectKey == .noProject && desktop.movedTo == nil, "Codex at /")
        desktop.project = uuid
        assert(desktop.projectKey == .noProject, "a scratch folder is still none")
        desktop.homeProject = "acme-api"
        desktop.project = "acme-api"
        assert(desktop.projectKey == .folder("acme-api"), "claimed by a real folder")
        desktop.project = "ios"
        assert(desktop.projectKey == .folder("acme-api") && desktop.movedTo == "ios", "and kept")
        // A pin that is not a folder, which no 1.7 server sends, is no pin.
        assert(card("z", home: uuid, project: "web").projectKey == .folder("web"), "a UUID pin is no pin")
    }

    /// Names compared code unit for code unit (`isExactly`), as the web and
    /// Android compare them, and never by Swift's canonical equivalence: a
    /// folder, a section and a name are each exactly what was sent. Every
    /// check here compares with `isExactly` or `ProjectKey`'s own `==`,
    /// since `==` on two Strings would pass either way.
    private static func verifyExactNames() {
        func same(_ a: String?, _ b: String?) -> Bool {
            switch (a, b) {
            case (nil, nil): true
            case let (a?, b?): a.isExactly(b)
            default: false
            }
        }
        // One folder in two forms: café composed (U+00E9), as a Linux
        // checkout names it, and decomposed (e, U+0301), as macOS's file
        // APIs often do. Swift's == calls them one name.
        let composed = "caf\u{E9}", decomposed = "cafe\u{301}"
        assert(composed == decomposed && !composed.isExactly(decomposed) && composed.isExactly("caf\u{E9}"),
               "== merges the two forms; isExactly does not")
        // Two sections on every board, from either machine first: by code
        // unit 'e' (0065) is before 'é' (00E9), so the decomposed one leads.
        for board in [[composed, decomposed], [decomposed, composed]] {
            let sections = ProjectSection.make(sessions: board.enumerated().map {
                card("c\($0.offset)", home: $0.element, project: $0.element)
            })
            assert(sections.map(\.key) == [.folder(decomposed), .folder(composed)]
                   && sections.map(\.label.count) == [1, 1], "café in two forms is two sections")
            assert(same(sections[0].key.folder, decomposed) && same(sections[1].key.folder, composed),
                   "each under its own form")
        }
        assert(ProjectKey.folder(composed) != .folder(decomposed)
               && Set([ProjectKey.folder(composed), .folder(decomposed)]).count == 2
               && Set([JumpTarget.section(.folder(composed)), .section(.folder(decomposed))]).count == 2,
               "two keys, two hashes, two targets")
        assert(SectionLabel(key: .folder(composed), count: 1) != SectionLabel(key: .folder(decomposed), count: 1),
               "two labels")
        // Each card is given its side in its own section.
        let sides = CardSides().resolved(for: ProjectSection.make(sessions: [card("c0", project: composed),
                                                                             card("c1", project: decomposed)]))
        assert(sides["c0"] == .leading && sides["c1"] == .leading, "each leads its own section")

        // A live folder in the other form is somewhere else: the card says
        // so, and More Content names it.
        let moved = card("m", home: composed, project: decomposed, name: "Fix the login redirect")
        assert(same(moved.movedTo, decomposed) && same(moved.directory, decomposed), "in café")
        let home = card("h", home: composed, project: composed, name: "Fix the login redirect")
        assert(home.movedTo == nil && home.directory == nil, "at home")
        // A title in the other form of the folder it moved to is not its
        // own folder's name.
        let named = card("n", home: "acme-api", project: decomposed, name: composed)
        assert(same(named.movedTo, decomposed), "a name in the other form")
        assert(card("o", home: "acme-api", project: composed, name: composed).movedTo == nil
               && same(card("o", home: "acme-api", project: composed, name: composed).directory, composed),
               "a name in the same form: More Content only")

        // The bar: a session titled café in its folder café, in the other
        // form, is not named after its folder, and says where it is.
        let titled = card("t", "claude", .blocked, home: decomposed, project: decomposed, name: composed)
        let words = NeedsYou.words(for: titled)
        assert(same(words.name, composed) && same(words.place, "in \(decomposed)"), "café · in café")
        assert(NeedsYou.words(for: card("u", "claude", .blocked, home: composed, project: composed, name: composed))
               .place == nil, "the same form: said once")
        // A bar whose name changes only its form is a bar to draw again.
        assert(NeedsYou.Face(count: 1, name: composed, place: nil, next: false)
               != NeedsYou.Face(count: 1, name: decomposed, place: nil, next: false)
               && NeedsYou.Face(count: 1, name: "x", place: composed, next: false)
               != NeedsYou.Face(count: 1, name: "x", place: decomposed, next: false)
               && NeedsYou.Face(count: 1, name: "x", place: nil, next: false)
               != NeedsYou.Face(count: 1, name: "x", place: "", next: false)
               && NeedsYou.Face(count: 1, name: composed, place: "in a", next: true)
               == NeedsYou.Face(count: 1, name: composed, place: "in a", next: true), "faces, exactly")

        // A card named after its agent is read once, and only when the name
        // is the agent's exactly: "codex" is a name of its own.
        let desk = card("d", "codex", name: "Codex")
        assert(desk.isNamed(for: "Codex") && desk.lead(agent: "Codex") == "Codex", "Codex, once")
        let lower = card("l", "codex", name: "codex")
        assert(!lower.isNamed(for: "Codex") && lower.lead(agent: "Codex") == "Codex, codex", "codex is a name")
        assert(card("e", "codex", name: "").lead(agent: "Codex") == "Codex", "no name: the agent's")
        assert(card("f", name: "Fix the login redirect").lead(agent: "Claude") == "Claude, Fix the login redirect",
               "<agent>, <name>")
    }

    /// What an agent is called, and the mark it wears: one rule on every
    /// board. Claude and Codex by name; any other agent its own spelling,
    /// first letter upper-cased, which is what the hook names an untitled
    /// session with no folder. The mark by prefix, after lowercasing, as the
    /// web and Android match it.
    private static func verifyAgentNames() {
        let names = ["claude": "Claude", "codex": "Codex", "gemini": "Gemini", "codex-cli": "Codex-cli",
                     "claude-work": "Claude-work", "gemini-cli": "Gemini-cli", "opencode": "Opencode",
                     "my_agent": "My_agent", "x": "X"]
        for (source, name) in names {
            assert(UsageInfo.displayName(for: source).isExactly(name), "\(source) is \(name)")
        }
        let marks = ["claude": "asterisk", "claude-work": "asterisk", "claude-code": "asterisk",
                     "codex": "hexagon", "codex-cli": "hexagon", "gemini": "diamond", "opencode": "diamond",
                     "my_agent": "diamond", "constructor": "diamond"]
        for (source, mark) in marks {
            assert(Theme.agentSymbol(for: source) == mark, "\(source) wears the \(mark)")
        }
        // The hook's untitled codex-cli session at /, "Codex-cli": named after
        // its agent, so the bar and the alarm name it once and a card reads
        // it once.
        let cli = card("x", "codex-cli", .blocked, name: "Codex-cli")
        let words = NeedsYou.words(for: cli)
        assert(words.name == "Codex-cli" && words.place == nil, "Codex-cli, once")
        assert(NeedsYou.announcement(for: [cli]) == "Codex-cli needs you", "said once")
        assert(cli.lead(agent: UsageInfo.displayName(for: cli.source)) == "Codex-cli", "read once")
        // A titled one in No project gets its agent as its place, spelled so.
        assert(NeedsYou.words(for: card("p", "gemini", .blocked, name: "Port the parser")).place == "Gemini"
               && NeedsYou.words(for: card("u", "gemini", .blocked, name: "")).name == "Gemini",
               "Gemini, as the bar names it")
    }

    /// The arrangement rule and the heads' pin rule, at the board widths of
    /// the devices they were drawn for.
    private static func verifyArrangements() {
        // The threshold itself: two 340pt columns and one 24pt gap.
        assert(fit(width: 703) == 1 && fit(width: 704) == 2, "two columns from 704")
        assert(fit(width: 0) == 1 && fit(width: -20) == 1, "never less than one")
        assert(fit(width: 1344) == 3 && resolve(width: 1344) == .stacked, "three fit, one arrangement")
        // Large text raises the bar instead of squeezing the columns.
        assert(resolve(width: 1000, minColumn: 340 * 1.55) == .list, "scaled column")
        // A phone held sideways keeps the list, at the widths a phone has on
        // its side, where the width alone would give it two columns.
        for width: CGFloat in [702, 718, 800] {
            assert(resolve(width: width, compactHeight: true) == .list, "held sideways at \(width)")
        }
        assert(resolve(width: 800) == .stacked, "by its width alone, stacked")

        // The phone pins two heads and no more, and none at an accessibility
        // size or on its side: 1.6.5's rule, unchanged.
        assert(!headsScroll(.list, agents: 0), "no agents, nothing to pin")
        assert(!headsScroll(.list, agents: 1) && !headsScroll(.list, agents: 2) && headsScroll(.list, agents: 3),
               "two across")
        assert(headsScroll(.list, agents: 1, largeText: true) && headsScroll(.list, agents: 2, largeText: true),
               "large text")
        assert(headsScroll(.list, agents: 1, compactHeight: true) && !headsScroll(.list, agents: 0, compactHeight: true),
               "sideways")
        // A head with more limit windows than a phone pins: from a fifth in
        // any head, at an SE or a mini (343), a 6.1" phone (361), a 6.9" one
        // (408) and a 320pt Slide Over window (288), for one agent and two.
        for width: CGFloat in [343, 361, 408, 288] {
            assert(resolve(width: width) == .list, "\(width) is a list")
            for agents in 1...2 {
                for windows in 0...6 {
                    assert(headsScroll(.list, agents: agents, windows: windows) == (windows > 4),
                           "\(windows) windows, \(agents) agents at \(width)")
                }
            }
        }
        // A wide board's strips: a lone agent's always, two at a standard
        // size with four windows each at most, never a third.
        for windows in 0...6 {
            assert(!headsScroll(.stacked, agents: 1, windows: windows), "one strip, \(windows) windows")
            assert(!headsScroll(.stacked, agents: 1, windows: windows, largeText: true), "one strip, large text")
            assert(headsScroll(.stacked, agents: 2, windows: windows) == (windows > 4), "two strips, \(windows) windows")
            assert(headsScroll(.stacked, agents: 3, windows: windows), "three strips")
        }
        assert(headsScroll(.stacked, agents: 2, largeText: true), "two strips at large text")
        assert(!headsScroll(.stacked, agents: 0), "no strips")

        // A card is a column wide two across, by `fit`, and in the list only
        // where the list's width is one. At AX1 a column is 527pt (title3 at
        // 31 over 20), so no card on a phone in portrait is, nor in a Slide
        // Over window; a 6.9" phone held sideways (800) is. At AX5 (55 over
        // 20) a 13" iPad's portrait list still is and an 11" one's is not.
        let ax1 = minColumn * 31 / 20, ax5 = minColumn * 55 / 20
        for width: CGFloat in [288, 343, 370, 408] {
            assert(!cardIsColumnWide(.list, width: width, minColumn: ax1), "a phone's card at AX1, \(width)")
        }
        assert(cardIsColumnWide(.list, width: 800, minColumn: ax1), "a sideways 6.9\" list at AX1")
        assert(cardIsColumnWide(.list, width: 1000, minColumn: ax5), "13\" portrait list at AX5")
        assert(!cardIsColumnWide(.list, width: 802, minColumn: ax5), "11\" portrait list at AX5")
        assert(cardIsColumnWide(.stacked, width: 1344, minColumn: ax1), "two across at AX1")
        for width in stride(from: CGFloat(704), through: 1400, by: 1) where fit(width: width) >= 2 {
            assert(track(width: width, count: 2, gap: cardGap) >= minColumn, "a side is a column at \(width)")
        }

        // Tracks: the gaps come out first, and what is left is shared.
        assert(track(width: 1344, count: 2) == 660, "two tracks")
        assert(track(width: 408, count: 2, gap: headGap) == 199, "half a phone")
        assert(track(width: 1344, count: 2, gap: cardGap) == 666, "two across")
        assert(track(width: 408, count: 0) == 408, "no tracks is one track")

        // Rows.
        assert([1, 2, 3].rows(of: 2) == [[1, 2], [3]], "a short last row")
        assert([1, 2, 3].rows(of: 3) == [[1, 2, 3]] && [1, 2, 3].rows(of: 0) == [[1], [2], [3]], "rows")
        assert([Int]().rows(of: 2).isEmpty, "no rows of nothing")

        // Which agents get a head, and what one is handed.
        let board = [card("d", "codex"), card("a", "claude"), card("c", "codex", .blocked), card("b", "claude"),
                     card("e", "gemini", .done)]
        let heads = AgentSummary.make(sessions: board, usage: [report("codex"), report("claude", windows: 2),
                                                               report("cursor"), report("gemini", windows: 0)])
        assert(heads.map(\.source) == ["claude", "codex", "gemini"], "by key, and only agents with sessions")
        assert(heads.map(\.sessions) == [2, 2, 1] && heads.map(\.windows.count) == [2, 1, 0], "counts and limits")
        assert(heads.mostWindows == 2, "the tallest head")
        let idle = AgentSummary.make(sessions: [], usage: [report("codex"), report("claude"), report("gemini", windows: 0)])
        assert(idle.map(\.source) == ["claude", "codex"], "no sessions: every agent that reports limits")
        assert(AgentSummary.make(sessions: [], usage: []).isEmpty, "nothing at all")
        assert(AgentSummary.make(sessions: [card("g", "gemini")], usage: []).mostWindows == 0, "no limits, no windows")

        // The pieces never collide: a folder, an agent and a session all
        // called "codex", and a folder called "No project" beside the bucket.
        let clash = [card("codex", "codex", home: "codex", project: "codex"),
                     card("No project", "claude", home: "No project", project: "No project"),
                     card("x", "claude", project: "")]
        let clashing = ProjectSection.make(sessions: clash)
        assert(clashing.map(\.key) == [.folder("codex"), .folder("No project"), .noProject], "three sections")
        let targets = clash.map { JumpTarget.card($0.id) } + clashing.map(\.id)
            + AgentSummary.make(sessions: clash, usage: []).map(\.id)
        assert(Set(targets).count == targets.count && targets.count == 8, "every target distinct")
        assert(JumpTarget.card("codex") != .head("codex") && JumpTarget.head("codex") != .section(.folder("codex")),
               "codex three ways")
    }

    /// Head forms. The thresholds are inside the head, 30 in from its edge.
    private static func verifyHeadForms() {
        assert(HeadForm.resolve(outer: 199, canStrip: false) == .narrow, "half a phone")
        assert(HeadForm.resolve(outer: 408, canStrip: true) == .regular, "a phone's width")
        assert(HeadForm.resolve(outer: 330, canStrip: false) == .narrow, "300 inside is still narrow")
        assert(HeadForm.resolve(outer: 331, canStrip: false) == .regular, "301 inside is regular")
        assert(HeadForm.resolve(outer: 432, canStrip: false) == .regular, "a third of a 13\" iPad")
        assert(HeadForm.resolve(outer: 549, canStrip: false) == .regular, "519 inside")
        assert(HeadForm.resolve(outer: 550, canStrip: false) == .across, "520 inside")
        assert(HeadForm.resolve(outer: 802, canStrip: true) == .across, "an 11\" iPad upright: across")
        assert(HeadForm.resolve(outer: 835, canStrip: true) == .across, "805 inside")
        assert(HeadForm.resolve(outer: 836, canStrip: true) == .strip, "806 inside")
        assert(HeadForm.resolve(outer: 1000, canStrip: true) == .strip, "a 13\" iPad upright: a strip")
        assert(HeadForm.resolve(outer: 1344, canStrip: true) == .strip, "the full board")
        assert(HeadForm.resolve(outer: 1344, canStrip: false) == .across, "never a strip beside another head")
        assert(HeadForm.resolve(outer: 660, canStrip: false, scale: 1.3) == .regular, "scaled thresholds")
        assert(HeadForm.stripTracks(available: 1008, windows: 3) == 3, "three windows, room for five")
        assert(HeadForm.stripTracks(available: 664, windows: 6) == 3, "six windows make two rows")
        assert(HeadForm.stripTracks(available: 100, windows: 3) == 1, "always one track")
        assert(HeadForm.stripTracks(available: 1008, windows: 0) == 1, "no windows is still one track")

        // What a head draws beside its name and in place of meters. At extra
        // extra extra large and AX3, on an SE and a 6.9" (343 and 408 inside
        // the gutters), the heads that lead the list are narrow, each alone
        // on its row, and still offer their count and say an agent has no
        // limits. A pair pinned two across, at the default size and at the
        // size that still pins one, is narrow and does neither.
        let phones: [(device: String, width: CGFloat)] = [("an SE", 343), ("a 6.9\"", 408)]
        let sizes: [(name: String, scale: CGFloat, large: Bool)] = [("the default size", 1, false),
                                                                    ("xxxL", 26.0 / 20, false),
                                                                    ("AX3", 43.0 / 20, true)]
        for phone in phones {
            for size in sizes {
                let at = "on \(phone.device) at \(size.name)"
                if size.scale > 1 {
                    assert(BoardArrangement.headsScroll(.list, agents: 4, largeText: size.large), "four heads lead \(at)")
                    let leading = HeadForm.resolve(outer: phone.width, canStrip: true, scale: size.scale)
                    assert(leading == .narrow, "a leading head is narrow \(at)")
                    assert(HeadForm.offersCount(sessions: 1, sharesRow: false, form: leading)
                           && HeadForm.saysNoLimits(windows: 0, showsNoLimits: true),
                           "and offers its count, and says there are no limits, \(at)")
                }
                guard !size.large else { continue }
                assert(!BoardArrangement.headsScroll(.list, agents: 2, largeText: size.large), "two are pinned \(at)")
                let track = BoardArrangement.track(width: phone.width, count: 2, gap: BoardArrangement.headGap)
                let pair = HeadForm.resolve(outer: track, canStrip: false, scale: size.scale)
                assert(pair == .narrow, "a pinned pair is narrow \(at)")
                assert(!HeadForm.offersCount(sessions: 1, sharesRow: true, form: pair)
                       && !HeadForm.saysNoLimits(windows: 0, showsNoLimits: false),
                       "and offers no count, and no sentence, \(at)")
            }
        }
        // Two heads pinned across an iPad's one-list board, where two columns
        // do not fit: an 11" iPad upright (802 inside the gutters) at extra
        // extra large text, and a board 690 wide at the default size, as an
        // iPad window about 722 wide gives. Each head is regular, and offers
        // its count, as at 0a6fd33.
        let ipads: [(board: String, width: CGFloat, scale: CGFloat)] = [("an 11\" iPad upright at xxL", 802, 24.0 / 20),
                                                                        ("a board 690 wide", 690, 1)]
        for ipad in ipads {
            let at = "on \(ipad.board)"
            assert(BoardArrangement.resolve(width: ipad.width, minColumn: BoardArrangement.minColumn * ipad.scale) == .list,
                   "one list \(at)")
            assert(!BoardArrangement.headsScroll(.list, agents: 2), "two are pinned \(at)")
            let track = BoardArrangement.track(width: ipad.width, count: 2, gap: BoardArrangement.headGap)
            let pair = HeadForm.resolve(outer: track, canStrip: false, scale: ipad.scale)
            assert(pair == .regular, "a pinned pair is regular \(at)")
            assert(HeadForm.offersCount(sessions: 3, sharesRow: true, form: pair), "and offers its count \(at)")
        }
        assert(!HeadForm.offersCount(sessions: 0, sharesRow: false, form: .regular), "no sessions, no count")
        assert(!HeadForm.saysNoLimits(windows: 2, showsNoLimits: true), "limits are meters")
    }

    /// Sides, counted per section, and the order the bar walks.
    private static func verifySidesAndReading() {
        // A first fill alternates down each section.
        let five = (1...5).map { card("s\($0)", home: "api") }
        let filled = CardSides().resolved(for: ProjectSection.make(sessions: five))
        assert(five.map { filled[$0.id] } == [.leading, .trailing, .leading, .trailing, .leading], "first fill alternates")
        assert(filled.resolved(for: ProjectSection.make(sessions: five)) == filled, "settled")

        // Removing a card never changes another card's side, and it comes
        // back to the side it left, as a failed dismiss needs.
        for removed in five {
            let rest = five.filter { $0.id != removed.id }
            let after = filled.resolved(for: ProjectSection.make(sessions: rest))
            assert(rest.allSatisfy { after[$0.id] == filled[$0.id] }, "others stay when \(removed.id) leaves")
            let restored = after.resolved(for: ProjectSection.make(sessions: five))
            assert(restored[removed.id] == filled[removed.id], "\(removed.id) returns to its side")
        }
        // An arrival takes the shorter side of what is PRESENT: with s1 and
        // s3 gone the leading side holds one card and the trailing side two.
        let thinned = five.filter { $0.id != "s1" && $0.id != "s3" }
        let arrived = filled.resolved(for: ProjectSection.make(sessions: [card("new", home: "api")] + thinned))
        assert(arrived["new"] == .leading, "an arrival takes the shorter side")
        // Each section keeps its own count.
        let mixed = [card("x1", home: "api"), card("y1", home: "web"), card("x2", home: "api"), card("y2", home: "web")]
        let both = CardSides().resolved(for: ProjectSection.make(sessions: mixed))
        assert(both["x1"] == .leading && both["x2"] == .trailing && both["y1"] == .leading && both["y2"] == .trailing,
               "sides are counted per section")
        // A card that moves section — out of No project, when its first real
        // folder arrives — is given a side again in its new section, by the
        // same rule as an arrival; every card that stays keeps its own.
        // Codex Desktop at / twice, beside one acme-api card: d1 leading and
        // d2 trailing in No project.
        let a1 = card("a1", home: "acme-api", project: "acme-api")
        var d1 = card("d1", "codex", name: "Codex")
        var d2 = card("d2", "codex", name: "Codex")
        let start = CardSides().resolved(for: ProjectSection.make(sessions: [a1, d1, d2]))
        assert(start["a1"] == .leading && start["d1"] == .leading && start["d2"] == .trailing, "before the move")
        // d1's folder is acme-api, which holds one card on its leading side:
        // d1 takes the trailing side, not a second card over the leading one.
        d1.homeProject = "acme-api"
        d1.project = "acme-api"
        let intoAcme = start.resolved(for: ProjectSection.make(sessions: [a1, d1, d2]))
        assert(intoAcme["a1"] == .leading && intoAcme["d1"] == .trailing, "into a section: the shorter side")
        assert(intoAcme["d2"] == .trailing, "the card left behind stays where it was")
        // d2's folder is web, a section of its own: its one card leads, not
        // a card on the right with the left side empty.
        d2.homeProject = "web"
        d2.project = "web"
        let intoWeb = intoAcme.resolved(for: ProjectSection.make(sessions: [a1, d1, d2]))
        assert(intoWeb["d2"] == .leading && intoWeb["a1"] == .leading && intoWeb["d1"] == .trailing,
               "into a new section: leading")
        assert(intoWeb.resolved(for: ProjectSection.make(sessions: [a1, d1, d2])) == intoWeb, "settled after a move")
        // Given once in its new section: a card that moves in after it, from
        // above it in the store, does not take its side from it.
        var d3 = card("d3", "codex", name: "Codex")
        let joined = intoWeb.resolved(for: ProjectSection.make(sessions: [d3, a1, d1, d2]))
        d3.homeProject = "acme-api"
        d3.project = "acme-api"
        let third = joined.resolved(for: ProjectSection.make(sessions: [d3, a1, d1, d2]))
        assert(third["a1"] == .leading && third["d1"] == .trailing && third["d3"] == .leading,
               "a later move-in takes the shorter side and moves nobody")
        // And a moved card that leaves comes back to its new side.
        let gone = third.resolved(for: ProjectSection.make(sessions: [d3, a1, d2]))
        assert(gone.resolved(for: ProjectSection.make(sessions: [d3, a1, d1, d2]))["d1"] == .trailing,
               "a moved card returns to the side it was given there")
        // A move between two folders, which a server too old to pin one
        // makes on a cd, follows the same rule.
        var moving = mixed
        moving[1].homeProject = "api"
        let moved = both.resolved(for: ProjectSection.make(sessions: moving))
        assert(moved["x1"] == .leading && moved["x2"] == .trailing && moved["y2"] == .trailing, "the others stay")
        assert(moved["y1"] == .leading, "y1 takes api's shorter side, leading on a tie")

        // Reading order: sections in order; in the list, top to bottom; two
        // across, row by row with the leading side first. With s2 gone the
        // sides are [s1, s3, s5] and [s4], so s4 is read second.
        let unbalanced = five.filter { $0.id != "s2" }
        let sections = ProjectSection.make(sessions: unbalanced + [card("w1", home: "web"), card("n1")])
        let sides = filled.resolved(for: sections)
        assert(ReadingOrder.make(sections, arrangement: .list, sides: sides).map(\.id)
               == ["s1", "s3", "s4", "s5", "w1", "n1"], "the list: down each section")
        assert(ReadingOrder.make(sections, arrangement: .stacked, sides: sides).map(\.id)
               == ["s1", "s4", "s3", "s5", "w1", "n1"], "two across: row by row, leading first")

        // The 'next after' step walks the blocked cards in that order and
        // wraps round; with one, it stays on it; with none, there is none.
        let blocked = Set(["s3", "s4", "n1"])
        let order = ReadingOrder.make(sections, arrangement: .stacked, sides: sides).map { session -> Session in
            var copy = session
            if blocked.contains(session.id) { copy.status = .blocked }
            return copy
        }
        func next(_ id: String?) -> String? { ReadingOrder.nextBlocked(after: id, in: order)?.id }
        assert(next(nil) == "s4" && next("s4") == "s3" && next("s3") == "n1" && next("n1") == "s4", "the walk wraps")
        assert(next("s1") == "s4" && next("s5") == "n1" && next("gone") == "s4", "from any card, or from none")
        assert(ReadingOrder.nextBlocked(after: nil, in: unbalanced) == nil, "nothing blocked")
        let lone = [card("a"), card("b", "claude", .blocked), card("c")]
        assert(ReadingOrder.nextBlocked(after: "b", in: lone)?.id == "b", "one blocked: itself again")
    }

    /// The stacked board read where its cards are drawn: by each card's top
    /// edge, the leading side first on a tie (`ReadingOrder`, `DrawnTop`).
    /// The bar walks it, and its press brings what it names.
    private static func verifyDrawnOrder() {
        let acme = ProjectKey.folder("acme-api")
        func at(_ edges: [(String, CGFloat)], in section: ProjectKey = acme) -> [String: DrawnTop] {
            Dictionary(uniqueKeysWithValues: edges.map { ($0.0, DrawnTop(section: section, y: $0.1)) })
        }
        // The review's board. A has ten subagents, of which the stacked
        // board shows three rows; B, C and D are a plain card's height, and C
        // and D are blocked. The first fill puts A and C on the leading side,
        // B and D on the trailing one.
        var a = card("A", home: "acme-api", project: "acme-api")
        a.subtasks = Subtasks(items: (1...10).map { Subtask(id: "k\($0)", n: $0, label: "k\($0)", state: .coding,
                                                              activity: "") }, done: 0)
        let board = [a, card("B", home: "acme-api", project: "acme-api"),
                     card("C", "claude", .blocked, home: "acme-api", project: "acme-api"),
                     card("D", "claude", .blocked, home: "acme-api", project: "acme-api")]
        let sections = ProjectSection.make(sessions: board)
        let sides = CardSides().resolved(for: sections)
        assert(sides["A"] == .leading && sides["B"] == .trailing && sides["C"] == .leading && sides["D"] == .trailing,
               "the first fill")
        assert(SubtaskSlots().resolved(for: board, slots: SubtaskSlots.slots(for: .stacked), expanded: [])
               .rows(for: a).count == 3, "A shows three rows")
        // Drawn 12pt apart under the label: a plain card is 112pt tall, and
        // A with its rows, its footer and its meta line under them about
        // 203. So D stands beside A, and C below it.
        let drawn = at([("A", 8), ("B", 8), ("D", 132), ("C", 223)])
        let order = ReadingOrder.make(sections, arrangement: .stacked, sides: sides, tops: drawn)
        assert(order.map(\.id) == ["A", "B", "D", "C"], "as drawn: D, beside A, before C, below it")
        // The bar names D first; a press brings D and the bar names C; a
        // press brings C and the bar names D again. Never up the screen and
        // back down.
        let show = NeedsYou.make(order: order, after: nil)
        assert(show?.target == "D" && show?.face.next == false, "D first, Show")
        let next = NeedsYou.make(order: order, after: "D")
        assert(next?.target == "C" && next?.face.next == true, "then C, Next")
        assert(NeedsYou.make(order: order, after: "C")?.target == "D", "and round to D")
        // Before the board is drawn, row by row: C, the second on its side,
        // before D, the second on its own.
        assert(ReadingOrder.make(sections, arrangement: .stacked, sides: sides).map(\.id) == ["A", "B", "C", "D"],
               "not yet drawn: row by row")
        // A section with a card not drawn in it yet — just arrived, or just
        // moved in, its edge still the one it had in the other section — is
        // read row by row until it is.
        var arriving = drawn
        arriving["D"] = nil
        assert(ReadingOrder.make(sections, arrangement: .stacked, sides: sides, tops: arriving).map(\.id)
               == ["A", "B", "C", "D"], "a card not yet drawn")
        var movedIn = drawn
        movedIn["D"] = DrawnTop(section: .noProject, y: 132)
        assert(ReadingOrder.make(sections, arrangement: .stacked, sides: sides, tops: movedIn).map(\.id)
               == ["A", "B", "C", "D"], "an edge from another section")
        // A tie is within a point, the leading side first; past it, the
        // higher card.
        func read(_ edges: [(String, CGFloat)]) -> [String] {
            ReadingOrder.make(sections, arrangement: .stacked, sides: sides, tops: at(edges)).map(\.id)
        }
        assert(read([("A", 8), ("B", 8), ("C", 132), ("D", 132)]) == ["A", "B", "C", "D"], "level: leading first")
        assert(read([("A", 8.6), ("B", 8), ("C", 133), ("D", 132)]) == ["A", "B", "C", "D"],
               "within a point: leading first")
        assert(read([("A", 10), ("B", 8), ("C", 134), ("D", 132)]) == ["B", "A", "D", "C"],
               "two points: the higher first")
        // A tall card on the trailing side: the leading side's second card
        // is read before the trailing side's.
        assert(read([("A", 8), ("B", 8), ("C", 132), ("D", 223)]) == ["A", "B", "C", "D"], "a tall trailing card")
        // The list reads down each section, whatever was drawn where; and a
        // section is read whole before the next, whatever its edges.
        assert(ReadingOrder.make(sections, arrangement: .list, sides: sides, tops: drawn).map(\.id)
               == ["A", "B", "C", "D"], "the list: down its section")
        let two = ProjectSection.make(sessions: board + [card("W", "codex", .blocked, home: "web", project: "web")])
        let twoSides = sides.resolved(for: two)
        var twoDrawn = drawn
        twoDrawn["W"] = DrawnTop(section: .folder("web"), y: 8)
        assert(ReadingOrder.make(two, arrangement: .stacked, sides: twoSides, tops: twoDrawn).map(\.id)
               == ["A", "B", "D", "C", "W"], "sections in their order, each as drawn")
    }

    /// What is whose news. A label, a head and the bar are handed only what
    /// they draw, so an event that changes none of it changes none of them,
    /// and they do not run (`ProjectLabel`, `AgentHead`, `NeedsYouBar`).
    private static func verifyNews() {
        let usage = [report("claude", windows: 3), report("codex", windows: 2)]
        func drawn(_ board: [Session], after: String? = nil)
            -> (labels: [SectionLabel], heads: [AgentSummary], bar: NeedsYou.Face?) {
            let sections = ProjectSection.make(sessions: board)
            let sides = CardSides().resolved(for: sections)
            let order = ReadingOrder.make(sections, arrangement: .stacked, sides: sides)
            return (sections.map(\.label), AgentSummary.make(sessions: board, usage: usage),
                    NeedsYou.make(order: order, after: after)?.face)
        }
        let board = [card("login", "claude", .blocked, home: "acme-api", project: "acme-api", name: "Fix the login redirect"),
                     card("limit", "claude", home: "acme-api", project: "web", name: "Add rate limiting to /login"),
                     card("api", "codex", .done, home: "acme-api", project: "acme-api", name: "acme-api"),
                     card("etl", "claude", .blocked, home: "etl-jobs", project: "etl-jobs", name: "Nightly backfill for March"),
                     card("desk", "codex", .planning, name: "Codex")]
        let quiet = drawn(board)
        assert(quiet.bar == NeedsYou.Face(count: 2, name: "Fix the login redirect", place: "in acme-api", next: false),
               "the bar names the first blocked card and its project")
        assert(quiet.bar?.spoken == "2 blocked: Fix the login redirect, in acme-api", "and says it")
        assert(quiet.labels.map(\.spoken) == ["acme-api, 3 sessions", "etl-jobs, 1 session", "No project, 1 session"],
               "the labels")

        // A message, a timestamp and a token figure — what most hook events
        // carry — on every card, the blocked one the bar names included.
        for index in board.indices {
            var messaged = board
            messaged[index].message = "Editing src/auth/token.ts"
            messaged[index].updatedAt += 60_000
            messaged[index].tokens = 48_200
            let after = drawn(messaged)
            assert(after.labels == quiet.labels && after.heads == quiet.heads && after.bar == quiet.bar,
                   "a message on \(board[index].id) is no label's, head's or bar's news")
            // A cd too, now that it never moves a card — except the one with
            // no folder yet, whose first real one is its one move.
            guard !board[index].homeProject.isEmpty else { continue }
            messaged[index].project = "src"
            let moved = drawn(messaged)
            assert(moved.labels == quiet.labels && moved.heads == quiet.heads && moved.bar == quiet.bar,
                   "nor is a cd on \(board[index].id)")
        }
        // A card becoming blocked is the bar's news, and only the bar's: the
        // heads have no alarm to change, and a label no count of it.
        var blocking = board
        blocking[1].status = .blocked
        let blocked = drawn(blocking)
        assert(blocked.labels == quiet.labels && blocked.heads == quiet.heads, "a block is no label's or head's news")
        assert(blocked.bar?.count == 3, "and is the bar's")
        // An arrival is its own label's news and its agent's head's count.
        let arrived = drawn([card("new", "codex", home: "etl-jobs")] + board)
        assert(arrived.labels[0] == quiet.labels[0] && arrived.labels[1].count == 2 && arrived.labels[2] == quiet.labels[2],
               "an arrival is its own section's")
        assert(arrived.heads[0] == quiet.heads[0] && arrived.heads[1].sessions == quiet.heads[1].sessions + 1,
               "and its own agent's")
        // A press makes the bar name the next one; it then says Next.
        assert(drawn(board, after: "login").bar == NeedsYou.Face(count: 2, name: "Nightly backfill for March",
                                                                 place: "in etl-jobs", next: true), "Next")
        assert(drawn(board, after: "etl").bar?.name == "Fix the login redirect", "round to the first")
        // A card the bar brought that has since gone: the first again, Show.
        assert(drawn(board, after: "dismissed").bar == quiet.bar, "gone: as if never pressed")
        // With one blocked the verb stays Show.
        var one = board
        one[3].status = .coding
        assert(drawn(one, after: "login").bar?.next == false && drawn(one, after: "login").bar?.name
               == "Fix the login redirect", "one blocked: Show, the same card")
        // No project: the agent's name stands in for the project, and is not
        // said twice for a session that is named after its agent.
        var desk = board
        desk[0].status = .coding
        desk[3].status = .coding
        desk[4].status = .blocked
        assert(drawn(desk).bar == NeedsYou.Face(count: 1, name: "Codex", place: nil, next: false), "Codex at /")
        desk[4].name = "Reading the brief"
        assert(drawn(desk).bar?.place == "Codex", "a named one gets its agent")
        desk[4].name = ""
        assert(drawn(desk).bar?.name == "Codex" && drawn(desk).bar?.place == nil, "an unnamed one is its agent's")
        assert(NeedsYou.announcement(for: [desk[4]]) == "Codex needs you", "and is said once")
        // A folder section: its project is not said twice either. The hook
        // names an untitled Codex session after its folder.
        var named = board
        named[0].status = .coding
        named[3].status = .coding
        named[2].status = .blocked
        assert(drawn(named).bar == NeedsYou.Face(count: 1, name: "acme-api", place: nil, next: false),
               "named after its folder: acme-api, not acme-api · in acme-api")
        assert(drawn(named).bar?.spoken == "1 blocked: acme-api", "and the bar says it once")
        assert(NeedsYou.announcement(for: [named[2]]) == "acme-api needs you", "and so does the alarm")
        named[2].name = "Acme-api"
        assert(drawn(named).bar?.place == "in acme-api", "an exact comparison")
        named[2].name = ""
        assert(drawn(named).bar?.name == "Codex" && drawn(named).bar?.place == "in acme-api",
               "an unnamed session is its agent's, in its folder")
        assert(NeedsYou.announcement(for: [board[0]]) == "Fix the login redirect, in acme-api, needs you"
               && NeedsYou.announcement(for: [board[0], board[3]]) == "2 sessions need you"
               && NeedsYou.announcement(for: []) == nil, "the alarm's sentences")
        // A moved card is named under its project, not where it went.
        var moved = board
        moved[0].project = "web"
        assert(drawn(moved).bar?.place == "in acme-api", "the project, not the live folder")
        // Nothing blocked, no bar; and done is never counted.
        let calm = board.map { session -> Session in
            var copy = session
            if copy.status == .blocked { copy.status = .coding }
            return copy
        }
        assert(drawn(calm).bar == nil, "no bar")
    }

    /// Which new blocks are news, as the store's paths decide it
    /// (`StandingBlocks`): a block a frame brings is, and one the board took
    /// in by itself is not, whatever took it in. The connection's silences,
    /// the minute and the half second are `announceBlocks`' own and are not
    /// modelled: this is the live stream between them.
    private static func verifyStandingBlocks() {
        // The store in miniature: its cards and its standing blocks, changed
        // as its paths change them. `update` is one update of the board, which
        // can hold more than one of them, and `news` what it would say: the
        // cards that have just become blocked, less the standing ones.
        var cards: [Session] = []
        var standing = StandingBlocks()
        var news: [String] = []
        func blocked() -> [String] { cards.filter { $0.status == .blocked }.map(\.id) }
        func update(_ change: () -> Void) {
            let before = blocked()
            change()
            news = blocked().filter { !before.contains($0) && !standing.contains($0) }
        }
        // A session frame, as `.upsert` takes it in, and a remove frame.
        func frame(_ id: String, _ status: AgentStatus) {
            if let index = cards.firstIndex(where: { $0.id == id }) {
                standing.noteFrame(id, was: cards[index].status, is: status)
                cards[index] = card(id, "claude", status)
            } else {
                standing.noteFrame(id, was: nil, is: status)
                cards.insert(card(id, "claude", status), at: 0)
            }
        }
        func removed(_ id: String) {
            standing.noteFrame(id, was: nil, is: nil)
            cards.removeAll { $0.id == id }
        }
        // A list taken in with no frame: a snapshot, a fetch, a dismissal, a
        // card put back (`setSessions`).
        func take(_ list: [Session]) {
            standing.noteList(was: cards, is: list)
            cards = list
        }
        func without(_ id: String) -> [Session] { cards.filter { $0.id != id } }

        update { take([card("login"), card("limit"), card("etl")]) }
        update { frame("login", .blocked) }
        assert(news == ["login"], "a frame that turns a card blocked is news")
        // The finding's case: the reader dismisses it, the server refuses,
        // and the card comes back where it was, blocked all along on the
        // server; the fetch after the refusal brings it once more.
        let refused = cards
        update { take(without("login")) }
        update { take(refused) }
        assert(news.isEmpty && standing.ids == ["login"], "a card a refused dismissal puts back is not news")
        update { take(refused) }
        assert(news.isEmpty && standing.ids == ["login"], "nor is the fetch after the refusal")
        // A frame that repeats the block, as a subagent's report does, and
        // one about another card, leave it as it was.
        update { frame("login", .blocked) }
        update { frame("limit", .testing) }
        assert(news.isEmpty && standing.ids == ["login"], "a frame that repeats a standing block changes nothing")
        // Answered, then blocked again: the new block it is, said once.
        update { frame("login", .coding) }
        assert(news.isEmpty && standing.ids.isEmpty, "answered, it is news again")
        update { frame("login", .blocked) }
        assert(news == ["login"], "blocked again, it is said")
        // Put back, and a frame repeating the block, in one update: still not
        // news. Two of the store's paths can land between two of the board's
        // updates.
        let blockedBoard = cards
        update { take(without("login")) }
        update {
            take(blockedBoard)
            frame("login", .blocked)
        }
        assert(news.isEmpty && standing.ids == ["login"], "put back and repeated in one update")
        update { frame("login", .coding) }
        // A card put back that was not blocked is not standing, and its next
        // block, from a frame, is news.
        let calm = cards
        update { take(without("limit")) }
        update { take(calm) }
        assert(news.isEmpty && standing.ids.isEmpty, "a calm card put back")
        update { frame("limit", .blocked) }
        assert(news == ["limit"], "then blocked by a frame: news")
        // A pull to refresh that brings in a block the stream has not
        // brought: standing; nor is the frame that brings it after a
        // transition; a later block from a frame is.
        let fetched = cards.map { $0.id == "etl" ? card("etl", "claude", .blocked) : $0 }
        update { take(fetched) }
        assert(news.isEmpty && standing.contains("etl"), "a block a fetch brings in is not news")
        update { frame("etl", .blocked) }
        assert(news.isEmpty, "nor is the frame that brings it after")
        update { frame("etl", .testing) }
        update { frame("etl", .blocked) }
        assert(news == ["etl"], "answered and blocked again by a frame: news")
        // A snapshot's blocks are standing as well, whatever the connection
        // does besides; anything gone or answered with it leaves.
        let snapshot = [card("login", "claude", .blocked), card("limit", "claude", .blocked), card("api", "codex", .blocked)]
        update { take(snapshot) }
        assert(news.isEmpty && standing.ids == ["login", "api"], "a snapshot's blocks are standing")
        update { take(snapshot.filter { $0.id != "api" }) }
        assert(standing.ids == ["login"], "a card gone with a list leaves")
        // A card that arrives blocked is news. Dismissed, with the server's
        // consent: the stream removes it, and its next post, blocked, is news
        // again, as on the web and Android.
        update { frame("new", .blocked) }
        assert(news == ["new"], "a card that arrives blocked is news")
        update { take(without("new")) }
        update { removed("new") }
        update { frame("new", .blocked) }
        assert(news == ["new"], "a dismissed card that posts again blocked is news")
        // A standing card the stream removes, and brings back blocked: news.
        update { removed("login") }
        assert(!standing.contains("login"), "a removed card leaves")
        update { frame("login", .blocked) }
        assert(news == ["login"], "and comes back as news")
    }

    /// When the needs-you bar beats (`BarBeat`), as the board drives it: the
    /// store's paths change its cards, the board hands each update to the
    /// beat with the news in it as the voice hears it, and waits out the half
    /// second the beat asks for. The clock is the table's own.
    private static func verifyBarBeat() {
        let start = Date(timeIntervalSinceReferenceDate: 0)
        var now = start
        var cards: [Session] = []
        var standing = StandingBlocks()
        var beat = BarBeat()
        var due: Date?
        var starts = 0
        var verdicts: [BarBeat.Verdict] = []
        // The board in front of the reader, and Reduce Motion off, unless a
        // case says otherwise.
        var inFront = true
        var moves = true
        func blocked() -> [String] { cards.filter { $0.status == .blocked }.map(\.id) }
        // One update of the board. `heard` is false for a list that came with
        // the connection, a snapshot or a demo's seed, whose blocks the voice
        // leaves unsaid; a block the board took in with no frame is not news
        // either (`StandingBlocks`).
        func update(heard: Bool = true, _ change: () -> Void) {
            let old = blocked()
            change()
            let new = blocked()
            let news = heard ? new.filter { !old.contains($0) && !standing.contains($0) } : []
            if beat.note(old: old, new: new, news: news, inFront: inFront, at: now) {
                assert(due == nil, "one half second at a time")
                due = now.addingTimeInterval(BarBeat.gathers)
                starts += 1
            }
        }
        // Time passing, and the half second ending when it is due, with the
        // board as it is then.
        func pass(_ seconds: TimeInterval) {
            let then = now.addingTimeInterval(seconds)
            if let at = due, at <= then {
                now = at
                due = nil
                if let verdict = beat.end(blocked: blocked(), inFront: inFront, moves: moves, at: now) {
                    verdicts.append(verdict)
                }
            }
            now = then
        }
        // The store's paths, as in `verifyStandingBlocks`: a frame of the
        // stream, and a list taken in with no frame.
        func frame(_ id: String, _ status: AgentStatus) {
            if let index = cards.firstIndex(where: { $0.id == id }) {
                standing.noteFrame(id, was: cards[index].status, is: status)
                cards[index] = card(id, "claude", status)
            } else {
                standing.noteFrame(id, was: nil, is: status)
                cards.insert(card(id, "claude", status), at: 0)
            }
        }
        func take(_ list: [Session]) {
            standing.noteList(was: cards, is: list)
            cards = list
        }
        func without(_ id: String) -> [Session] { cards.filter { $0.id != id } }
        // A board drawn from its first snapshot, its blocks standing, and left
        // to rest.
        func board(blocked ids: [String], working: [String] = ["w1", "w2", "w3"]) {
            now = start
            cards = []
            standing = StandingBlocks()
            beat = BarBeat()
            due = nil
            starts = 0
            verdicts = []
            inFront = true
            moves = true
            update(heard: false) { take(ids.map { card($0, "claude", .blocked) } + working.map { card($0) }) }
            pass(10)
        }

        // The first draw: its blocks were standing before the board looked.
        board(blocked: ["a", "b"])
        assert(starts == 0 && verdicts.isEmpty, "a first draw is no beat")

        // A rise while the bar shows: one beat, when the half second is over,
        // with the count already risen. Another, later: another beat.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(0.4)
        assert(verdicts.isEmpty && beat.gathering != nil, "nothing until the half second is over")
        pass(0.2)
        assert(verdicts == [.beats], "a rise while the bar shows beats")
        pass(10)
        update { frame("w2", .blocked) }
        pass(1)
        assert(verdicts == [.beats, .beats] && starts == 2, "one beat for each rise")
        assert(beat.rest == 3, "and the bar rests on the count it beat with")

        // Blocks that land together, 15 ms apart as two hook events do: one beat.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(0.015)
        update { frame("w2", .blocked) }
        pass(1)
        assert(verdicts == [.beats] && starts == 1, "blocks that land together make one beat")

        // The first block: the bar arrives with it, and that is its beat. So
        // is a block within half a second of the arrival, which the bar was
        // still making.
        board(blocked: [])
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.arrival], "the first block is the bar's arrival, no beat")
        board(blocked: [])
        update { frame("w1", .blocked) }
        pass(0.3)
        update { frame("w2", .blocked) }
        pass(1)
        assert(verdicts == [.arrival], "nor for one that lands as the bar arrives")
        // An arrival that is no news of its own (its session said within the
        // minute), and a block a third of a second after it: still the arrival.
        update { frame("w1", .coding); frame("w2", .coding) }
        pass(5)
        update { frame("w1", .blocked) }
        assert(starts == 1, "a session that was news within the minute is no news")
        pass(0.3)
        update { frame("w3", .blocked) }
        pass(1)
        assert(verdicts == [.arrival, .arrival], "a block a third of a second after any arrival is part of it")
        // Half a second later the bar rests on the count, and a rise beats.
        pass(5)
        update { frame("x", .blocked) }
        pass(1)
        assert(verdicts == [.arrival, .arrival, .beats], "a rise once the bar has arrived beats")

        // A fall, an unblock or a dismissal: no beat, and nothing gathered.
        board(blocked: ["a", "b", "c"])
        update { frame("b", .coding) }
        pass(1)
        update { take(without("c")) }
        pass(1)
        update { take(without("a")) }
        pass(1)
        assert(starts == 0 && verdicts.isEmpty, "a fall is no beat")

        // One block in place of another: no rise. In one update; the new one
        // first; the answered one first.
        board(blocked: ["a", "b"])
        update {
            frame("w1", .blocked)
            frame("a", .coding)
        }
        pass(1)
        assert(verdicts == [.noRise], "a swap in one update is no beat")
        board(blocked: ["a", "b"])
        update { frame("w1", .blocked) }
        pass(0.1)
        update { frame("a", .coding) }
        pass(1)
        assert(verdicts == [.noRise], "nor a block answered just after another lands")
        board(blocked: ["a", "b"])
        update { frame("a", .coding) }
        pass(0.1)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.noRise], "nor a block that lands just after another is answered")
        // Seconds apart, the count the reader saw fell and then rose: a rise.
        board(blocked: ["a", "b"])
        update { frame("a", .coding) }
        pass(5)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.beats], "a block seconds after another was answered is a rise")
        // A beat, then within half a second one answered and another
        // blocked: the bar rests on the count it beat with, so no rise.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(0.3)
        update { frame("w2", .blocked) }
        pass(0.3)
        update { frame("a", .coding) }
        pass(0.3)
        update { frame("w3", .blocked) }
        pass(1)
        assert(verdicts == [.beats, .noRise], "a swap just after a beat is no second beat")

        // A card the board puts back after a refused dismissal, and the fetch
        // after it: no frame brought them, so they are no news (A1), though
        // the count rises.
        board(blocked: ["a", "b"])
        let refused = cards
        update { take(without("b")) }
        pass(0.2)
        update { take(refused) }
        pass(1)
        update { take(refused) }
        pass(1)
        assert(starts == 0 && verdicts.isEmpty, "a restored card is no beat")
        // Nor a block a pull to refresh brings in ahead of its frame, nor
        // that frame when it comes; nor a reconnect's snapshot with a block
        // that landed while the stream was down.
        update { take(cards.map { $0.id == "w1" ? card("w1", "claude", .blocked) : $0 }) }
        pass(1)
        update { frame("w1", .blocked) }
        pass(1)
        update(heard: false) { take(cards.map { $0.id == "w2" ? card("w2", "claude", .blocked) : $0 }) }
        pass(1)
        assert(starts == 0 && verdicts.isEmpty, "nor a refetch's block, nor a reconnect's")

        // A session that was news within the minute: no beat on its next
        // block, whatever the first did. After the minute, a beat again.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(1)
        update { frame("w1", .coding) }
        pass(20)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.beats] && starts == 1, "a repeat within the minute is no beat")
        pass(60)
        update { frame("w1", .coding) }
        pass(5)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.beats, .beats], "past the minute it beats again")
        // The first block's own minute runs from its arrival.
        board(blocked: [])
        update { frame("w1", .blocked) }
        pass(5)
        update { frame("w2", .blocked) }
        pass(5)
        update { frame("w1", .coding) }
        pass(5)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.arrival, .beats], "the arrival's session is held for its minute too")

        // Answered within the half second: no news by then.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(0.2)
        update { frame("w1", .coding) }
        pass(1)
        assert(verdicts == [.answered], "a block answered within the half second is no beat")
        // The bar empties and comes back within it: an arrival again.
        board(blocked: ["a"])
        update { frame("w1", .blocked) }
        pass(0.1)
        update {
            frame("a", .coding)
            frame("w1", .coding)
        }
        pass(0.1)
        update {
            frame("w1", .blocked)
            frame("w2", .blocked)
        }
        pass(1)
        assert(verdicts == [.arrival], "a bar that empties and comes back has arrived again")

        // Reduce Motion: nothing moves. The session is news for its minute
        // all the same.
        board(blocked: ["a"])
        moves = false
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.still], "under Reduce Motion, no beat")
        moves = true
        update { frame("w1", .coding) }
        pass(5)
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.still], "and its session is held for the minute")

        // The board not in front of the reader: the app inactive or in the
        // background, a pushed screen or a sheet. When the block lands, when
        // the half second ends, or both: no beat, nor on the way back.
        board(blocked: ["a"])
        inFront = false
        update { frame("w1", .blocked) }
        pass(1)
        assert(verdicts == [.away], "a block while the board is not in front is no beat")
        update { frame("w2", .blocked) }
        pass(0.2)
        inFront = true
        pass(1)
        assert(verdicts == [.away, .away], "nor on the way back, within its half second")
        update { frame("w3", .blocked) }
        pass(0.2)
        inFront = false
        pass(1)
        assert(verdicts == [.away, .away, .away], "nor when the reader leaves within it")
        inFront = true
        update { frame("x", .blocked) }
        pass(1)
        assert(verdicts == [.away, .away, .away, .beats], "back in front, a rise beats")

        // The rule's order: what the trace says first.
        assert(BarBeat.verdict(rest: 0, answered: false, count: 1, inFront: false, moves: false) == .arrival
               && BarBeat.verdict(rest: 2, answered: false, count: 2, inFront: false, moves: false) == .noRise
               && BarBeat.verdict(rest: 2, answered: false, count: 3, inFront: false, moves: false) == .away
               && BarBeat.verdict(rest: 2, answered: true, count: 3, inFront: true, moves: true) == .answered,
               "the verdict's order")
    }

    /// Every board the rules have to hold on: the six widths and the
    /// sideways phones, at five text sizes, with zero to twelve projects and
    /// one to three agents.
    private static func verifyMatrix() {
        // The factor `minColumn` grows by at each size, title3's size over its
        // default 20pt, and whether it is an accessibility size.
        let sizes: [(name: String, scale: CGFloat, large: Bool)] = [
            ("default", 1, false), ("xxxL", 26.0 / 20, false), ("AX1", 31.0 / 20, true),
            ("AX3", 43.0 / 20, true), ("AX5", 55.0 / 20, true),
        ]
        let L = BoardArrangement.list, S = BoardArrangement.stacked
        // Each board's width inside its gutters, whether it is a phone on its
        // side, and the arrangement at each size above.
        let boards: [(device: String, width: CGFloat, sideways: Bool, expected: [BoardArrangement])] = [
            ("6.1\" phone", 361, false, [L, L, L, L, L]),
            ("6.1\" phone on its side", 702, true, [L, L, L, L, L]),
            ("6.9\" phone", 408, false, [L, L, L, L, L]),
            ("6.9\" phone on its side", 800, true, [L, L, L, L, L]),
            ("iPad in Split View", 646, false, [L, L, L, L, L]),
            ("11\" iPad upright", 802, false, [S, L, L, L, L]),
            ("11\" iPad on its side", 1178, false, [S, S, S, L, L]),
            ("13\" iPad upright", 1000, false, [S, S, L, L, L]),
            ("13\" iPad on its side", 1344, false, [S, S, S, L, L]),
        ]
        // Whether the heads are pinned for one, two and three agents, with
        // at most four windows a head and then with five.
        func pinned(_ arrangement: BoardArrangement, large: Bool, sideways: Bool) -> (four: [Bool], five: [Bool]) {
            switch (arrangement, large, sideways) {
            case (.list, false, false): ([true, true, false], [false, false, false])
            case (.list, _, _): ([false, false, false], [false, false, false])
            case (.stacked, false, _): ([true, true, false], [true, false, false])
            case (.stacked, true, _): ([true, false, false], [true, false, false])
            }
        }
        // Twelve folder names, chosen to exercise the order — mixed case, a
        // digit, a hyphen — and the order they must come out in.
        let names = ["web", "Alpha", "api", "agstatus", "AgStatus", "docs", "etl-jobs", "zeta", "beta", "ios", "2fa",
                     "infra"]
        let sorted = ["2fa", "AgStatus", "agstatus", "Alpha", "api", "beta", "docs", "etl-jobs", "infra", "ios", "web",
                      "zeta"]
        let sources = ["claude", "codex", "gemini"]

        // What a board holds depends on its arrangement and not on how it
        // came to have it, so each one is checked once however many widths
        // and sizes lead to it — the whole cross product is still walked.
        var checked = Set<[Int]>()
        for board in boards {
            for (size, arrangement) in zip(sizes, board.expected) {
                let column = minColumn * size.scale
                let resolved = resolve(width: board.width, minColumn: column, compactHeight: board.sideways)
                let at = "\(board.device) at \(size.name)"
                assert(resolved == arrangement, "the arrangement of a \(at)")
                if arrangement == .stacked {
                    assert(track(width: board.width, count: 2, gap: cardGap) >= column, "a side is a column on a \(at)")
                }
                let pins = pinned(arrangement, large: size.large, sideways: board.sideways)
                for agents in 1...3 {
                    for (windows, expected) in [(4, pins.four[agents - 1]), (5, pins.five[agents - 1])] {
                        assert(headsScroll(arrangement, agents: agents, windows: windows, largeText: size.large,
                                           compactHeight: board.sideways) == !expected,
                               "\(agents) heads with \(windows) windows on a \(at)")
                    }
                }
                for projects in 0...12 {
                    for agents in 1...3
                    where checked.insert([projects, agents, arrangement == .list ? 0 : 1]).inserted {
                        verifyBoard(projects: projects, agents: agents, arrangement: arrangement,
                                    names: names, sorted: sorted, sources: sources, at: at)
                    }
                }
            }
        }
    }

    /// One board of the matrix: `projects` folders with one to three cards
    /// each, two cards in No project with none or an odd number, every
    /// fourth card blocked, the agents taking turns.
    private static func verifyBoard(projects: Int, agents: Int, arrangement: BoardArrangement,
                                    names: [String], sorted: [String], sources: [String], at: String) {
        var sessions: [Session] = []
        func add(home: String) {
            let n = sessions.count
            sessions.append(card("s\(n)", sources[n % agents], n % 4 == 1 ? .blocked : .coding,
                                 home: home, project: home))
        }
        for index in 0..<projects {
            for _ in 0...(index % 3) { add(home: names[index]) }
        }
        let unfiled = projects == 0 || projects % 2 == 1
        if unfiled { add(home: ""); add(home: "") }
        let label = "\(projects) projects, \(agents) agents, a \(at)"

        let sections = ProjectSection.make(sessions: sessions)
        let named = sorted.filter { names.prefix(projects).contains($0) }.map(ProjectKey.folder)
        assert(sections.map(\.key) == named + (unfiled ? [.noProject] : []), "sections in order: \(label)")
        assert(sections.map(\.label.count).reduce(0, +) == sessions.count, "every card counted once: \(label)")
        for section in sections {
            assert(section.sessions.map(\.id) == sessions.filter { $0.projectKey == section.key }.map(\.id),
                   "the store's order inside \(section.key.title): \(label)")
        }

        let sides = CardSides().resolved(for: sections)
        for section in sections {
            assert(section.sessions.enumerated().allSatisfy { sides[$0.element.id] == ($0.offset % 2 == 0 ? .leading : .trailing) },
                   "a first fill alternates in \(section.key.title): \(label)")
        }
        let order = ReadingOrder.make(sections, arrangement: arrangement, sides: sides)
        assert(order.count == sessions.count && Set(order.map(\.id)).count == sessions.count,
               "every card read once: \(label)")
        // On a first fill, row by row is the section's own order.
        assert(order.map(\.id) == sections.flatMap(\.sessions).map(\.id), "read section by section: \(label)")
        // And drawn, every card one height, it still is: where cards are
        // drawn changes the order only where their heights differ.
        var level: [String: DrawnTop] = [:]
        for section in sections {
            for side in CardSides.Side.allCases {
                for (row, session) in sides.cards(section.sessions, on: side).enumerated() {
                    level[session.id] = DrawnTop(section: section.key, y: 8 + CGFloat(row) * 124)
                }
            }
        }
        assert(ReadingOrder.make(sections, arrangement: arrangement, sides: sides, tops: level).map(\.id)
               == order.map(\.id), "drawn at one height, the same order: \(label)")

        let blocked = order.filter { $0.status == .blocked }.map(\.id)
        var after: String?
        var walked: [String] = []
        for step in 0..<max(1, blocked.count) {
            let bar = NeedsYou.make(order: order, after: after)
            assert((bar == nil) == blocked.isEmpty, "a bar while something is blocked: \(label)")
            guard let bar else { break }
            assert(bar.face.count == blocked.count && bar.face.next == (step > 0 && blocked.count > 1),
                   "the bar's count and verb: \(label)")
            walked.append(bar.target)
            after = bar.target
        }
        assert(walked == blocked, "the bar walks every blocked card in reading order: \(label)")
        if let first = blocked.first {
            assert(NeedsYou.make(order: order, after: after)?.target == first, "and round to the first: \(label)")
        }

        let heads = AgentSummary.make(sessions: sessions, usage: [])
        assert(heads.count == Set(sessions.map(\.source)).count && heads.map(\.sessions).reduce(0, +) == sessions.count,
               "a head for every agent on the board: \(label)")
        let targets = sessions.map { JumpTarget.card($0.id) } + sections.map(\.id) + heads.map(\.id)
        assert(Set(targets).count == targets.count, "distinct targets: \(label)")
    }


    /// The slot rule for a card's subagents — the other half of "a row keeps
    /// its place", and like the side ledger, a thing no single capture can
    /// show: it is about what happens to the rows that stay.
    private static func verifySubtaskSlots() {
        func item(_ n: Int, _ state: SubtaskState = .coding) -> Subtask {
            Subtask(id: "r\(n)", n: n, label: "r\(n)", state: state, activity: "")
        }
        func card(_ items: [Subtask], done: Int = 0) -> Session {
            Session(id: "card", name: "card", status: .coding, message: "", project: "",
                    createdAt: 0, updatedAt: 0, subtasks: Subtasks(items: items, done: done))
        }
        func ids(_ rows: [Subtask]) -> [String] { rows.map(\.id) }
        /// One resolution step, and the rows it draws.
        func step(_ ledger: SubtaskSlots, _ items: [Subtask], slots: Int = 3,
                  open: Bool = false) -> (SubtaskSlots, [String]) {
            let next = ledger.resolved(for: [card(items)], slots: slots, expanded: open ? ["card"] : [])
            return (next, ids(next.rows(for: card(items))))
        }

        // First fill: the first to start, and a blocked one first of all —
        // listed in start order either way.
        let five = (1...5).map { item($0) }
        let (filled, firstRows) = step(SubtaskSlots(), five)
        assert(firstRows == ["r1", "r2", "r3"], "oldest first")
        let withBlocked = five.map { $0.n == 5 ? item(5, .blocked) : $0 }
        assert(step(SubtaskSlots(), withBlocked).1 == ["r1", "r2", "r5"], "a blocked one takes a first slot")
        let allBlocked = (1...4).map { item($0, .blocked) }
        assert(step(SubtaskSlots(), allBlocked).1 == ["r1", "r2", "r3"], "more blocked than slots: the first")
        assert(step(SubtaskSlots(), five, slots: 2).1 == ["r1", "r2"], "two under the phone's rules")
        assert(step(SubtaskSlots(), [item(1)]).1 == ["r1"], "fewer than the slots")

        // Resolving the answer again changes nothing — the property the view
        // depends on to resolve in `body` and store in `onChange`.
        assert(step(filled, five).0 == filled, "idempotent")

        // A finish leaves a hole in ITS slot, and the next hidden row takes it
        // in place: r4 lands between r1 and r3, and neither moves.
        let (afterFinish, finishRows) = step(filled, five.filter { $0.n != 2 })
        assert(finishRows == ["r1", "r4", "r3"], "a finish is filled in place")
        assert(step(afterFinish, five.filter { $0.n != 2 }).0 == afterFinish, "idempotent after a finish")

        // A blocked subagent takes the bottom-most slot whose row is not
        // blocked; the row it displaces goes hidden.
        let fiveBlocked = five.map { $0.n == 5 ? item(5, .blocked) : $0 }
        let (afterBlock, blockRows) = step(filled, fiveBlocked)
        assert(blockRows == ["r1", "r2", "r5"], "blocked takes the bottom-most slot")
        // Approved, it keeps the slot, and the displaced row does not come back.
        let (afterApproval, approvedRows) = step(afterBlock, five)
        assert(approvedRows == ["r1", "r2", "r5"], "an approved row keeps its slot")
        // That row returns only into a slot a finish frees.
        assert(step(afterApproval, five.filter { $0.n != 1 }).1 == ["r3", "r2", "r5"],
               "the displaced row returns into a freed slot")
        // Blocked rows are never displaced by another blocked one: each takes
        // the bottom-most slot still holding a row that is not.
        let twoBlocked = five.map { $0.n == 4 || $0.n == 5 ? item($0.n, .blocked) : $0 }
        let (pair, pairRows) = step(filled, twoBlocked)
        assert(pairRows == ["r1", "r5", "r4"], "the second blocked row takes the next slot up")
        let threeBlocked = twoBlocked + [item(6, .blocked)]
        assert(step(pair, threeBlocked).1 == ["r6", "r5", "r4"], "and the third the last one left")
        assert(step(step(pair, threeBlocked).0, threeBlocked + [item(7, .blocked)]).1 == ["r6", "r5", "r4"],
               "with every slot blocked, a fourth waits")

        // A slot nothing can take closes.
        let three = (1...3).map { item($0) }
        let (trio, _) = step(SubtaskSlots(), three)
        assert(step(trio, [item(1), item(3)]).1 == ["r1", "r3"], "an untaken slot closes")
        // And a new row then joins at the end, not in the closed slot's place.
        assert(step(step(trio, [item(1), item(3)]).0, [item(1), item(3), item(4)]).1 == ["r1", "r3", "r4"],
               "a new row joins at the end")

        // A different slot count starts again from a first drawing.
        let (narrow, _) = step(SubtaskSlots(), five, slots: 2)
        let (shuffled, _) = step(narrow, five.filter { $0.n != 1 }, slots: 2)
        assert(step(shuffled, five.filter { $0.n != 1 }, slots: 2).1 == ["r3", "r2"], "the phone's ledger")
        assert(step(shuffled, five.filter { $0.n != 1 }, slots: 3).1 == ["r2", "r3", "r4"],
               "two slots to three resets the ledger")

        // Thirty at once: three rows, the rest counted.
        let thirty = (1...30).map { item($0, $0 % 3 == 0 ? .testing : .coding) }
        let (busy, busyRows) = step(SubtaskSlots(), thirty)
        assert(busyRows == ["r1", "r2", "r3"], "thirty: the first three")
        assert(step(busy, thirty).0 == busy, "thirty: idempotent")

        // Opened in place: the rows on show stay where they are, and the rest
        // follow in start order. Folded, the first slots keep their rows.
        let (opened, openRows) = step(afterFinish, five.filter { $0.n != 2 }, open: true)
        assert(openRows == ["r1", "r4", "r3", "r5"], "open keeps the slots and adds the rest")
        assert(opened.isOpen("card"), "open")
        assert(step(opened, five.filter { $0.n != 2 }, open: true).0 == opened, "idempotent while open")
        assert(step(opened, five.filter { $0.n != 2 }).1 == ["r1", "r4", "r3"], "fold keeps the first slots")
        // While open, a finished row's place closes and a new one joins the end.
        assert(step(opened, [item(1), item(3), item(5), item(6)], open: true).1 == ["r1", "r3", "r5", "r6"],
               "open: a finish closes, a start joins the end")
        // A list open with fewer rows than slots, which then grows, is still open.
        let (smallOpen, _) = step(SubtaskSlots(), [item(1), item(2)], open: true)
        assert(step(smallOpen, five, open: true).1 == ["r1", "r2", "r3", "r4", "r5"],
               "an open list that shrank and grew again is still open")

        // A card without subagents has no ledger; one that comes back starts again.
        let gone = filled.resolved(for: [Session(id: "card", name: "card", status: .done, message: "",
                                                 project: "", createdAt: 0, updatedAt: 0)],
                                   slots: 3, expanded: [])
        assert(gone == SubtaskSlots().resolved(for: [], slots: 3, expanded: []), "no block, no ledger")
        assert(step(gone, five.filter { $0.n != 2 }).1 == ["r1", "r3", "r4"], "a returning card starts again")
        // Every row finished, the count still showing: no rows, and no crash.
        assert(step(filled, []).1.isEmpty, "count only")

        // The label's share of a row's text.
        assert(SubtaskTextLayout.widths(total: 300, label: 80, spacing: 8) == (80, 212), "a short label is whole")
        let capped = SubtaskTextLayout.widths(total: 300, label: 280, spacing: 8)
        assert(abs(capped.label - 174) < 0.001 && abs(capped.activity - 118) < 0.001, "a long label stops at 58%")
        assert(SubtaskTextLayout.widths(total: 0, label: 80, spacing: 8) == (0, 0), "no room at all")
    }
}
#endif
