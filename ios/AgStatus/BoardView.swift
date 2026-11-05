import SwiftUI
import UIKit

/// The live board: one glanceable card per agent session, in one section per
/// agent.
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
    /// board is rotated or an agent arrives, and a card's side has to outlive
    /// the swap.
    @State private var sides = CardSides()
    /// The card an alarm last brought into view, for as long as its ring shows.
    @State private var jumped: String?
    /// Counts the jumps. The ring's two seconds run from the LAST press, and a
    /// second press on the same alarm leaves `jumped` holding an equal id,
    /// which would restart nothing.
    @State private var jumpStamp = 0
    /// Where VoiceOver goes after a jump: the card an alarm brought into view,
    /// or the head a name on the agent line did. A scroll that left the cursor
    /// on the alarm or the name would have moved nothing for that reader. One
    /// state for both, keyed as the scroll targets are, so a card and an agent
    /// cannot be taken for each other. Never read in a body: VoiceOver writes
    /// it on every swipe across a card or a head.
    @AccessibilityFocusState private var jumpFocus: JumpTarget?
    /// Which of the phone's List rows exist, and the one a jump is waiting
    /// for (`JumpLanding`).
    @State private var landing = JumpLanding()
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

    /// The narrowest a column may be, growing with the reader's text size.
    ///
    /// Scaled so that large text steps the board DOWN an arrangement — an iPad
    /// drops from columns to the stack, then to the list — instead of holding
    /// its columns and cutting every name in them. At the default size it is
    /// exactly `BoardArrangement.minColumn`, and the head's thresholds scale
    /// by the same factor (`BoardPlan.scale`).
    @ScaledMetric(relativeTo: .title3) private var minColumn = BoardArrangement.minColumn

    /// At an accessibility size a phone pins the agent line, not its heads:
    /// `BoardArrangement.headsScroll`.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Compact on a phone held sideways, and only there: it keeps the list,
    /// with the agent line pinned. The one size class the board reads, and it
    /// is never asked about width (`BoardArrangement`).
    @Environment(\.verticalSizeClass) private var verticalSizeClass

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
                // One reader for whichever container is live, so an alarm
                // does not need to know whether it is scrolling a List or a
                // ScrollView.
                ScrollViewReader { scroller in
                    board(plan(for: geo.size.width), scroller: scroller)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            // Both destinations live at the root, on a view that is always
            // there. The session one used to hang off the List — but the List
            // is now one of three containers that replace each other when the
            // board is rotated or an agent arrives, and a destination declared
            // on a container that has just been swapped out is gone from under
            // the screen it pushed.
            //
            // Two value types, so the two cannot collide: a session id is a
            // String, an agent's usage is a UsageDetailRoute.
            .navigationDestination(for: UsageDetailRoute.self) { route in
                UsageDetailView(source: route.source)
            }
            .navigationDestination(for: String.self) { sessionId in
                SessionHistoryView(sessionId: sessionId)
            }
            // Actions, not bare closures, so that one hook event runs only its
            // own card, not every card under the board (`BoardAction`). The
            // heads still run again: each is handed a rebuilt AgentGroup on
            // every pass.
            .environment(\.openSession, BoardAction(name: "history") { path.append($0) })
            .environment(\.openUsage, BoardAction(name: "usage") { path.append(UsageDetailRoute(source: $0)) })
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
            .onChange(of: store.connection) { old, new in announceConnection(from: old, to: new) }
            // The body draws from `sides.resolved(for:)`, and this stores the
            // same answer — so the first frame a card appears in already has
            // it on its side, and every later frame finds it there.
            .onChange(of: store.sessions.map(\.id), initial: true) {
                sides = sides.resolved(for: groups)
            }
            // A different board is different cards. Starting again is also
            // what stops the ledger growing without end across a day of
            // switching boards.
            .onChange(of: store.board) {
                sides = CardSides().resolved(for: groups)
                // A different board's first connect is not a reconnection.
                announcedDrop = false
                dropWait?.cancel()
            }
            .onChange(of: store.isDemo) { sides = CardSides().resolved(for: groups) }
            // The ring says "this is the blocked card you asked for". Once the
            // card is no longer blocked it would be saying something untrue.
            .onChange(of: store.sessions.filter { $0.status == .blocked }.map(\.id)) { _, blocked in
                if let jumped, !blocked.contains(jumped) { self.jumped = nil }
            }
            .task(id: jumpStamp) { await fadeRing() }
        }
    }

    /// The board itself: what is pinned, what scrolls, and the streak beneath.
    private func board(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        VStack(spacing: 0) {
            if !plan.groups.isEmpty && store.connection != .boardGone && !plan.idleHeadsScroll {
                pinned(plan, scroller: scroller)
                    .transition(.move(edge: .top).combined(with: .opacity))
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
                    sessionBoard(plan, scroller: scroller)
                        // Whether each card has a column at this text size:
                        // the board has measured it, and a card cannot without
                        // a reader that would decide a frame late.
                        .environment(\.cardIsColumnWide, plan.cardsColumnWide)
                }
            }

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
        }
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
        .motion(.snappy, value: plan.groups.map { $0.windows.map(\.id) })
        .motion(.snappy, value: store.streak)
        #if DEBUG
        .frame(maxWidth: Self.widthForScreenshots.map { $0 + 2 * Theme.Space.md })
        #endif
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await jumpForScreenshots(plan, scroller: scroller) }
    }

    /// Debug-only deep links so screenshot automation can reach the pushed
    /// screens, which have no launch argument and cannot be tapped by simctl.
    /// AGSTATUS_OPEN_HISTORY=1 opens the first session's timeline;
    /// AGSTATUS_OPEN_USAGE=<source> opens that agent's usage history.
    private func openHistoryForScreenshots() async {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
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
        guard environment["AGSTATUS_OPEN_HISTORY"] == "1" else { return }
        // Demo sessions are seeded synchronously; a real board arrives over SSE.
        for _ in 0..<40 {
            if !store.sessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if let first = store.sessions.first, path.isEmpty {
            path.append(first.id)
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

    /// AGSTATUS_JUMP=<source> presses that agent's alarm once the board has
    /// been laid out, because simctl cannot tap and the jump is the one piece
    /// of this layout that only exists after a touch.
    private func jumpForScreenshots(_ plan: BoardPlan, scroller: ScrollViewProxy) async {
        #if DEBUG
        guard let source = ProcessInfo.processInfo.environment["AGSTATUS_JUMP"],
              !source.isEmpty else { return }
        // Demo sessions are seeded synchronously, so the plan this task was
        // started with already holds them; the wait is for the scroll view to
        // have a first layout to scroll.
        try? await Task.sleep(for: .milliseconds(600))
        jump(to: source, in: plan, scroller: scroller)
        #endif
    }

    // MARK: - Plan

    /// The agents on the board, each with its sessions and its limits.
    private var groups: [AgentGroup] {
        AgentGroup.make(sessions: store.sessions, usage: store.usage)
    }

    /// Everything one pass of layout decides, from the width it was given.
    private func plan(for outerWidth: CGFloat) -> BoardPlan {
        var width = max(0, outerWidth - 2 * Theme.Space.md)
        #if DEBUG
        if let clamp = Self.widthForScreenshots { width = min(width, clamp) }
        #endif
        let groups = groups
        let compactHeight = verticalSizeClass == .compact
        return BoardPlan(
            width: width,
            scale: minColumn / BoardArrangement.minColumn,
            groups: groups,
            arrangement: BoardArrangement.resolve(width: width, agents: groups.count, minColumn: minColumn,
                                                  compactHeight: compactHeight),
            wide: BoardArrangement.fit(width: width, minColumn: minColumn) >= 2,
            idle: store.sessions.isEmpty,
            largeText: typeSize.isAccessibilitySize,
            compactHeight: compactHeight,
            sides: sides.resolved(for: groups)
        )
    }

    // MARK: - Pinned

    /// What stays above the scroll view: the agents' heads, where the limit
    /// bars already sat. The list scrolls beneath, so what is pinned never
    /// leaves the screen — and with it, every agent's alarm.
    @ViewBuilder
    private func pinned(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        if plan.idle {
            // Nothing running. The heads are the limits again and nothing
            // more: side by side as the limit blocks were, up to three across
            // where there is room and two where there is not.
            headRows(plan, perRow: plan.wide ? min(plan.groups.count, 3) : 2,
                     gap: BoardArrangement.headGap, level: plan.wide, scroller: scroller)
                .padding(.horizontal, Theme.Space.md)
                .padding(.top, 10)
                .padding(.bottom, 2)
        } else if plan.headsScroll {
            // More agents than this board pins heads for: on a wide board more
            // than fit, on a phone more than two — or, on a phone held
            // sideways, at an accessibility text size, or with a fifth limit
            // window in a head, any at all. Their heads scroll with their
            // sections; this one line is what stays.
            agentLine(plan, scroller: scroller)
        } else {
            switch plan.arrangement {
            case .narrow:
                // Two across, each keeping its own height; the only agent
                // takes the whole row. A third agent no longer gets a row of
                // its own here — see `BoardArrangement.narrowPinnedHeads` —
                // and no head here holds more than four limit windows:
                // `narrowPinnedWindows`.
                headRows(plan, perRow: 2, gap: BoardArrangement.headGap, level: false, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .columns:
                // The same tracks as the columns beneath, from the same
                // arithmetic and inside the same gutters, so a head cannot
                // stand anywhere but over its own cards.
                headRows(plan, perRow: plan.groups.count, gap: BoardArrangement.agentGutter,
                         level: true, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .stackedOne:
                // One agent: there is nothing to put beside it, so its head
                // runs the full width, still pinned, as its limits were when
                // they were only bars.
                headRows(plan, perRow: 1, gap: 0, level: false, canStrip: true, scroller: scroller)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
            case .stackedMany:
                // Always `headsScroll`, and drawn above. The case is here
                // for the switch to be exhaustive, and draws the same line.
                agentLine(plan, scroller: scroller)
            }
        }
    }

    /// One pinned line for every agent: its name, which takes you to its
    /// section, and its alarm, which takes you to its first blocked card.
    private func agentLine(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        AgentLine(groups: plan.groups,
                  width: plan.width,
                  scale: plan.scale,
                  onSection: { source in
                      withAnimation(jumpAnimation) {
                          scroller.scrollTo(JumpTarget.section(source), anchor: .top)
                      }
                      // "Codex, show its sessions" moves the reader as well as
                      // the board: to the head, which names the section.
                      moveVoiceOver(to: .section(source), in: plan)
                  },
                  onJump: { jump(to: $0, in: plan, scroller: scroller) })
            .padding(.horizontal, Theme.Space.md)
    }

    /// The heads in rows of `perRow`, every one a fixed track wide.
    ///
    /// `level` draws a row as one band: each head stretches to the tallest in
    /// its row. Where the heads are not level, a short last row — one head
    /// under a pair — is given the full width, so a third agent on an idle
    /// phone board is a line of its own and not half of an empty row. (With
    /// sessions running, a phone never pins a third head: `headsScroll`.)
    private func headRows(_ plan: BoardPlan, perRow: Int, gap: CGFloat, level: Bool,
                          canStrip: Bool = false, scroller: ScrollViewProxy) -> some View {
        let track = BoardArrangement.track(width: plan.width, count: perRow, gap: gap)
        return VStack(alignment: .leading, spacing: BoardArrangement.headGap) {
            ForEach(plan.groups.rows(of: perRow), id: \.first?.source) { row in
                HStack(alignment: .top, spacing: gap) {
                    ForEach(row) { group in
                        AgentHead(group: group,
                                  width: !level && row.count == 1 ? plan.width : track,
                                  canStrip: canStrip,
                                  showsNoLimits: plan.arrangement != .narrow,
                                  fillsHeight: level,
                                  scale: plan.scale,
                                  alone: !level && row.count == 1,
                                  peers: row.filter { $0.blocked > 0 && $0.id != group.id },
                                  now: now,
                                  jumpFocus: $jumpFocus,
                                  onJump: { jump(to: group.source, in: plan, scroller: scroller) })
                    }
                }
                // Lets the row settle on its tallest head's height, which is
                // what `fillsHeight` then stretches the others to.
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Sessions

    /// The cards, in whichever container the width calls for.
    ///
    /// Three containers, and they replace each other outright. A change of
    /// arrangement is never cross-faded: two boards drawn over one another for
    /// a third of a second is the overlapping-text defect `scrollChrome`
    /// already describes, at the size of the whole screen. The same holds
    /// inside the list when its agents change — see `groupedList`.
    @ViewBuilder
    private func sessionBoard(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        switch plan.arrangement {
        case .narrow:
            scrollChrome(groupedList(plan, scroller: scroller))
                .transition(.identity)
        case .columns:
            scrollChrome(columnBoard(plan))
                .transition(.identity)
        case .stackedOne, .stackedMany:
            scrollChrome(stackedBoard(plan, scroller: scroller))
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
    private func groupedList(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        List {
            if plan.headsScroll {
                // Three agents or more, or any number on a phone held sideways,
                // at an accessibility text size, or with a fifth limit window
                // in a head: the agent line is pinned above, and each agent's
                // full head opens its group and
                // scrolls with it, as the sections of a wide board do. No
                // pinned group name as well — it would stand directly over a
                // head saying the same name, which is the repetition one agent
                // already avoids.
                ForEach(plan.groups, id: \.section) { group in
                    reportsLanding(AgentHead(group: group,
                                             width: plan.width,
                                             canStrip: true,
                                             scale: plan.scale,
                                             now: now,
                                             jumpFocus: $jumpFocus,
                                             onJump: { jump(to: group.source, in: plan, scroller: scroller) }),
                                   as: group.section)
                        // Where the agent line's names send the list. A row
                        // is the one thing in a List that can be scrolled to.
                        .id(JumpTarget.section(group.source))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        // The wide board's spacing: the first head 10pt under
                        // the agent line, a head 24pt under the card before it
                        // (6 of that is the card's own), and 8pt above its
                        // first card (the card brings 6). No swipe: a head is
                        // not something to dismiss.
                        .listRowInsets(EdgeInsets(top: group.id == plan.groups.first?.id ? 10 : 18,
                                                  leading: Theme.Space.md, bottom: 2,
                                                  trailing: Theme.Space.md))
                    ForEach(group.sessions) { session in
                        row(session, in: group)
                    }
                }
            } else if plan.groups.count > 1 {
                ForEach(plan.groups, id: \.section) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            row(session, in: group)
                        }
                    } header: {
                        // A plain list pins its section headers by itself.
                        // What it does not do is draw them our way: the
                        // system insets a header, capitalises it, and rules a
                        // line under it. The label brings its own ground and
                        // its own padding, so all three are turned off.
                        GroupLabel(group: group, leads: group.id == plan.groups.first?.id)
                            .listRowInsets(EdgeInsets())
                            .textCase(nil)
                    }
                    .listSectionSeparator(.hidden)
                    .modifier(FlushSection())
                }
            } else {
                // One agent has its head directly above: a second name would
                // only repeat it. No Section at all, because an empty header
                // still takes its height — and this is the board most people
                // look at every day, which should not gain a gap for a
                // feature it is not using.
                ForEach(plan.groups, id: \.section) { group in
                    ForEach(group.sessions) { session in
                        row(session, in: group)
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .modifier(OpaquePinnedLabels(pinned: plan.groups.count > 1 && !plan.headsScroll))
        .environment(\.cardsSwipeToDismiss, true)
        // The list is rebuilt, not morphed, when the set of agents changes:
        // one agent is a flat run of rows and two are sections, and animating
        // between those drew every card twice for a fifth of a second and
        // dropped the list back to its top.
        .settles(on: plan.shape)
    }

    private func row(_ session: Session, in group: AgentGroup) -> some View {
        reportsLanding(card(session, in: group), as: .card(session.id))
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

    /// One column per agent, under the head pinned over it.
    ///
    /// Eager stacks, not lazy ones. A hosted board holds fifty cards at most,
    /// which is nothing to lay out — and a stack that knows every card's
    /// height is what makes a jump land exactly, a removal close its gap
    /// properly, and the scroll offset hold still when a card far above
    /// changes height.
    private func columnBoard(_ plan: BoardPlan) -> some View {
        ScrollView {
            HStack(alignment: .top, spacing: BoardArrangement.agentGutter) {
                ForEach(plan.groups) { group in
                    cardStack(group.sessions, in: group)
                        .frame(width: plan.track, alignment: .top)
                        // Read one agent at a time. Left to itself VoiceOver
                        // goes across the columns row by row, which deals the
                        // agents' cards into one another.
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("\(group.name) sessions")
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.top, Self.scrollTop - Self.cardLead)
            .padding(.bottom, Self.scrollBottom)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .settles(on: plan.shape)
        }
    }

    /// Agents stacked full width, cards two across: one agent under its pinned
    /// head, or several, each under a head that scrolls with it.
    private func stackedBoard(_ plan: BoardPlan, scroller: ScrollViewProxy) -> some View {
        let many = plan.arrangement == .stackedMany
        return ScrollView {
            // 24pt between two agents' sections, of which each head carries
            // the last 4 as its own — see `cardStack`.
            VStack(alignment: .leading, spacing: many ? BoardArrangement.agentGutter - Self.sectionLead : 0) {
                ForEach(plan.groups) { group in
                    // No spacing here: the cards bring the 8pt that separates
                    // them from their head.
                    VStack(alignment: .leading, spacing: 0) {
                        if many {
                            AgentHead(group: group,
                                      width: plan.width,
                                      canStrip: true,
                                      scale: plan.scale,
                                      now: now,
                                      jumpFocus: $jumpFocus,
                                      onJump: { jump(to: group.source, in: plan, scroller: scroller) })
                                .padding(.top, Self.sectionLead)
                                .id(JumpTarget.section(group.source))
                        }
                        // Two columns that each keep their cards — see CardSides.
                        HStack(alignment: .top, spacing: BoardArrangement.cardGap) {
                            ForEach(CardSides.Side.allCases, id: \.self) { side in
                                cardStack(plan.sides.cards(group.sessions, on: side), in: group)
                                    .frame(width: plan.side, alignment: .top)
                            }
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("\(group.name) sessions")
                }
            }
            .padding(.horizontal, Theme.Space.md)
            // A section's head stands a little further below the agent line
            // than a card stands below a head: the line is a rule across the
            // screen, and a box hard under a rule reads as hanging from it.
            .padding(.top, many ? 10 - Self.sectionLead : Self.scrollTop - Self.cardLead)
            .padding(.bottom, Self.scrollBottom)
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .settles(on: plan.shape)
        }
    }

    /// The first card sits 8pt under what is pinned (2 of it is the pinned
    /// area's own), as the list's first row always has.
    private static let scrollTop: CGFloat = 6
    private static let scrollBottom: CGFloat = 18

    /// How far below the top edge a jump leaves what it brought there: a card
    /// by the gap that separates it from a head, a section by half of that.
    private static let cardLead = Theme.Space.xs
    private static let sectionLead = Theme.Space.xxs

    /// One agent's cards in a column, 12pt apart.
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
    /// So a stack of cards begins with 8pt of air, and whatever holds one
    /// allows for that: see the top padding of the two containers.
    private func cardStack(_ sessions: [Session], in group: AgentGroup) -> some View {
        VStack(spacing: BoardArrangement.cardGap - Self.cardLead) {
            ForEach(sessions) { session in
                card(session, in: group)
                    .padding(.top, Self.cardLead)
                    .id(JumpTarget.card(session.id))
            }
        }
    }

    private func card(_ session: Session, in group: AgentGroup) -> some View {
        SessionCardView(session: session, agentName: group.name, jumpFocus: $jumpFocus)
            .overlay {
                // A ring only where one is news: the card the alarm just
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

    /// Brings `source`'s first blocked card into view and marks it.
    ///
    /// This is the other half of "a card keeps its place". A card that becomes
    /// blocked is recoloured where it stands, which may be a screen down, so
    /// the alarm in its agent's head has to be the way to it.
    private func jump(to source: String, in plan: BoardPlan, scroller: ScrollViewProxy) {
        guard let group = plan.groups.first(where: { $0.source == source }) else { return }
        let target: Session?
        switch plan.arrangement {
        case .narrow, .columns:
            target = group.firstBlocked
        case .stackedOne, .stackedMany:
            target = plan.sides.firstBlocked(in: group.sessions)
        }
        guard let target else { return }
        withAnimation(jumpAnimation) {
            switch plan.arrangement {
            case .narrow:
                // List rows answer to their session's own id.
                scroller.scrollTo(target.id, anchor: listAnchor(plan))
            case .columns, .stackedOne, .stackedMany:
                scroller.scrollTo(JumpTarget.card(target.id), anchor: .top)
            }
            jumped = target.id
            jumpStamp += 1
        }
        moveVoiceOver(to: .card(target.id), in: plan)
    }

    /// A jump's scroll: .snappy, drawn in one step under Reduce Motion as
    /// withMotion would be, and also while VoiceOver runs. VoiceOver is about
    /// to go to whatever the jump brings into view, and a row still sliding in
    /// at the edge of the screen when the cursor arrives is one it may scroll
    /// again on its own, to show it whole, against the scroll in flight. Drawn
    /// in one step, the card or head is already where the jump leaves it.
    private var jumpAnimation: Animation? {
        UIAccessibility.isReduceMotionEnabled || UIAccessibility.isVoiceOverRunning ? nil : .snappy
    }

    /// Moves VoiceOver to what a jump has just brought into view: a card for
    /// an alarm, a head for a name on the agent line.
    ///
    /// The wide board's stacks are eager, so every card and head already has
    /// its element and the cursor is sent at once. The phone's List is lazy: a
    /// row more than about a screen away has not been made when the jump
    /// fires, and a request then has nothing to land on — and since the focus
    /// state would already hold the target, setting it again later would be
    /// no change at all. So unless the row is laid out, the target waits with
    /// `landing`, and the row takes the cursor when the scroll lays it out
    /// (`reportsLanding`).
    private func moveVoiceOver(to target: JumpTarget, in plan: BoardPlan) {
        if plan.arrangement == .narrow && !landing.isLaidOut(target) {
            landing.wait(for: target)
        } else {
            landing.stopWaiting()
            jumpFocus = target
        }
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
    /// The design wants it at the top, clear of the group's name stuck there.
    /// A List gives no way to say "38pt down": it does not honour a fractional
    /// anchor (0.1 moved the row to two fifths of the way down, in the
    /// simulator), and a row is the only thing in it that can be scrolled to.
    ///
    /// What it does do, on iOS 26, is treat its own pinned header as the top:
    /// `.top` brings the row to rest directly under the label, the card 6pt
    /// beneath it. That is the design's answer to within a few points, so
    /// where it has been seen to hold it is used.
    ///
    /// It has only been seen on 26. An older list that put the row at the
    /// very top would hide the card's name behind the label — the one outcome
    /// a jump must not have, since the name is what you jumped to read. So
    /// before 26, with several agents, the row goes to the centre, which no
    /// version can put under anything. With one agent there is no label, nor
    /// wherever the heads scroll (three agents or more, a phone held sideways,
    /// an accessibility text size, a fifth limit window), which leaves nothing
    /// pinned inside the list — and there the top is simply the top.
    private func listAnchor(_ plan: BoardPlan) -> UnitPoint {
        if plan.groups.count < 2 || plan.headsScroll { return .top }
        if #available(iOS 26.0, *) { return .top }
        return .center
    }

    /// The ring is an answer to a tap, not a state: it goes after a couple of
    /// seconds, or sooner if another alarm is pressed.
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
    /// padding outside — the alarm's way (`AlarmButton.reach`). Drawn as it
    /// was, it was 16pt tall.
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

    /// The same reach, from a 21pt target to about 40 by 45.
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
                .padding(.trailing, 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -12)
        .padding(.leading, -5)
        .padding(.trailing, -14)
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
    /// scrolls. On a narrower sideways board, an SE or a 6.1" phone, and at an
    /// accessibility size, the heads scroll in here instead (`idleHeads`),
    /// and the sentence follows them.
    private func emptyState(_ plan: BoardPlan) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                idleHeads(plan)
                emptyMessage(hasAgents: !plan.groups.isEmpty,
                             compact: verticalSizeClass == .compact,
                             underHeads: plan.idleHeadsScroll && !plan.groups.isEmpty)
            }
        }
        .refreshable { await store.refresh() }
    }

    /// `compact` is the sideways strip, where even the title steps down;
    /// `underHeads`, heads scrolling above it. Either way the moon and the
    /// 64pt above it go.
    private func emptyMessage(hasAgents: Bool, compact: Bool, underHeads: Bool) -> some View {
        let plain = compact || underHeads
        return VStack(spacing: compact ? Theme.Space.xs : 16) {
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
        .padding(.horizontal, 24)
        .padding(.vertical, compact ? Theme.Space.sm : 24)
        .padding(.top, plain ? 0 : 64)
        .frame(maxWidth: .infinity)
    }

    /// An idle board's heads where they cannot be pinned (`idleHeadsScroll`):
    /// at the top of what scrolls, each the whole width, as the list's own
    /// scrolling heads are, so a name has its line to itself. With nothing
    /// running nothing is blocked, so there is no alarm to jump from.
    @ViewBuilder
    private func idleHeads(_ plan: BoardPlan) -> some View {
        if plan.idleHeadsScroll && !plan.groups.isEmpty {
            VStack(alignment: .leading, spacing: BoardArrangement.headGap) {
                ForEach(plan.groups) { group in
                    AgentHead(group: group, width: plan.width, canStrip: true,
                              scale: plan.scale, now: now, jumpFocus: $jumpFocus, onJump: {})
                }
            }
            .padding(.horizontal, Theme.Space.md)
            .padding(.top, 10)
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
        let short = verticalSizeClass == .compact || (plan.idleHeadsScroll && !plan.groups.isEmpty)
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
                        .foregroundStyle(Theme.textSecondary.opacity(0.7))
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
        Group {
            switch lampState {
            case .live:
                Circle().fill(dotColor)
            case .connecting, .reconnecting:
                Circle().strokeBorder(dotColor, lineWidth: 2)
            case .boardGone:
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .heavy))
                    .foregroundStyle(dotColor)
            case .idle, .demo:
                Circle().strokeBorder(dotColor, style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
            }
        }
        .frame(width: 9, height: 9)
        // One element: what it is, then where it stands. A bare
        // "Reconnecting" named nothing. Not .updatesFrequently, which only
        // has VoiceOver poll the element its cursor is on: a dropped
        // connection matters while the cursor is somewhere else, so the
        // board says it aloud instead (`announceConnection`).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Board connection")
        .accessibilityValue(dotDescription)
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
    let groups: [AgentGroup]
    let arrangement: BoardArrangement
    /// Whether two columns fit the width. An idle board asks it to choose
    /// between two heads across and three. It is the width's answer and not
    /// the arrangement's: a phone held sideways keeps its sessions in a list,
    /// but its idle heads take the one row its width allows, which is the row
    /// a short screen wants.
    let wide: Bool
    /// No sessions: the heads are the limits and nothing else.
    let idle: Bool
    /// An accessibility text size.
    let largeText: Bool
    /// A phone held sideways: the list, whatever the width.
    let compactHeight: Bool
    let sides: CardSides

    /// Whether the heads scroll with their sections under one pinned agent
    /// line. Never on an idle board: there are no sections for an agent line
    /// to name. Where an idle board's pinned heads would not fit, they scroll
    /// inside the empty state instead (`idleHeadsScroll`).
    var headsScroll: Bool {
        !idle && BoardArrangement.headsScroll(arrangement, agents: groups.count,
                                              windows: groups.mostWindows,
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
    /// And on a phone held sideways that is too narrow for two columns, an
    /// SE or a 6.1" phone, where the heads go two across in their narrow
    /// form, 54pt a window: on an SE's board of about 261pt between the
    /// navigation bar and the streak, four windows already ran past its
    /// bottom edge. Wider sideways boards, a 6.3" phone and up, lay the heads
    /// across in one row of their regular form, which fits.
    ///
    /// No agent line: an idle board has no sections for its names to send
    /// you to, and nothing blocked.
    var idleHeadsScroll: Bool { idle && (largeText || (compactHeight && !wide)) }

    /// One agent's column, and the head over it.
    var track: CGFloat { BoardArrangement.track(width: width, count: groups.count) }
    /// One side of a pair of cards.
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
        Shape(arrangement: arrangement, tracks: arrangement == .columns ? groups.count : 0, idle: idle,
              headsScroll: headsScroll, agents: groups.map(\.source))
    }

    struct Shape: Hashable {
        let arrangement: BoardArrangement
        /// How many columns, where there are columns. A third agent arriving
        /// keeps the arrangement and still re-cuts every track on the board.
        let tracks: Int
        let idle: Bool
        /// Pinned heads or the agent line. A phone turned on its side keeps
        /// its list, but trades the one for the other, and its list's groups
        /// go from named sections to heads among the rows.
        let headsScroll: Bool
        /// Which agents are on the board. One arriving or leaving changes
        /// every head and every group even where the arrangement and the
        /// track count stay as they were — two agents becoming two different
        /// agents, or the phone's list going from one group to two.
        let agents: [String]
    }
}

/// Which of the phone's List rows are laid out, and the one a jump is waiting
/// for.
///
/// A List makes a row only as it scrolls into view, so a card two screens
/// down has no accessibility element when its alarm is pressed. The jump
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
/// nothing between the heads and the first group's name, and again before
/// every later one, on a board where 12pt is the gap between two cards. The
/// label already carries the space it wants, so the system's is taken out.
///
/// Two ways, because the direct one is new. iOS 26 can zero a section's
/// margins and does exactly that: checked on 26.5, where the first label then
/// sits flush under the heads and the rest 6pt under the card before them.
/// Before 26 the nearest thing is the section spacing, which on 26.5 closes
/// the gap between sections and leaves the first header's alone. Nothing older
/// than 26 was available to run this on, so on iOS 17 and 18 expect the first
/// group's name to stand up to 22pt lower than drawn, and no worse.
private struct FlushSection: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.listSectionMargins(.vertical, 0)
        } else {
            content.listSectionSpacing(0)
        }
    }
}

/// Keeps a pinned group name opaque while it hands over to the next one.
///
/// iOS 26 fades a pinned section header out as the following header pushes it
/// off, and the fade takes the header's own background with it. For the length
/// of that hand-over the last card of the outgoing group showed straight
/// through its name — "Claude 3" printed over "8m ago · 1.4M", two lines of
/// text on one, and exactly where the alarm's jump leaves the list when it
/// bottoms out. The hard edge style puts the system's own opaque band behind
/// whatever is pinned at the top, so the name may dim as it leaves but nothing
/// is read through it.
///
/// Checked on 26.5, the only runtime here. Before 26 a plain list's pinned
/// headers are pushed off without fading, so the label's own ground is enough
/// and there is nothing to switch on.
private struct OpaquePinnedLabels: ViewModifier {
    /// Whether the list has group names to pin at all. With one agent there
    /// are none, and the hard edge would leave an empty band where one stood.
    let pinned: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(pinned ? .hard : .automatic, for: .top)
        } else {
            content
        }
    }
}
