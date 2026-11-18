import SwiftUI
import UIKit
#if DEBUG
import os
#endif

/// The live board: one glanceable card per agent session, in one section per
/// project, under the agents' heads, with one needs-you bar at the bottom
/// while anything is blocked.
struct BoardView: View {
    @Environment(SessionStore.self) private var store
    @Environment(NotificationManager.self) private var notifications
    @AppStorage("pushTipShown") private var pushTipShown = false

    @State private var showPairSheet = false
    @State private var showSettings = false
    @State private var copiedWebhook = false
    @State private var path = NavigationPath()

    /// Which side each card sits on where cards run two across. Kept here and
    /// not in the container that draws them: containers are swapped when the
    /// board is rotated or the text size changes, and a card's side has to
    /// outlive the swap.
    @State private var sides = CardSides()
    /// Which subagents stand in which row slots of each card — see
    /// `SubtaskSlots`. Here beside `sides` for the same reason: every frame
    /// replaces a session whole, the containers are swapped on rotation, and
    /// a row's slot has to outlive both.
    @State private var subtaskSlots = SubtaskSlots()
    /// The cards whose subagent lists the reader opened in place. A card stays
    /// open until it is folded, or loses its subagents, or leaves the board.
    @State private var expandedSubtasks: Set<String> = []
    /// The card the needs-you bar last brought into view, for as long as its
    /// ring shows.
    @State private var jumped: String?
    /// Counts the jumps. The ring's two seconds run from the LAST press, and a
    /// second press that brings the same card leaves `jumped` holding an equal
    /// id, which would restart nothing.
    @State private var jumpStamp = 0
    /// The card the bar brought last, which the bar then names the next
    /// blocked card after (`NeedsYou.make`). Nil until it is pressed, and
    /// again once nothing is blocked.
    @State private var barAfter: String?
    /// Where VoiceOver goes after a jump: the card the bar brought into view.
    /// A scroll that left the cursor on the bar would have moved nothing for
    /// that reader. Keyed as the scroll targets are. Never read in a body:
    /// VoiceOver writes it on every swipe across a card.
    @AccessibilityFocusState private var jumpFocus: JumpTarget?
    /// Which of the phone's List rows exist, and the one a jump is waiting
    /// for (`JumpLanding`).
    @State private var landing = JumpLanding()
    /// The plan and the scroll view the board was last drawn with, which a
    /// press of the bar reads (`DrawnBoard`).
    @State private var drawn = DrawnBoard()
    /// Where each card on the stacked board was last drawn, which its
    /// reading order follows (`CardTops`). Not observed: layout writes it.
    @State private var cardTops = CardTops()
    /// Counts the times layout has changed the order the stacked board's
    /// cards are read in, and is the one thing about where cards are drawn
    /// that the board observes (`cardsMoved`).
    @State private var reorders = 0
    /// Redraws every minute so the "resets in …" countdowns stay honest. One
    /// clock for the whole board, handed to every head: heads now live both
    /// above the scroll view and inside it, and a clock apiece would let two
    /// countdowns on one screen disagree for most of a minute.
    private static let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    @State private var now = Date()
    /// A dropped connection that has been said aloud, so that its return is
    /// said too — and only then (`announceConnection`).
    @State private var announcedDrop = false
    /// The wait before a drop is said aloud.
    @State private var dropWait: Task<Void, Never>?
    /// What the board has said about blocks, and what it is about to say
    /// (`announceBlocks`).
    @State private var blockSpeech = BlockSpeech()
    /// The needs-you bar's beat: its half second and its minute (`BarBeat`),
    /// kept as the voice's are, unobserved (`noteBeat`).
    @State private var beat = BeatClock()
    /// How many times the bar has beaten: each one more brings it in from the
    /// bottom edge again (`NeedsYouStyle`). The one part of the beat the board
    /// observes, and it changes on a beat and at no other time.
    @State private var barBeats = 0
    /// Whether the board's scene is in front of the reader, as it is now:
    /// what the voice and the bar's beat read when their half second ends
    /// (`LivePhase`).
    @State private var livePhase = LivePhase()

    /// The narrowest a column may be, growing with the reader's text size.
    ///
    /// Scaled so that large text steps the board DOWN an arrangement — an iPad
    /// drops from two across to the list — instead of holding two columns and
    /// cutting every name in them. At the default size it is exactly
    /// `BoardArrangement.minColumn`, and the head's thresholds scale by the
    /// same factor (`BoardPlan.scale`).
    @ScaledMetric(relativeTo: .title3) private var minColumn = BoardArrangement.minColumn
    /// The connection lamp, 9pt at the default size, growing with the text
    /// as the DEMO badge that stands in its place does, to 15pt; past that the
    /// long press shows it large with its word (`connectionDot`).
    @ScaledMetric(relativeTo: .caption2) private var lampMetric: CGFloat = 9

    /// At an accessibility size a phone's heads lead the list and scroll
    /// away rather than staying pinned: `BoardArrangement.headsScroll`.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Compact on a phone held sideways, and only there: it keeps the list,
    /// with nothing pinned above it. The one size class the board reads, and
    /// it is never asked about width (`BoardArrangement`).
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    /// The scene's phase, read here only to keep `livePhase` current. Whether
    /// a block is said aloud, or makes the bar beat, is asked when its half
    /// second ends, and the task waiting it out holds this value as it was
    /// when the task began (`LivePhase`).
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack(path: $path) {
            // The board is arranged from its MEASURED width, read here, once,
            // at the root. A reader is synchronous: the width is known in the
            // same pass that lays the board out, so no frame is ever drawn for
            // the wrong one. Writing a measurement into state instead would
            // draw the phone's list on an iPad for one frame at every launch
            // and every rotation.
            //
            // It is the width inside the safe area, which is the width the
            // content actually gets — on a phone in landscape as well.
            GeometryReader { geo in
                // One reader for whichever container is live, so the bar
                // does not need to know whether it is scrolling a List or a
                // ScrollView.
                ScrollViewReader { scroller in
                    board(plan(for: geo.size.width), scroller: scroller)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            // Both destinations live at the root, on a view that is always
            // there. The session one used to hang off the List — but the List
            // is one of two containers that replace each other when the board
            // is rotated or the text size changes, and a destination declared
            // on a container that has just been swapped out is gone from under
            // the screen it pushed.
            //
            // Two value types, so the two cannot collide: a session's screen is
            // a SessionRoute, an agent's usage is a UsageDetailRoute.
            .navigationDestination(for: UsageDetailRoute.self) { route in
                UsageDetailView(source: route.source)
            }
            .navigationDestination(for: SessionRoute.self) { route in
                SessionHistoryView(sessionId: route.sessionId, subtaskId: route.subtaskId)
            }
            // Actions, not bare closures, so that one hook event runs only its
            // own card, not every card, head and label under the board
            // (`BoardAction`). A head, a label and the bar also have to be
            // handed only what they draw to stay as they were (`AgentHead`'s
            // `==`, `ProjectLabel`, `NeedsYouSlot`).
            .environment(\.openSession, BoardAction(name: "history") { path.append($0) })
            .environment(\.openUsage, BoardAction(name: "usage") { path.append(UsageDetailRoute(source: $0)) })
            // The reader's own act, so it is the one change to a card's rows
            // that is animated as a whole: the rows on show stay where they
            // are, the rest come in below, and the cards under it move down.
            .environment(\.toggleSubtasks, BoardAction(name: "subtasks") { id in
                withMotion(.snappy) {
                    if expandedSubtasks.contains(id) {
                        expandedSubtasks.remove(id)
                    } else {
                        expandedSubtasks.insert(id)
                    }
                }
            })
            .navigationTitle("AgStatus")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("AgStatus")
                        .font(.system(.headline, design: .rounded).weight(.bold))
                        .foregroundStyle(Theme.textPrimary)
                }
                BoardStatusItem {
                    if store.isDemo && !lampForScreenshots {
                        demoBadge
                    } else {
                        connectionDot
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    // The demo badge says where you are; this says how you leave.
                    if store.isDemo {
                        Button("Exit Demo") {
                            store.stopDemo()
                        }
                        .font(.subheadline.weight(.semibold))
                        .tint(Theme.textSecondary)
                    }
                    if store.board?.token != nil && store.connection != .boardGone {
                        Button {
                            showPairSheet = true
                        } label: {
                            Image(systemName: "laptopcomputer.and.arrow.down")
                        }
                        .accessibilityLabel("Pair your computer")
                    }
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
            .task { await openHistoryForScreenshots() }
            .sheet(isPresented: $showPairSheet) { PairSheet() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task(id: store.board) {
                if let board = store.board, board.token != nil, !pushTipShown {
                    await notifications.probeServerSupport(for: board)
                }
            }
            .onReceive(Self.clock) { now = $0 }
            // Where the end of a half second reads it (`LivePhase`).
            .onChange(of: scenePhase, initial: true) { _, phase in livePhase.scene = phase }
            .onChange(of: store.connection) { old, new in announceConnection(from: old, to: new) }
            // The body draws from `sides.resolved(for:)`, and this stores the
            // same answer — so the first frame a card appears in already has
            // it on its side, and every later frame finds it there. Keyed on
            // the answer itself, which changes when a card arrives and when
            // one changes section, and at no other time: a card that has
            // just moved out of No project is held to the side it was given
            // in its new section, whichever cards move in after it.
            .onChange(of: sides.resolved(for: sections), initial: true) { _, resolved in
                sides = resolved
            }
            // A card that loses its subagents, or leaves the board, is folded:
            // its next subagents start a list of their own.
            .onChange(of: store.sessions.filter { $0.subtasks != nil }.map(\.id)) { _, ids in
                expandedSubtasks.formIntersection(ids)
            }
            // A different board is different cards. Starting again is also
            // what stops the ledger growing without end across a day of
            // switching boards.
            .onChange(of: store.board) {
                startOver()
                // A different board's first connect is not a reconnection.
                announcedDrop = false
                dropWait?.cancel()
            }
            .onChange(of: store.isDemo) { startOver() }
            // The ring says "this is the blocked card you asked for". Once the
            // card is no longer blocked it would be saying something untrue.
            // With nothing blocked the bar goes, and the next one to come
            // starts from the first. A card that has just become blocked is
            // said aloud, and, where the bar already shows, makes it beat.
            .onChange(of: blockedCards) { old, new in
                if let jumped, !new.ids.contains(jumped) { self.jumped = nil }
                if new.ids.isEmpty { barAfter = nil }
                let blocks = newBlocks(from: old, to: new)
                if let blocks { announceBlocks(blocks, from: old, to: new) }
                noteBeat(blocks, from: old, to: new)
            }
            .task(id: jumpStamp) { await fadeRing() }
        }
    }

    /// The board itself: what is pinned, what scrolls, the needs-you bar and
    /// the streak beneath.
    private func board(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        // Before anything this pass draws can be pressed.
        drawn.plan = plan
        drawn.scroller = scroller
        let bar = store.connection == .boardGone ? nil : plan.needsYou?.face
        return reachingBar(VStack(spacing: 0) {
            if !plan.heads.isEmpty && store.connection != .boardGone
                && !(plan.idle ? plan.idleHeadsScroll : plan.headsScroll) {
                pinned(plan)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    // Read first, as it is drawn (`reachingBar`).
                    .accessibilitySortPriority(3)
            }
            Group {
                if store.connection == .boardGone {
                    boardGoneView
                } else if store.sessions.isEmpty {
                    // "No agents yet" is only true when we're actually live —
                    // while (re)connecting, an empty list just means "unknown".
                    if store.isDemo || store.connection == .live {
                        emptyState(plan)
                    } else {
                        connectingState(plan)
                    }
                } else {
                    sessionBoard(plan)
                        // Whether each card has a column at this text size:
                        // the board has measured it, and a card cannot without
                        // a reader that would decide a frame late.
                        .environment(\.cardIsColumnWide, plan.cardsColumnWide)
                        // Every card draws its subagent rows from the ledger
                        // resolved for this pass, and under the phone's rules
                        // — two rows, a footer that opens the session screen
                        // — exactly where the board is one list. By measured
                        // width, as everything here is: an iPad in Split View
                        // gets the phone's rules, and so does a phone held
                        // sideways, which keeps its list.
                        .environment(\.subtaskSlots, plan.subtasks)
                        .environment(\.subtasksOpenScreen, plan.arrangement == .list)
                }
            }
            // The cards, after the bar for VoiceOver (`reachingBar`): one
            // container, so the List and the stack each take one place in
            // the order however many elements they hold.
            .accessibilityElement(children: .contain)
            .accessibilitySortPriority(1)

            // The board's one alarm, between the board and the streak, and
            // only while something is blocked (`NeedsYouBar`). Outside the
            // scroll view, so whatever the reader has scrolled to, it stays
            // in view.
            NeedsYouSlot(face: bar,
                         lines: plan.compactHeight ? .one : plan.wide ? .oneOrTwo : .two,
                         beats: barBeats,
                         onPress: barAction)
                .equatable()
                // Before the cards, though it is drawn below them.
                .accessibilitySortPriority(2)

            // Pinned under the list rather than inside it: the streak is
            // about the board, not about any card, and a row that scrolled
            // away with the sessions would be a different claim. It enters
            // from the bottom the way the heads enter from the top, so the
            // two pieces of board-level chrome behave as a pair.
            //
            // Absent until the first fetch lands, and absent again if it
            // fails — `days > 0` covers both. A streak is ambient; an
            // apology where a number should be is worse than silence.
            if store.streak.days > 0 && store.connection != .boardGone {
                StreakBar(streak: store.streak)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }, while: bar != nil)
        .settles(on: plan.shape)
        // A head gaining or losing a limit window, which changes its height:
        // it grows with the cards under it moving together, rather than
        // jumping. Keyed on which windows there are, so it fires when one
        // comes or goes and at no other time. A bar that moves animates its
        // own fill (LimitMeter), pinned or scrolling, and heads arriving or
        // leaving change the board's shape, which is drawn (`settles`).
        //
        // It was keyed on every agent's usage report. A report carries the
        // time it was made, so each one armed an animation even when no bar
        // had moved, and it was armed over the whole board: a card that
        // changed in the same update — the snapshot and the limits arrive
        // together on a reconnect — cross-faded its old text into its new.
        .motion(.snappy, value: plan.heads.map { $0.windows.map(\.id) })
        .motion(.snappy, value: store.streak)
        #if DEBUG
        .frame(maxWidth: Self.widthForScreenshots.map { $0 + 2 * Theme.Space.md })
        #endif
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await pressBarForScreenshots() }
        .task { await dumpAccessibilityForScreenshots() }
        // The body draws from `subtaskSlots.resolved(…)` and this stores the
        // same answer, as `sides` is stored: so the frame a row first appears
        // in already has it in its slot. Resolving is idempotent, so storing
        // it never asks for another pass that would change it again. Here and
        // not at the root, because the slot count is the arrangement's, and
        // only this side of the reader knows the width.
        .onChange(of: plan.subtasks, initial: true) { _, resolved in
            subtaskSlots = resolved
        }
    }

    /// The board as VoiceOver meets it: one container, its parts in the
    /// order a reader needs them rather than the order they are drawn — the
    /// pinned heads, then the needs-you bar, then the cards, then the streak.
    /// As on the web and Android, the board's one alarm comes before the
    /// cards it leads to. Drawn at the bottom and left to the geometry, it
    /// came after every label, card and subagent row, so a VoiceOver reader
    /// with twenty cards swiped through all of them to reach it. Where the
    /// heads lead the scroll they are the first rows of the cards'
    /// container, and the bar is read before them.
    ///
    /// And while the bar shows, Magic Tap — VoiceOver's two-finger double
    /// tap — presses it from anywhere on the board: the bar's card comes into
    /// view, and VoiceOver lands on it. While it does not, nothing here
    /// answers a Magic Tap, which goes on to the system as it always did, to
    /// pause what is playing.
    ///
    /// The action is added or not on one value of one type, so the bar
    /// arriving or leaving changes an accessibility property, never which
    /// view the board is: an `if` around the board would have rebuilt it,
    /// and its scroll position with it.
    private func reachingBar<Board: View>(_ board: Board, while shows: Bool) -> some View {
        // The board's own place among its neighbours is the first, as it was.
        let contained = board.accessibilityElement(children: .contain).accessibilitySortPriority(0)
        // One action for the board's life, kept with what a press reads
        // (`DrawnBoard`): a closure made afresh on each pass would be a
        // changed property on the board's container at every hook event,
        // which only arrivals, departures and blocks should touch. It keeps
        // the press, not the board (`BarPress`).
        if drawn.magicTap == nil { drawn.magicTap = { [press = barPress] in press() } }
        return shows ? contained.accessibilityAction(.magicTap, drawn.magicTap ?? {}) : contained
    }

    /// Forgets every card's side, slots and open list, and where the bar had
    /// got to, for a board that is no longer the one they were kept for.
    private func startOver() {
        sides = CardSides().resolved(for: sections)
        subtaskSlots = SubtaskSlots()
        expandedSubtasks = []
        barAfter = nil
        // Not the edges where cards are drawn: they are layout's own answer,
        // true of whatever is on the board now, and a card laid out where it
        // already was reports nothing to replace them with.
    }

    /// Debug-only deep links so screenshot automation can reach the pushed
    /// screens and the states only a touch makes, none of which have a launch
    /// argument, and simctl cannot tap.
    /// AGSTATUS_OPEN_SHEET=settings|pair presents that sheet;
    /// AGSTATUS_OPEN_HISTORY=1 opens the first session's timeline, and
    /// AGSTATUS_OPEN_HISTORY=<session id> that session's;
    /// AGSTATUS_OPEN_USAGE=<source> opens that agent's usage history;
    /// AGSTATUS_OPEN_SUBTASK=<n> opens the session screen at subagent number n
    /// of the first card that has one, as tapping its row would;
    /// AGSTATUS_EXPAND_SUBTASKS=1 opens every card's subagent list in place,
    /// as its footer would (nothing opens in place under the phone's rules).
    private func openHistoryForScreenshots() async {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        switch environment["AGSTATUS_OPEN_SHEET"] {
        case "settings": showSettings = true; return
        case "pair": showPairSheet = true; return
        default: break
        }
        if let source = environment["AGSTATUS_OPEN_USAGE"], !source.isEmpty {
            // Demo usage is seeded synchronously; a real board's arrives over SSE.
            for _ in 0..<40 {
                if !store.usage.isEmpty { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if path.isEmpty {
                path.append(UsageDetailRoute(source: source))
            }
            return
        }
        let expands = environment["AGSTATUS_EXPAND_SUBTASKS"] == "1"
        let subtask = environment["AGSTATUS_OPEN_SUBTASK"].flatMap { Int($0) }
        let which = environment["AGSTATUS_OPEN_HISTORY"] ?? ""
        guard expands || subtask != nil || !which.isEmpty else { return }
        // Demo sessions are seeded synchronously; a real board arrives over SSE.
        for _ in 0..<40 {
            if !store.sessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if expands {
            expandedSubtasks = Set(store.sessions.filter { $0.subtasks != nil }.map(\.id))
        }
        if let subtask {
            for session in store.sessions {
                guard let item = session.subtasks?.items.first(where: { $0.n == subtask }) else { continue }
                if path.isEmpty {
                    path.append(SessionRoute(sessionId: session.id, subtaskId: item.id))
                }
                return
            }
            return
        }
        guard !which.isEmpty else { return }
        // "1" is the first session; anything else names one, so a stale
        // session's history can be reached when a blocked one sorts first.
        let session = which == "1" ? store.sessions.first : store.sessions.first { $0.id == which }
        if let session, path.isEmpty {
            path.append(SessionRoute(sessionId: session.id))
        }
        #endif
    }

    #if DEBUG
    /// AGSTATUS_BOARD_WIDTH=<pt> clamps the board to that width inside its
    /// gutters, whatever the device. It is how a full-screen iPad is made to
    /// stand in for one in Split View: 646 has to give the phone's list on a
    /// device whose size class is regular, and simctl cannot open Split View.
    private static let widthForScreenshots: CGFloat? =
        ProcessInfo.processInfo.environment["AGSTATUS_BOARD_WIDTH"]
            .flatMap(Double.init)
            .map { CGFloat($0) }
    #endif

    /// AGSTATUS_PRESS_BAR=<n> presses the needs-you bar n times once the
    /// board has been laid out — 1 brings the first blocked card, 2 the next —
    /// because simctl cannot tap and the jump is the one piece of this layout
    /// that only exists after a touch.
    private func pressBarForScreenshots() async {
        #if DEBUG
        if let project = ProcessInfo.processInfo.environment["AGSTATUS_SCROLL_TO"], !project.isEmpty {
            try? await Task.sleep(for: .milliseconds(600))
            scrollForScreenshots(to: project)
        }
        guard let presses = ProcessInfo.processInfo.environment["AGSTATUS_PRESS_BAR"].flatMap(Int.init),
              presses > 0 else { return }
        // Demo sessions are seeded synchronously, so the board is drawn with
        // them from its first pass; the wait is for the scroll view to have a
        // first layout to scroll.
        try? await Task.sleep(for: .milliseconds(600))
        for press in 0..<presses {
            if press > 0 { try? await Task.sleep(for: .milliseconds(900)) }
            pressBar()
        }
        #endif
    }

    #if DEBUG
    /// AGSTATUS_SCROLL_TO=<folder> scrolls the board to that project's
    /// section, its label at the top, as a reader would: the sections below
    /// the first screen can be captured. `none` is No project.
    private func scrollForScreenshots(to project: String) {
        guard let plan = drawn.plan, let scroller = drawn.scroller else { return }
        let key: ProjectKey = project == "none" ? .noProject : .folder(project)
        guard let section = plan.sections.first(where: { $0.key == key }),
              let first = section.sessions.first else { return }
        switch plan.arrangement {
        case .list: scroller.scrollTo(first.id, anchor: .top)
        case .stacked: scroller.scrollTo(section.id, anchor: .top)
        }
    }
    #endif

    /// AGSTATUS_AX_DUMP=1 logs what VoiceOver is offered once the board has
    /// settled, after any AGSTATUS_PRESS_BAR presses (`AccessibilityDump`).
    /// AGSTATUS_MAGIC_TAP=<words> then makes VoiceOver's Magic Tap from the
    /// first element whose label holds those words, as UIKit hands it on
    /// (`AccessibilityDump.magicTap`), and logs the tree again.
    private func dumpAccessibilityForScreenshots() async {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard environment["AGSTATUS_AX_DUMP"] == "1" else { return }
        let presses = environment["AGSTATUS_PRESS_BAR"].flatMap(Int.init) ?? 0
        try? await Task.sleep(for: .milliseconds(2500 + 900 * presses))
        AccessibilityDump.log(focused: jumpFocus.map { "\($0)" })
        guard let words = environment["AGSTATUS_MAGIC_TAP"], !words.isEmpty else { return }
        AccessibilityDump.magicTap(from: words)
        try? await Task.sleep(for: .milliseconds(1500))
        AccessibilityDump.log(focused: jumpFocus.map { "\($0)" })
        #endif
    }

    // MARK: - Plan

    /// The projects on the board, in the shared order, each with its
    /// sessions in the store's order.
    private var sections: [ProjectSection] {
        ProjectSection.make(sessions: store.sessions)
    }

    /// Everything one pass of layout decides, from the width it was given.
    private func plan(for outerWidth: CGFloat) -> BoardPlan {
        var width = max(0, outerWidth - 2 * Theme.Space.md)
        #if DEBUG
        if let clamp = Self.widthForScreenshots { width = min(width, clamp) }
        #endif
        let sections = sections
        let compactHeight = verticalSizeClass == .compact
        let arrangement = BoardArrangement.resolve(width: width, minColumn: minColumn, compactHeight: compactHeight)
        let sides = sides.resolved(for: sections)
        // Read so that layout changing the order cards are read in draws the
        // board again (`cardsMoved`); the edges themselves are not observed.
        _ = reorders
        let order = ReadingOrder.make(sections, arrangement: arrangement, sides: sides, tops: cardTops.edges)
        return BoardPlan(
            width: width,
            scale: minColumn / BoardArrangement.minColumn,
            heads: AgentSummary.make(sessions: store.sessions, usage: store.usage),
            sections: sections,
            arrangement: arrangement,
            wide: BoardArrangement.fit(width: width, minColumn: minColumn) >= 2,
            idle: store.sessions.isEmpty,
            largeText: typeSize.isAccessibilitySize,
            compactHeight: compactHeight,
            sides: sides,
            // Nothing opens in place under the phone's rules, whatever the
            // reader opened before the board narrowed — the flag is kept, and
            // a board that widens again finds the card still open.
            subtasks: subtaskSlots.resolved(for: store.sessions,
                                            slots: SubtaskSlots.slots(for: arrangement),
                                            expanded: arrangement == .list ? [] : expandedSubtasks),
            order: order,
            needsYou: NeedsYou.make(order: order, after: barAfter)
        )
    }

    // MARK: - Pinned

    /// What stays above the scroll view: the agents' heads, where the limit
    /// bars always sat, while there is room to pin them
    /// (`BoardArrangement.headsScroll`). Otherwise they lead the scroll and
    /// nothing is pinned up here: the label of the section under you is, in
    /// the list, and the alarm is the bar at the bottom.
    @ViewBuilder
    private func pinned(_ plan: BoardPlan) -> some View {
        if plan.idle {
            // Nothing running. The heads are the limits again and nothing
            // more: side by side as the limit blocks were, up to three across
            // where there is room and two where there is not.
            headRows(plan, perRow: plan.wide ? min(plan.heads.count, 3) : 2, level: plan.wide)
                .padding(.horizontal, Theme.Space.md)
                .padding(.top, BoardArrangement.headsTop)
                .padding(.bottom, 2)
        } else {
            switch plan.arrangement {
            case .list:
                // Two across, each keeping its own height; the only agent
                // takes the whole row. No third head, and no head holding
                // more than four limit windows: `narrowPinnedHeads`,
                // `narrowPinnedWindows`.
                headRows(plan, perRow: 2, level: false)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, BoardArrangement.headsTop)
                    .padding(.bottom, 2)
            case .stacked:
                // Full-width strips, one to a row: never side by side over two
                // sides of cards that mix agents, which would read as "left is
                // Claude". One always, two at a standard size
                // (`widePinnedHeads`).
                headRows(plan, perRow: 1, level: false, canStrip: true)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, BoardArrangement.headsTop)
                    .padding(.bottom, 2)
            }
        }
    }

    /// The heads in rows of `perRow`, every one a fixed track wide
    /// (`HeadRows`). `alone` is for pinned rows: a head with a row to itself
    /// takes the fuller line where it fits. Heads that lead the scroll keep
    /// the form their width gives them, as they did in 1.6.5, and say when
    /// an agent reports no limits.
    private func headRows(_ plan: BoardPlan, perRow: Int, level: Bool, canStrip: Bool = false,
                          alone: Bool = true, showsNoLimits: Bool? = nil) -> some View {
        HeadRows(heads: plan.heads,
                 perRow: perRow,
                 width: plan.width,
                 level: level,
                 canStrip: canStrip,
                 showsNoLimits: showsNoLimits ?? (plan.arrangement != .list),
                 scale: plan.scale,
                 alone: alone,
                 now: now)
            .equatable()
    }

    /// The heads where they lead the scroll: each across the whole width, one
    /// to a row, every window in it.
    private func leadingHeads(_ plan: BoardPlan) -> some View {
        headRows(plan, perRow: 1, level: false, canStrip: true, alone: false, showsNoLimits: true)
    }

    // MARK: - Sessions

    /// The cards, in whichever container the width calls for.
    ///
    /// Two containers, and they replace each other outright. A change of
    /// arrangement is never cross-faded: two boards drawn over one another for
    /// a third of a second is the overlapping-text defect `scrollChrome`
    /// already describes, at the size of the whole screen.
    @ViewBuilder
    private func sessionBoard(_ plan: BoardPlan) -> some View {
        switch plan.arrangement {
        case .list:
            scrollChrome(sectionList(plan))
                .transition(.identity)
        case .stacked:
            scrollChrome(stackedBoard(plan))
                .transition(.identity)
        }
    }

    /// What every container carries, whichever one is live: pull to refresh,
    /// the motion of a card arriving or leaving, and the push tip above the
    /// bottom edge.
    private func scrollChrome<Container: View>(_ container: Container) -> some View {
        container
            .refreshable { await store.refresh() }
            // Keyed on the ORDER of cards, not their contents. Animating on
            // `store.sessions` crossfaded every card whenever any field changed, so
            // a session whose message updated drew the old and new text on top of
            // each other for the length of the transition — it read as a rendering
            // bug, which is what it was. Motion on this board should mean a card
            // arrived, left or moved; a message changing in place is not news.
            //
            // A new project's section arrives with its first card, and goes
            // with its last, in that motion. The one move between sections, a
            // card leaving No project when its first folder arrives, changes
            // no order and so is drawn, not animated.
            .motion(.snappy, value: store.sessions.map(\.id))
            .safeAreaInset(edge: .bottom) {
                if showsPushTip {
                    pushTip
                }
            }
    }

    /// Where two columns do not fit — a phone, or an iPad in Split View — and
    /// on a phone held sideways, the sessions stay one list, because the list
    /// is the only container that can be swiped, and the swipe is how a phone
    /// has always dismissed a card.
    ///
    /// A section per project, its label pinned while its cards scroll under
    /// it, in every mode, text size and orientation: with the agents sharing
    /// sections, the label is the only thing on screen that says which
    /// project these cards are. Where the heads cannot be pinned they are the
    /// first row, and scroll away.
    private func sectionList(_ plan: BoardPlan) -> some View {
        List {
            if plan.headsScroll {
                // A section of its own, without a header, so the first
                // project's label is flush under it as it is under pinned
                // heads, and nothing of the heads is ever pinned.
                Section {
                    leadingHeads(plan)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        // 10pt under the navigation bar, where the pinned
                        // heads stand; no swipe, a head is not something to
                        // dismiss.
                        .listRowInsets(EdgeInsets(top: BoardArrangement.headsTop, leading: Theme.Space.md,
                                                  bottom: 2, trailing: Theme.Space.md))
                }
                .listSectionSeparator(.hidden)
                .modifier(FlushSection())
            }
            ForEach(plan.sections) { section in
                Section {
                    ForEach(section.sessions) { session in
                        row(session)
                    }
                } header: {
                    // A plain list pins its section headers by itself. What it
                    // does not do is draw them our way: the system insets a
                    // header, capitalises it, and rules a line under it. The
                    // label brings its own ground and its own padding, so all
                    // three are turned off.
                    ProjectLabel(label: section.label, inset: Theme.Space.md + 2)
                        .equatable()
                        .listRowInsets(EdgeInsets())
                        .textCase(nil)
                }
                .listSectionSeparator(.hidden)
                .modifier(FlushSection())
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .modifier(OpaquePinnedLabels())
        .environment(\.cardsSwipeToDismiss, true)
        // The list is rebuilt, not morphed, when its heads go from pinned to
        // leading it: animated, the heads' row slid in while every card under
        // it was drawn twice for a fifth of a second.
        .settles(on: plan.shape)
    }

    private func row(_ session: Session) -> some View {
        reportsLanding(card(session), as: .card(session.id))
            // No invisible full-card NavigationLink any more. It was
            // an overlay across the whole card, which meant it sat on
            // top of the Focus and Resume controls and could swallow
            // the tap meant for them — a card that opens history when
            // you asked it to raise a window. A tap on the card's content
            // column opens history instead, and the Focus control sits in
            // the rail or on its own line, outside that gesture.
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive) {
                    Task { await store.dismiss(session) }
                } label: {
                    Label("Dismiss", systemImage: "xmark.circle.fill")
                }
                .tint(Theme.destructiveFill)
            }
    }

    /// Projects stacked full width, cards two across inside each, under the
    /// heads' strips: the wide board's one arrangement, whatever the number
    /// of projects.
    ///
    /// Eager stacks, not lazy ones. A hosted board holds fifty cards at most,
    /// which is nothing to lay out — and a stack that knows every card's
    /// height is what makes a jump land exactly, a removal close its gap
    /// properly, and the scroll offset hold still when a card far above
    /// changes height. Eager stacks cannot pin a header, so here a label
    /// scrolls with its section; the bar has already named the project, and
    /// the card its agent.
    private func stackedBoard(_ plan: BoardPlan) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if plan.headsScroll {
                    leadingHeads(plan)
                        .padding(.top, BoardArrangement.headsTop)
                        .padding(.bottom, 2)
                }
                ForEach(plan.sections) { section in
                    VStack(alignment: .leading, spacing: 0) {
                        // 24pt between two projects, twice the 12 between two
                        // cards; the first stands as far under what is above
                        // it as a label does in the list. No space under the
                        // name: the first card brings the 8.
                        ProjectLabel(label: section.label,
                                     top: section.id == plan.sections.first?.id ? 18 : BoardArrangement.sectionGap,
                                     bottom: 0)
                            .equatable()
                        // Two sides that each keep their cards — see CardSides.
                        HStack(alignment: .top, spacing: BoardArrangement.cardGap) {
                            ForEach(CardSides.Side.allCases, id: \.self) { side in
                                cardStack(plan.sides.cards(section.sessions, on: side), in: section.key)
                                    .frame(width: plan.side, alignment: .top)
                            }
                        }
                    }
                    // Read one project at a time. Left to itself VoiceOver
                    // goes across the sides by where things are drawn, which
                    // is the reading order (`ReadingOrder`), but would run on
                    // into the next project's cards without saying so.
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(section.key.folder.map { "\($0) sessions" } ?? "Sessions with no project")
                    .id(section.id)
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.bottom, Self.scrollBottom)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .settles(on: plan.shape)
        }
    }

    private static let scrollBottom: CGFloat = 18

    /// How far below the top edge a jump leaves the card it brought there:
    /// the gap that separates a card from what is above it.
    private static let cardLead = Theme.Space.xs

    /// One side of a section's cards, 12pt apart.
    ///
    /// Each card carries `cardLead` of that gap as padding ABOVE itself, inside
    /// the view a jump scrolls to, and the stack supplies the rest. That is
    /// what makes a jump land right: `scrollTo(_:anchor: .top)` puts a view's
    /// top edge hard against the scroll view's, and a card flush under the
    /// heads reads as cut off — but a card that owns the 8pt above it comes to
    /// rest 8pt down, exactly, with no arithmetic on a scroll view's height.
    ///
    /// The obvious alternative does not work, and was tried: a view of no
    /// height standing 8pt above the card in an overlay, given the id instead.
    /// It is laid out where it should be, and ScrollViewReader ignores where —
    /// asked to scroll to it, it brings the CARD's top to the edge, whether the
    /// overlay is placed by an alignment guide or by negative padding, and
    /// whether it stands 8pt up or 30. An id in an overlay evidently answers
    /// with the frame of the view it is laid over.
    ///
    /// So a side begins with 8pt of air, which is also the label's 8 above
    /// the first card.
    ///
    /// Laid out by `DrawnSide`, which stacks the cards as a VStack of that
    /// spacing would and keeps the top edge it gives each one (`CardTops`):
    /// where a card is drawn is what the reading order follows.
    private func cardStack(_ sessions: [Session], in section: ProjectKey) -> some View {
        // What a laid-out side reports to, made once and kept with the edges
        // (`cardsMoved`). Like Magic Tap's action it keeps what it reads and
        // the one count it writes, not the board (`BarPress` says why).
        if cardTops.moved == nil {
            cardTops.moved = { [weak drawn, reorders = $reorders] tops in
                BoardView.cardsMoved(tops, drawn: drawn, reorders: reorders)
            }
        }
        return DrawnSide(spacing: BoardArrangement.cardGap - Self.cardLead, section: section,
                         ids: sessions.map(\.id), tops: cardTops) {
            ForEach(sessions) { session in
                card(session)
                    .padding(.top, Self.cardLead)
                    .id(JumpTarget.card(session.id))
            }
        }
    }

    /// Cards on the stacked board have been laid out with their top edges
    /// somewhere new (`DrawnSide`). The edges are kept where nothing observes
    /// them; the board is drawn again only if they change the order the
    /// cards are read in, which is what the bar names and what a press
    /// brings. An event that moves no card asks nothing of this, and one that
    /// moves cards without reordering them draws nothing more.
    private static func cardsMoved(_ tops: CardTops, drawn: DrawnBoard?, reorders: Binding<Int>) {
        guard let plan = drawn?.plan, plan.arrangement == .stacked else { return }
        tops.forget(allBut: plan.order)
        let order = ReadingOrder.make(plan.sections, arrangement: .stacked, sides: plan.sides, tops: tops.edges)
        if !order.lazy.map(\.id).elementsEqual(plan.order.lazy.map(\.id)) {
            reorders.wrappedValue &+= 1
        }
    }

    private func card(_ session: Session) -> some View {
        // Its own agent's name, from the session: a section mixes agents, so
        // the card is the one thing that can say whose it is.
        SessionCardView(session: session, agentName: UsageInfo.displayName(for: session.source),
                        jumpFocus: $jumpFocus)
            .overlay {
                // A ring only where one is news: the card the bar just
                // brought into view. Neutral ink — a green ring on a card
                // that is not done would be a colour claiming a state.
                if jumped == session.id {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg + 4, style: .continuous)
                        .strokeBorder(Theme.textPrimary, lineWidth: 2)
                        .padding(-4)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    // MARK: - Jump

    /// What the bar does: brings the blocked card it names into view.
    ///
    /// The same action on every pass, so that the bar holding it compares
    /// equal (`NeedsYouSlot`) — and so it takes nothing from the pass that
    /// made it. The bar runs again only when something it draws changes, so
    /// the action it holds may be several events old, and a plan carried in
    /// it would be as old: the card it named gone, another blocked in its
    /// place, the count the same. It reads the board as last drawn instead.
    private var barAction: BoardAction<Void> {
        BoardAction(name: "needs-you") { _ in pressBar() }
    }

    /// Brings the card the bar names into view, rings it, and moves VoiceOver
    /// onto it; the bar then names the next blocked card (`BarPress`).
    ///
    /// This is the other half of "a card keeps its place". A card that
    /// becomes blocked is recoloured where it stands, which may be a screen
    /// down, so the bar is the way to it.
    private func pressBar() { barPress() }

    /// A press of the bar, holding the parts of this board it touches.
    private var barPress: BarPress {
        BarPress(drawn: drawn, landing: landing, jumped: $jumped, jumpStamp: $jumpStamp,
                 barAfter: $barAfter, jumpFocus: $jumpFocus)
    }

    /// What a press of the bar does, holding only what it reads and writes:
    /// the board as last drawn, weakly; where the List's rows are; and the
    /// four pieces of the board's state a press changes, as bindings.
    ///
    /// Never the board itself. Magic Tap's action is kept for the board's
    /// life in `DrawnBoard`, and a closure that called a method of the board
    /// held the board's value, and with it every piece of its state:
    /// `DrawnBoard` among them, which held the closure. Neither was ever
    /// freed. Each board that left the screen, when the demo ended or this
    /// device was disconnected, stayed in memory with everything its state
    /// held. The bar's own action presses through this too, so the two
    /// presses are one.
    private struct BarPress {
        weak var drawn: DrawnBoard?
        let landing: JumpLanding
        let jumped: Binding<String?>
        let jumpStamp: Binding<Int>
        let barAfter: Binding<String?>
        let jumpFocus: AccessibilityFocusState<JumpTarget?>.Binding

        /// Read from the board as last drawn, so a card dismissed or
        /// unblocked since is not the one brought.
        func callAsFunction() {
            guard let drawn, let plan = drawn.plan, let scroller = drawn.scroller,
                  let target = plan.needsYou?.target else { return }
            withAnimation(BoardView.jumpAnimation) {
                switch plan.arrangement {
                case .list:
                    // List rows answer to their session's own id.
                    scroller.scrollTo(target, anchor: BoardView.listAnchor)
                case .stacked:
                    // 8pt below what is pinned: the card's own lead (`cardStack`).
                    scroller.scrollTo(JumpTarget.card(target), anchor: .top)
                }
                jumped.wrappedValue = target
                jumpStamp.wrappedValue += 1
            }
            // Outside the animation: the bar's words change in place, and are
            // never cross-faded.
            barAfter.wrappedValue = target
            moveVoiceOver(to: .card(target), in: plan)
        }

        /// Moves VoiceOver to the card a press of the bar has just brought
        /// into view.
        ///
        /// The wide board's stacks are eager, so every card already has its
        /// element and the cursor is sent at once. The phone's List is lazy: a
        /// row more than about a screen away has not been made when the jump
        /// fires, and a request then has nothing to land on — and since the
        /// focus state would already hold the target, setting it again later
        /// would be no change at all. So unless the row is laid out, the
        /// target waits with `landing`, and the row takes the cursor when the
        /// scroll lays it out (`reportsLanding`).
        private func moveVoiceOver(to target: JumpTarget, in plan: BoardPlan) {
            if plan.arrangement == .list && !landing.isLaidOut(target) {
                landing.wait(for: target)
            } else {
                landing.stopWaiting()
                jumpFocus.wrappedValue = target
            }
        }
    }

    /// A jump's scroll: .snappy, drawn in one step under Reduce Motion as
    /// withMotion would be, and also while VoiceOver runs. VoiceOver is about
    /// to go to whatever the jump brings into view, and a row still sliding in
    /// at the edge of the screen when the cursor arrives is one it may scroll
    /// again on its own, to show it whole, against the scroll in flight. Drawn
    /// in one step, the card is already where the jump leaves it.
    private static var jumpAnimation: Animation? {
        UIAccessibility.isReduceMotionEnabled || UIAccessibility.isVoiceOverRunning ? nil : .snappy
    }

    /// A List row's part in a jump: it tells `landing` it exists while it is
    /// laid out, and takes VoiceOver when a jump has been waiting for it.
    private func reportsLanding<Row: View>(_ row: Row, as target: JumpTarget) -> some View {
        row
            .onAppear {
                guard landing.arrived(target) else { return }
                // A turn later: the row the List has just made is in the
                // window by then, where VoiceOver can find it.
                Task { @MainActor in jumpFocus = target }
            }
            .onDisappear { landing.left(target) }
    }

    /// Where a jumped-to row comes to rest in the List.
    ///
    /// The design wants it at the top, clear of its project's label stuck
    /// there. A List gives no way to say "48pt down": it does not honour a
    /// fractional anchor (0.1 moved the row to two fifths of the way down, in
    /// the simulator), and a row is the only thing in it that can be scrolled
    /// to.
    ///
    /// What it does do, on iOS 26, is treat its own pinned header as the top:
    /// `.top` brings the row to rest directly under the label, the card 6pt
    /// beneath it. That is the design's answer to within a few points, so
    /// where it has been seen to hold it is used.
    ///
    /// It has only been seen on 26. An older list that put the row at the
    /// very top would hide the card's name behind the label — the one outcome
    /// a jump must not have, since the name is what you jumped to read. So
    /// before 26 the row goes to the centre, which no version can put under
    /// anything. Every section has a label now, so there is no list without
    /// one to allow for.
    private static var listAnchor: UnitPoint {
        if #available(iOS 26.0, *) { return .top }
        return .center
    }

    /// The ring is an answer to a press, not a state: it goes after a couple
    /// of seconds, or sooner if the bar is pressed again.
    private func fadeRing() async {
        guard jumped != nil else { return }
        #if DEBUG
        // A frozen demo board is being photographed, and a ring that leaves
        // on a timer turns the capture into a race.
        if DemoData.isFrozen { return }
        #endif
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        withMotion { jumped = nil }
    }

    // MARK: - A block, aloud

    /// The blocked cards, and what the board was doing when they were read:
    /// what `announceBlocks` compares from one update to the next. One value,
    /// so that a connection's first snapshot, which brings its cards and
    /// `.live` in the same update, arrives as one change and is known for
    /// what it is.
    private struct BlockedCards: Equatable {
        let ids: [String]
        let connection: SessionStore.Connection
        /// No cards at all, blocked or not.
        let empty: Bool
    }

    private var blockedCards: BlockedCards {
        BlockedCards(ids: store.sessions.filter { $0.status == .blocked }.map(\.id),
                     connection: store.connection,
                     empty: store.sessions.isEmpty)
    }

    /// How long a session whose block has been said goes unsaid if it blocks
    /// again: the server's wait before it pushes the same session's block a
    /// second time (`DEFAULT_DEBOUNCE_MS`, src/push.ts).
    private static let blockRepeatWait: TimeInterval = 60

    /// How long a new block waits for others before it is said. Blocks that
    /// arrive together do not arrive in one update: two hook events posted at
    /// once reached the board 15 ms apart, as two. Said as they came, the
    /// second announcement would cut the first off mid-word, which a default
    /// priority does to whatever is being spoken. Half a second, and the bar's
    /// beat gathers for the same half second (`BarBeat.gathers`).
    private static let blockGathering: Duration = .seconds(BarBeat.gathers)

    /// The cards an update has just made blocked, and which of them are
    /// news: a session's transition into blocked on a board watching the
    /// stream. What the voice says (`announceBlocks`) and what makes the bar
    /// beat (`noteBeat`), worked out once for both.
    private struct NewBlocks {
        let fresh: [String]
        /// Why none of them is news, for the trace: "standing", for blocks
        /// that came with the connection, or "off the stream". Nil while the
        /// board is watching.
        let unheard: String?
        /// Standing too, though the stream is live: cards the board took in
        /// with no frame, one put back or one fetched (`StandingBlocks`).
        let taken: [String]

        var news: [String] { unheard == nil ? fresh.filter { !taken.contains($0) } : [] }
    }

    /// What an update of the blocked cards brings (`NewBlocks`); nil when it
    /// made no card blocked.
    private func newBlocks(from old: BlockedCards, to new: BlockedCards) -> NewBlocks? {
        let fresh = new.ids.filter { !old.ids.contains($0) }
        guard !fresh.isEmpty else { return nil }
        // Standing, not news: blocks that came with the connection, as a
        // first snapshot's do, or with a demo's seed — its first, or the one
        // an emptied demo board is given on its next tick.
        let standing = old.connection != new.connection || (new.connection == .demo && old.empty)
        guard !standing, new.connection == .live || new.connection == .demo else {
            return NewBlocks(fresh: fresh, unheard: standing ? "standing" : "off the stream", taken: [])
        }
        return NewBlocks(fresh: fresh, unheard: nil, taken: fresh.filter { store.standingBlocks.contains($0) })
    }

    /// Says aloud that a card has just become blocked — an agent waiting on
    /// you, the board's main event. A sighted reader sees the needs-you bar
    /// rise, or its count change. A reader with VoiceOver has only this,
    /// unless push is on and its banner says it (`AppDelegate`).
    ///
    /// Speech nobody asked for has to be earned, so this is kept as rare as
    /// the state it reports, the rarest on the board. Only a block that
    /// arrives while the board is watching is news. A connection's first
    /// snapshot (connecting or reconnecting to live) and the demo's seed
    /// bring blocks that were standing before the board looked, and those
    /// are drawn, not said — for the reason a snapshot clears the closing
    /// beats. Nor is anything a fetch brings in while the stream is down,
    /// nor, with the stream live, a block the board took in by itself with
    /// no frame: a card a refused dismissal put back, or a block a fetch
    /// brought in (`StandingBlocks`). A session that has been said is not
    /// said again for a minute, which is as often as the server would push
    /// it.
    ///
    /// A block is gathered, and said half a second later with any that came
    /// with it, as one sentence (`sayGatheredBlocks`), if it is still
    /// blocked by then. The sentence goes at the default priority: it
    /// interrupts what VoiceOver is reading, and the reader's next swipe
    /// interrupts it. Nothing is said while the app is not in front, while
    /// VoiceOver is off, or while push is on (`blockSilence`).
    ///
    /// What is news is worked out once, for the voice and the bar's beat
    /// alike (`newBlocks`); the minute and the silences are the voice's own.
    private func announceBlocks(_ blocks: NewBlocks, from old: BlockedCards, to new: BlockedCards) {
        let fresh = blocks.fresh
        if let unheard = blocks.unheard {
            traceBlocks("\(Self.change(old, new)) \(fresh) \(unheard), not said")
            return
        }
        let taken = blocks.taken
        let speech = blockSpeech
        let now = Date()
        speech.saidAt = speech.saidAt.filter { now.timeIntervalSince($0.value) < Self.blockRepeatWait }
        let held = fresh.filter { !taken.contains($0) && speech.saidAt[$0] != nil }
        let news = fresh.filter { !taken.contains($0) && !held.contains($0) && !speech.gathered.contains($0) }
        traceBlocks("\(Self.change(old, new)) " + [
            news.isEmpty ? nil : "\(news) gathered",
            held.isEmpty ? nil : "\(held) held, said within the minute",
            taken.isEmpty ? nil : "\(taken) standing, taken in with no frame, not said",
        ].compactMap { $0 }.joined(separator: "; "))
        guard !news.isEmpty else { return }
        speech.gathered += news
        guard speech.wait == nil else { return }
        speech.wait = Task {
            try? await Task.sleep(for: Self.blockGathering)
            sayGatheredBlocks()
        }
    }

    /// Says what `announceBlocks` gathered, as one sentence: the blocks still
    /// standing. One answered within the half second is no longer news.
    private func sayGatheredBlocks() {
        let speech = blockSpeech
        let gathered = speech.gathered
        speech.gathered = []
        speech.wait = nil
        let sessions = gathered.compactMap { id in store.sessions.first { $0.id == id && $0.status == .blocked } }
        guard let sentence = NeedsYou.announcement(for: sessions) else {
            traceBlocks("nothing said: \(gathered) no longer blocked")
            return
        }
        let silence = blockSilence
        traceBlocks("""
            \(silence.map { "not said, \($0):" } ?? "said") "\(sentence)" for \(sessions.map(\.id))\
            \(sessions.count == gathered.count ? "" : "; \(gathered.filter { id in !sessions.contains { $0.id == id } }) no longer blocked")
            """)
        guard silence == nil else { return }
        let now = Date()
        for session in sessions { speech.saidAt[session.id] = now }
        var line = AttributedString(sentence)
        line.accessibilitySpeechAnnouncementPriority = .default
        AccessibilityNotification.Announcement(line).post()
    }

    /// Why a block would go unsaid now, or nil when it can be said. Asked when
    /// the half second ends, so the app's being in front is read as it is
    /// then (`LivePhase`).
    private var blockSilence: String? {
        if !livePhase.active { return "the app is not active" }
        if !voiceOverIsRunning { return "VoiceOver is off" }
        // Its banner says it already. Not in the demo, whose blocks the
        // server never hears of.
        if notifications.state == .on && !store.isDemo { return "push is on" }
        return nil
    }

    /// Whether VoiceOver is running — or, in a debug build launched with
    /// AGSTATUS_ANNOUNCE_BLOCKS=1, taken to be, so that the simulator, where
    /// it never runs, takes the path that says a block aloud.
    private var voiceOverIsRunning: Bool {
        #if DEBUG
        if Self.announcesBlocksForTesting { return true }
        #endif
        return UIAccessibility.isVoiceOverRunning
    }

    #if DEBUG
    private static let announcesBlocksForTesting =
        ProcessInfo.processInfo.environment["AGSTATUS_ANNOUNCE_BLOCKS"] == "1"
    #endif

    /// A debug build's record of each newly blocked card and what became of
    /// it (`Logger.blocks`); nothing in a release build, where the line is
    /// never even built.
    private func traceBlocks(_ line: @autoclosure () -> String) {
        #if DEBUG
        let line = line()
        Logger.blocks.info("\(line, privacy: .public)")
        #endif
    }

    /// "board live: blocked [a] → [a, b]:", or "board reconnecting → live: …"
    /// when the connection changed in the same update, for the trace.
    private static func change(_ old: BlockedCards, _ new: BlockedCards) -> String {
        let board = old.connection == new.connection ? "\(new.connection)" : "\(old.connection) → \(new.connection)"
        return "board \(board): blocked \(old.ids) → \(new.ids):"
    }

    // MARK: - The bar's beat

    /// Hands the bar's beat an update of the blocked cards, with the news in
    /// it as the voice hears it (`BarBeat`), and waits out the half second
    /// when it starts one.
    ///
    /// Not the voice's silences: push on and VoiceOver off are no reason to
    /// keep the bar still. Its own are an app not in front, another screen or
    /// a sheet over the board, and Reduce Motion (`boardInFront`, `endBeat`).
    /// It runs only when the blocked cards change, and costs nothing to the
    /// hook events that do not change them.
    private func noteBeat(_ blocks: NewBlocks?, from old: BlockedCards, to new: BlockedCards) {
        let clock = beat
        let gathered = clock.rule.gathering?.ids ?? []
        guard clock.rule.note(old: old.ids, new: new.ids, news: blocks?.news ?? [], inFront: boardInFront,
                              at: Date()) else {
            let joined = (clock.rule.gathering?.ids ?? []).filter { !gathered.contains($0) }
            if !joined.isEmpty { traceBlocks("beat: \(joined) gathered with \(gathered)") }
            return
        }
        if let gathering = clock.rule.gathering {
            traceBlocks("beat: \(gathering.ids) gathered, the bar resting on \(gathering.rest)\(gathering.away ? ", away" : "")")
        }
        clock.wait = Task {
            try? await Task.sleep(for: Self.blockGathering)
            endBeat()
        }
    }

    /// The half second is over: the bar beats, or the trace says why not.
    private func endBeat() {
        let clock = beat
        clock.wait = nil
        let gathered = clock.rule.gathering?.ids ?? []
        let blocked = blockedCards.ids
        guard let verdict = clock.rule.end(blocked: blocked, inFront: boardInFront && store.connection != .boardGone,
                                           moves: !UIAccessibility.isReduceMotionEnabled, at: Date()) else { return }
        traceBlocks("beat: \(gathered), \(blocked.count) blocked: \(verdict)")
        if verdict == .beats { barBeats += 1 }
    }

    /// Whether the board is in front of the reader, where the bar's beat can
    /// be seen: the app active, and no other screen or sheet over the board.
    /// Read as it is now, whichever copy of the board asks: the end of a half
    /// second asks from the copy its task was started with (`LivePhase`).
    private var boardInFront: Bool {
        livePhase.active && path.isEmpty && !showSettings && !showPairSheet
    }

    // MARK: - Push tip

    /// One-time nudge: the board is live, the server can push, and the user
    /// hasn't opted in (or dismissed the tip) yet.
    private var showsPushTip: Bool {
        !pushTipShown
            && !store.isDemo
            && store.connection == .live
            && !store.sessions.isEmpty
            && notifications.state == .off
            && notifications.serverPushAvailable == true
            && store.board?.token != nil
    }

    private var pushTip: some View {
        Group {
            if typeSize.isAccessibilitySize {
                // The sentence first, whole, and the two controls under it.
                // Beside them it was squeezed to "Ge…" at AX5 on a 375pt
                // phone, and "Enable" stood there not saying what it enables.
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    pushTipText
                    HStack {
                        pushTipEnable
                        Spacer(minLength: 0)
                        pushTipClose
                    }
                }
            } else {
                HStack(spacing: 10) {
                    Image(systemName: "bell.badge")
                        .font(.subheadline)
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    pushTipText
                        .lineLimit(2)
                    Spacer(minLength: 4)
                    pushTipEnable
                    pushTipClose
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.card)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.cardBorder)
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var pushTipText: some View {
        Text("Get a ping when an agent needs you")
            .font(.footnote)
            .foregroundStyle(Theme.textPrimary)
    }

    /// 44pt to hit, laid out as the word: the reach is padding inside the
    /// label, where the button's hit shape includes it, cancelled by the same
    /// padding outside, so the tip's line is laid out around the word alone.
    /// Drawn as it was, it was 16pt tall.
    private var pushTipEnable: some View {
        Button {
            withMotion { pushTipShown = true }
            if let board = store.board {
                Task { await notifications.enable(for: board) }
            }
        } label: {
            Text("Enable")
                .padding(.vertical, 14)
                .padding(.horizontal, 5)
                .contentShape(Rectangle())
        }
        .font(.footnote.weight(.semibold))
        .buttonStyle(.borderless)
        .foregroundStyle(Theme.accent)
        .padding(.vertical, -14)
        .padding(.horizontal, -5)
    }

    /// The same reach, from a 21pt target to 44 by 44. Toward Enable it
    /// reaches 5pt, to meet Enable's own 5pt in the middle of the 10pt between
    /// them; the rest goes the other way, over the tip's 14pt inset and 4pt
    /// into the gutter beyond it, where there is nothing else to hit.
    private var pushTipClose: some View {
        Button {
            withMotion { pushTipShown = true }
        } label: {
            Image(systemName: "xmark")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Theme.textSecondary)
                .padding(4)
                .padding(.vertical, 12)
                .padding(.leading, 5)
                .padding(.trailing, 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -12)
        .padding(.leading, -5)
        .padding(.trailing, -18)
        .accessibilityLabel("Dismiss notification tip")
    }

    // MARK: - Empty state

    /// No sessions on the board — in one of two quite different situations.
    ///
    /// Which one is whether any agent has a head (`hasAgents`, in
    /// `emptyMessage`), which with no sessions means it reports plan limits. Limits on the board prove it is
    /// paired and that an agent has reported, so "No agents yet" and a
    /// prominent "Pair your computer" under two named heads with live bars
    /// contradicted the screen they were on. It is a common state, too: the
    /// morning after the evening's sessions have expired. There the board
    /// says only that nothing is running. Pairing a further computer stays in
    /// the toolbar, and the webhook in Settings, where they always were.
    ///
    /// A board with no heads at all keeps the first-run copy and the button.
    ///
    /// On a phone held sideways the moon and the 64pt above it go. Where the
    /// idle heads stay pinned there — a sideways board wide enough for two
    /// columns — they leave this a strip, about 150pt on a 6.9" phone: the
    /// moon filled it, and the sentence that says nothing is running sat
    /// below the fold. Without them the title comes first, and the rest
    /// scrolls. On a narrower sideways board (under 718pt: an SE, a mini, an
    /// iPhone 15 or 16), on a wide one past four limit windows a head, and at
    /// an accessibility size, the heads scroll in here instead (`idleHeads`),
    /// and the sentence follows them.
    private func emptyState(_ plan: BoardPlan) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                idleHeads(plan)
                emptyMessage(hasAgents: !plan.heads.isEmpty,
                             compact: verticalSizeClass == .compact,
                             underHeads: plan.idleHeadsScroll && !plan.heads.isEmpty)
            }
        }
        .refreshable { await store.refresh() }
    }

    /// `compact` is the sideways strip, where even the title steps down;
    /// `underHeads`, heads scrolling above it. Either way the moon and the
    /// 64pt above it go.
    private func emptyMessage(hasAgents: Bool, compact: Bool, underHeads: Bool) -> some View {
        let plain = compact || underHeads
        return VStack(spacing: compact ? Theme.Space.xs : Theme.Space.md) {
                if !plain {
                    Image(systemName: "moon.zzz.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(Theme.textSecondary)
                        .accessibilityHidden(true)
                }
                if hasAgents {
                    Text("Nothing running")
                        .font(.system(compact ? .headline : .title2, design: .rounded).weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("Sessions appear here when an agent starts.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                } else {
                    firstRun
                }
        }
        .padding(.horizontal, Theme.Space.lg)
        .padding(.vertical, compact ? Theme.Space.sm : Theme.Space.lg)
        .padding(.top, plain ? 0 : 64)
        .frame(maxWidth: .infinity)
    }

    /// An idle board's heads where they cannot be pinned (`idleHeadsScroll`):
    /// at the top of what scrolls, each the whole width, as the list's own
    /// scrolling heads are, so a name has its line to itself. With nothing
    /// running nothing is blocked, so there is no bar.
    @ViewBuilder
    private func idleHeads(_ plan: BoardPlan) -> some View {
        if plan.idleHeadsScroll && !plan.heads.isEmpty {
            leadingHeads(plan)
                .padding(.horizontal, Theme.Space.md)
                .padding(.top, BoardArrangement.headsTop)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A board nothing has reported to: how to get something onto it.
    @ViewBuilder
    private var firstRun: some View {
        Text("No agents yet")
            .font(.system(.title2, design: .rounded).weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
        Text("Pair your computer and your coding agents will show up here the moment they report in.")
            .font(.subheadline)
            .foregroundStyle(Theme.textSecondary)
            .multilineTextAlignment(.center)

        if store.board?.token != nil {
            Button {
                showPairSheet = true
            } label: {
                Label("Pair your computer", systemImage: "laptopcomputer.and.arrow.down")
                    .font(.headline)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accentFill)
            .padding(.top, 4)
        }

        if let board = store.board {
            VStack(spacing: 8) {
                Text("Or send updates straight to the webhook:")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                webhookRow(board.webhookURL)
            }
            .padding(.top, 16)
        }
    }

    private func webhookRow(_ url: URL) -> some View {
        Button {
            UIPasteboard.general.string = url.absoluteString
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // The tick that stands in for the glyph for 1.5 s is the only
            // other sign, and VoiceOver cannot see it.
            AccessibilityNotification.Announcement("Webhook URL copied").post()
            withMotion { copiedWebhook = true }
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                withMotion { copiedWebhook = false }
            }
        } label: {
            HStack(spacing: 8) {
                Text(url.absoluteString)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                // A word as well as the glyph: the URL is what gets copied,
                // not a name for the control, and Voice Control needs a
                // visible word to say (WCAG 2.5.3). Spelled out beside the
                // icon rather than as a Label, which a tight row can reduce
                // to its icon alone (FocusControl).
                HStack(spacing: Theme.Space.xxs) {
                    Image(systemName: copiedWebhook ? "checkmark" : "doc.on.doc")
                    Text(copiedWebhook ? "Copied" : "Copy")
                }
                .font(.footnote)
                .foregroundStyle(copiedWebhook ? Theme.color(for: .done) : Theme.textSecondary)
                .fixedSize()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            // A control: 44pt at the least, where the one line made it 35.
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.cardBorder)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy webhook URL")
        .accessibilityInputLabels(["Copy webhook URL", "Copy", "Webhook"])
    }

    // MARK: - Connecting

    /// While the board reconnects with nothing running. The store keeps the
    /// limits through a reconnect, so the heads are here too: pinned above, or
    /// at the top of this where pinned ones would not fit (`idleHeads`). The
    /// 160pt that set the spinner down an empty screen drops to 24 under heads
    /// that scroll in here and on a phone held sideways, where it pushed the
    /// spinner off the screen; under pinned heads in portrait it stays 160.
    private func connectingState(_ plan: BoardPlan) -> some View {
        let short = verticalSizeClass == .compact || (plan.idleHeadsScroll && !plan.heads.isEmpty)
        return ScrollView {
            VStack(spacing: 0) {
                idleHeads(plan)
                VStack(spacing: 14) {
                    ProgressView()
                        .controlSize(.large)
                        .tint(Theme.textSecondary)
                    Text("Connecting to your board…")
                        .font(.system(.headline, design: .rounded))
                        .foregroundStyle(Theme.textSecondary)
                    Text("Pull down to retry.")
                        .font(.caption)
                        // The line's token, 5.88:1. Secondary at 70% was a
                        // grey of its own, darker than the lowest text token.
                        .foregroundStyle(Theme.textTertiary)
                }
                .padding(.top, short ? Theme.Space.lg : 160)
                .frame(maxWidth: .infinity)
            }
        }
        .refreshable { await store.refresh() }
    }

    // MARK: - Board gone

    /// Scrolls only where it does not fit — AX4 on an SE, AX5 on most
    /// phones, the larger sizes on a phone held sideways. It is the whole
    /// screen in this state, and unscrollable its explanation was cut to
    /// whatever fitted. Where it fits it is the page it always was.
    private var boardGoneView: some View {
        ViewThatFits(in: .vertical) {
            boardGoneContent
            ScrollView { boardGoneContent.frame(maxWidth: .infinity) }
        }
    }

    private var boardGoneContent: some View {
        VStack(spacing: 16) {
            Image(systemName: "questionmark.folder")
                .font(.system(size: 44))
                .foregroundStyle(Theme.color(for: .blocked))
                .accessibilityHidden(true)
            Text("This board no longer exists")
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("It was probably deleted. Your device is fine — just set up a new one.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                store.disconnectBoard()
            } label: {
                Text("Start over")
                    .font(.headline)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accentFill)
            .padding(.top, 4)
        }
        .padding(32)
    }

    // MARK: - Toolbar bits

    /// The state the lamp shows: the store's, unless a debug launch asked for
    /// another (`connectionForScreenshots`).
    private var lampState: SessionStore.Connection {
        #if DEBUG
        if let state = Self.connectionForScreenshots { return state }
        #endif
        return store.connection
    }

    /// Whether a debug launch put the lamp where demo mode shows its badge.
    private var lampForScreenshots: Bool {
        #if DEBUG
        return Self.connectionForScreenshots != nil
        #else
        return false
        #endif
    }

    #if DEBUG
    /// AGSTATUS_DEMO_CONNECTION=live|connecting|idle|gone shows the
    /// connection lamp, in that state, where demo mode shows its badge —
    /// `connecting` drawn and spoken as reconnecting, which looks the same. The
    /// lamp is otherwise only drawn on a paired board, which simctl cannot
    /// make, so its four shapes could not be captured.
    private static let connectionForScreenshots: SessionStore.Connection? = {
        switch ProcessInfo.processInfo.environment["AGSTATUS_DEMO_CONNECTION"] {
        case "live": .live
        case "connecting": .reconnecting
        case "idle": .idle
        case "gone": .boardGone
        default: nil
        }
    }()
    #endif

    /// Where the live connection stands, told by shape as well as colour, as
    /// a panel lamp is: lit while live, a ring while it connects or
    /// reconnects, a broken ring when nothing is connected, a cross for a
    /// board that is gone.
    ///
    /// It used to be one dot in four colours. Live green and reconnecting
    /// teal are close, and with cards on screen a dropped connection changed
    /// nothing else — state carried by hue alone, on the one board read from
    /// the corner of an eye. It also glowed, the only lit thing on a board
    /// where nothing glows.
    private var connectionDot: some View {
        let size = min(lampMetric, 15)
        let k = size / 9
        return Group {
            switch lampState {
            case .live:
                Circle().fill(dotColor)
            case .connecting, .reconnecting:
                Circle().strokeBorder(dotColor, lineWidth: 2 * k)
            case .boardGone:
                Image(systemName: "xmark")
                    .font(.system(size: size, weight: .heavy))
                    .foregroundStyle(dotColor)
            case .idle, .demo:
                Circle().strokeBorder(dotColor, style: StrokeStyle(lineWidth: 1.5 * k, dash: [2 * k, 2 * k]))
            }
        }
        .frame(width: size, height: size)
        // One element: what it is, then where it stands. A bare
        // "Reconnecting" named nothing. Not .updatesFrequently, which only
        // has VoiceOver poll the element its cursor is on: a dropped
        // connection matters while the cursor is somewhere else, so the
        // board says it aloud instead (`announceConnection`).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Board connection")
        .accessibilityValue(dotDescription)
        // At the accessibility sizes a long press shows the lamp large, with
        // its word, as the system's own bar buttons are shown: a 15pt ring
        // against a 15pt disc is still a small difference to read.
        .accessibilityShowsLargeContentViewer {
            Label(dotDescription, systemImage: lampSymbol)
        }
    }

    /// The lamp's shape as a symbol, for the large content viewer.
    private var lampSymbol: String {
        switch lampState {
        case .live: "circle.fill"
        case .connecting, .reconnecting: "circle"
        case .boardGone: "xmark"
        case .idle, .demo: "circle.dashed"
        }
    }

    private var dotColor: Color {
        switch lampState {
        case .live:
            Theme.color(for: .done)
        case .connecting, .reconnecting:
            Theme.color(for: .testing)
        case .boardGone:
            Theme.color(for: .blocked)
        case .idle, .demo:
            Theme.color(for: .idle)
        }
    }

    private var dotDescription: String {
        switch lampState {
        case .live: "Connected"
        case .connecting: "Connecting"
        case .reconnecting: "Reconnecting"
        case .boardGone: "Board not found"
        case .idle: "Not connected"
        case .demo: "Demo"
        }
    }

    /// Says a lasting change of connection aloud, for a reader whose cursor
    /// is on the cards. The lamp is the only other place it shows, and the
    /// cards go on drawing a board that has stopped updating.
    ///
    /// A drop is said once it has lasted five seconds: a stream drops and
    /// comes back within a breath often enough that saying each one would
    /// make the board chatter. So is a reconnect that fails on coming back to
    /// the foreground with cards still on screen — they are the cards from
    /// before, and they read as live. A cold launch with no cards says
    /// nothing; its screen already says it is connecting. A return is said
    /// only if the drop was, even across a stay in the background, so the
    /// last thing said about a board is never that it is lost when it is not.
    /// The app's own reconnect on coming to the foreground — idle, connecting,
    /// live — says nothing, and nor does going to the background. A board
    /// that is gone is said at once: it does not come back.
    private func announceConnection(from old: SessionStore.Connection, to new: SessionStore.Connection) {
        switch (old, new) {
        case (_, .reconnecting):
            let wasLive = old == .live
            dropWait?.cancel()
            dropWait = Task {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, store.connection == .reconnecting,
                      wasLive || !store.sessions.isEmpty else { return }
                announcedDrop = true
                AccessibilityNotification.Announcement(
                    wasLive ? "Board connection lost. Reconnecting." : "Can't reach the board. Retrying."
                ).post()
            }
        case (_, .live):
            dropWait?.cancel()
            if announcedDrop {
                announcedDrop = false
                AccessibilityNotification.Announcement("Board reconnected.").post()
            }
        case (_, .boardGone):
            dropWait?.cancel()
            announcedDrop = false
            AccessibilityNotification.Announcement("This board no longer exists.").post()
        default:
            // To the background, or a first connect: nothing to say, and a
            // drop not yet said never will be.
            dropWait?.cancel()
        }
    }

    /// Says where you are, quietly.
    ///
    /// It used to be drawn in `coding` blue while the control beside it took
    /// the accent green — two different colours in one toolbar, neither of them
    /// meaning anything. It is a label, not a state and not an action, so it
    /// takes text colours: the chrome should say what it is without competing
    /// with the cards, which are the only things on this screen carrying colour
    /// that means something.
    private var demoBadge: some View {
        Text("DEMO")
            .font(.caption2.weight(.bold))
            .kerning(1)
            .fixedSize()
            .foregroundStyle(Theme.textTertiary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(Capsule().strokeBorder(Theme.cardBorder))
            .accessibilityLabel("Demo mode")
    }
}

#if DEBUG
/// What VoiceOver is offered on screen, written to the log: each element's
/// label, value, traits, hint, Voice Control names and More Content, inside
/// the containers that name them, with its frame. VoiceOver does not run in
/// the Simulator, so this is how a debug build shows the headings, the "Plan
/// limits" container, a card's label and the bar's. Where a jump sent the
/// focus it cannot show: with no assistive technology running, an
/// accessibility focus state keeps nothing.
///
/// SwiftUI builds the tree only for an app that accessibility has been
/// switched on for: `xcrun simctl spawn <udid> defaults write
/// com.apple.Accessibility ApplicationAccessibilityEnabled -bool true` once
/// per simulator. Read it with `xcrun simctl spawn <udid> log stream --level
/// info --predicate 'subsystem == "com.kardanov.agstatus" AND category ==
/// "ax"'`.
enum AccessibilityDump {
    @MainActor
    static func log(focused: String?) {
        let windows = UIApplication.shared.connectedScenes.flatMap { ($0 as? UIWindowScene)?.windows ?? [] }
        var lines = ["focus target: \(focused ?? "none"), \(windows.count) window(s)"]
        for window in windows { walk(window, depth: 0, into: &lines) }
        for line in lines { Logger.ax.info("\(line, privacy: .public)") }
    }

    private static func walk(_ object: Any, depth: Int, into lines: inout [String]) {
        guard let node = object as? NSObject, depth < 40 else { return }
        if let view = node as? UIView, view.isHidden || view.alpha == 0 { return }
        let indent = String(repeating: "  ", count: depth)
        if node.isAccessibilityElement {
            var parts = [node.accessibilityLabel ?? "(no label)"]
            if let value = node.accessibilityValue, !value.isEmpty { parts.append("value: \(value)") }
            let traits = node.accessibilityTraits
            if traits.contains(.header) { parts.append("[heading]") }
            if traits.contains(.button) { parts.append("[button]") }
            if let hint = node.accessibilityHint, !hint.isEmpty { parts.append("hint: \(hint)") }
            if let input = node.accessibilityUserInputLabels, !input.isEmpty {
                parts.append("voice control: \(input.joined(separator: " / "))")
            }
            if node.responds(to: NSSelectorFromString("accessibilityCustomContent")),
               let content = node.value(forKey: "accessibilityCustomContent") as? [AXCustomContent] {
                let more = content.map { "\($0.label): \($0.value)" }
                if !more.isEmpty { parts.append("more: \(more.joined(separator: "; "))") }
            }
            let frame = node.accessibilityFrame
            parts.append("@\(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height))")
            lines.append(indent + parts.joined(separator: " | "))
            return
        }
        var next = depth
        if let label = node.accessibilityLabel, !label.isEmpty {
            lines.append(indent + "<\(label)>")
            next += 1
        }
        for child in children(of: node) { walk(child, depth: next, into: &lines) }
    }

    /// A container's elements, in the order it gives them.
    private static func children(of node: NSObject) -> [Any] {
        let named = node.accessibilityElements ?? []
        guard named.isEmpty else { return named }
        let count = node.accessibilityElementCount()
        if count != NSNotFound && count > 0 {
            return (0..<count).compactMap { node.accessibilityElement(at: $0) }
        }
        // Plain views are read in reading order, top to bottom and then
        // leading to trailing, which is what VoiceOver does with views that
        // name no order of their own: the List's rows and headers among them.
        return (node as? UIView)?.subviews.sorted { a, b in
            let fa = a.accessibilityFrame, fb = b.accessibilityFrame
            return fa.minY != fb.minY ? fa.minY < fb.minY : fa.minX < fb.minX
        } ?? []
    }

    /// What VoiceOver's Magic Tap does with its cursor on the first element
    /// whose label holds `words`, written to the log a step at a time.
    ///
    /// UIKit offers the tap to the element under the cursor, then to each
    /// container above it, until one says it has handled it; one that nothing
    /// on the board takes is the system's, which pauses whatever is playing.
    /// VoiceOver does not run in the Simulator, so this walk — by each
    /// element's `accessibilityContainer`, and a view's superview where it
    /// names none — is how a debug build shows which part of the board
    /// answers, and that a tap goes on past it while nothing is blocked.
    @MainActor
    static func magicTap(from words: String) {
        let windows = UIApplication.shared.connectedScenes.flatMap { ($0 as? UIWindowScene)?.windows ?? [] }
        guard let start = windows.lazy.compactMap({ first(labelled: words, under: $0, depth: 0) }).first else {
            Logger.ax.info("magic tap: no element's label holds \(words, privacy: .public)")
            return
        }
        var node: NSObject? = start
        var steps = 0
        while let current = node, steps < 80 {
            let handled = current.accessibilityPerformMagicTap()
            let label = current.accessibilityLabel.map { " \"\($0)\"" } ?? ""
            Logger.ax.info("magic tap: \(String(describing: type(of: current)), privacy: .public)\(label, privacy: .public): \(handled ? "handled" : "passed on", privacy: .public)")
            if handled { return }
            node = container(of: current)
            steps += 1
        }
        Logger.ax.info("magic tap: nothing on the board handled it; the system's own action would run")
    }

    private static func first(labelled words: String, under object: Any, depth: Int) -> NSObject? {
        guard let node = object as? NSObject, depth < 40 else { return nil }
        if let view = node as? UIView, view.isHidden || view.alpha == 0 { return nil }
        if node.isAccessibilityElement {
            return node.accessibilityLabel?.contains(words) == true ? node : nil
        }
        for child in children(of: node) {
            if let found = first(labelled: words, under: child, depth: depth + 1) { return found }
        }
        return nil
    }

    private static func container(of node: NSObject) -> NSObject? {
        if node.responds(to: NSSelectorFromString("accessibilityContainer")),
           let container = node.value(forKey: "accessibilityContainer") as? NSObject {
            return container
        }
        return (node as? UIView)?.superview
    }
}

extension Logger {
    /// The accessibility tree, written by `AccessibilityDump`.
    static let ax = Logger(subsystem: Bundle.main.bundleIdentifier ?? "AgStatus", category: "ax")

    /// Blocks said aloud, or why not (`BoardView.announceBlocks`), beside the
    /// demo's own record of each card its tick blocked — so a run can show
    /// every new block said once, and once only. Debug builds only. At the
    /// info level, which a stream shows without any `log config`:
    /// `xcrun simctl spawn booted log stream --level info --predicate
    /// 'subsystem == "com.kardanov.agstatus" AND category == "blocks"'`.
    static let blocks = Logger(subsystem: Bundle.main.bundleIdentifier ?? "AgStatus", category: "blocks")
}
#endif

/// The toolbar's leading item: the DEMO badge, or the connection lamp.
///
/// Both are labels, not controls, so on iOS 26 the item gives up the glass
/// capsule the toolbar draws behind each item. Under the glass the badge was
/// a capsule inside a capsule, two outlines round one word, and a status
/// light in a glass bubble reads as a button to press. Before 26 there is no
/// glass, and nothing to give up.
private struct BoardStatusItem<Content: View>: ToolbarContent {
    @ViewBuilder let content: Content

    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarLeading) { content }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { content }
        }
    }
}

// MARK: - Head rows

/// The heads in rows of `perRow`, every one a fixed track wide: wherever heads
/// are drawn — pinned two across on a phone, as strips on a wide board, at the
/// top of what scrolls when they cannot be pinned, and on an idle board.
///
/// `level` draws a row as one band: each head stretches to the tallest in
/// its row. Where the heads are not level, a short last row — one head
/// under a pair — is given the full width, so a third agent on an idle
/// phone board is a line of its own and not half of an empty row. (With
/// sessions running, a phone never pins a third head: `headsScroll`.)
///
/// One container for VoiceOver, "Plan limits": the heads are where the
/// limits are, and no longer the headings of the board, which are its
/// projects (`ProjectLabel`).
///
/// A view of its own, made with `.equatable()`, rather than rows drawn in the
/// board's body. Drawn there, the rows were drawn again on every pass, and
/// every head in them was laid out again with them although none had run:
/// each meter's reset cascade measured anew, some 190 asks a hook event for a
/// phone's two heads (counted in a macOS harness built from this source).
/// Equal, the rows and their heads are left as they were. Equal on every
/// input, as a head is (`AgentHead`'s `==`).
///
/// It costs something once a minute. On the board clock's tick every head
/// runs anyway, for its countdowns, and in the same harness the phone's two
/// heads took about 1.5 ms longer to tick as a view of their own than drawn
/// inline (9.1 against 7.6 ms; on an iPad about 0.5 ms). Why is not known:
/// the same heads, meters and cascade asks ran either way. It is small beside
/// the 4 to 5 ms every hook event saves.
private struct HeadRows: View, Equatable {
    let heads: [AgentSummary]
    let perRow: Int
    /// The board's width, which a head alone on a row that is not level has.
    let width: CGFloat
    let level: Bool
    let canStrip: Bool
    let showsNoLimits: Bool
    let scale: CGFloat
    /// Whether a head alone on a row that is not level takes the fuller line
    /// by fit (`AgentHead.alone`).
    let alone: Bool
    let now: Date

    var body: some View {
        let gap = BoardArrangement.headGap
        let track = BoardArrangement.track(width: width, count: perRow, gap: gap)
        VStack(alignment: .leading, spacing: gap) {
            ForEach(heads.rows(of: perRow), id: \.first?.id) { row in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(row) { head in
                        AgentHead(group: head,
                                  width: !level && row.count == 1 ? width : track,
                                  canStrip: canStrip,
                                  showsNoLimits: showsNoLimits,
                                  fillsHeight: level,
                                  scale: scale,
                                  alone: alone && !level && row.count == 1,
                                  now: now)
                            .equatable()
                    }
                }
                // Lets the row settle on its tallest head's height, which is
                // what `fillsHeight` then stretches the others to.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan limits")
    }
}

// MARK: - Layout plan

/// One pass of layout: the width the board was measured at, and everything
/// that follows from it. Made fresh on every render and never stored — see
/// `BoardView.plan(for:)`.
private struct BoardPlan {
    /// The board's width inside its 16pt gutters. Every other width on the
    /// board is arithmetic from this one.
    let width: CGFloat
    /// The Dynamic Type factor: 1 at the default text size.
    let scale: CGFloat
    /// The agents that get a head.
    let heads: [AgentSummary]
    /// The projects, in the shared order.
    let sections: [ProjectSection]
    let arrangement: BoardArrangement
    /// Whether two columns fit the width. An idle board asks it to choose
    /// between two heads across and three, and the bar whether to try one
    /// line. It is the width's answer and not the arrangement's: a phone
    /// held sideways keeps its sessions in a list, but its idle heads take
    /// the one row its width allows, which is the row a short screen wants.
    let wide: Bool
    /// No sessions: the heads are the limits and nothing else.
    let idle: Bool
    /// An accessibility text size.
    let largeText: Bool
    /// A phone held sideways: the list, whatever the width.
    let compactHeight: Bool
    let sides: CardSides
    /// Every card's subagent rows, resolved for this pass's slot count.
    let subtasks: SubtaskSlots
    /// Every card as a reader meets it (`ReadingOrder`): what the bar walks.
    let order: [Session]
    /// What the bar says and the card it brings; nil while nothing is blocked.
    let needsYou: NeedsYou?

    /// Whether the heads lead the scroll instead of being pinned. Never on an
    /// idle board, whose heads are all there is: where its pinned heads would
    /// not fit, they scroll inside the empty state instead
    /// (`idleHeadsScroll`).
    var headsScroll: Bool {
        !idle && BoardArrangement.headsScroll(arrangement, agents: heads.count,
                                              windows: heads.mostWindows,
                                              largeText: largeText, compactHeight: compactHeight)
    }

    /// An idle board whose pinned heads would not fit: its heads leave the
    /// pinned area and open the empty state instead, each the whole width,
    /// scrolling with it.
    ///
    /// At an accessibility text size, the one place a phone still pinned
    /// narrow heads: two across they cut a name to its first letters, and
    /// with every limit in each the row outgrew a small phone's board —
    /// three windows at AX4 on an SE, six from AX2 — where nothing could
    /// scroll it back into view.
    ///
    /// And on a phone held sideways that is too narrow for two columns — a
    /// board under 718pt: an SE, a mini, an iPhone 15 or 16 — where the heads
    /// go two across in their narrow form, 54pt a window: on an SE's board of
    /// about 261pt between the navigation bar and the streak, four windows
    /// already ran past its bottom edge. Wider sideways boards, 718pt and up —
    /// an iPhone 12 to 14 or 16e, a 6.3" phone and larger — lay two heads
    /// across in one row of their regular form, which fits up to four windows
    /// a head. Past four it does not on the shortest of them: with six the row
    /// is 252pt, which left the empty state 6pt on a 402pt-tall phone and
    /// nothing on a 390pt one; with five, 29pt on the 390pt phones, under the
    /// height of its first line, and 41pt on the 402pt ones, which held it.
    /// The count cannot tell those apart, so past four the heads scroll on
    /// both, as past `narrowPinnedWindows` a phone's pinned heads do, and on
    /// a 402pt phone with five the sentence is then a scroll away.
    var idleHeadsScroll: Bool {
        idle && (largeText || (compactHeight
            && (!wide || heads.mostWindows > BoardArrangement.narrowPinnedWindows)))
    }

    /// One side of a section's cards.
    var side: CGFloat { BoardArrangement.track(width: width, count: 2, gap: BoardArrangement.cardGap) }

    /// Whether each card is a whole column wide at the reader's text size. At
    /// an accessibility size that decides whether a card keeps its rail
    /// beside its text (SessionCardView's `stacked`).
    var cardsColumnWide: Bool {
        BoardArrangement.cardIsColumnWide(arrangement, width: width,
                                          minColumn: BoardArrangement.minColumn * scale)
    }

    /// The board's shape. A change of it is drawn, not animated — see
    /// `settles(on:)`.
    var shape: Shape {
        Shape(arrangement: arrangement, idle: idle, headsScroll: headsScroll || idleHeadsScroll,
              agents: heads.map(\.source))
    }

    struct Shape: Hashable {
        let arrangement: BoardArrangement
        let idle: Bool
        /// Pinned heads, or heads leading the scroll. A phone turned on its
        /// side keeps its list, but its heads go from pinned to the list's
        /// first row. On an idle board, pinned heads or heads scrolling in
        /// the empty state (`idleHeadsScroll`), which a fifth limit window
        /// can swap: animated, the outgoing row slid up under the toolbar and
        /// "Nothing running" slid down through the incoming heads.
        let headsScroll: Bool
        /// Which agents are on the board. One arriving or leaving changes
        /// every head's width where they stand two across, and the pinned
        /// area's height.
        let agents: [String]
    }
}

/// The plan the board was last drawn from, and the scroll view it was drawn
/// in: what a press of the needs-you bar acts on.
///
/// Not the plan of the pass that handed out the action. The bar runs again
/// only when something it draws changes, so the action it holds can be
/// several events old, and the cards that pass's plan named may have moved,
/// gone or been joined since (`BoardView.barAction`). Every pass writes this
/// before anything it draws can be pressed.
///
/// A class held in @State and deliberately not observable, as `JumpLanding`
/// is: the board writes it on every pass, and none of that is anything to
/// redraw. Main thread only; it is written by the board's body and read by
/// view actions.
private final class DrawnBoard {
    var plan: BoardPlan?
    var scroller: ScrollViewProxy?
    /// What the board's Magic Tap does, made on the first pass and kept
    /// (`BoardView.reachingBar`). Like the bar's own action, it presses the
    /// bar from whatever board is drawn when it runs. It holds the press and
    /// not the board, which holds this (`BoardView.BarPress`).
    var magicTap: (() -> Void)?
}

/// Where each card on the stacked board was last drawn: its top edge in its
/// section (`DrawnTop`), which the board's reading order follows
/// (`ReadingOrder.make`).
///
/// A class held in @State and deliberately not observable, as `DrawnBoard`
/// is: layout writes it as it places cards (`DrawnSide`), and an edge that
/// moves is nothing to redraw unless it changes the order cards are read in,
/// which the board counts apart (`BoardView.cardsMoved`). A hook event that
/// moves no card — a message, a token figure — changes nothing here. Main
/// thread only.
private final class CardTops {
    private(set) var edges: [String: DrawnTop] = [:]
    /// What the board does when edges have moved (`BoardView.cardsMoved`),
    /// made on its first pass and kept, as the bar's Magic Tap is. Handed
    /// these edges when it runs, it holds neither them nor the board.
    var moved: ((CardTops) -> Void)?
    private var settling = false

    /// Keeps where a side has placed a card. True when that is somewhere
    /// new.
    func place(_ id: String, _ top: DrawnTop) -> Bool {
        guard edges[id] != top else { return false }
        edges[id] = top
        return true
    }

    /// Tells the board that edges have moved, once layout is over: layout
    /// may not change what the board observes. Every side that moved in one
    /// pass is told about once.
    func settle() {
        guard !settling else { return }
        settling = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.settling = false
            self.moved?(self)
        }
    }

    /// Forgets the cards that have left, once there are more of them than
    /// cards on the board: a day of sessions coming and going would
    /// otherwise keep every edge it ever drew.
    func forget(allBut board: [Session]) {
        guard edges.count > 2 * board.count + 8 else { return }
        let ids = Set(board.map(\.id))
        edges = edges.filter { ids.contains($0.key) }
    }
}

/// One side of a stacked section: its cards one under another, `spacing`
/// apart, laid out as a VStack of that spacing lays them out — each offered
/// the side's width and given its own height, centred across it — that also
/// keeps where it put each one (`CardTops`): its top edge, measured from the
/// top of the side, which a scroll never moves. A section's two sides are
/// top-aligned, so their edges compare.
///
/// A layout rather than a VStack because it already knows every card's place:
/// keeping it costs a comparison a card each time the side is laid out, and
/// nothing on a hook event that moves no card. A geometry reader on every
/// card, tried first, cost the 13-inch iPad's busy board about a million
/// instructions an event that moved nothing.
private struct DrawnSide: Layout {
    let spacing: CGFloat
    let section: ProjectKey
    /// The cards' ids, in the order of the subviews.
    let ids: [String]
    let tops: CardTops

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let offer = ProposedViewSize(width: proposal.width, height: nil)
        var size = CGSize.zero
        for (index, subview) in subviews.enumerated() {
            let card = subview.sizeThatFits(offer)
            size.width = max(size.width, card.width)
            size.height += card.height + (index == 0 ? 0 : spacing)
        }
        return size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let offer = ProposedViewSize(width: proposal.width ?? bounds.width, height: nil)
        var y = bounds.minY
        var moved = false
        for (index, subview) in subviews.enumerated() {
            let card = subview.sizeThatFits(offer)
            subview.place(at: CGPoint(x: bounds.midX, y: y), anchor: .top,
                          proposal: ProposedViewSize(width: offer.width, height: card.height))
            if index < ids.count, tops.place(ids[index], DrawnTop(section: section, y: y - bounds.minY)) {
                moved = true
            }
            y += card.height + spacing
        }
        if moved { tops.settle() }
    }
}

/// Which of the phone's List rows are laid out, and the one a jump is waiting
/// for.
///
/// A List makes a row only as it scrolls into view, so a card two screens
/// down has no accessibility element when the bar is pressed. The jump
/// leaves its target here; the row, laid out by the scroll, finds itself
/// named and takes the cursor (`BoardView.reportsLanding`). A row already
/// laid out takes it at once, which is what the set is for: a row already on
/// screen gets no onAppear to hand over in.
///
/// A class held in @State, and deliberately not observable: rows write to it
/// whenever they scroll in or out, and none of that is anything to redraw.
/// Main thread only; every caller is a view action.
///
/// Counted rather than a set: when the list swaps one arrangement of its rows
/// for another, the same card can be laid out twice for a moment, and SwiftUI
/// promises no order between the new row's appearing and the old one's
/// going. A set would drop a card that is on screen if the old row left
/// last; a count does not care.
private final class JumpLanding {
    private var laidOut: [JumpTarget: Int] = [:]
    private var waiting: (target: JumpTarget, until: Date)?

    func isLaidOut(_ target: JumpTarget) -> Bool { (laidOut[target] ?? 0) > 0 }

    /// Two seconds to arrive, the ring's two seconds. After that, a row that
    /// appears because the reader scrolled there is not taken for the jump's.
    func wait(for target: JumpTarget) {
        waiting = (target, Date().addingTimeInterval(2))
    }

    func stopWaiting() { waiting = nil }

    /// A row has been laid out. True when it is the one a jump is waiting for.
    func arrived(_ target: JumpTarget) -> Bool {
        laidOut[target, default: 0] += 1
        guard let waiting, waiting.target == target else { return false }
        self.waiting = nil
        return Date() < waiting.until
    }

    func left(_ target: JumpTarget) {
        guard let count = laidOut[target] else { return }
        laidOut[target] = count > 1 ? count - 1 : nil
    }
}

/// When each session's block was last said aloud, and the blocks gathered for
/// the next sentence (`BoardView.announceBlocks`).
///
/// A class held in @State and deliberately not observable, as `JumpLanding`
/// is: it changes with every new block, and none of that is anything to
/// redraw. Main thread only; every caller is a view's change handler or the
/// task one of them started.
private final class BlockSpeech {
    var saidAt: [String: Date] = [:]
    var gathered: [String] = []
    /// The half second the gathered blocks wait before they are said.
    var wait: Task<Void, Never>?
}

/// The needs-you bar's beat (`BarBeat`), and the half second it is waiting
/// out (`BoardView.noteBeat`).
///
/// Held in @State and not observable, as `BlockSpeech` is: it changes with
/// every new block, and none of that is anything to redraw. What is drawn is
/// the count of beats, which changes only on a beat. Main thread only.
private final class BeatClock {
    var rule = BarBeat()
    var wait: Task<Void, Never>?
}

/// Whether the board's scene is in front of the reader, as it is now: what
/// the voice (`BoardView.blockSilence`) and the bar's beat
/// (`BoardView.boardInFront`) read when their half second ends.
///
/// Not the board's own `scenePhase`. A half second is waited out by a task,
/// and the task holds the copy of the board it was started from, whose
/// @Environment values are the ones from when that copy was made, where its
/// @State is read live. So a block that landed with the board in front, with
/// the reader gone within half a second, was said, and made the bar beat,
/// while the app was inactive. The board keeps `scene` current as its phase
/// changes. The app runs as one scene, with no second window of it to be in
/// front instead. UIKit's own state is asked as well, since it can change
/// before the scene's new phase reaches the board.
///
/// Held in @State and not observable, as `BlockSpeech` is: nothing is drawn
/// from it. On the main actor, where UIKit's state is read.
@MainActor
private final class LivePhase {
    var scene: ScenePhase = .active

    /// The scene active, and the app with it.
    var active: Bool {
        scene == .active && UIApplication.shared.applicationState == .active
    }
}

private extension View {
    /// Applies a change of `shape` at once, whatever animation it arrived in.
    ///
    /// When the board changes shape — an agent arrives and two columns become
    /// three, the last card of one is dismissed, the device is rotated — every
    /// card is re-cut to a new width in the same update that some other card
    /// arrived or left in, and that update is animated. Left alone, each card
    /// would cross-fade from its old line breaks to its new ones while sliding
    /// to its new track: the whole board drawn twice, overlapping, for a third
    /// of a second. Motion here means one card has news. A re-flow is not one
    /// card's news, so it is simply drawn.
    func settles(on shape: BoardPlan.Shape) -> some View {
        transaction(value: shape) { $0.animation = nil }
    }
}

// MARK: - Needs-you bar

/// Where the needs-you bar comes and goes: nothing while no session is
/// blocked, the bar while one is.
///
/// It enters from the bottom edge when the first block lands and leaves when
/// none remain, with .snappy, drawn its own height below its place at the far
/// end and never above it (`Lowered`). Those are its only transitions: under
/// Reduce Motion it appears and goes in place (`motion`), and its words
/// change in place. The animation is the slot's own, never the board's: a
/// card turning blocked in the same update must not cross-fade its word into
/// the new one. Its one other motion is its beat (`beats`), which is drawn,
/// never a transition.
///
/// A view of its own, made with `.equatable()`, and handed only what the bar
/// draws: a hook event that changes none of it — a message, a token figure,
/// another card's state — does not run it (`HeadRows` says why the container
/// has to be a view of its own).
///
/// Nor does such an event lay its insides out again, which takes the fixed
/// height as well. The board's stack is laid out again whenever a card in
/// the phone's list changes height, and asks each of its children for its
/// size at several heights to learn how far it gives; every one was a new
/// question to the bar, and its cascades answered it afresh, some 18 size
/// asks and 8 placements a hook event, counted in the running app on a 6.9"
/// simulator. Held to its own height, the bar is asked one way and answers
/// from what it measured: none. The pinned heads' rows are held the same
/// way, which is why they never showed it.
private struct NeedsYouSlot: View, Equatable {
    let face: NeedsYou.Face?
    let lines: NeedsYouBar.Lines
    /// How many times the bar has beaten (`BarBeat`). It changes on a beat
    /// and at no other time, so it costs a hook event nothing.
    let beats: Int
    let onPress: BoardAction<Void>

    var body: some View {
        VStack(spacing: 0) {
            if let face {
                NeedsYouBar(face: face, lines: lines, beats: beats, onPress: onPress)
                    .fixedSize(horizontal: false, vertical: true)
                    // From behind the streak, which is drawn after it.
                    .transition(.modifier(active: Lowered(share: 1), identity: Lowered(share: 0)))
            }
        }
        .motion(.snappy, value: face != nil)
    }
}

/// The bar drawn `share` of its own height below its place, and never above
/// it: how it arrives, beats and leaves (`NeedsYouSlot`, `NeedsYouStyle`).
/// Drawn only, as an offset that layout never sees.
///
/// Never above, because there SwiftUI stops drawing the ground under the
/// home indicator. A background reaches into the safe area only while the
/// view, as drawn, still meets the safe area's edge to within half a device
/// pixel: moved up by more than that, by an offset, a visual effect or a
/// transform alike, the 34pt under a phone's home indicator (20pt on an
/// iPad) is not drawn at all and shows the page, though layout still puts
/// the bar where it was and reports the same inset (0.18pt up on a 6.9"
/// simulator, 0.26pt on a 13" iPad; 0.15 and 0.24 drew it). The bar is the
/// last thing on a board with no streak, so the ground it draws there is
/// the strip's. .snappy overshoots by 0.63% of a move: 0.35pt above its
/// place for the phone's 56pt bar, more than half a pixel for about 190 ms
/// from 410 ms into a beat, and 0.28pt for the iPad's 44pt bar, for about
/// 70 ms. So every beat blinked the strip, 10 to 12 frames on the phone and
/// 1 to 4 on the iPad, and every arrival for a frame on the phone. Held at
/// its place instead, the bar runs .snappy's own curve until it gets there,
/// and leaves out only the overshoot, about a device pixel.
private struct Lowered: ViewModifier, Animatable {
    var share: CGFloat

    var animatableData: CGFloat {
        get { share }
        set { share = newValue }
    }

    func body(content: Content) -> some View {
        let below = max(0, share)
        return content.visualEffect { bar, place in bar.offset(y: below * place.size.height) }
    }
}

/// The board's one alarm: how many sessions are blocked, which one, in which
/// project, and the way to it. "(!) 2 BLOCKED · Fix the login redirect · in
/// acme-api · Show".
///
/// One button, the whole bar, at least 44pt tall. It is never hue alone: the
/// blocked card's solid mark and its word lead it, the bar stands where
/// nothing else on the board does, and it is there only while somebody is
/// waiting on you. It wears the blocked card's own surface and, along its top,
/// the blocked card's edge — no colour that is not already the board's.
///
/// One line where that fits, on a board two columns wide; on a phone, two,
/// the alarm over the session. On one line, when room runs out, the word
/// BLOCKED goes first, the mark and the count staying, then the project,
/// then the name is cut at its end — or, on a board two columns wide, the
/// bar takes its second line instead. On two lines each line gives way on
/// its own: the session line drops the project, then cuts the name at its
/// end, and the alarm line drops BLOCKED only when that line itself lacks
/// room, since dropping it there gives the session line nothing. The web
/// and Android give way the same way.
///
/// When the count rises while it shows, it comes in from the bottom edge
/// again, once, with the new count already in it (`BarBeat`,
/// `NeedsYouStyle`).
private struct NeedsYouBar: View {
    /// How many lines the bar may take (`BoardView.board`).
    enum Lines: Equatable {
        /// A phone upright: the alarm over the session.
        case two
        /// A board two columns wide: one line where it fits, else two.
        case oneOrTwo
        /// A phone held sideways, short of height before it is short of
        /// width: one line, the name cut rather than a second line taken. At
        /// AX5 on an SE a second line left the board some 60pt.
        case one
    }

    let face: NeedsYou.Face
    let lines: Lines
    /// How many times the bar has beaten (`NeedsYouSlot`).
    let beats: Int
    let onPress: BoardAction<Void>

    var body: some View {
        Button {
            onPress(())
        } label: {
            Group {
                switch lines {
                case .two:
                    twoLines
                case .oneOrTwo:
                    ViewThatFits(in: .horizontal) {
                        oneLine(word: true, place: true)
                        oneLine(word: false, place: true)
                        oneLine(word: false, place: false)
                        twoLines
                    }
                case .one:
                    ViewThatFits(in: .horizontal) {
                        oneLine(word: true, place: true)
                        oneLine(word: false, place: true)
                        oneLine(word: false, place: false)
                        // The last step: the name cut at its end.
                        oneLine(word: false, place: false, whole: false)
                    }
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.xs)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(NeedsYouStyle(beats: beats))
        // "2 blocked: Fix the login redirect, in acme-api", and what a press
        // does. Not .updatesFrequently: a new block is said aloud on its own
        // (`BoardView.announceBlocks`).
        .accessibilityLabel(face.spoken)
        .accessibilityHint("Shows that session")
        // Voice Control: "Show blocked", or "Tap Blocked". The label is a
        // sentence whose count and name move while it is being said. And the
        // verb the bar shows, so that "Tap Show", or "Tap Next" once it has
        // been pressed, reaches it: its name holds the word a reader sees on
        // it (WCAG 2.5.3), as the web's does.
        .accessibilityInputLabels(["Show blocked", "Blocked", verbWord])
        // The words change in place, never cross-faded into the next ones.
        .transaction(value: face) { $0.animation = nil }
    }

    /// The bar on one line: the alarm, the session, the verb at the end.
    /// `whole` holds the session to its full width, which is what lets a
    /// candidate be measured; the last one gives it up and is cut.
    private func oneLine(word: Bool, place: Bool, whole: Bool = true) -> some View {
        endingInVerb(spacing: Theme.Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.sm) {
                alarm(word: word)
                session(place: place)
                    .fixedSize(horizontal: whole, vertical: false)
            }
        }
    }

    /// The bar on two lines: the alarm and the verb, and under them the
    /// session. Each line gives way on its own.
    private var twoLines: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            ViewThatFits(in: .horizontal) {
                alarmLine(word: true)
                alarmLine(word: false)
            }
            ViewThatFits(in: .horizontal) {
                session(place: true)
                    .fixedSize()
                // The name alone, cut at its end where even that is too long.
                session(place: false)
            }
        }
    }

    private func alarmLine(word: Bool) -> some View {
        endingInVerb(spacing: Theme.Space.xs) {
            alarm(word: word)
        }
    }

    /// A line of the bar: `content` at the start, the verb at the far end,
    /// `spacing` apart, and between them a gap of at least 8pt — laid out to
    /// the point as `content`, a `Spacer(minLength: 8)` and the verb were in
    /// an HStack of that spacing, wherever the line is wide enough and
    /// wherever it is not. A cascade measures the same width for it.
    ///
    /// Without that Spacer, because with it the bar made every hook event
    /// cost the whole board's layout. The alarm's fixed token — the mark
    /// beside its count — in a line with a Spacer and the verb had the board's
    /// root stack ask every child for its size again on every update: about
    /// 12 asks and 4 placements an event for the pinned heads, the bar and
    /// the streak each, though none of them had changed, and the root reader
    /// placing the whole board again (a 6.9" simulator, 40 message events:
    /// some 39 million more instructions on the main thread an event than
    /// with the bar hidden, half as many again). Any one piece taken away
    /// ended it: the Spacer, the verb, the token's .fixedSize(), its count,
    /// or the mark. The mark had to stay, so the Spacer went; a flexible frame
    /// holding the gap costs nothing. Why SwiftUI did this is not known.
    private func endingInVerb<Content: View>(spacing: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: spacing) {
            content()
                // The Spacer's least length, and the spacing that stood
                // before it.
                .padding(.trailing, Theme.Space.xs + spacing)
                .frame(maxWidth: .infinity, alignment: .leading)
            verb
        }
    }

    /// The mark, the count and the word, in the blocked ink: the blocked
    /// card's own badge, counted. A fixed token: "2 BLOC…" reads as a bug.
    private func alarm(word: Bool) -> some View {
        HStack(spacing: Theme.Space.xxs) {
            Image(systemName: Theme.symbol(for: .blocked))
            Text("\(face.count)")
                .monospacedDigit()
            if word {
                Text(AgentStatus.blocked.label.uppercased())
            }
        }
        .font(.footnote.weight(.semibold))
        .kerning(0.5)
        .foregroundStyle(Theme.color(for: .blocked))
        .lineLimit(1)
        .fixedSize()
    }

    /// The session in the primary ink, and where it is in the secondary.
    private func session(place: Bool) -> some View {
        var line = Text(face.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
        if place, let location = face.place {
            line = line + Text(" · \(location)")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
        return line
            .lineLimit(1)
            .truncationMode(.tail)
    }

    /// What a press does: brings the card it names, or after a press the
    /// next blocked one.
    private var verbWord: String { face.next ? "Next" : "Show" }

    /// The verb as drawn: a word, in the secondary ink, at the far end.
    private var verb: some View {
        Text(verbWord)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.textSecondary)
            .lineLimit(1)
            .fixedSize()
    }
}

/// The bar's ground: the blocked card's surface, and its edge along the top,
/// over the board. Under the finger the words dim and nothing else changes:
/// the bar is already the loudest thing on the board, and a pressed state
/// that added a surface would make it louder at the one moment it has been
/// heard.
///
/// And its beat (`BarBeat`): each time `beats` goes up, the ground, the edge
/// and the words are drawn their own height below where they stand and come
/// back with the bar's .snappy, as its arrival first brought them in, and
/// never above their place (`Lowered`). Drawn only, as an offset that layout
/// never sees: the bar's place, the board's frame, the scroll position and
/// VoiceOver's cursor stay where they are, and a press lands on the bar's
/// place throughout. Once for each beat, never on appearing, and nothing
/// moves under Reduce Motion, where no beat is called for in the first
/// place.
private struct NeedsYouStyle: ButtonStyle {
    let beats: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let travel = reduceMotion ? 0.0 : 1.0
        return configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .background(Theme.cardSurface(for: .blocked))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Theme.cardEdge(for: .blocked))
                    .frame(height: 1)
            }
            .keyframeAnimator(initialValue: 0.0, trigger: beats) { bar, below in
                // `below` is the share of its own height it is drawn below
                // its place.
                bar.modifier(Lowered(share: below))
            } keyframes: { _ in
                MoveKeyframe(travel)
                SpringKeyframe(0.0, spring: .snappy)
            }
            .contentShape(Rectangle())
    }
}

// MARK: - Streak

/// The streak, pinned under the board.
///
/// One row, and deliberately the quietest thing on screen: it reports, it does
/// not ask. The cards are the only things here allowed to demand attention, and
/// a streak that competed with a `blocked` card would be exactly backwards —
/// this is ambient context, that is somebody waiting on you.
///
/// The metals are the only colour on this board that does not mean a state, so
/// they are fenced to this row and never touch a card. The rank is also carried
/// by a pip count, because roughly one man in twelve cannot separate five
/// metals by hue and the board's second design principle says state is never
/// carried by colour alone — a rank is no different.
///
/// Not interactive. The obvious destination would be the usage screen, but that
/// screen is per-agent and a streak spans all of them, so a tap would have to
/// pick one arbitrarily. A row that goes somewhere half-chosen is worse than a
/// row that stays put.
private struct StreakBar: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let streak: Streak

    /// How far along the current rung, 0–1. Measured between the tier reached
    /// and the next one rather than from zero, so the bar fills at a readable
    /// rate instead of crawling for a month between Gold and Platinum.
    private var progress: Double {
        guard let next = streak.next else { return 1 }
        let floor = streak.tier?.days ?? 0
        let span = Double(next.days - floor)
        guard span > 0 else { return 1 }
        return min(1, max(0, Double(streak.days - floor) / span))
    }

    private var metal: Color {
        switch streak.tier {
        case .wood: Theme.tierWood
        case .bronze: Theme.tierBronze
        case .silver: Theme.tierSilver
        case .gold: Theme.tierGold
        case .platinum: Theme.tierPlatinum
        case nil: Theme.textSecondary
        }
    }

    /// The rank as a count, not only as a colour.
    private var pips: Int { streak.tier?.pips ?? 0 }

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: streak.tier == nil ? "circle.dotted" : "star.fill")
                .font(.system(size: 13))
                .foregroundStyle(metal)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                    if let tier = streak.tier {
                        Text(tier.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(metal)
                            .lineLimit(1)
                            .fixedSize()
                        // Countable, not decorative. As 10x3 capsules these
                        // read as a dashed rule — a shape that looks like data
                        // and carries none. Dots at 5pt with real gaps can
                        // actually be counted at a glance, which is the whole
                        // job: the rank must survive without hue, because
                        // roughly one man in twelve cannot separate the metals.
                        //
                        // Not at an accessibility size. There they sat on the
                        // baseline after a 49pt "Silver" and read as an
                        // ellipsis, as though the name had been cut, and they
                        // took the width the day count needed. The name is
                        // the rank in words, which needs no hue either.
                        if !typeSize.isAccessibilitySize {
                            HStack(spacing: Theme.Space.xxs) {
                                ForEach(0..<StreakTier.allCases.count, id: \.self) { index in
                                    Circle()
                                        .fill(index < pips ? metal : Color.clear)
                                        .overlay(
                                            Circle().strokeBorder(
                                                index < pips ? Color.clear : Theme.cardBorder,
                                                lineWidth: 1
                                            )
                                        )
                                        .frame(width: 5, height: 5)
                                }
                            }
                            .accessibilityHidden(true)
                        }
                    }
                    // Whole words or the short form, never "19 day" over "s".
                    // VoiceOver reads the bar's own label, not these.
                    ViewThatFits(in: .horizontal) {
                        Text("\(streak.days) day\(streak.days == 1 ? "" : "s") active")
                            .fixedSize()
                        Text("\(streak.days)d")
                            .fixedSize()
                    }
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.textTertiary)
                    // Offered the width before the forecast. Both can fall
                    // back to something smaller, so without this the row
                    // halves the room between them, and "19 days active" went
                    // to "19d" beside a forecast it had room for. The day
                    // count is the fact; the forecast is the one to go first.
                    .layoutPriority(1)

                    Spacer(minLength: Theme.Space.xs)

                    // Drops out whole rather than truncating. At large Dynamic
                    // Type "16d to Platinum" beside a tier name and a day count
                    // overruns 390pt, and a clipped "16d to Plat…" is worse
                    // than no forecast at all.
                    if let next = streak.next, let togo = streak.daysToNext, togo > 0 {
                        ViewThatFits(in: .horizontal) {
                            Text("\(togo)d to \(next.name)")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(Theme.textTertiary)
                                .fixedSize()
                            // Not EmptyView, which ViewThatFits does not count:
                            // with it the forecast never dropped out, and at
                            // accessibility sizes the tier broke a few letters
                            // to a line beside it.
                            FitsAsNothing()
                        }
                    }
                }

                // A track, and only while there is somewhere to go. At the top
                // rung `progress` is 1, and a full-width bar under a dark board
                // is the brightest thing on screen — an ambient counter
                // out-shouting a card that needs a human, which is backwards.
                // Nothing left to reach means nothing to draw.
                //
                // The fill is neutral rather than the metal for the same
                // reason: this is a position, not an achievement to celebrate.
                if streak.next != nil {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.raised)
                            Capsule()
                                .fill(Theme.textTertiary)
                                .frame(width: max(2, geo.size.width * progress))
                        }
                    }
                    .frame(height: 2)
                }
            }
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.top, Theme.Space.xs)
        .padding(.bottom, Theme.Space.xxs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card)
        .overlay(alignment: .top) {
            Rectangle().fill(Theme.cardBorder).frame(height: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    /// Spelled out, because the pips and the metal say nothing to a screen
    /// reader and "Silver, 14, 16" would be a riddle.
    private var accessibilityText: String {
        let run = "\(streak.days) day\(streak.days == 1 ? "" : "s") active"
        guard let tier = streak.tier else {
            if let next = streak.next, let togo = streak.daysToNext {
                return "\(run). \(togo) more to reach \(next.name)."
            }
            return run
        }
        guard let next = streak.next, let togo = streak.daysToNext, togo > 0 else {
            return "\(tier.name) tier. \(run). Top of the ladder."
        }
        return "\(tier.name) tier. \(run). \(togo) more to reach \(next.name)."
    }
}

// MARK: - List chrome

/// A list section with none of the system's own space around it.
///
/// A plain list stands every section header 22pt clear of whatever is above
/// it — measured in the simulator, and written down nowhere. That is 22pt of
/// nothing between the heads and the first project's name, and again before
/// every later one, on a board where 12pt is the gap between two cards. The
/// label already carries the space it wants, so the system's is taken out.
///
/// Two ways, because the direct one is new. iOS 26 can zero a section's
/// margins and does exactly that: checked on 26.5, where the first label then
/// sits flush under the heads and the rest 6pt under the card before them.
/// Before 26 the nearest thing is the section spacing, which on 26.5 closes
/// the gap between sections and leaves the first header's alone. Nothing older
/// than 26 was available to run this on, so on iOS 17 and 18 expect the first
/// project's name to stand up to 22pt lower than drawn, and no worse.
private struct FlushSection: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.listSectionMargins(.vertical, 0)
        } else {
            content.listSectionSpacing(0)
        }
    }
}

/// Keeps a pinned project label opaque while it hands over to the next one.
///
/// iOS 26 fades a pinned section header out as the following header pushes it
/// off, and the fade takes the header's own background with it. For the length
/// of that hand-over the last card of the outgoing section showed straight
/// through its name — "Claude 3" printed over "8m ago · 1.4M", two lines of
/// text on one, and exactly where the bar's jump leaves the list when it
/// bottoms out. The hard edge style puts the system's own opaque band behind
/// whatever is pinned at the top, so the name may dim as it leaves but nothing
/// is read through it. Every section has a label now, so the list always
/// has one to pin.
///
/// Checked on 26.5, the only runtime here. Before 26 a plain list's pinned
/// headers are pushed off without fading, so the label's own ground is enough
/// and there is nothing to switch on.
private struct OpaquePinnedLabels: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            content
        }
    }
}
